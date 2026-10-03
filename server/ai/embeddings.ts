import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import { ProviderError, ProviderNotConfiguredError } from './provider';

// Embeddings (OpenAI-compatible /embeddings) with a content-hash cache.
//
// The vector column is vector(1536). text-embedding-3-* models are asked for 1536
// dimensions explicitly (so text-embedding-3-large also fits); any other model must
// natively return 1536 dimensions or the call fails with a clear error.

export const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 64;
/** Inputs are cut to stay well inside the model's 8k-token limit. */
const MAX_INPUT_CHARS = 24_000;
const TIMEOUT_MS = 60_000;

export const embeddingModel = () => env().OPENAI_EMBEDDING_MODEL;
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

export function embeddingsConfigured(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}

async function requestEmbeddings(model: string, inputs: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const e = env();
  if (!e.OPENAI_API_KEY) throw new ProviderNotConfiguredError();
  const body = {
    model,
    input: inputs.map((t) => t.slice(0, MAX_INPUT_CHARS)),
    ...(model.startsWith('text-embedding-3') ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
  };
  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${e.OPENAI_BASE_URL.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = new ProviderError(`Embedding request failed: ${(err as Error).message}`, undefined, true);
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    if (res.ok) {
      const data = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
      const vectors = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (vectors.length !== inputs.length) throw new ProviderError('Embedding response does not match the input count');
      const wrong = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
      if (wrong) {
        throw new ProviderError(`Embedding model "${model}" returned ${wrong.length} dimensions; ${EMBEDDING_DIMENSIONS} are required.`);
      }
      return { vectors, tokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0 };
    }
    lastError = new ProviderError(`Embedding provider responded with ${res.status}`, res.status, res.status === 429 || res.status >= 500);
    await res.body?.cancel().catch(() => undefined);
    if (!lastError.retryable) break;
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw lastError!;
}

export const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

/**
 * Embeds texts, reusing cached vectors for identical text. Returns vectors in input
 * order and the tokens actually billed (cache hits are free).
 */
export async function embedTexts(texts: string[], model = embeddingModel()): Promise<{ vectors: number[][]; tokens: number; cacheHits: number }> {
  if (!texts.length) return { vectors: [], tokens: 0, cacheHits: 0 };
  const hashes = texts.map(hashText);
  const unique = Array.from(new Set(hashes));
  const cached = new Map<string, number[]>();
  const rows = await prisma.$queryRaw<{ contentHash: string; embedding: string }[]>`
    SELECT "contentHash", "embedding"::text AS "embedding" FROM "EmbeddingCache"
    WHERE "model" = ${model} AND "contentHash" IN (${Prisma.join(unique)})`;
  for (const row of rows) cached.set(row.contentHash, JSON.parse(row.embedding) as number[]);

  const missing = unique.filter((h) => !cached.has(h));
  let tokens = 0;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((h) => texts[hashes.indexOf(h)]!);
    const result = await requestEmbeddings(model, inputs);
    tokens += result.tokens;
    for (let j = 0; j < batch.length; j++) {
      cached.set(batch[j]!, result.vectors[j]!);
      await prisma.$executeRaw`
        INSERT INTO "EmbeddingCache" ("id", "model", "contentHash", "embedding", "createdAt")
        VALUES (${`emb_${batch[j]!.slice(0, 24)}_${Date.now().toString(36)}${j}`}, ${model}, ${batch[j]!}, ${toVectorLiteral(result.vectors[j]!)}::vector, now())
        ON CONFLICT ("model", "contentHash") DO NOTHING`;
    }
  }
  if (missing.length) logger.debug('embeddings computed', { model, requested: texts.length, computed: missing.length, cacheHits: unique.length - missing.length });
  return { vectors: hashes.map((h) => cached.get(h)!), tokens, cacheHits: unique.length - missing.length };
}
