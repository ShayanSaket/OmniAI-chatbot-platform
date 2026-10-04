'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import { Building2, Globe2, Loader2, Mail, MessageCircle, Phone, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api } from '@/lib/api-client';
import { humanize } from '@/lib/format';
import { customerDisplayName, type InboxConversationDetail } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { ChannelIcon, CustomerAvatar, shortTime, StatusPill, useNow } from './shared';

type Note = InboxConversationDetail['notes'][number];

interface Props {
  conversation: InboxConversationDetail;
  canReply: boolean;
  meId: string;
  onSelectConversation: (id: string) => void;
  onChange: (patch: Partial<InboxConversationDetail>) => void;
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b px-4 py-4 last:border-b-0">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

export function CustomerPanel({ conversation, canReply, meId, onSelectConversation, onChange }: Props) {
  const c = conversation.customer;
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function refreshSummary() {
    setRefreshing(true);
    try {
      const res = await api<{ data: { updated: boolean; summary: InboxConversationDetail['summary'] } }>(`/api/v1/conversations/${conversation.id}/summary`, { method: 'POST' });
      if (res.data.summary) onChange({ summary: res.data.summary });
      if (!res.data.updated) toast.message(res.data.summary ? 'Summary is up to date.' : 'Not enough messages to summarize yet, or no AI provider is configured.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not refresh the summary.');
    } finally {
      setRefreshing(false);
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    setSaving(true);
    try {
      const res = await api<{ data: Note }>(`/api/v1/customers/${c.id}/notes`, { method: 'POST', json: { content: note } });
      onChange({ notes: [res.data, ...conversation.notes] });
      setNote('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteNote(id: string) {
    try {
      await api(`/api/v1/customers/${c.id}/notes/${id}`, { method: 'DELETE' });
      onChange({ notes: conversation.notes.filter((n) => n.id !== id) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the note.');
    }
  }

  const contact = [
    c.email && { icon: Mail, value: c.email, href: `mailto:${c.email}` },
    c.phone && { icon: Phone, value: c.phone, href: `tel:${c.phone}` },
    c.whatsappNumber && c.whatsappNumber !== c.phone?.replace(/\D/g, '') && { icon: MessageCircle, value: `+${c.whatsappNumber}`, href: null },
    c.company && { icon: Building2, value: c.company, href: null },
    c.language && { icon: Globe2, value: new Intl.DisplayNames(['en'], { type: 'language' }).of(c.language) ?? c.language, href: null },
  ].filter(Boolean) as { icon: typeof Mail; value: string; href: string | null }[];

  return (
    <div className="text-sm">
      <div className="flex flex-col items-center border-b px-4 py-5 text-center">
        <CustomerAvatar customer={c} size={56} />
        <Link href={`/customers/${c.id}`} className="mt-2 font-semibold hover:underline" dir="auto">
          {customerDisplayName(c)}
        </Link>
        <p className="text-xs text-muted-foreground">
          {c.isAnonymous ? 'Anonymous visitor' : 'Customer'} · since <span suppressHydrationWarning>{now ? ago(c.createdAt) : ''}</span>
        </p>
        {c.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-center gap-1">
            {c.tags.map((t) => (
              <span key={t.name} className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${t.color}22`, color: t.color }}>
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {contact.length > 0 && (
        <Section title="Contact">
          <ul className="space-y-1.5">
            {contact.map((item) => (
              <li key={item.value} className="flex items-center gap-2 text-[13px]">
                <item.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {item.href ? (
                  <a href={item.href} className="min-w-0 truncate hover:underline">
                    {item.value}
                  </a>
                ) : (
                  <span className="min-w-0 truncate">{item.value}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="AI summary"
        action={
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void refreshSummary()} disabled={refreshing} aria-label="Refresh summary">
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        }
      >
        {conversation.summary ? (
          <>
            <p className="text-[13px] leading-relaxed" dir="auto">
              {conversation.summary.text}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground" suppressHydrationWarning>
              <Sparkles className="me-1 inline h-3 w-3" />
              Updated {now ? ago(conversation.summary.createdAt) : ''}
            </p>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">No summary yet. Summaries are written as the conversation grows, or refresh to create one now.</p>
        )}
        {c.facts.length > 0 && (
          <ul className="mt-3 space-y-1 border-t pt-3 text-[13px]">
            {c.facts.map((f) => (
              <li key={f} className="flex gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span dir="auto">{f}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Conversation">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Channel</dt>
          <dd className="flex items-center gap-1.5">
            <ChannelIcon channel={conversation.channel} className="h-3.5 w-3.5" />
            {conversation.channel === 'WHATSAPP' ? 'WhatsApp' : 'Website'}
          </dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd suppressHydrationWarning>{now ? ago(conversation.createdAt) : ''}</dd>
          {conversation.intent && (
            <>
              <dt className="text-muted-foreground">Intent</dt>
              <dd>{humanize(conversation.intent)}</dd>
            </>
          )}
          {conversation.leadTemperature && (
            <>
              <dt className="text-muted-foreground">Lead</dt>
              <dd>{humanize(conversation.leadTemperature)}</dd>
            </>
          )}
          {conversation.sentiment && (
            <>
              <dt className="text-muted-foreground">Sentiment</dt>
              <dd>{humanize(conversation.sentiment.toUpperCase())}</dd>
            </>
          )}
          {conversation.handoffReason && (
            <>
              <dt className="text-muted-foreground">Handoff</dt>
              <dd>{humanize(conversation.handoffReason.toUpperCase())}</dd>
            </>
          )}
        </dl>
      </Section>

      {(conversation.leads.length > 0 || conversation.tickets.length > 0 || conversation.appointments.length > 0) && (
        <Section title="Leads, tickets & appointments">
          <ul className="space-y-2 text-[13px]">
            {conversation.leads.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">Lead</span> · {l.requestedService ?? 'General interest'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {humanize(l.status)} · {humanize(l.temperature)}
                </span>
              </li>
            ))}
            {conversation.tickets.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">{t.reference}</span> · {t.subject}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {humanize(t.status)} · {humanize(t.priority)}
                </span>
              </li>
            ))}
            {conversation.appointments.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">Appointment</span> · {a.topic} — {a.preferredTime}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{humanize(a.status)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Internal notes">
        {canReply && (
          <div className="mb-3 space-y-2">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only your team sees notes" rows={2} maxLength={2000} className="text-[13px]" aria-label="New note" />
            <Button size="sm" variant="secondary" onClick={() => void addNote()} disabled={!note.trim() || saving} className="h-7 text-xs">
              {saving && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
              Add note
            </Button>
          </div>
        )}
        {conversation.notes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {conversation.notes.map((n) => (
              <li key={n.id} className="group rounded-md bg-amber-500/[0.07] px-3 py-2 ring-1 ring-amber-500/15">
                <p className="whitespace-pre-wrap text-[13px]" dir="auto">
                  {n.content}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>
                    {n.authorName ?? 'Former member'} · <span suppressHydrationWarning>{shortTime(n.createdAt, now)}</span>
                  </span>
                  {canReply && n.authorId === meId && (
                    <button type="button" onClick={() => void deleteNote(n.id)} className="ms-auto opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100" aria-label="Delete note">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {conversation.otherConversations.length > 0 && (
        <Section title="Other conversations">
          <ul className="space-y-1">
            {conversation.otherConversations.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => onSelectConversation(o.id)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] hover:bg-muted')}>
                  <ChannelIcon channel={o.channel} className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
                    {o.lastMessagePreview || 'No messages'}
                  </span>
                  <StatusPill status={o.status} />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
