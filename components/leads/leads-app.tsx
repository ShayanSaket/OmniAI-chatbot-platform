'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Download, KanbanSquare, List, Loader2, Plus, Search, Target, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { ChannelIcon } from '@/components/inbox/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api } from '@/lib/api-client';
import { formatNumber, humanize } from '@/lib/format';
import type { InboxMember } from '@/lib/inbox';
import { LEAD_STATUS_INFO, LEAD_STATUSES, leadQueryString, type LeadFilters, type LeadItem, type LeadStats } from '@/lib/leads';
import type { LeadStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { EMPTY_LEAD, LeadForm, leadPayload, type LeadFormValues } from './lead-form';
import { LeadSheet } from './lead-sheet';

interface Column {
  status: LeadStatus;
  count: number;
  value: number;
  items: LeadItem[];
}

interface Props {
  initialBoard: Column[];
  initialStats: LeadStats;
  initialLeadId: string | null;
  members: InboxMember[];
  currency: string;
  canManage: boolean;
  canInbox: boolean;
  meId: string;
}

const TEMP_STYLE: Record<string, string> = {
  HOT: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  WARM: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  COLD: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

function setLeadParam(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('lead', id);
  else url.searchParams.delete('lead');
  window.history.replaceState(window.history.state, '', url);
}

export function LeadsApp({ initialBoard, initialStats, initialLeadId, members, currency, canManage, canInbox, meId }: Props) {
  const money = useCallback((n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n), [currency]);
  const [view, setView] = useState<'board' | 'table'>('board');
  const [filters, setFilters] = useState<LeadFilters>({ q: '', status: 'all', temperature: 'all', source: 'all', assignee: 'anyone' });
  const [query, setQuery] = useState('');
  const [board, setBoard] = useState(initialBoard);
  const [stats, setStats] = useState(initialStats);
  const [rows, setRows] = useState<LeadItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialLeadId);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<LeadStatus | null>(null);
  const seq = useRef(0);
  const first = useRef(true);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      if (view === 'board') {
        const res = await api<{ data: { columns: Column[]; stats: LeadStats } }>(`/api/v1/leads?view=board&${leadQueryString(filters)}`);
        if (id !== seq.current) return;
        setBoard(res.data.columns);
        setStats(res.data.stats);
      } else {
        const res = await api<{ data: { items: LeadItem[]; nextCursor: string | null; stats: LeadStats } }>(`/api/v1/leads?${leadQueryString(filters)}`);
        if (id !== seq.current) return;
        setRows(res.data.items);
        setNextCursor(res.data.nextCursor);
        setStats(res.data.stats);
      }
    } catch {
      toast.error('Could not load leads.');
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [view, filters]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load();
  }, [load]);

  useEffect(() => {
    if (query.trim() === filters.q) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: query.trim() })), 300);
    return () => clearTimeout(t);
  }, [query, filters.q]);

  const open = (id: string | null) => {
    setOpenId(id);
    setLeadParam(id);
  };

  /** Moves a card to another stage (optimistic). */
  async function move(lead: LeadItem, status: LeadStatus) {
    if (lead.status === status || !canManage) return;
    const before = board;
    setBoard((cols) =>
      cols.map((c) =>
        c.status === lead.status
          ? { ...c, count: c.count - 1, value: c.value - (lead.estimatedValue ?? 0), items: c.items.filter((i) => i.id !== lead.id) }
          : c.status === status
            ? { ...c, count: c.count + 1, value: c.value + (lead.estimatedValue ?? 0), items: [{ ...lead, status }, ...c.items] }
            : c,
      ),
    );
    try {
      await api(`/api/v1/leads/${lead.id}`, { method: 'PATCH', json: { status } });
      toast.success(`${lead.name ?? lead.reference} moved to ${LEAD_STATUS_INFO[status].label}.`);
      void load();
    } catch (err) {
      setBoard(before);
      toast.error(err instanceof ApiError ? err.message : 'Could not move the lead.');
    }
  }

  const findLead = (id: string) => board.flatMap((c) => c.items).find((l) => l.id === id);
  const set = <K extends keyof LeadFilters>(key: K, value: LeadFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open leads" value={formatNumber(stats.open)} hint={`${stats.newThisWeek} new in the last 7 days`} />
        <Stat label="Pipeline value" value={money(stats.pipelineValue)} hint="Estimated value of open leads" />
        <Stat label="Win rate (90 days)" value={stats.winRate === null ? '—' : `${stats.winRate}%`} hint="Won ÷ (won + lost)" />
        <Stat label="Won" value={money(stats.wonValue)} hint={`${stats.byStatus.WON} won · conversion ${stats.conversionRate === null ? '—' : `${stats.conversionRate}%`}`} />
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="inline-flex w-fit rounded-md bg-muted p-0.5" role="tablist" aria-label="View">
          {(['board', 'table'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              type="button"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn('inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium', view === v ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {v === 'board' ? <KanbanSquare className="h-4 w-4" /> : <List className="h-4 w-4" />}
              {v === 'board' ? 'Pipeline' : 'List'}
            </button>
          ))}
        </div>
        <div className="relative lg:max-w-xs lg:flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads…" aria-label="Search leads" className="ps-8" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {view === 'table' && (
            <Select value={filters.status} onValueChange={(v) => set('status', v as LeadFilters['status'])}>
              <SelectTrigger className="sm:w-[140px]" aria-label="Stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                {LEAD_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_STATUS_INFO[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={filters.temperature} onValueChange={(v) => set('temperature', v as LeadFilters['temperature'])}>
            <SelectTrigger className="sm:w-[170px]" aria-label="Temperature">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any temperature</SelectItem>
              <SelectItem value="HOT">Hot</SelectItem>
              <SelectItem value="WARM">Warm</SelectItem>
              <SelectItem value="COLD">Cold</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.source} onValueChange={(v) => set('source', v as LeadFilters['source'])}>
            <SelectTrigger className="sm:w-[140px]" aria-label="Source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="WEBSITE">Website chat</SelectItem>
              <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
              <SelectItem value="MANUAL">Added by team</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.assignee} onValueChange={(v) => set('assignee', v as LeadFilters['assignee'])}>
            <SelectTrigger className="sm:w-[140px]" aria-label="Owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anyone">Any owner</SelectItem>
              <SelectItem value="me">My leads</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2 lg:ms-auto">
          {loading && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/leads/export?${leadQueryString(filters)}`} download>
              <Download className="me-1.5 h-4 w-4" /> Export CSV
            </a>
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="me-1.5 h-4 w-4" /> New lead
            </Button>
          )}
        </div>
      </div>

      {view === 'board' ? (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="grid min-w-[1180px] grid-cols-6 gap-3" aria-label="Lead pipeline">
            {board.map((col) => (
              <section
                key={col.status}
                aria-label={`${LEAD_STATUS_INFO[col.status].label}: ${col.count} leads`}
                onDragOver={(e) => {
                  if (!dragging || !canManage) return;
                  e.preventDefault();
                  setDropTarget(col.status);
                }}
                onDragLeave={() => setDropTarget((t) => (t === col.status ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  const lead = dragging ? findLead(dragging) : undefined;
                  setDragging(null);
                  setDropTarget(null);
                  if (lead) void move(lead, col.status);
                }}
                className={cn('flex min-h-[320px] flex-col rounded-lg bg-muted/40 p-2 transition-colors', dropTarget === col.status && 'bg-primary/10 ring-2 ring-primary/40')}
              >
                <header className="mb-2 px-1.5 pt-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', LEAD_STATUS_INFO[col.status].dot)} />
                    <h2 className="text-sm font-semibold">{LEAD_STATUS_INFO[col.status].label}</h2>
                    <span className="ms-auto text-xs text-muted-foreground">{col.count}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{col.value ? money(col.value) : LEAD_STATUS_INFO[col.status].description}</p>
                </header>
                <ul className="flex-1 space-y-2">
                  {col.items.map((l) => (
                    <li
                      key={l.id}
                      draggable={canManage}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', l.id);
                        setDragging(l.id);
                      }}
                      onDragEnd={() => (setDragging(null), setDropTarget(null))}
                      className={cn(dragging === l.id && 'opacity-40')}
                    >
                      <LeadCard lead={l} money={money} meId={meId} onOpen={() => open(l.id)} />
                    </li>
                  ))}
                  {col.items.length === 0 && <li className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">No leads</li>}
                  {col.count > col.items.length && <li className="px-1 text-center text-xs text-muted-foreground">+{col.count - col.items.length} more in the list view</li>}
                </ul>
              </section>
            ))}
          </div>
          {canManage && <p className="mt-2 text-xs text-muted-foreground">Drag cards between stages, or open a lead to change its stage.</p>}
        </div>
      ) : (
        <LeadTable rows={rows} money={money} onOpen={open} nextCursor={nextCursor} filters={filters} onMore={(items, cursor) => (setRows((r) => [...r, ...items]), setNextCursor(cursor))} />
      )}

      <LeadSheet
        leadId={openId}
        onClose={() => open(null)}
        onChanged={() => void load()}
        members={members}
        currency={currency}
        canManage={canManage}
        canInbox={canInbox}
      />
      {canManage && <CreateLeadDialog open={creating} onOpenChange={setCreating} members={members} currency={currency} onCreated={(l) => (void load(), open(l.id))} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function LeadCard({ lead: l, money, meId, onOpen }: { lead: LeadItem; money: (n: number) => string; meId: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-md border bg-card p-3 text-start shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">
          {l.name ?? l.company ?? l.email ?? l.reference}
        </p>
        {l.source ? <ChannelIcon channel={l.source} className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
      </div>
      {l.company && l.name && <p className="truncate text-xs text-muted-foreground">{l.company}</p>}
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" dir="auto">
        {l.requestedService ?? 'General interest'}
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', TEMP_STYLE[l.temperature])}>{humanize(l.temperature)}</span>
        {l.estimatedValue !== null && <span className="text-[11px] font-medium tabular-nums">{money(l.estimatedValue)}</span>}
        {l.assignedTo && (
          <span className="ms-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground" title={`Owner: ${l.assignedTo.name ?? ''}`}>
            <UserRound className="h-3 w-3 shrink-0" />
            <span className="truncate">{l.assignedTo.id === meId ? 'You' : (l.assignedTo.name?.split(' ')[0] ?? '')}</span>
          </span>
        )}
      </div>
      {l.status === 'LOST' && l.lostReason && <p className="mt-1.5 truncate text-[11px] text-muted-foreground">Lost: {l.lostReason}</p>}
    </button>
  );
}

function LeadTable({
  rows,
  money,
  onOpen,
  nextCursor,
  filters,
  onMore,
}: {
  rows: LeadItem[];
  money: (n: number) => string;
  onOpen: (id: string) => void;
  nextCursor: string | null;
  filters: LeadFilters;
  onMore: (items: LeadItem[], cursor: string | null) => void;
}) {
  const [loading, setLoading] = useState(false);
  async function more() {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const res = await api<{ data: { items: LeadItem[]; nextCursor: string | null } }>(`/api/v1/leads?${leadQueryString(filters, nextCursor)}`);
      onMore(res.data.items, res.data.nextCursor);
    } finally {
      setLoading(false);
    }
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border px-6 py-16 text-center">
        <Target className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium">No leads match</p>
        <p className="text-xs text-muted-foreground">The AI creates leads when customers show buying interest. You can also add them yourself.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Lead</th>
              <th className="px-4 py-2.5 font-medium">Interested in</th>
              <th className="px-4 py-2.5 font-medium">Stage</th>
              <th className="px-4 py-2.5 font-medium">Temp.</th>
              <th className="px-4 py-2.5 text-right font-medium">Value</th>
              <th className="px-4 py-2.5 font-medium">Owner</th>
              <th className="px-4 py-2.5 text-right font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} onClick={() => onOpen(l.id)} className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40">
                <td className="px-4 py-3">
                  <button type="button" onClick={() => onOpen(l.id)} className="text-start font-medium hover:underline" dir="auto">
                    {l.name ?? l.company ?? l.email ?? l.reference}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {l.reference} · {[l.email, l.phone].filter(Boolean).join(' · ')}
                  </p>
                </td>
                <td className="max-w-[220px] truncate px-4 py-3" dir="auto">
                  {l.requestedService ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', LEAD_STATUS_INFO[l.status].dot)} />
                    {LEAD_STATUS_INFO[l.status].label}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TEMP_STYLE[l.temperature])}>{humanize(l.temperature)}</span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{l.estimatedValue === null ? '—' : money(l.estimatedValue)}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.assignedTo?.name ?? '—'}</td>
                <td className="px-4 py-3 text-right text-muted-foreground" suppressHydrationWarning>
                  {formatDistanceToNowStrict(new Date(l.createdAt), { addSuffix: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void more()} disabled={loading}>
            {loading && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function CreateLeadDialog({
  open,
  onOpenChange,
  members,
  currency,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  members: InboxMember[];
  currency: string;
  onCreated: (lead: LeadItem) => void;
}) {
  const [values, setValues] = useState<LeadFormValues>(EMPTY_LEAD);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setValues(EMPTY_LEAD);
      setErrors({});
    }
  }, [open]);

  async function create() {
    setSaving(true);
    setErrors({});
    try {
      const res = await api<{ data: LeadItem }>('/api/v1/leads', { method: 'POST', json: leadPayload(values) });
      toast.success('Lead created.');
      onOpenChange(false);
      onCreated(res.data);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v?.[0]])));
      else toast.error(err instanceof ApiError ? err.message : 'Could not create the lead.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
          <DialogDescription>For leads from calls, events or email. It is linked to the customer with the same email or phone, or a new customer profile is created.</DialogDescription>
        </DialogHeader>
        <LeadForm values={values} onChange={setValues} errors={errors} members={members} currency={currency} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={saving}>
            {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            Create lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
