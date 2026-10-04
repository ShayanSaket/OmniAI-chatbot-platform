import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { retryMessage } from '@/server/modules/inbox/inbox-service';

/** Retries a failed outgoing message. */
export const POST = route<{ conversationId: string; messageId: string }>(async (_req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  await enforceRateLimit(RATE_LIMITS.inboxReply, ctx.userId);
  return NextResponse.json({ data: await retryMessage(ctx, params.conversationId, params.messageId) });
});
