import { NextResponse } from 'next/server';
import { suggestionSchema } from '@/lib/inbox';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { suggestReply } from '@/server/modules/inbox/suggestions';

/** AI draft for the composer (generate, shorten, friendlier, professional, translate). Never sends. */
export const POST = route<{ conversationId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  await enforceRateLimit(RATE_LIMITS.inboxSuggestion, ctx.userId);
  const input = await parseJson(req, suggestionSchema);
  return NextResponse.json({ data: await suggestReply(ctx, params.conversationId, input) });
});
