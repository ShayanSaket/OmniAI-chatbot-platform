import type { Metadata } from 'next';
import { InboxApp } from '@/components/inbox/inbox-app';
import { DEFAULT_INBOX_FILTERS } from '@/lib/inbox';
import { hasPermission } from '@/lib/permissions';
import { requirePageAuth } from '@/server/auth/session';
import { listInboxConversations, listInboxMembers } from '@/server/modules/inbox/inbox-service';

export const metadata: Metadata = { title: 'Inbox' };

export default async function InboxPage({ searchParams }: { searchParams: { conversation?: string } }) {
  const ctx = await requirePageAuth('inbox:access');
  const [list, members] = await Promise.all([listInboxConversations(ctx, DEFAULT_INBOX_FILTERS), listInboxMembers(ctx)]);
  const selected = typeof searchParams.conversation === 'string' && /^[a-z0-9]{10,40}$/i.test(searchParams.conversation) ? searchParams.conversation : null;
  return (
    <InboxApp
      initialFilters={DEFAULT_INBOX_FILTERS}
      initialList={list}
      initialSelectedId={selected}
      members={members}
      me={{ id: ctx.userId, name: ctx.user.name }}
      canReply={hasPermission(ctx.role, 'conversations:reply')}
      canManage={hasPermission(ctx.role, 'conversations:manage')}
    />
  );
}
