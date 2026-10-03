'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { AlertTriangle, Copy, KeyRound, Loader2, MoreHorizontal, Plus, RefreshCw, Send, Webhook } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Field, fieldErrorsFrom, SettingsSection } from '@/components/agent/form-parts';
import { api } from '@/lib/api-client';
import { EVENT_INFO, EVENT_TYPES } from '@/lib/events';
import { cn } from '@/lib/utils';
import { WEBHOOK_PRESETS, webhookEndpointSchema } from '@/lib/validation';

export interface EndpointItem {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  preset: string;
  isActive: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  createdAt: string;
  last24h: { delivered: number; failed: number; pending: number };
}

interface DeliveryItem {
  id: string;
  event: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  createdAt: string;
  payload: unknown;
}

export type Preset = (typeof WEBHOOK_PRESETS)[number];
const PRESET_LABEL: Record<Preset, string> = { custom: 'Custom', zapier: 'Zapier', make: 'Make', n8n: 'n8n' };
const PRESET_HINT: Record<Preset, string> = {
  custom: 'Any HTTPS endpoint that accepts JSON POST requests.',
  zapier: 'In Zapier, create a Zap with “Webhooks by Zapier → Catch Hook” and paste its URL.',
  make: 'In Make, add a “Webhooks → Custom webhook” module and paste its address.',
  n8n: 'In n8n, add a Webhook node (POST) and paste its production URL.',
};

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  return (
    <Dialog open={secret !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Signing secret</DialogTitle>
          <DialogDescription>Copy it now — it is stored encrypted and will not be shown again. Use it to verify the X-OmniAI-Signature header.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={secret ?? ''} className="font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} aria-label="Signing secret" />
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy secret"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret ?? '');
                toast.success('Secret copied');
              } catch {
                toast.error('Copy failed: select and copy it manually');
              }
            }}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I’ve stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EndpointDialog({
  open,
  initialPreset,
  endpoint,
  onClose,
  onSaved,
}: {
  open: boolean;
  initialPreset: Preset;
  endpoint: EndpointItem | null;
  onClose: () => void;
  onSaved: (secret: string | null) => void;
}) {
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [preset, setPreset] = useState<Preset>((endpoint?.preset as Preset) ?? initialPreset);
  const [events, setEvents] = useState<string[]>(endpoint?.events ?? ['lead.created']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const all = events.includes('*');

  async function save() {
    const parsed = webhookEndpointSchema.safeParse({ url: url.trim(), events, description: description.trim() || null, preset });
    if (!parsed.success) return setErrors(fieldErrorsFrom(parsed.error));
    setErrors({});
    setSaving(true);
    try {
      if (endpoint) {
        await api(`/api/v1/webhooks/${endpoint.id}`, { method: 'PATCH', json: parsed.data });
        toast.success('Endpoint updated');
        onSaved(null);
      } else {
        const res = await api<{ data: { secret: string } }>('/api/v1/webhooks', { method: 'POST', json: parsed.data });
        toast.success('Endpoint added');
        onSaved(res.data.secret);
      }
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{endpoint ? 'Edit webhook endpoint' : 'Add webhook endpoint'}</DialogTitle>
          <DialogDescription>OmniAI POSTs a signed JSON payload to this URL for every selected event.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="inline-flex rounded-lg border p-0.5" role="radiogroup" aria-label="Destination">
            {WEBHOOK_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={preset === p}
                onClick={() => setPreset(p)}
                className={cn('rounded-md px-3 py-1 text-sm', preset === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {PRESET_LABEL[p]}
              </button>
            ))}
          </div>
          <Field label="Endpoint URL" htmlFor="wh-url" error={errors.url} hint={PRESET_HINT[preset]}>
            <Input id="wh-url" placeholder="https://hooks.example.com/omniai" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-[13px]" />
          </Field>
          <Field label="Description" htmlFor="wh-desc" error={errors.description}>
            <Input id="wh-desc" placeholder="e.g. Leads to our CRM" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Events" error={errors.events}>
            <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Checkbox checked={all} onCheckedChange={(v) => setEvents(v === true ? ['*'] : [])} />
              All events (including future ones)
            </label>
            {!all && (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {EVENT_TYPES.map((e) => (
                  <label key={e} className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm" title={EVENT_INFO[e].description}>
                    <Checkbox
                      className="mt-0.5"
                      checked={events.includes(e)}
                      onCheckedChange={(v) => setEvents((list) => (v === true ? [...list, e] : list.filter((x) => x !== e)))}
                    />
                    <span>
                      {EVENT_INFO[e].label}
                      <span className="block font-mono text-[11px] text-muted-foreground">{e}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {endpoint ? 'Save' : 'Add endpoint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesSheet({ endpoint, onClose, onChanged }: { endpoint: EndpointItem | null; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<DeliveryItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async (id: string) => {
    try {
      const res = await api<{ data: DeliveryItem[] }>(`/api/v1/webhooks/${id}`);
      setRows(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load deliveries');
      setRows([]);
    }
  }, []);
  useEffect(() => {
    setRows(null);
    if (endpoint) void load(endpoint.id);
  }, [endpoint, load]);

  async function redeliver(id: string) {
    try {
      const res = await api<{ data: { ok: boolean; error: string | null } }>(`/api/v1/webhook-deliveries/${id}/redeliver`, { method: 'POST' });
      if (res.data.ok) toast.success('Delivered');
      else toast.error('Delivery failed again', { description: res.data.error ?? undefined });
      if (endpoint) await load(endpoint.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not redeliver');
    }
  }

  return (
    <Sheet open={endpoint !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-all pe-6 font-mono text-sm">{endpoint?.url}</SheetTitle>
          <SheetDescription>Last 30 deliveries. Failed deliveries are retried after 30 s, 2 min, 10 min, 1 h and 6 h.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          {!rows ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet. Use “Send test event”.</p>
          ) : (
            rows.map((d) => (
              <div key={d.id} className="rounded-lg border">
                <button type="button" className="flex w-full items-center gap-2 p-3 text-start text-sm" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <Badge variant={d.status === 'DELIVERED' ? 'default' : d.status === 'FAILED' ? 'destructive' : 'secondary'}>
                    {d.status === 'PENDING' ? (d.attempts ? 'Retrying' : 'Queued') : d.status === 'DELIVERED' ? 'Delivered' : 'Failed'}
                  </Badge>
                  <span className="font-mono text-xs">{d.event}</span>
                  <span className="ms-auto text-xs text-muted-foreground" suppressHydrationWarning>
                    {d.responseStatus ? `HTTP ${d.responseStatus} · ` : ''}
                    {d.durationMs !== null ? `${d.durationMs} ms · ` : ''}
                    {ago(d.createdAt)}
                  </span>
                </button>
                {open === d.id && (
                  <div className="space-y-2 border-t p-3">
                    <p className="text-xs text-muted-foreground">
                      Attempts: {d.attempts}
                      {d.nextAttemptAt && d.status === 'PENDING' ? ` · next ${ago(d.nextAttemptAt)}` : ''}
                    </p>
                    {d.lastError && <p className="text-xs text-destructive">{d.lastError}</p>}
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">{JSON.stringify(d.payload, null, 2)}</pre>
                    {d.status !== 'DELIVERED' && (
                      <Button size="sm" variant="outline" onClick={() => redeliver(d.id)}>
                        <RefreshCw className="me-1.5 h-3.5 w-3.5" /> Redeliver now
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const VERIFY_SNIPPET = `// Node.js: verify an OmniAI webhook (use the raw request body)
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // replay
  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;

export function WebhooksManager({ initial, addRequest }: { initial: EndpointItem[]; addRequest: { preset: Preset; key: number } | null }) {
  const [items, setItems] = useState(initial);
  const [dialog, setDialog] = useState<{ endpoint: EndpointItem | null; preset: Preset; key: number } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<EndpointItem | null>(null);
  const [deleting, setDeleting] = useState<EndpointItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (addRequest) setDialog({ endpoint: null, preset: addRequest.preset, key: addRequest.key });
  }, [addRequest]);

  const refresh = async () => {
    try {
      const res = await api<{ data: EndpointItem[] }>('/api/v1/webhooks');
      setItems(res.data);
    } catch {
      /* keep */
    }
  };

  async function act(e: EndpointItem, action: 'test' | 'rotate-secret') {
    setBusy(e.id);
    try {
      const res = await api<{ data: { ok?: boolean; responseStatus?: number | null; error?: string | null; durationMs?: number | null; secret?: string } }>(
        `/api/v1/webhooks/${e.id}/${action}`,
        { method: 'POST' },
      );
      if (action === 'rotate-secret') {
        setSecret(res.data.secret ?? null);
        toast.success('New secret created', { description: 'The old secret stops working now.' });
      } else if (res.data.ok) {
        toast.success('Test event delivered', { description: `HTTP ${res.data.responseStatus} in ${res.data.durationMs} ms` });
      } else {
        toast.error('Test event failed', { description: res.data.error ?? undefined });
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  async function setActive(e: EndpointItem, isActive: boolean) {
    try {
      await api(`/api/v1/webhooks/${e.id}`, { method: 'PATCH', json: { isActive } });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update');
    }
  }

  async function remove(e: EndpointItem) {
    try {
      await api(`/api/v1/webhooks/${e.id}`, { method: 'DELETE' });
      toast.success('Endpoint deleted');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  return (
    <SettingsSection
      title="Webhooks"
      description="Send OmniAI events (new leads, conversations, handoffs, …) to your own systems, Zapier, Make or n8n. Every request is signed."
      action={
        <Button onClick={() => setDialog({ endpoint: null, preset: 'custom', key: Date.now() })}>
          <Plus className="me-2 h-4 w-4" /> Add endpoint
        </Button>
      }
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center">
          <Webhook className="h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No webhook endpoints</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">Add an endpoint to push events to your CRM, a data warehouse or an automation tool.</p>
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {items.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-3 p-4">
              <Switch checked={e.isActive} onCheckedChange={(v) => setActive(e, v)} aria-label={`${e.url} active`} />
              <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setDeliveriesFor(e)}>
                <p className="truncate font-mono text-[13px]">{e.url}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {PRESET_LABEL[e.preset as Preset] ?? 'Custom'}
                  {e.description ? ` · ${e.description}` : ''} · {e.events.includes('*') ? 'all events' : `${e.events.length} event${e.events.length === 1 ? '' : 's'}`}
                </p>
                {!e.isActive && e.disabledReason && (
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" /> Disabled: {e.disabledReason}
                  </p>
                )}
              </button>
              <div className="text-end text-xs text-muted-foreground">
                <p>
                  24 h: <span className="text-emerald-600 dark:text-emerald-400">{e.last24h.delivered} ok</span>
                  {e.last24h.failed ? <span className="text-destructive"> · {e.last24h.failed} failed</span> : null}
                  {e.last24h.pending ? <span> · {e.last24h.pending} retrying</span> : null}
                </p>
                {e.lastDeliveryAt && <p suppressHydrationWarning>last {ago(e.lastDeliveryAt)}</p>}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy === e.id} aria-label={`Actions for ${e.url}`}>
                    {busy === e.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => act(e, 'test')} disabled={!e.isActive}>
                    <Send className="me-2 h-4 w-4" /> Send test event
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeliveriesFor(e)}>Delivery log</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog({ endpoint: e, preset: e.preset as Preset, key: Date.now() })}>Edit</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => act(e, 'rotate-secret')}>
                    <KeyRound className="me-2 h-4 w-4" /> Rotate secret
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(e)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      <details className="rounded-lg border bg-muted/30 p-3 text-sm">
        <summary className="cursor-pointer font-medium">Verifying signatures</summary>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Each request carries <code className="text-xs">X-OmniAI-Signature: t=…,v1=…</code> (HMAC-SHA256 of <code className="text-xs">t.body</code>),{' '}
          <code className="text-xs">X-OmniAI-Event</code> and <code className="text-xs">X-OmniAI-Event-Id</code> (deduplicate on it — retries reuse it). Answer with any
          2xx status within 10 seconds.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed">{VERIFY_SNIPPET}</pre>
      </details>

      {dialog && (
        <EndpointDialog
          key={dialog.key}
          open
          endpoint={dialog.endpoint}
          initialPreset={dialog.preset}
          onClose={() => setDialog(null)}
          onSaved={(s) => {
            setDialog(null);
            if (s) setSecret(s);
            void refresh();
          }}
        />
      )}
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <DeliveriesSheet endpoint={deliveriesFor} onClose={() => setDeliveriesFor(null)} onChanged={() => void refresh()} />
      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.url} stops receiving events and its delivery log is removed. Automations that call it skip this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove(deleting)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
