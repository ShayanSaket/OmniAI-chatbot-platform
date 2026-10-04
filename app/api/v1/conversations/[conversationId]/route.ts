import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { deleteConversation } from '@/server/modules/customers/customer-service';
import { getInboxConversation } from '@/server/modules/inbox/inbox-service';

/** Conversation with messages, customer profile, summary, leads, tickets and notes. */
export const GET = route<{ conversationId: string }>(async (_req, { params }) => {
  const ctx = await requireApiAuth('inbox:access');
  return NextResponse.json({ data: await getInboxConversation(ctx, params.conversationId) });
});

/** Deletes the conversation, its messages and attachments (GDPR). */
export const DELETE = route<{ conversationId: string }>(async (_req, { params }) => {
  const ctx = await requireApiAuth('customers:delete');
  return NextResponse.json({ data: await deleteConversation(ctx, params.conversationId) });
});
