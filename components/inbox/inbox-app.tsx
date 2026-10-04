'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MessagesSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ApiError, api } from '@/lib/api-client';
import {
  customerDisplayName,
  inboxQueryString,
  type InboxConversationDetail,
  type InboxConversationItem,
  type InboxCounts,
  type InboxFilters,
  type InboxMember,
  type InboxMessage,
} from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { Composer } from './composer';
import { ConversationList } from './conversation-list';
import { CustomerPanel } from './customer-panel';
import { MessageThread } from './message-thread';
import { ThreadHeader, type ThreadAction } from './thread-header';
import { useInboxEvents, type InboxEvent } from './use-inbox-events';

interface ListResult {
  items: InboxConversationItem[];
  nextCursor: string | null;
  counts: InboxCounts | null;
}

interface Props {
  initialFilters: InboxFilters;
  initialList: ListResult;
  initialSelectedId: string | null;
  members: InboxMember[];
  me: { id: string; name: string | null };
  canReply: boolean;
  canManage: boolean;
}

/** Inserts or replaces messages by id (or clientMessageId for optimistic ones), oldest first. */
function mergeMessages(current: InboxMessage[], incoming: InboxMessage[]): InboxMessage[] {
  const out = current.slice();
  for (const m of incoming) {
    const i = out.findIndex((x) => x.id === m.id || (m.clientMessageId && x.clientMessageId === m.clientMessageId));
    if (i >= 0) out[i] = m;
    else out.push(m);
  }
  return out.sort((a, b) => (a.id.startsWith('tmp-') ? 1 : b.id.startsWith('tmp-') ? -1 : a.createdAt.localeCompare(b.createdAt)));
}

function setUrl(conversationId: string | null) {
  const url = new URL(window.location.href);
  if (conversationId) url.searchParams.set('conversation', conversationId);
  else url.searchParams.delete('conversation');
  window.history.replaceState(window.history.state, '', url);
}

export function InboxApp({ initialFilters, initialList, initialSelectedId, members, me, canReply, canManage }: Props) {
  const [filters, setFilters] = useState(initialFilters);
  const [list, setList] = useState<ListResult>(initialList);
  const [counts, setCounts] = useState<InboxCounts | null>(initialList.counts);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [detail, setDetail] = useState<InboxConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(Boolean(initialSelectedId));
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ThreadAction | 'assign' | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const listSeq = useRef(0);
  const detailSeq = useRef(0);

  // ─── Loading ──────────────────────────────────────────────────────

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    setListLoading(true);
    try {
      const res = await api<{ data: ListResult }>(`/api/v1/conversations?${inboxQueryString(filtersRef.current)}`);
      if (seq !== listSeq.current) return;
      setList(res.data);
      if (res.data.counts) setCounts(res.data.counts);
    } catch {
      /* keep the current list; the next event or reconnect retries */
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, []);

  const markRead = useCallback(async (id: string) => {
    if (document.visibilityState !== 'visible') return;
    setList((l) => ({ ...l, items: l.items.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)) }));
    await api(`/api/v1/conversations/${id}/read`, { method: 'POST' }).catch(() => undefined);
  }, []);

  /** Loads the open conversation; `merge` keeps older pages and optimistic messages. */
  const loadDetail = useCallback(
    async (id: string, merge: boolean) => {
      const seq = ++detailSeq.current;
      if (!merge) {
        setDetailLoading(true);
        setDetailError(null);
      }
      try {
        const res = await api<{ data: InboxConversationDetail }>(`/api/v1/conversations/${id}`);
        if (seq !== detailSeq.current || selectedRef.current !== id) return;
        const fresh = res.data;
        setDetail((prev) => (merge && prev?.id === id ? { ...fresh, messages: mergeMessages(prev.messages, fresh.messages), hasOlder: prev.hasOlder } : fresh));
        if (fresh.unreadCount > 0) void markRead(id);
      } catch (err) {
        if (seq !== detailSeq.current || merge) return;
        setDetail(null);
        setDetailError(err instanceof ApiError && err.status === 404 ? 'This conversation no longer exists.' : 'Could not load the conversation.');
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false);
      }
    },
    [markRead],
  );

  useEffect(() => {
    if (initialSelectedId) void loadDetail(initialSelectedId, false);
  }, [initialSelectedId, loadDetail]);

  const firstFilters = useRef(true);
  useEffect(() => {
    if (firstFilters.current) {
      firstFilters.current = false;
      return;
    }
    void loadList();
  }, [filters, loadList]);

  // Refresh when the tab becomes visible again (e.g. unread state while away).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void loadList();
      if (selectedRef.current) void loadDetail(selectedRef.current, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadList, loadDetail]);

  // ─── Live updates ─────────────────────────────────────────────────

  const listTimer = useRef<ReturnType<typeof setTimeout>>();
  const detailTimer = useRef<ReturnType<typeof setTimeout>>();
  const scheduleList = useCallback(() => {
    clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => void loadList(), 400);
  }, [loadList]);
  const scheduleDetail = useCallback(() => {
    clearTimeout(detailTimer.current);
    detailTimer.current = setTimeout(() => selectedRef.current && void loadDetail(selectedRef.current, true), 200);
  }, [loadDetail]);

  const live = useInboxEvents(
    (e: InboxEvent) => {
      if (e.type === 'notification.created') return;
      if (e.conversationId || e.type.startsWith('conversation') || e.type === 'handoff.requested') scheduleList();
      const open = detailRef.current;
      if (e.conversationId && e.conversationId === selectedRef.current) scheduleDetail();
      else if (open && e.customerId && e.customerId === open.customer.id) scheduleDetail();
    },
    () => {
      void loadList();
      if (selectedRef.current) void loadDetail(selectedRef.current, true);
    },
  );

  // ─── Actions ──────────────────────────────────────────────────────

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setUrl(id);
      setDetailsOpen(false);
      if (detailRef.current?.id !== id) setDetail(null);
      void loadDetail(id, false);
    },
    [loadDetail],
  );

  const onMessage = useCallback((m: InboxMessage) => {
    setDetail((d) => (d ? { ...d, messages: mergeMessages(d.messages, [m]) } : d));
  }, []);

  async function runAction(action: ThreadAction) {
    if (!detail) return;
    setBusy(action);
    try {
      const res = await api<{ data: InboxConversationDetail }>(`/api/v1/conversations/${detail.id}/${action}`, { method: 'POST' });
      setDetail((d) => (d && d.id === res.data.id ? { ...res.data, messages: mergeMessages(d.messages, res.data.messages), hasOlder: d.hasOlder } : d));
      const done = { 'take-over': 'You’re now handling this conversation. The AI has stopped replying.', 'return-to-ai': 'The AI assistant is answering again.', close: 'Conversation closed.', reopen: 'Conversation reopened.' };
      toast.success(done[action]);
      scheduleList();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong.');
      if (err instanceof ApiError && err.code === 'CONFLICT') void loadDetail(detail.id, true);
    } finally {
      setBusy(null);
    }
  }

  async function assign(userId: string | null) {
    if (!detail) return;
    setBusy('assign');
    try {
      const res = await api<{ data: InboxConversationDetail }>(`/api/v1/conversations/${detail.id}/assign`, { method: 'PUT', json: { assigneeId: userId } });
      setDetail((d) => (d && d.id === res.data.id ? { ...res.data, messages: mergeMessages(d.messages, res.data.messages), hasOlder: d.hasOlder } : d));
      const who = members.find((m) => m.id === userId);
      toast.success(userId ? `Assigned to ${userId === me.id ? 'you' : (who?.name ?? who?.email ?? 'team member')}.` : 'Unassigned.');
      scheduleList();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the assignment.');
    } finally {
      setBusy(null);
    }
  }

  async function loadOlder() {
    if (!detail || loadingOlder) return;
    const first = detail.messages.find((m) => !m.id.startsWith('tmp-'));
    if (!first) return;
    setLoadingOlder(true);
    try {
      const res = await api<{ data: { messages: InboxMessage[]; hasOlder: boolean } }>(`/api/v1/conversations/${detail.id}/messages?before=${first.id}`);
      setDetail((d) => (d && d.id === detail.id ? { ...d, messages: mergeMessages(res.data.messages, d.messages), hasOlder: res.data.hasOlder } : d));
    } catch {
      toast.error('Could not load earlier messages.');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function retry(m: InboxMessage) {
    if (!detail) return;
    setRetrying(m.id);
    try {
      const res = await api<{ data: { message: InboxMessage; delivered: boolean } }>(`/api/v1/conversations/${detail.id}/messages/${m.id}/retry`, { method: 'POST' });
      onMessage(res.data.message);
      if (res.data.delivered) toast.success('Message sent.');
      else toast.error(res.data.message.error ?? 'Still not delivered.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Retry failed.');
    } finally {
      setRetrying(null);
    }
  }

  async function loadMore() {
    if (!list.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api<{ data: ListResult }>(`/api/v1/conversations?${inboxQueryString(filtersRef.current, list.nextCursor)}`);
      setList((l) => ({ ...l, items: [...l.items, ...res.data.items.filter((i) => !l.items.some((x) => x.id === i.id))], nextCursor: res.data.nextCursor }));
    } catch {
      toast.error('Could not load more conversations.');
    } finally {
      setLoadingMore(false);
    }
  }

  // ─── Layout ───────────────────────────────────────────────────────

  const panel = detail && (
    <CustomerPanel
      conversation={detail}
      canReply={canReply}
      meId={me.id}
      onSelectConversation={select}
      onChange={(patch) => setDetail((d) => (d ? { ...d, ...patch } : d))}
    />
  );

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-4rem)] overflow-hidden border-b bg-background sm:-mx-6 lg:-mx-8 lg:-my-8 lg:border-x">
      <h1 className="sr-only">Inbox</h1>
      {/* Conversation list */}
      <aside className={cn('w-full shrink-0 flex-col border-e md:flex md:w-[320px] lg:w-[340px]', selectedId ? 'hidden' : 'flex')} aria-label="Conversation list">
        <div className="flex items-center justify-between px-3 pt-3">
          <p className="text-base font-semibold">Inbox</p>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" title={live ? 'Live updates on' : 'Reconnecting…'}>
            <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-amber-500')} />
            {live ? 'Live' : 'Connecting'}
          </span>
        </div>
        <ConversationList
          items={list.items}
          counts={counts}
          filters={filters}
          onFiltersChange={setFilters}
          selectedId={selectedId}
          onSelect={select}
          loading={listLoading}
          hasMore={Boolean(list.nextCursor)}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          meId={me.id}
        />
      </aside>

      {/* Thread */}
      <section className={cn('min-w-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden md:flex')} aria-label="Conversation">
        {!selectedId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <MessagesSquare className="h-10 w-10 text-muted-foreground/50" />
            <p className="font-medium">Select a conversation</p>
            <p className="max-w-xs text-sm text-muted-foreground">Website and WhatsApp conversations arrive here in real time. Take over from the AI at any moment.</p>
          </div>
        ) : detailLoading && !detail ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !detail ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            {detailError ?? 'Conversation not found.'}
            <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => (setSelectedId(null), setUrl(null))}>
              Back to the list
            </button>
          </div>
        ) : (
          <>
            <ThreadHeader
              conversation={detail}
              members={members}
              meId={me.id}
              canReply={canReply}
              canManage={canManage}
              busy={busy}
              onAction={(a) => void runAction(a)}
              onAssign={(u) => void assign(u)}
              onBack={() => (setSelectedId(null), setUrl(null), setDetail(null))}
              onToggleDetails={() => setDetailsOpen(true)}
            />
            <MessageThread
              messages={detail.messages}
              customerName={customerDisplayName(detail.customer)}
              hasOlder={detail.hasOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder()}
              onRetry={(m) => void retry(m)}
              retrying={retrying}
            />
            <Composer key={detail.id} conversation={detail} canReply={canReply} onMessage={onMessage} onReopen={() => void runAction('reopen')} busy={busy !== null} meName={me.name} />
          </>
        )}
      </section>

      {/* Customer details: side panel on wide screens, sheet otherwise */}
      {detail && <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-s scrollbar-thin xl:block" aria-label="Customer details">{panel}</aside>}
      <Sheet open={detailsOpen && Boolean(detail)} onOpenChange={setDetailsOpen}>
        <SheetContent side="right" className="w-[320px] overflow-y-auto p-0 sm:max-w-[360px]">
          <SheetTitle className="sr-only">Customer details</SheetTitle>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
