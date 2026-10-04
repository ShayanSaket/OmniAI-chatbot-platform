'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Search, Users } from 'lucide-react';
import { ChannelIcon, CustomerAvatar, shortTime, useNow } from '@/components/inbox/shared';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { customerQueryString, type CustomerFilters, type CustomerListItem, type TagItem } from '@/lib/customers';
import { formatNumber } from '@/lib/format';
import { customerDisplayName } from '@/lib/inbox';
import { cn } from '@/lib/utils';

interface Page {
  items: CustomerListItem[];
  nextCursor: string | null;
  total: number | null;
}

interface Props {
  initial: Page;
  initialFilters: CustomerFilters;
  tags: TagItem[];
}

export function CustomersTable({ initial, initialFilters, tags }: Props) {
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(initial);
  const [total, setTotal] = useState(initial.total ?? 0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState(initialFilters.q);
  const now = useNow();
  const router = useRouter();
  const seq = useRef(0);
  const first = useRef(true);

  const load = useCallback(async (f: CustomerFilters) => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const res = await api<{ data: Page }>(`/api/v1/customers?${customerQueryString(f)}`);
      if (id !== seq.current) return;
      setPage(res.data);
      setTotal(res.data.total ?? 0);
      const qs = customerQueryString(f);
      window.history.replaceState(window.history.state, '', qs ? `/customers?${qs}` : '/customers');
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(filters);
  }, [filters, load]);

  useEffect(() => {
    if (query.trim() === filters.q) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: query.trim() })), 300);
    return () => clearTimeout(t);
  }, [query, filters.q]);

  async function loadMore() {
    if (!page.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api<{ data: Page }>(`/api/v1/customers?${customerQueryString(filters, page.nextCursor)}`);
      setPage((p) => ({ ...res.data, items: [...p.items, ...res.data.items] }));
    } finally {
      setLoadingMore(false);
    }
  }

  const set = <K extends keyof CustomerFilters>(key: K, value: CustomerFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:max-w-sm lg:flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, email, phone, company…" aria-label="Search customers" className="ps-8" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Select value={filters.type} onValueChange={(v) => set('type', v as CustomerFilters['type'])}>
            <SelectTrigger className="sm:w-[150px]" aria-label="Customer type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All customers</SelectItem>
              <SelectItem value="identified">Identified</SelectItem>
              <SelectItem value="anonymous">Anonymous</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.channel} onValueChange={(v) => set('channel', v as CustomerFilters['channel'])}>
            <SelectTrigger className="sm:w-[140px]" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              <SelectItem value="WEBSITE">Website</SelectItem>
              <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.tag || 'any'} onValueChange={(v) => set('tag', v === 'any' ? '' : v)}>
            <SelectTrigger className="sm:w-[150px]" aria-label="Tag">
              <SelectValue placeholder="Any tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any tag</SelectItem>
              {tags.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                    {t.name}
                    <span className="text-muted-foreground">{t.customerCount}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.sort} onValueChange={(v) => set('sort', v as CustomerFilters['sort'])}>
            <SelectTrigger className="sm:w-[160px]" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recently active</SelectItem>
              <SelectItem value="created">Newest first</SelectItem>
              <SelectItem value="name">Name A–Z</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground lg:ms-auto" aria-live="polite">
          {loading ? <Loader2 className="inline h-4 w-4 animate-spin" /> : `${formatNumber(total)} ${total === 1 ? 'customer' : 'customers'}`}
        </p>
      </div>

      <div className={cn('overflow-hidden rounded-lg border bg-card transition-opacity', loading && 'opacity-60')}>
        {page.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <Users className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">No customers found</p>
            <p className="text-xs text-muted-foreground">Customers appear here when they chat on your website or WhatsApp.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="hidden border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground md:table-header-group">
              <tr>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Channels</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Tags</th>
                <th className="px-4 py-2.5 text-right font-medium">Conversations</th>
                <th className="px-4 py-2.5 text-right font-medium">Open leads</th>
                <th className="px-4 py-2.5 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((c) => (
                <tr
                  key={c.id}
                  onClick={(e) => !(e.target as HTMLElement).closest('a') && router.push(`/customers/${c.id}`)}
                  className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <CustomerAvatar customer={c} size={36} />
                      <div className="min-w-0">
                        <Link href={`/customers/${c.id}`} className="block truncate font-medium hover:underline" dir="auto">
                          {customerDisplayName(c)}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.isAnonymous ? 'Anonymous visitor' : [c.email, c.phone, c.company].filter(Boolean).join(' · ') || 'No contact details'}
                        </p>
                        {/* Compact meta on phones */}
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground md:hidden">
                          {c.channels.map((ch) => (
                            <ChannelIcon key={ch} channel={ch} className="h-3 w-3" />
                          ))}
                          <span>
                            {c.conversationCount} conv. · <span suppressHydrationWarning>{c.lastSeenAt ? shortTime(c.lastSeenAt, now) : '—'}</span>
                          </span>
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <div className="flex items-center gap-1.5">
                      {c.channels.map((ch) => (
                        <ChannelIcon key={ch} channel={ch} className="h-4 w-4" />
                      ))}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 3).map((t) => (
                        <span key={t.id} className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${t.color}22`, color: t.color }}>
                          {t.name}
                        </span>
                      ))}
                      {c.tags.length > 3 && <span className="text-[11px] text-muted-foreground">+{c.tags.length - 3}</span>}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">{c.conversationCount}</td>
                  <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">{c.openLeadCount || <span className="text-muted-foreground">—</span>}</td>
                  <td className="hidden px-4 py-3 text-right text-muted-foreground md:table-cell" suppressHydrationWarning>
                    {c.lastSeenAt ? shortTime(c.lastSeenAt, now) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {page.nextCursor && (
        <div className="flex justify-center">
          <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm text-muted-foreground hover:bg-muted">
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
