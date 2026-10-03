import { NextResponse } from 'next/server';
import { knowledgeFaqSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { addKnowledgeFaq } from '@/server/modules/knowledge/knowledge-service';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('knowledge:manage');
  await enforceRateLimit(RATE_LIMITS.knowledgeWrite, ctx.organizationId);
  const input = await parseJson(req, knowledgeFaqSchema);
  return NextResponse.json({ data: await addKnowledgeFaq(ctx, input) }, { status: 201 });
});
