import { NextResponse } from 'next/server';
import { agentReplySchema } from '@/lib/inbox';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { listConversationMessages, sendAgentReply } from '@/server/modules/inbox/inbox-service';

type Params = { conversationId: string };

/** ?before=<messageId> (older page) or ?after=<messageId> (catch up). */
export const GET = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('inbox:access');
  const p = req.nextUrl.searchParams;
  return NextResponse.json({
    data: await listConversationMessages(ctx, params.conversationId, { before: p.get('before') ?? undefined, after: p.get('after') ?? undefined }),
  });
});

/** A team member's reply, delivered on the conversation's own channel. */
export const POST = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  await enforceRateLimit(RATE_LIMITS.inboxReply, ctx.userId);
  const input = await parseJson(req, agentReplySchema);
  const result = await sendAgentReply(ctx, params.conversationId, input);
  return NextResponse.json({ data: result }, { status: result.duplicate ? 200 : 201 });
});
