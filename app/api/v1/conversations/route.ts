import { NextResponse } from 'next/server';
import { parseInboxQuery } from '@/lib/inbox';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listInboxConversations } from '@/server/modules/inbox/inbox-service';

/** Inbox list: ?status=open|closed|all&channel=&mode=ai|human|waiting&assignee=me|unassigned&unread=1&q=&cursor= */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('inbox:access');
  return NextResponse.json({ data: await listInboxConversations(ctx, parseInboxQuery(req.nextUrl.searchParams)) });
});
