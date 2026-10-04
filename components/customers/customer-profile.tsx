'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNowStrict } from 'date-fns';
import { AlertTriangle, ArrowLeft, Building2, Download, GitMerge, Globe2, Loader2, Mail, MessageCircle, MessagesSquare, Pencil, Phone, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ChannelIcon, CustomerAvatar, StatusPill, useNow } from '@/components/inbox/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api } from '@/lib/api-client';
import { APPOINTMENT_STATUSES, TICKET_STATUSES, type CustomerProfile as Profile, type TagItem } from '@/lib/customers';
import { humanize } from '@/lib/format';
import { customerDisplayName } from '@/lib/inbox';
import { LEAD_STATUS_INFO } from '@/lib/leads';
import type { LeadStatus } from '@/lib/types';
import { CustomerEditDialog } from './customer-edit-dialog';
import { TagEditor } from './tag-editor';

interface Props {
  initial: Profile;
  allTags: TagItem[];
  me: { id: string };
  can: { manage: boolean; delete: boolean; reply: boolean; leads: boolean; inbox: boolean };
}

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

type Confirm =
  | { kind: 'delete-customer' }
  | { kind: 'delete-conversation'; id: string }
  | { kind: 'merge'; id: string; label: string }
  | null;

export function CustomerProfileView({ initial, allTags, me, can }: Props) {
  const router = useRouter();
  const now = useNow();
  const [c, setC] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const name = customerDisplayName(c);

  async function reload() {
    const res = await api<{ data: Profile }>(`/api/v1/customers/${c.id}`);
    setC(res.data);
  }

  async function runConfirm() {
    if (!confirm) return;
    const current = confirm;
    setBusy(true);
    try {
      if (current.kind === 'delete-customer') {
        await api(`/api/v1/customers/${c.id}`, { method: 'DELETE' });
        toast.success('Customer and all their data were deleted.');
        router.push('/customers');
        router.refresh();
        return;
      }
      if (current.kind === 'delete-conversation') {
        await api(`/api/v1/conversations/${current.id}`, { method: 'DELETE' });
        await reload();
        toast.success('Conversation deleted.');
      }
      if (current.kind === 'merge') {
        const res = await api<{ data: Profile }>(`/api/v1/customers/${c.id}/merge`, { method: 'POST', json: { sourceId: current.id } });
        setC(res.data);
        toast.success('Profiles merged.');
      }
      // Only close the dialog this action belongs to.
      setConfirm((open) => (open === current ? null : open));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function patch(path: string, body: unknown, done: string) {
    try {
      await api(path, { method: 'PATCH', json: body });
      await reload();
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    try {
      await api(`/api/v1/customers/${c.id}/notes`, { method: 'POST', json: { content: note } });
      setNote('');
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the note.');
    }
  }

  async function deleteNote(id: string) {
    try {
      await api(`/api/v1/customers/${c.id}/notes/${id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the note.');
    }
  }

  const contact = [
    c.email && { icon: Mail, label: 'Email', value: c.email, href: `mailto:${c.email}` },
    c.phone && { icon: Phone, label: 'Phone', value: c.phone, href: `tel:${c.phone}` },
    ...c.identities.filter((i) => i.channel === 'WHATSAPP').map((i) => ({ icon: MessageCircle, label: 'WhatsApp', value: i.label, href: null })),
    c.company && { icon: Building2, label: 'Company', value: c.company, href: null },
    c.language && { icon: Globe2, label: 'Language', value: new Intl.DisplayNames(['en'], { type: 'language' }).of(c.language) ?? c.language, href: null },
  ].filter(Boolean) as { icon: typeof Mail; label: string; value: string; href: string | null }[];

  const latestOpen = c.conversations.find((v) => v.status !== 'CLOSED') ?? c.conversations[0];

  return (
    <div className="space-y-6">
      <Link href="/customers" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Customers
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <CustomerAvatar customer={c} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight" dir="auto">
            {name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{c.isAnonymous ? 'Anonymous visitor' : 'Identified customer'}</span>
            <span className="inline-flex items-center gap-1">
              {c.channels.map((ch) => (
                <ChannelIcon key={ch} channel={ch} className="h-3.5 w-3.5" />
              ))}
            </span>
            <span suppressHydrationWarning>Customer since {day(c.createdAt)}</span>
            {c.lastSeenAt && <span suppressHydrationWarning>Last seen {now ? ago(c.lastSeenAt) : ''}</span>}
          </p>
          <div className="mt-2">
            <TagEditor customer={c} allTags={allTags} canManage={can.manage} onSaved={setC} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can.inbox && latestOpen && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/inbox?conversation=${latestOpen.id}`}>
                <MessagesSquare className="me-1.5 h-4 w-4" /> Open in inbox
              </Link>
            </Button>
          )}
          {can.manage && (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="me-1.5 h-4 w-4" /> Edit
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={`/api/v1/customers/${c.id}/export`} download>
                  <Download className="me-1.5 h-4 w-4" /> Export data
                </a>
              </Button>
            </>
          )}
          {can.delete && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => (setConfirmText(''), setConfirm({ kind: 'delete-customer' }))}>
              <Trash2 className="me-1.5 h-4 w-4" /> Delete
            </Button>
          )}
        </div>
      </div>

      {c.duplicates.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" /> Possible duplicate {c.duplicates.length === 1 ? 'profile' : 'profiles'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Same contact details as this customer. Contact details typed in a chat are not verified, so profiles are only merged when your team confirms it.
          </p>
          <ul className="mt-3 space-y-2">
            {c.duplicates.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-md bg-background/70 px-3 py-2 text-sm ring-1 ring-border">
                <Link href={`/customers/${d.id}`} className="font-medium hover:underline">
                  {customerDisplayName(d)}
                </Link>
                <span className="text-muted-foreground">
                  matches on {d.matchedOn.join(' and ')} · created {day(d.createdAt)}
                </span>
                {can.manage && (
                  <Button size="sm" variant="secondary" className="ms-auto h-7" onClick={() => setConfirm({ kind: 'merge', id: d.id, label: customerDisplayName(d) })}>
                    <GitMerge className="me-1.5 h-3.5 w-3.5" /> Merge into this profile
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {contact.length ? (
                <dl className="space-y-2.5">
                  {contact.map((item) => (
                    <div key={`${item.label}-${item.value}`} className="flex items-start gap-2.5">
                      <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{item.label}</dt>
                        <dd className="truncate">
                          {item.href ? (
                            <a href={item.href} className="hover:underline">
                              {item.value}
                            </a>
                          ) : (
                            item.value
                          )}
                        </dd>
                      </div>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-muted-foreground">No contact details yet.</p>
              )}
              {Object.keys(c.customFields).length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t pt-3">
                  {Object.entries(c.customFields).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="break-words">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="border-t pt-3">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Channel identities</p>
                <ul className="space-y-1">
                  {c.identities.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 text-[13px]">
                      <ChannelIcon channel={i.channel} className="h-3.5 w-3.5" />
                      <span className="truncate">{i.label}</span>
                      <span className="ms-auto shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>
                        {day(i.createdAt)}
                      </span>
                    </li>
                  ))}
                  {c.identities.length === 0 && <li className="text-[13px] text-muted-foreground">Added by the team</li>}
                </ul>
              </div>
              {c.consentAt && <p className="border-t pt-3 text-xs text-muted-foreground">Consent recorded {day(c.consentAt)}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-violet-500" /> What the AI knows
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className={c.aiSummary ? 'leading-relaxed' : 'text-muted-foreground'} dir="auto">
                {c.aiSummary ?? 'No summary yet. It is written when conversations end or are handed over.'}
              </p>
              {[...c.memory.productInterests.map((p) => `Interested in ${p}`), ...c.memory.preferences, ...c.memory.facts].length > 0 && (
                <ul className="space-y-1 border-t pt-3">
                  {[...c.memory.productInterests.map((p) => `Interested in ${p}`), ...c.memory.preferences, ...c.memory.facts].map((f) => (
                    <li key={f} className="flex gap-2 text-[13px]">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                      <span dir="auto">{f}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: history */}
        <div className="min-w-0 lg:col-span-2">
          <Tabs defaultValue="conversations">
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <TabsList>
                <TabsTrigger value="conversations">Conversations ({c.conversations.length})</TabsTrigger>
                {can.leads && <TabsTrigger value="leads">Leads ({c.leads.length})</TabsTrigger>}
                <TabsTrigger value="tickets">Tickets ({c.tickets.length})</TabsTrigger>
                <TabsTrigger value="appointments">Appointments ({c.appointments.length})</TabsTrigger>
                <TabsTrigger value="notes">Notes ({c.notes.length})</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="conversations" className="space-y-2">
              {c.conversations.length === 0 && <Empty text="No conversations yet." />}
              {c.conversations.map((v) => (
                <div key={v.id} className="rounded-lg border bg-card p-3.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <ChannelIcon channel={v.channel} className="h-4 w-4" />
                    <span className="font-medium">{v.channel === 'WHATSAPP' ? 'WhatsApp' : 'Website'}</span>
                    <StatusPill status={v.status} />
                    {v.intent && v.intent !== 'OTHER' && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{humanize(v.intent)}</span>}
                    <span className="ms-auto text-xs text-muted-foreground" suppressHydrationWarning>
                      {day(v.createdAt)} · {v.messageCount} messages{v.assignedTo ? ` · ${v.assignedTo}` : ''}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[13px] text-muted-foreground" dir="auto">
                    {v.summary ?? v.lastMessagePreview ?? 'No messages'}
                  </p>
                  <div className="mt-2 flex gap-3 text-xs">
                    {can.inbox && (
                      <Link href={`/inbox?conversation=${v.id}`} className="font-medium text-primary hover:underline">
                        Open in inbox
                      </Link>
                    )}
                    {can.delete && (
                      <button type="button" onClick={() => setConfirm({ kind: 'delete-conversation', id: v.id })} className="text-muted-foreground hover:text-destructive">
                        Delete conversation
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </TabsContent>

            {can.leads && (
              <TabsContent value="leads" className="space-y-2">
                {c.leads.length === 0 && <Empty text="No leads for this customer." />}
                {c.leads.map((l) => (
                  <Link key={l.id} href={`/leads?lead=${l.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3.5 text-sm hover:bg-muted/40">
                    <span className={`h-2 w-2 rounded-full ${LEAD_STATUS_INFO[l.status as LeadStatus].dot}`} />
                    <span className="font-medium">{l.reference}</span>
                    <span className="min-w-0 flex-1 truncate">{l.requestedService ?? 'General interest'}</span>
                    <span className="text-xs text-muted-foreground">
                      {LEAD_STATUS_INFO[l.status as LeadStatus].label} · {humanize(l.temperature)}
                      {l.estimatedValue ? ` · ${Number(l.estimatedValue).toLocaleString('en-GB')}` : ''}
                    </span>
                  </Link>
                ))}
              </TabsContent>
            )}

            <TabsContent value="tickets" className="space-y-2">
              {c.tickets.length === 0 && <Empty text="No support tickets." />}
              {c.tickets.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3.5 text-sm">
                  <span className="font-medium">{t.reference}</span>
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {t.subject}
                  </span>
                  <span className="text-xs text-muted-foreground">{humanize(t.priority)} priority</span>
                  {can.manage ? (
                    <Select value={t.status} onValueChange={(v) => void patch(`/api/v1/tickets/${t.id}`, { status: v }, 'Ticket updated.')}>
                      <SelectTrigger className="h-8 w-[140px]" aria-label={`Status of ${t.reference}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TICKET_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {humanize(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs">{humanize(t.status)}</span>
                  )}
                </div>
              ))}
            </TabsContent>

            <TabsContent value="appointments" className="space-y-2">
              {c.appointments.length === 0 && <Empty text="No appointment requests." />}
              {c.appointments.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium" dir="auto">
                      {a.topic}
                    </span>
                    <span className="block text-xs text-muted-foreground" dir="auto">
                      Preferred: {a.preferredTime}
                    </span>
                  </span>
                  {can.manage ? (
                    <Select value={a.status} onValueChange={(v) => void patch(`/api/v1/appointments/${a.id}`, { status: v }, 'Appointment updated.')}>
                      <SelectTrigger className="h-8 w-[140px]" aria-label={`Status of appointment ${a.topic}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {APPOINTMENT_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {humanize(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs">{humanize(a.status)}</span>
                  )}
                </div>
              ))}
            </TabsContent>

            <TabsContent value="notes" className="space-y-3">
              {can.reply && (
                <div className="space-y-2">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note — never shown to the customer" rows={3} maxLength={2000} aria-label="New note" />
                  <Button size="sm" onClick={() => void addNote()} disabled={!note.trim()}>
                    Add note
                  </Button>
                </div>
              )}
              {c.notes.length === 0 && <Empty text="No notes yet." />}
              {c.notes.map((n) => (
                <div key={n.id} className="rounded-lg bg-amber-500/[0.07] p-3.5 ring-1 ring-amber-500/15">
                  <p className="whitespace-pre-wrap text-sm" dir="auto">
                    {n.content}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span suppressHydrationWarning>
                      {n.authorName ?? 'Former member'} · {now ? ago(n.createdAt) : ''}
                    </span>
                    {(n.authorId === me.id || can.manage) && can.reply && (
                      <button type="button" onClick={() => void deleteNote(n.id)} className="ms-auto hover:text-destructive" aria-label="Delete note">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {can.manage && <CustomerEditDialog customer={c} open={editing} onOpenChange={setEditing} onSaved={setC} />}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'delete-customer' ? `Delete ${name}?` : confirm?.kind === 'merge' ? `Merge ${confirm.label} into ${name}?` : 'Delete this conversation?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {confirm?.kind === 'delete-customer' && (
                  <>
                    <p>This permanently deletes the profile, all conversations and messages, files, leads, tickets, appointments and notes. Use it for erasure requests. It cannot be undone.</p>
                    <p>
                      Type <strong>delete</strong> to confirm.
                    </p>
                    <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="Type delete to confirm" autoFocus />
                  </>
                )}
                {confirm?.kind === 'delete-conversation' && <p>All messages and files of this conversation are deleted permanently. Leads and tickets created from it are kept.</p>}
                {confirm?.kind === 'merge' && (
                  <p>
                    Conversations, channels, leads, tickets, notes and tags of {confirm.label} move to this profile, and empty fields here are filled in. The other profile is removed. Only merge when
                    you are sure both are the same person.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
              disabled={busy || (confirm?.kind === 'delete-customer' && confirmText.trim().toLowerCase() !== 'delete')}
              className={confirm?.kind === 'merge' ? undefined : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {busy && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              {confirm?.kind === 'merge' ? 'Merge profiles' : 'Delete permanently'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
