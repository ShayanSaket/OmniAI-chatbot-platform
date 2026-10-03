import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Prisma cannot model these hand-written indexes (pgvector HNSW, full-text expression
// index), so `prisma migrate dev` will try to drop them in every newly generated
// migration. This guard fails the build if a migration drops one without recreating it.
// Fix: delete the generated DROP INDEX line.
const MANUAL_INDEXES = ['KnowledgeChunk_embedding_hnsw_idx', 'KnowledgeChunk_content_fts_idx'];
const dir = path.resolve(__dirname, '../../prisma/migrations');

describe('migrations', () => {
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const all = migrations.map((m) => readFileSync(path.join(dir, m, 'migration.sql'), 'utf8')).join('\n');

  it('create the pgvector extension and the hand-written indexes', () => {
    expect(all).toMatch(/CREATE EXTENSION IF NOT EXISTS "?vector"?/);
    for (const index of MANUAL_INDEXES) expect(all).toContain(index);
  });

  it.each(MANUAL_INDEXES)('never leave %s dropped', (index) => {
    let present = false;
    for (const m of migrations) {
      const sql = readFileSync(path.join(dir, m, 'migration.sql'), 'utf8');
      const dropAt = sql.search(new RegExp(`DROP INDEX[^;]*${index}`));
      const createAt = sql.search(new RegExp(`CREATE INDEX[^;]*${index}`));
      if (createAt >= 0 && (dropAt < 0 || createAt > dropAt)) present = true;
      else if (dropAt >= 0) present = false;
    }
    expect(present, `A migration drops ${index} without recreating it — remove the generated DROP INDEX line.`).toBe(true);
  });
});
