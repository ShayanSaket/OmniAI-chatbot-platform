import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { reindexKnowledgeDocument } from '@/server/modules/knowledge/knowledge-service';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';

type Params = { documentId: string };

/** Re-extract and re-embed (web pages are fetched again). */
export const POST = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('knowledge:manage');
  await enforceRateLimit(RATE_LIMITS.knowledgeWrite, ctx.organizationId);
  return NextResponse.json({ data: await reindexKnowledgeDocument(ctx, params.documentId) });
});
