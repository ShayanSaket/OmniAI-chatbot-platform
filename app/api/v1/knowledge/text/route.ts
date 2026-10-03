import { NextResponse } from 'next/server';
import { knowledgeTextSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { addKnowledgeText } from '@/server/modules/knowledge/knowledge-service';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('knowledge:manage');
  await enforceRateLimit(RATE_LIMITS.knowledgeWrite, ctx.organizationId);
  const input = await parseJson(req, knowledgeTextSchema);
  return NextResponse.json({ data: await addKnowledgeText(ctx, input) }, { status: 201 });
});
