'use client';

import { useEffect, useState } from 'react';
import { Inbox, Loader2, Search, UserRound } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { customerDisplayName, type InboxConversationItem, type InboxCounts, type InboxFilters } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { ChannelIcon, CustomerAvatar, shortTime, StatusPill, useNow } from './shared';

interface Props {
  items: InboxConversationItem[];
  counts: InboxCounts | null;
  filters: InboxFilters;
  onFiltersChange: (next: InboxFilters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  meId: string;
}

function Chip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: React.ReactNode; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className={cn('rounded-full px-1.5 text-[10px] leading-4', active ? 'bg-primary-foreground/20' : 'bg-muted-foreground/15')}>{count > 99 ? '99+' : count}</span>
      )}
    </button>
  );
}

const STATUS_TABS: { value: InboxFilters['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export function ConversationList(props: Props) {
  const { filters, onFiltersChange: set, counts } = props;
  const now = useNow();
  const [query, setQuery] = useState(filters.q);

  // Search as you type (debounced).
  useEffect(() => {
    if (query === filters.q) return;
    const t = setTimeout(() => set({ ...filters, q: query.trim() }), 300);
    return () => clearTimeout(t);
  }, [query, filters, set]);

  const toggle = <K extends keyof InboxFilters>(key: K, value: InboxFilters[K], off: InboxFilters[K]) =>
    set({ ...filters, [key]: filters[key] === value ? off : value });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b p-3">
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Conversation status" className="inline-flex rounded-md bg-muted p-0.5">
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                role="tab"
                type="button"
                aria-selected={filters.status === t.value}
                onClick={() => set({ ...filters, status: t.value })}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  filters.status === t.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {t.value === 'open' && counts ? <span className="ms-1 text-muted-foreground">{counts.open}</span> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, phone, message…"
            aria-label="Search conversations"
            className="h-9 ps-8"
          />
        </div>
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 scrollbar-thin" aria-label="Filters">
          <Chip active={filters.mode === 'waiting'} onClick={() => toggle('mode', 'waiting', 'any')} count={counts?.waiting}>
            Waiting
          </Chip>
          <Chip active={filters.assignee === 'me'} onClick={() => toggle('assignee', 'me', 'anyone')} count={counts?.mine}>
            Mine
          </Chip>
          <Chip active={filters.unread} onClick={() => set({ ...filters, unread: !filters.unread })} count={counts?.unread}>
            Unread
          </Chip>
          <Chip active={filters.channel === 'WEBSITE'} onClick={() => toggle('channel', 'WEBSITE', 'all')}>
            Website
          </Chip>
          <Chip active={filters.channel === 'WHATSAPP'} onClick={() => toggle('channel', 'WHATSAPP', 'all')}>
            WhatsApp
          </Chip>
          <Chip active={filters.mode === 'ai'} onClick={() => toggle('mode', 'ai', 'any')}>
            AI
          </Chip>
          <Chip active={filters.mode === 'human'} onClick={() => toggle('mode', 'human', 'any')}>
            Human
          </Chip>
          <Chip active={filters.assignee === 'unassigned'} onClick={() => toggle('assignee', 'unassigned', 'anyone')}>
            Unassigned
          </Chip>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin" aria-busy={props.loading}>
        {props.loading && (
          <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary/70" />
        )}
        {props.items.length === 0 && !props.loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">No conversations</p>
            <p className="text-xs text-muted-foreground">
              {filters.q || filters.unread || filters.mode !== 'any' || filters.channel !== 'all' || filters.assignee !== 'anyone'
                ? 'Nothing matches these filters.'
                : 'New website and WhatsApp conversations will appear here.'}
            </p>
          </div>
        ) : (
          <ul role="listbox" aria-label="Conversations">
            {props.items.map((c) => {
              const name = customerDisplayName(c.customer);
              const selected = c.id === props.selectedId;
              const unread = c.unreadCount > 0;
              return (
                <li key={c.id} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => props.onSelect(c.id)}
                    className={cn(
                      'flex w-full gap-3 border-b border-border/60 px-3 py-3 text-start transition-colors',
                      selected ? 'bg-primary/[0.07]' : 'hover:bg-muted/60',
                      c.status === 'WAITING_FOR_AGENT' && !selected && 'bg-amber-500/[0.06]',
                    )}
                  >
                    <div className="relative">
                      <CustomerAvatar customer={c.customer} size={40} />
                      <span className="absolute -bottom-0.5 -end-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-background ring-1 ring-border">
                        <ChannelIcon channel={c.channel} className="h-3 w-3" />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>{name}</p>
                        <time dateTime={c.lastMessageAt} className={cn('shrink-0 text-[11px]', unread ? 'font-medium text-primary' : 'text-muted-foreground')} suppressHydrationWarning>
                          {shortTime(c.lastMessageAt, now)}
                        </time>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <p className={cn('min-w-0 flex-1 truncate text-[13px]', unread ? 'text-foreground' : 'text-muted-foreground')} dir="auto">
                          {c.lastMessagePreview || 'No messages yet'}
                        </p>
                        {unread && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" aria-label={`${c.unreadCount} unread`}>
                            {c.unreadCount > 99 ? '99+' : c.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <StatusPill status={c.status} />
                        {c.intent && c.intent !== 'OTHER' && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] leading-none text-muted-foreground">{c.intent.charAt(0) + c.intent.slice(1).toLowerCase()}</span>
                        )}
                        {c.leadTemperature === 'HOT' && <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] leading-none text-rose-700 dark:text-rose-300">Hot lead</span>}
                        {c.assignedTo && (
                          <span className="ms-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground" title={`Assigned to ${c.assignedTo.name ?? 'a team member'}`}>
                            <UserRound className="h-3 w-3 shrink-0" />
                            <span className="truncate">{c.assignedTo.id === props.meId ? 'You' : (c.assignedTo.name ?? 'Assigned')}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {props.hasMore && (
          <div className="p-3">
            <button
              type="button"
              onClick={props.onLoadMore}
              disabled={props.loadingMore}
              className="flex w-full items-center justify-center gap-2 rounded-md border py-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-60"
            >
              {props.loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
