'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import { ExternalLink, Loader2, MessagesSquare, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ApiError, api } from '@/lib/api-client';
import { humanize } from '@/lib/format';
import type { InboxMember } from '@/lib/inbox';
import { LEAD_STATUS_INFO, LEAD_STATUSES, type LeadActivity, type LeadItem } from '@/lib/leads';
import type { LeadStatus } from '@/lib/types';
import { EMPTY_LEAD, LeadForm, leadPayload, type LeadFormValues } from './lead-form';

type Detail = LeadItem & { activity: LeadActivity[] };

interface Props {
  leadId: string | null;
  onClose: () => void;
  onChanged: (lead: LeadItem | null, removedId?: string) => void;
  members: InboxMember[];
  currency: string;
  canManage: boolean;
  canInbox: boolean;
}

const toForm = (l: LeadItem): LeadFormValues => ({
  ...EMPTY_LEAD,
  name: l.name ?? '',
  email: l.email ?? '',
  phone: l.phone ?? '',
  company: l.company ?? '',
  requestedService: l.requestedService ?? '',
  message: l.message ?? '',
  preferredContact: l.preferredContact ?? '',
  temperature: l.temperature,
  estimatedValue: l.estimatedValue === null ? '' : String(l.estimatedValue),
  assignedToId: l.assignedTo?.id ?? '',
});

export function LeadSheet({ leadId, onClose, onChanged, members, currency, canManage, canInbox }: Props) {
  const [lead, setLead] = useState<Detail | null>(null);
  const [form, setForm] = useState<LeadFormValues>(EMPTY_LEAD);
  const [status, setStatus] = useState<LeadStatus>('NEW');
  const [lostReason, setLostReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) return;
    setLead(null);
    setLoadError(null);
    api<{ data: Detail }>(`/api/v1/leads/${leadId}`)
      .then((res) => {
        setLead(res.data);
        setForm(toForm(res.data));
        setStatus(res.data.status);
        setLostReason(res.data.lostReason ?? '');
        setErrors({});
      })
      .catch((err) => setLoadError(err instanceof ApiError && err.status === 404 ? 'This lead no longer exists.' : 'Could not load the lead.'));
  }, [leadId]);

  async function save() {
    if (!lead) return;
    setSaving(true);
    setErrors({});
    try {
      const res = await api<{ data: Detail }>(`/api/v1/leads/${lead.id}`, {
        method: 'PATCH',
        json: { ...leadPayload(form), status, lostReason: status === 'LOST' ? lostReason : null },
      });
      setLead(res.data);
      onChanged(res.data);
      toast.success('Lead saved.');
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v?.[0]])));
      else toast.error(err instanceof ApiError ? err.message : 'Could not save the lead.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!lead) return;
    setDeleting(true);
    try {
      await api(`/api/v1/leads/${lead.id}`, { method: 'DELETE' });
      onChanged(null, lead.id);
      toast.success('Lead deleted.');
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the lead.');
    } finally {
      setDeleting(false);
    }
  }

  const title = lead ? (lead.name ?? lead.company ?? lead.email ?? lead.reference) : 'Lead';

  return (
    <Sheet open={leadId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle dir="auto">{title}</SheetTitle>
          <SheetDescription>
            {lead ? (
              <>
                {lead.reference} · {lead.source ? `from ${lead.source === 'WHATSAPP' ? 'WhatsApp' : 'website chat'}` : 'added by the team'} ·{' '}
                <span suppressHydrationWarning>{formatDistanceToNowStrict(new Date(lead.createdAt), { addSuffix: true })}</span>
              </>
            ) : (
              'Loading…'
            )}
          </SheetDescription>
        </SheetHeader>

        {loadError ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{loadError}</p>
        ) : !lead ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap gap-2">
              {lead.customerId && (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/customers/${lead.customerId}`}>
                    <UserRound className="me-1.5 h-4 w-4" /> Customer profile
                  </Link>
                </Button>
              )}
              {lead.conversationId && canInbox && (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/inbox?conversation=${lead.conversationId}`}>
                    <MessagesSquare className="me-1.5 h-4 w-4" /> Conversation
                  </Link>
                </Button>
              )}
              {lead.email && (
                <Button asChild size="sm" variant="outline">
                  <a href={`mailto:${lead.email}`}>
                    <ExternalLink className="me-1.5 h-4 w-4" /> Email
                  </a>
                </Button>
              )}
            </div>

            <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="lead-status">Stage</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as LeadStatus)} disabled={!canManage}>
                  <SelectTrigger id="lead-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        <span className="inline-flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${LEAD_STATUS_INFO[s].dot}`} />
                          {LEAD_STATUS_INFO[s].label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {status === 'LOST' && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-lost">Reason lost</Label>
                  <Input id="lead-lost" value={lostReason} onChange={(e) => setLostReason(e.target.value)} maxLength={300} placeholder="e.g. chose a competitor" disabled={!canManage} />
                </div>
              )}
              {lead.intent && (
                <p className="text-sm text-muted-foreground sm:col-span-2">
                  Detected intent: <span className="text-foreground">{humanize(lead.intent)}</span>
                </p>
              )}
            </div>

            <LeadForm values={form} onChange={setForm} errors={errors} members={members} currency={currency} disabled={!canManage} />

            {canManage && (
              <div className="flex items-center gap-2">
                <Button onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
                <Button variant="ghost" className="ms-auto text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="me-1.5 h-4 w-4" /> Delete
                </Button>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
              {lead.activity.length === 0 ? (
                <p className="text-sm text-muted-foreground">{lead.source ? 'Captured by the AI assistant.' : 'No changes yet.'}</p>
              ) : (
                <ol className="space-y-2 border-s ps-4">
                  {lead.activity.map((a) => (
                    <li key={a.id} className="relative text-sm">
                      <span className="absolute -start-[21px] top-1.5 h-2 w-2 rounded-full bg-border" />
                      <span className="font-medium">{a.actorName ?? 'System'}</span> <span className="text-muted-foreground">{a.detail.charAt(0).toLowerCase() + a.detail.slice(1)}</span>
                      <span className="block text-xs text-muted-foreground" suppressHydrationWarning>
                        {formatDistanceToNowStrict(new Date(a.createdAt), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}

        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this lead?</AlertDialogTitle>
              <AlertDialogDescription>The lead is removed from the pipeline. The customer profile and conversation stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void remove();
                }}
                disabled={deleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete lead
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
