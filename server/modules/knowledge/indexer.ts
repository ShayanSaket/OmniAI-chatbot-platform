import 'server-only';
import type { TenantDb } from '../../tenancy/tenant-db';
import { processDocument } from './ingest';

/**
 * (Re)processes a document synchronously: chunks, embeddings, READY. The document must
 * belong to the given tenant. Used by tests and admin re-index; uploads use the
 * background path (knowledge-service.ts).
 */
export async function indexDocumentText(db: TenantDb, documentId: string) {
  await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: 'PENDING' } });
  const result = await processDocument(documentId);
  const doc = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId }, select: { chunkCount: true } });
  return { result, chunkCount: doc.chunkCount };
}
