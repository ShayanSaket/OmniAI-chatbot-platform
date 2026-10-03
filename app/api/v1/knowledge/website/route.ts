import { NextResponse } from 'next/server';
import { knowledgeWebsiteSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { addKnowledgeWebsite } from '@/server/modules/knowledge/knowledge-service';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('knowledge:manage');
  await enforceRateLimit(RATE_LIMITS.knowledgeWrite, ctx.organizationId);
  const input = await parseJson(req, knowledgeWebsiteSchema);
  return NextResponse.json({ data: await addKnowledgeWebsite(ctx, input) }, { status: 201 });
});
