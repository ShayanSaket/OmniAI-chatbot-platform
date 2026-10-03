import 'server-only';
import { Prisma } from '@prisma/client';
import { embeddingModel, embeddingsConfigured, embedTexts, toVectorLiteral } from '../../ai/embeddings';
import { estimateCostUsd } from '../../ai/pricing';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { queryTerms, termCoverage, toPrefixTsQuery } from './query';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  location: string | null;
  pageNumber: number | null;
  content: string;
  /** Fused relevance score (0..1, higher is better). */
  score: number;
  /** Cosine similarity of the semantic match, if any. */
  similarity: number | null;
  matchedBy: ('semantic' | 'keyword')[];
}

/** Minimum share of query terms a chunk must contain to count as a keyword match. */
const MIN_COVERAGE = 0.34;
/**
 * Minimum cosine similarity for a semantic match. text-embedding-3 models put unrelated
 * text around 0.05–0.25 and relevant passages typically above 0.35.
 */
export const MIN_SIMILARITY = 0.32;
const CANDIDATES = 24;
const RRF_K = 60;
/** Diversity: at most this many chunks from one document. */
const MAX_PER_DOCUMENT = 2;

interface Candidate {
  id: string;
  documentId: string;
  title: string;
  location: string | null;
  pageNumber: number | null;
  content: string;
}

async function keywordCandidates(organizationId: string, terms: string[]) {
  const tsQuery = toPrefixTsQuery(terms);
  if (!tsQuery) return [];
  // Raw SQL is not tenant-scoped automatically: organizationId is filtered explicitly.
  const rows = await prisma.$queryRaw<(Candidate & { rank: number })[]>(Prisma.sql`
    SELECT c."id", c."documentId", d."title", c."location", c."pageNumber", c."content",
           ts_rank_cd(to_tsvector('simple', c."content"), q, 32)::float AS "rank"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeDocument" d ON d."id" = c."documentId",
         to_tsquery('simple', ${tsQuery}) q
    WHERE c."organizationId" = ${organizationId}
      AND d."organizationId" = ${organizationId}
      AND d."status" = 'READY'
      AND to_tsvector('simple', c."content") @@ q
    ORDER BY "rank" DESC
    LIMIT ${CANDIDATES}
  `);
  return rows
    .map((row) => ({ row, coverage: termCoverage(terms, `${row.title} ${row.location ?? ''} ${row.content}`) }))
    .filter((r) => r.coverage >= MIN_COVERAGE || (terms.length === 1 && r.coverage > 0))
    .sort((a, b) => b.coverage - a.coverage || b.row.rank - a.row.rank);
}

async function semanticCandidates(organizationId: string, query: string) {
  const model = embeddingModel();
  // No embedded knowledge for this model → don't pay for a query embedding.
  const indexed = await prisma.knowledgeDocument.findFirst({
    where: { organizationId, status: 'READY', embeddingModel: model },
    select: { id: true },
  });
  if (!indexed) return [];
  const { vectors, tokens } = await embedTexts([query], model);
  const vector = toVectorLiteral(vectors[0]!);
  // Iterative HNSW scan (pgvector ≥ 0.8) keeps enough rows after the tenant filter.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 100`);
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`).catch(() => undefined);
    return tx.$queryRaw<(Candidate & { similarity: number })[]>(Prisma.sql`
      SELECT c."id", c."documentId", d."title", c."location", c."pageNumber", c."content",
             (1 - (c."embedding" <=> ${vector}::vector))::float AS "similarity"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE c."organizationId" = ${organizationId}
        AND d."organizationId" = ${organizationId}
        AND d."status" = 'READY'
        AND d."embeddingModel" = ${model}
        AND c."embedding" IS NOT NULL
      ORDER BY c."embedding" <=> ${vector}::vector
      LIMIT ${CANDIDATES}
    `);
  });
  if (tokens > 0) {
    await prisma.usageRecord.create({
      data: { organizationId, kind: 'EMBEDDING', model, embeddingTokens: tokens, costUsd: estimateCostUsd(model, tokens, 0) ?? 0 },
    });
  }
  return rows.filter((r) => r.similarity >= MIN_SIMILARITY);
}

/** Reciprocal Rank Fusion of ranked lists (robust to different score scales). */
export function fuseRankings(lists: { id: string }[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

/** Keeps the best-scoring items while limiting how many come from one document. */
export function diversify<T extends { documentId: string }>(ranked: T[], limit: number, perDocument = MAX_PER_DOCUMENT): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const item of ranked) {
    const n = counts.get(item.documentId) ?? 0;
    if (n >= perDocument) continue;
    counts.set(item.documentId, n + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Hybrid retrieval within one organization:
 *   semantic  pgvector cosine search on chunk embeddings (cross-language, paraphrases)
 *   keyword   Postgres full-text search with a term-coverage filter (exact names, SKUs)
 * Results are fused with Reciprocal Rank Fusion, gated by relevance thresholds (so the
 * assistant gets nothing rather than something irrelevant) and diversified per document.
 * Without an embedding provider, keyword search alone is used.
 */
export async function searchKnowledge(organizationId: string, query: string, options: { limit?: number } = {}): Promise<RetrievedChunk[]> {
  const limit = options.limit ?? 4;
  const text = query.trim().slice(0, 2000);
  if (!text) return [];
  const terms = queryTerms(text);
  const started = Date.now();

  const [keyword, semantic] = await Promise.all([
    keywordCandidates(organizationId, terms).catch((err) => {
      logger.warn('keyword retrieval failed', { organizationId, err: (err as Error).message });
      return [];
    }),
    embeddingsConfigured()
      ? semanticCandidates(organizationId, text).catch((err) => {
          logger.warn('semantic retrieval failed; keyword only', { organizationId, err: (err as Error).message });
          return [];
        })
      : Promise.resolve([]),
  ]);

  const byId = new Map<string, Candidate>();
  keyword.forEach((k) => byId.set(k.row.id, k.row));
  semantic.forEach((s) => byId.set(s.id, s));
  const fused = fuseRankings([keyword.map((k) => ({ id: k.row.id })), semantic]);
  const maxPossible = 2 / (RRF_K + 1);
  const similarity = new Map(semantic.map((s) => [s.id, s.similarity]));
  const keywordIds = new Set(keyword.map((k) => k.row.id));

  const ranked = Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => {
      const c = byId.get(id)!;
      return {
        chunkId: c.id,
        documentId: c.documentId,
        title: c.title,
        location: c.location,
        pageNumber: c.pageNumber,
        content: c.content,
        score: Math.round((score / maxPossible) * 1000) / 1000,
        similarity: similarity.has(id) ? Math.round(similarity.get(id)! * 1000) / 1000 : null,
        matchedBy: [...(similarity.has(id) ? (['semantic'] as const) : []), ...(keywordIds.has(id) ? (['keyword'] as const) : [])],
      };
    });
  const results = diversify(ranked, limit);

  logger.debug('knowledge retrieval', {
    organizationId,
    keyword: keyword.length,
    semantic: semantic.length,
    results: results.length,
    retrievalMs: Date.now() - started,
  });
  return results;
}

/** Counts how often documents were used in answers (dashboard "most used sources"). */
export async function recordKnowledgeUsage(organizationId: string, documentIds: string[]) {
  const unique = Array.from(new Set(documentIds));
  if (!unique.length) return;
  await prisma.knowledgeDocument.updateMany({
    where: { organizationId, id: { in: unique } },
    data: { usageCount: { increment: 1 } },
  });
}
