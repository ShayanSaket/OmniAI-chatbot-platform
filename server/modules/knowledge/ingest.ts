import 'server-only';
import { Prisma, type KnowledgeDocument } from '@prisma/client';
import { embeddingModel, embeddingsConfigured, embedTexts, hashText, toVectorLiteral } from '../../ai/embeddings';
import { estimateCostUsd } from '../../ai/pricing';
import { ProviderNotConfiguredError } from '../../ai/provider';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { getObject } from '../../storage/s3';
import { chunkFaq, chunkPages, chunkText, parseFaqText, type FaqEntry, type TextChunk } from './chunker';
import { cleanPages, cleanText } from './clean';
import { ExtractionError, extractFile } from './extract';
import { fetchPage, TransientFetchError } from './web';

// Knowledge ingestion:
//   source (file in S3 | web page | FAQ entries | text) → extract → clean → chunk
//   → embed (cached) → store chunks + vectors → READY
// Runs in the background after upload; jobs/knowledge-jobs.ts recovers stuck documents
// and backfills embeddings that could not be computed at ingestion time.

/** A PROCESSING document older than this is considered abandoned (crashed worker). */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;
export const MAX_PROCESSING_ATTEMPTS = 3;

interface DocMeta {
  attempts?: number;
  faq?: FaqEntry[];
  crawlRoot?: string;
  embeddingError?: string | null;
  /** Replace the placeholder title with the one found in the source. */
  titleFromSource?: boolean;
  [key: string]: unknown;
}

const metaOf = (doc: Pick<KnowledgeDocument, 'metadata'>) => (doc.metadata ?? {}) as DocMeta;

/** The text sent to the embedding model: the chunk plus where it comes from. */
export function embeddingInput(doc: { title: string }, chunk: Pick<TextChunk, 'content' | 'location'>): string {
  const where = chunk.location && chunk.location !== doc.title ? `${doc.title} › ${chunk.location.replace(`${doc.title} › `, '')}` : doc.title;
  return `${where}\n\n${chunk.content}`;
}

/** Claims a document for processing; null if another worker has it or it is done. */
async function claim(documentId: string) {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimed = await prisma.knowledgeDocument.updateMany({
    where: { id: documentId, OR: [{ status: 'PENDING' }, { status: 'PROCESSING', updatedAt: { lt: staleBefore } }] },
    data: { status: 'PROCESSING', error: null },
  });
  if (claimed.count !== 1) return null;
  return prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
}

async function readSource(doc: KnowledgeDocument): Promise<{ chunks: TextChunk[]; fullText: string; title: string | null; extra: Record<string, unknown> }> {
  const meta = metaOf(doc);
  // Uploads and web pages start with a placeholder title until the source provides one;
  // the final title is decided before chunking so passages carry it as their location.
  const finalTitle = (found: string | null | undefined) => (meta.titleFromSource && found?.trim() ? found.trim().slice(0, 200) : doc.title);
  if (doc.sourceType === 'FAQ') {
    const entries = meta.faq?.length ? meta.faq : parseFaqText(doc.rawText ?? '');
    if (!entries.length) throw new ExtractionError('Add at least one question with an answer.');
    const chunks = chunkFaq(entries, { title: doc.title });
    return { chunks, fullText: chunks.map((c) => c.content).join('\n\n'), title: null, extra: { faq: entries } };
  }
  if (doc.sourceType === 'WEBSITE' && doc.sourceUrl) {
    const page = await fetchPage(doc.sourceUrl);
    const text = cleanText(page.text);
    return {
      chunks: chunkText(text, { title: finalTitle(page.title) }),
      fullText: text,
      title: finalTitle(page.title),
      extra: { finalUrl: page.url, language: page.language, fetchedAt: new Date().toISOString() },
    };
  }
  if (doc.storageKey && doc.mimeType) {
    const object = await getObject(doc.storageKey);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const extracted = await extractFile(bytes, doc.mimeType);
    if (extracted.paginated) {
      const pages = cleanPages(extracted.pages);
      return {
        chunks: chunkPages(pages, { title: finalTitle(extracted.title) }),
        fullText: pages.map((p) => p.text).join('\n\n'),
        title: finalTitle(extracted.title),
        extra: { pageCount: extracted.pages.length },
      };
    }
    const text = cleanText(extracted.pages.map((p) => p.text).join('\n\n'));
    return { chunks: chunkText(text, { title: finalTitle(extracted.title) }), fullText: text, title: finalTitle(extracted.title), extra: {} };
  }
  const text = cleanText(doc.rawText ?? '');
  return { chunks: chunkText(text, { title: doc.title }), fullText: text, title: null, extra: {} };
}

/**
 * Embeds and stores vectors for chunks. Returns the model used, or null (with the reason)
 * when no provider is configured or the provider failed: the document then stays
 * keyword-searchable and the backfill job retries later.
 */
async function embedChunks(doc: Pick<KnowledgeDocument, 'id' | 'organizationId' | 'title'>, chunks: { id: string; content: string; location: string | null }[]) {
  if (!embeddingsConfigured() || !chunks.length) return { model: null, error: embeddingsConfigured() ? null : 'No embedding provider configured' };
  const model = embeddingModel();
  const started = Date.now();
  try {
    const { vectors, tokens } = await embedTexts(chunks.map((c) => embeddingInput(doc, c)), model);
    await prisma.$transaction(
      chunks.map((c, i) => prisma.$executeRaw`UPDATE "KnowledgeChunk" SET "embedding" = ${toVectorLiteral(vectors[i]!)}::vector WHERE "id" = ${c.id} AND "organizationId" = ${doc.organizationId}`),
    );
    if (tokens > 0) {
      await prisma.usageRecord.create({
        data: {
          organizationId: doc.organizationId,
          kind: 'EMBEDDING',
          model,
          embeddingTokens: tokens,
          costUsd: estimateCostUsd(model, tokens, 0) ?? 0,
          latencyMs: Date.now() - started,
        },
      });
    }
    return { model, error: null };
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) return { model: null, error: 'No embedding provider configured' };
    logger.warn('embedding failed; document stays keyword-searchable', { organizationId: doc.organizationId, documentId: doc.id, err: (err as Error).message });
    return { model: null, error: (err as Error).message.slice(0, 300) };
  }
}

export async function processDocument(documentId: string): Promise<'ready' | 'failed' | 'skipped'> {
  const doc = await claim(documentId);
  if (!doc) return 'skipped';
  const meta = metaOf(doc);
  const attempts = (meta.attempts ?? 0) + 1;
  const log = logger.child({ organizationId: doc.organizationId, documentId: doc.id, sourceType: doc.sourceType });
  const started = Date.now();

  try {
    const source = await readSource(doc);
    if (!source.chunks.length) throw new ExtractionError('No text was found in this source.');

    const title = source.title ?? doc.title;
    const contentHash = hashText(source.fullText);
    const stored = await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { documentId: doc.id, organizationId: doc.organizationId } });
      await tx.knowledgeChunk.createMany({
        data: source.chunks.map((c) => ({
          organizationId: doc.organizationId,
          documentId: doc.id,
          chunkIndex: c.index,
          content: c.content,
          location: c.location,
          pageNumber: c.pageNumber,
          tokenCount: c.tokenCount,
        })),
      });
      return tx.knowledgeChunk.findMany({ where: { documentId: doc.id }, orderBy: { chunkIndex: 'asc' }, select: { id: true, content: true, location: true } });
    });

    const embedding = await embedChunks({ ...doc, title }, stored);
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        status: 'READY',
        error: null,
        title,
        rawText: source.fullText,
        contentHash,
        chunkCount: source.chunks.length,
        tokenCount: source.chunks.reduce((n, c) => n + c.tokenCount, 0),
        embeddingModel: embedding.model,
        processedAt: new Date(),
        metadata: { ...meta, ...source.extra, attempts: 0, titleFromSource: false, embeddingError: embedding.error } as unknown as Prisma.InputJsonValue,
      },
    });
    log.info('knowledge document processed', { chunks: source.chunks.length, embedded: Boolean(embedding.model), ms: Date.now() - started });
    return 'ready';
  } catch (err) {
    const userFacing = err instanceof ExtractionError;
    const retry = !userFacing && attempts < MAX_PROCESSING_ATTEMPTS;
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        // Unexpected errors go back to PENDING for the recovery job; content problems fail.
        status: retry ? 'PENDING' : 'FAILED',
        error: userFacing || err instanceof TransientFetchError ? (err as Error).message : 'Processing failed. Try re-indexing the document.',
        metadata: { ...meta, attempts } as unknown as Prisma.InputJsonValue,
      },
    });
    log[userFacing ? 'info' : 'error']('knowledge document failed', { err: (err as Error).message, attempts, willRetry: retry });
    return 'failed';
  }
}

/** Embeds READY documents that have no vectors yet (or vectors of another model). */
export async function backfillEmbeddings(limit = 5): Promise<number> {
  if (!embeddingsConfigured()) return 0;
  const model = embeddingModel();
  const docs = await prisma.knowledgeDocument.findMany({
    where: { status: 'READY', chunkCount: { gt: 0 }, OR: [{ embeddingModel: null }, { embeddingModel: { not: model } }] },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true, organizationId: true, title: true, metadata: true, updatedAt: true },
  });
  let done = 0;
  for (const doc of docs) {
    // Don't hammer a failing provider: wait 10 minutes after an embedding error.
    const meta = metaOf(doc as KnowledgeDocument);
    if (meta.embeddingError && meta.embeddingError !== 'No embedding provider configured' && Date.now() - doc.updatedAt.getTime() < 10 * 60_000) continue;
    const chunks = await prisma.knowledgeChunk.findMany({ where: { documentId: doc.id }, orderBy: { chunkIndex: 'asc' }, select: { id: true, content: true, location: true } });
    const result = await embedChunks(doc, chunks);
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { embeddingModel: result.model, metadata: { ...meta, embeddingError: result.error } as unknown as Prisma.InputJsonValue },
    });
    if (result.model) done++;
  }
  return done;
}

/** Documents waiting too long (missed background run, crash) are processed again. */
export async function recoverPendingDocuments(limit = 5): Promise<number> {
  const docs = await prisma.knowledgeDocument.findMany({
    where: {
      OR: [
        { status: 'PENDING', updatedAt: { lt: new Date(Date.now() - 30_000) } },
        { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let n = 0;
  for (const { id } of docs) if ((await processDocument(id)) !== 'skipped') n++;
  return n;
}
