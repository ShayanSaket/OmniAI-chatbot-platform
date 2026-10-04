import { NextResponse } from 'next/server';
import { assignSchema } from '@/lib/inbox';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { assignConversation } from '@/server/modules/inbox/inbox-service';

/** { assigneeId: string | null } — agents may only assign themselves. */
export const PUT = route<{ conversationId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  const input = await parseJson(req, assignSchema);
  return NextResponse.json({ data: await assignConversation(ctx, params.conversationId, input.assigneeId) });
});
