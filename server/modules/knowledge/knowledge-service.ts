import 'server-only';
import { randomUUID } from 'node:crypto';
import type { KnowledgeSourceType, KnowledgeStatus, Prisma } from '@prisma/client';
import { hasPermission } from '@/lib/permissions';
import {
  KNOWLEDGE_MAX_FILE_BYTES,
  type KnowledgeFaqInput,
  type KnowledgeTextInput,
  type KnowledgeWebsiteInput,
} from '@/lib/validation';
import { embeddingModel, embeddingsConfigured, hashText } from '../../ai/embeddings';
import { runInBackground } from '../../background';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';
import { env } from '../../env';
import { AppError, forbidden, notFound } from '../../errors';
import { logger } from '../../logger';
import { assertPublicUrl, OutboundRequestError } from '../../net/safe-fetch';
import { safeFileName, signedFileUrl, sniffFileType } from '../../storage/files';
import { deletePrefix, putObject } from '../../storage/s3';
import { auditFromContext } from '../audit/audit-service';
import { processDocument } from './ingest';
import { searchKnowledge } from './retrieval';
import { crawlSite, MAX_CRAWL_PAGES } from './web';

const MAX_DOCUMENTS = 1000;

function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'knowledge:manage')) throw forbidden();
}

const knowledgePrefix = (organizationId: string, documentId: string) => `org/${organizationId}/knowledge/${documentId}/`;

function scheduleProcessing(documentId: string) {
  runInBackground('knowledge-process', () => processDocument(documentId), { documentId });
}

async function assertCapacity(ctx: ServiceContext, adding = 1) {
  if ((await ctx.db.knowledgeDocument.count()) + adding > MAX_DOCUMENTS) {
    throw new AppError('BAD_REQUEST', `A workspace can hold up to ${MAX_DOCUMENTS} knowledge sources.`);
  }
}

const SOURCE_LABEL: Record<KnowledgeSourceType, string> = {
  PDF: 'PDF',
  DOCX: 'Word',
  TXT: 'Text file',
  MARKDOWN: 'Markdown',
  WEBSITE: 'Website',
  FAQ: 'FAQ',
  MANUAL: 'Text',
};

export function serializeDocument(d: {
  id: string;
  title: string;
  sourceType: KnowledgeSourceType;
  sourceUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  status: KnowledgeStatus;
  error: string | null;
  chunkCount: number;
  tokenCount: number;
  usageCount: number;
  embeddingModel: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Prisma.JsonValue;
  createdBy?: { name: string | null } | null;
}) {
  const meta = (d.metadata ?? {}) as { embeddingError?: string | null; pageCount?: number; crawlRoot?: string };
  return {
    id: d.id,
    title: d.title,
    sourceType: d.sourceType,
    sourceLabel: SOURCE_LABEL[d.sourceType],
    sourceUrl: d.sourceUrl,
    fileName: d.fileName,
    fileSize: d.fileSize,
    status: d.status,
    error: d.error,
    chunkCount: d.chunkCount,
    tokenCount: d.tokenCount,
    usageCount: d.usageCount,
    semantic: Boolean(d.embeddingModel),
    embeddingError: meta.embeddingError ?? null,
    pageCount: meta.pageCount ?? null,
    processedAt: d.processedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    createdBy: d.createdBy?.name ?? null,
  };
}
export type KnowledgeDocumentDto = ReturnType<typeof serializeDocument>;

const LIST_SELECT = {
  id: true,
  title: true,
  sourceType: true,
  sourceUrl: true,
  fileName: true,
  fileSize: true,
  status: true,
  error: true,
  chunkCount: true,
  tokenCount: true,
  usageCount: true,
  embeddingModel: true,
  processedAt: true,
  createdAt: true,
  updatedAt: true,
  metadata: true,
  createdBy: { select: { name: true } },
} as const;

export async function listKnowledge(ctx: ServiceContext) {
  assertCanManage(ctx);
  const docs = await ctx.db.knowledgeDocument.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_DOCUMENTS, select: LIST_SELECT });
  const items = docs.map(serializeDocument);
  return {
    documents: items,
    stats: {
      documents: items.length,
      ready: items.filter((d) => d.status === 'READY').length,
      processing: items.filter((d) => d.status === 'PENDING' || d.status === 'PROCESSING').length,
      failed: items.filter((d) => d.status === 'FAILED').length,
      chunks: items.reduce((n, d) => n + d.chunkCount, 0),
      semantic: items.filter((d) => d.semantic).length,
      embeddingsConfigured: embeddingsConfigured(),
      embeddingModel: embeddingModel(),
    },
  };
}
export type KnowledgeOverview = Awaited<ReturnType<typeof listKnowledge>>;

export async function getKnowledgeDocument(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  const doc = await ctx.db.knowledgeDocument.findUnique({ where: { id }, select: { ...LIST_SELECT, storageKey: true, mimeType: true, rawText: true } });
  if (!doc) throw notFound('Document');
  const chunks = await prisma.$queryRaw<{ chunkIndex: number; content: string; location: string | null; pageNumber: number | null; embedded: boolean }[]>`
    SELECT "chunkIndex", "content", "location", "pageNumber", ("embedding" IS NOT NULL) AS "embedded"
    FROM "KnowledgeChunk" WHERE "documentId" = ${id} AND "organizationId" = ${ctx.organizationId}
    ORDER BY "chunkIndex" ASC LIMIT 300`;
  const meta = (doc.metadata ?? {}) as { faq?: { question: string; answer: string }[] };
  return {
    ...serializeDocument(doc),
    downloadUrl: doc.storageKey ? signedFileUrl(env().AUTH_SECRET, doc.storageKey) : null,
    faq: doc.sourceType === 'FAQ' ? (meta.faq ?? []) : null,
    text: doc.sourceType === 'MANUAL' || doc.sourceType === 'MARKDOWN' ? (doc.rawText ?? '') : null,
    chunks,
  };
}
export type KnowledgeDocumentDetail = Awaited<ReturnType<typeof getKnowledgeDocument>>;

/** Upload a PDF, DOCX, TXT or Markdown file; processing continues in the background. */
export async function uploadKnowledgeFile(ctx: ServiceContext, file: File) {
  assertCanManage(ctx);
  if (file.size === 0) throw new AppError('BAD_REQUEST', 'The file is empty.');
  if (file.size > KNOWLEDGE_MAX_FILE_BYTES) throw new AppError('BAD_REQUEST', 'Files can be at most 20 MB.');
  await assertCapacity(ctx);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffFileType(bytes, file.name);
  const isMarkdown = /\.(md|markdown)$/i.test(file.name);
  if (!type || !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'].includes(type.mime)) {
    throw new AppError('BAD_REQUEST', 'Upload a PDF, Word (.docx), text (.txt) or Markdown (.md) file.');
  }
  const fileHash = hashText(Buffer.from(bytes).toString('base64'));
  const duplicate = await ctx.db.knowledgeDocument.findFirst({ where: { metadata: { path: ['fileHash'], equals: fileHash } }, select: { title: true } });
  if (duplicate) throw new AppError('CONFLICT', `This file is already in the knowledge base (“${duplicate.title}”).`);

  const sourceType: KnowledgeSourceType = type.mime === 'application/pdf' ? 'PDF' : type.ext === 'docx' ? 'DOCX' : isMarkdown ? 'MARKDOWN' : 'TXT';
  const mimeType = isMarkdown ? 'text/markdown' : type.mime;
  const id = randomUUID();
  const fileName = safeFileName(file.name, isMarkdown ? 'md' : type.ext);
  const storageKey = `${knowledgePrefix(ctx.organizationId, id)}${fileName}`;
  await putObject(storageKey, bytes, mimeType === 'text/markdown' ? 'text/plain' : mimeType);
  const doc = await ctx.db.knowledgeDocument.create({
    data: {
      id,
      organizationId: ctx.organizationId,
      title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Untitled',
      sourceType,
      fileName,
      mimeType,
      fileSize: bytes.byteLength,
      storageKey,
      createdById: ctx.userId,
      metadata: { fileHash, titleFromSource: true },
    },
    select: LIST_SELECT,
  });
  await auditFromContext(ctx, 'knowledge.uploaded', { type: 'KnowledgeDocument', id }, { fileName, size: bytes.byteLength });
  scheduleProcessing(id);
  return serializeDocument(doc);
}

async function createWebsiteDocument(ctx: ServiceContext, url: string, crawlRoot: string | null) {
  return ctx.db.knowledgeDocument.create({
    data: {
      organizationId: ctx.organizationId,
      title: url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 200),
      sourceType: 'WEBSITE',
      sourceUrl: url,
      createdById: ctx.userId,
      metadata: { titleFromSource: true, ...(crawlRoot ? { crawlRoot } : {}) },
    },
    select: LIST_SELECT,
  });
}

/** Adds a web page (and optionally the same-site pages it links to). */
export async function addKnowledgeWebsite(ctx: ServiceContext, input: KnowledgeWebsiteInput) {
  assertCanManage(ctx);
  let url: string;
  try {
    url = (await assertPublicUrl(input.url)).toString();
  } catch (err) {
    if (err instanceof OutboundRequestError) throw new AppError('VALIDATION_FAILED', err.message, { url: [err.message] });
    throw err;
  }
  if (await ctx.db.knowledgeDocument.findFirst({ where: { sourceUrl: url }, select: { id: true } })) {
    throw new AppError('CONFLICT', 'This page is already in the knowledge base. Use “Refresh” to update it.');
  }
  await assertCapacity(ctx);
  const doc = await createWebsiteDocument(ctx, url, input.crawl ? url : null);
  await auditFromContext(ctx, 'knowledge.website_added', { type: 'KnowledgeDocument', id: doc.id }, { url, crawl: input.crawl });
  scheduleProcessing(doc.id);

  if (input.crawl) {
    runInBackground(
      'knowledge-crawl',
      async () => {
        const { pages } = await crawlSite(url, Math.min(input.maxPages, MAX_CRAWL_PAGES));
        const existing = new Set(
          (await ctx.db.knowledgeDocument.findMany({ where: { sourceType: 'WEBSITE' }, select: { sourceUrl: true } })).map((d) => d.sourceUrl),
        );
        for (const page of pages.slice(1)) {
          if (existing.has(page.url) || (await ctx.db.knowledgeDocument.count()) >= MAX_DOCUMENTS) continue;
          const child = await createWebsiteDocument(ctx, page.url, url);
          existing.add(page.url);
          await processDocument(child.id);
        }
      },
      { organizationId: ctx.organizationId, url },
    );
  }
  return serializeDocument(doc);
}

export async function addKnowledgeFaq(ctx: ServiceContext, input: KnowledgeFaqInput) {
  assertCanManage(ctx);
  await assertCapacity(ctx);
  const doc = await ctx.db.knowledgeDocument.create({
    data: {
      organizationId: ctx.organizationId,
      title: input.title,
      sourceType: 'FAQ',
      rawText: input.entries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n'),
      createdById: ctx.userId,
      metadata: { faq: input.entries },
    },
    select: LIST_SELECT,
  });
  await auditFromContext(ctx, 'knowledge.faq_added', { type: 'KnowledgeDocument', id: doc.id }, { entries: input.entries.length });
  scheduleProcessing(doc.id);
  return serializeDocument(doc);
}

export async function addKnowledgeText(ctx: ServiceContext, input: KnowledgeTextInput) {
  assertCanManage(ctx);
  await assertCapacity(ctx);
  const doc = await ctx.db.knowledgeDocument.create({
    data: { organizationId: ctx.organizationId, title: input.title, sourceType: 'MANUAL', rawText: input.content, createdById: ctx.userId, metadata: {} },
    select: LIST_SELECT,
  });
  await auditFromContext(ctx, 'knowledge.text_added', { type: 'KnowledgeDocument', id: doc.id }, { characters: input.content.length });
  scheduleProcessing(doc.id);
  return serializeDocument(doc);
}

async function findDocument(ctx: ServiceContext, id: string) {
  const doc = await ctx.db.knowledgeDocument.findUnique({ where: { id } });
  if (!doc) throw notFound('Document');
  return doc;
}

/** Edits an FAQ or text source and re-processes it. */
export async function updateKnowledgeContent(ctx: ServiceContext, id: string, input: KnowledgeFaqInput | KnowledgeTextInput) {
  assertCanManage(ctx);
  const doc = await findDocument(ctx, id);
  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  let data: Prisma.KnowledgeDocumentUpdateInput;
  if (doc.sourceType === 'FAQ' && 'entries' in input) {
    data = {
      title: input.title,
      rawText: input.entries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n'),
      metadata: { ...meta, faq: input.entries, attempts: 0 },
    };
  } else if ((doc.sourceType === 'MANUAL' || doc.sourceType === 'MARKDOWN') && 'content' in input) {
    data = { title: input.title, rawText: input.content, metadata: { ...meta, attempts: 0 } };
  } else {
    throw new AppError('BAD_REQUEST', 'Only FAQ and text sources can be edited. Upload a new version of files instead.');
  }
  const updated = await ctx.db.knowledgeDocument.update({ where: { id }, data: { ...data, status: 'PENDING', error: null }, select: LIST_SELECT });
  await auditFromContext(ctx, 'knowledge.updated', { type: 'KnowledgeDocument', id });
  scheduleProcessing(id);
  return serializeDocument(updated);
}

/** Re-extracts and re-embeds a document (refetches web pages). */
export async function reindexKnowledgeDocument(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  const doc = await findDocument(ctx, id);
  if (doc.status === 'PROCESSING') throw new AppError('CONFLICT', 'This document is being processed right now.');
  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  const updated = await ctx.db.knowledgeDocument.update({
    where: { id },
    data: { status: 'PENDING', error: null, metadata: { ...meta, attempts: 0 } as Prisma.InputJsonValue },
    select: LIST_SELECT,
  });
  await auditFromContext(ctx, 'knowledge.reindexed', { type: 'KnowledgeDocument', id });
  scheduleProcessing(id);
  return serializeDocument(updated);
}

export async function deleteKnowledgeDocument(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  const doc = await findDocument(ctx, id);
  await ctx.db.knowledgeDocument.delete({ where: { id } });
  if (doc.storageKey) {
    await deletePrefix(knowledgePrefix(ctx.organizationId, id)).catch((err) =>
      logger.warn('knowledge file could not be deleted from storage', { organizationId: ctx.organizationId, documentId: id, err: (err as Error).message }),
    );
  }
  await auditFromContext(ctx, 'knowledge.deleted', { type: 'KnowledgeDocument', id }, { title: doc.title });
}

/** "Test a question": shows exactly what the assistant would retrieve. */
export async function testKnowledgeSearch(ctx: ServiceContext, query: string) {
  assertCanManage(ctx);
  const started = Date.now();
  const results = await searchKnowledge(ctx.organizationId, query, { limit: 6 });
  return { results, ms: Date.now() - started, semanticEnabled: embeddingsConfigured() };
}
