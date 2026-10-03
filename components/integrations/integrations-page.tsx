'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import { AlertTriangle, CheckCircle2, Loader2, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Field, SettingsSection } from '@/components/agent/form-parts';
import { api } from '@/lib/api-client';
import { hubspotConnectSchema } from '@/lib/validation';
import { WebhooksManager, type EndpointItem, type Preset } from './webhooks-manager';

export interface ConnectorItem {
  type: string;
  name: string;
  description: string;
  category: 'crm' | 'automation' | 'commerce' | 'calendar' | 'custom';
  status: 'available' | 'webhook' | 'planned';
  connection: { isActive: boolean; config: unknown; lastSyncAt: string | null; lastError: string | null; connectedAt: string } | null;
}

const CATEGORY: Record<ConnectorItem['category'], string> = { crm: 'CRM', automation: 'Automation', commerce: 'E-commerce', calendar: 'Calendar', custom: 'Custom' };

function HubSpotDialog({ open, connected, onClose, onDone }: { open: boolean; connected: boolean; onClose: () => void; onDone: () => void }) {
  const [token, setToken] = useState('');
  const [syncLeads, setSyncLeads] = useState(true);
  const [syncCustomers, setSyncCustomers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function connect() {
    const parsed = hubspotConnectSchema.safeParse({ accessToken: token, syncLeads, syncCustomers });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the token');
    setSaving(true);
    setError(null);
    try {
      await api('/api/v1/integrations/hubspot', { method: 'PUT', json: parsed.data });
      toast.success('HubSpot connected', { description: 'New leads are synced as HubSpot contacts.' });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{connected ? 'Update HubSpot token' : 'Connect HubSpot'}</DialogTitle>
          <DialogDescription>
            In HubSpot: Settings → Integrations → Private apps → create an app with the scopes <code className="text-xs">crm.objects.contacts.read</code> and{' '}
            <code className="text-xs">crm.objects.contacts.write</code>, then paste its access token. It is verified and stored encrypted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Access token" htmlFor="hs-token" error={error ?? undefined}>
            <Input id="hs-token" type="password" autoComplete="off" placeholder="pat-eu1-…" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={syncLeads} onCheckedChange={setSyncLeads} aria-label="Sync leads" /> Create or update a contact for every new lead
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={syncCustomers} onCheckedChange={setSyncCustomers} aria-label="Sync customers" /> Also for new customers with an email address
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={connect} disabled={saving || !token.trim()}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            Verify & connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IntegrationsPage({ connectors: initial, endpoints }: { connectors: ConnectorItem[]; endpoints: EndpointItem[] }) {
  const [connectors, setConnectors] = useState(initial);
  const [hubspotOpen, setHubspotOpen] = useState(false);
  const [addWebhook, setAddWebhook] = useState<{ preset: Preset; key: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await api<{ data: ConnectorItem[] }>('/api/v1/integrations');
      setConnectors(res.data);
    } catch {
      /* keep */
    }
  };

  async function hubspotAction(action: 'test' | 'pause' | 'resume' | 'disconnect') {
    setBusy(action);
    try {
      if (action === 'test') {
        const res = await api<{ data: { ok: boolean; detail: string } }>('/api/v1/integrations/hubspot', { method: 'POST' });
        if (res.data.ok) toast.success('HubSpot connection works', { description: res.data.detail });
        else toast.error('HubSpot connection failed', { description: res.data.detail });
      } else if (action === 'disconnect') {
        await api('/api/v1/integrations/hubspot', { method: 'DELETE' });
        toast.success('HubSpot disconnected');
      } else {
        await api('/api/v1/integrations/hubspot', { method: 'PATCH', json: { isActive: action === 'resume' } });
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Apps & CRMs" description="Connect OmniAI to the tools your team already uses.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {connectors.map((c) => {
            const conn = c.connection;
            return (
              <div key={c.type} className="flex flex-col rounded-xl border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{CATEGORY[c.category]}</p>
                  </div>
                  {conn ? (
                    <Badge variant={conn.isActive ? 'default' : 'secondary'}>{conn.isActive ? 'Connected' : 'Paused'}</Badge>
                  ) : c.status === 'planned' ? (
                    <Badge variant="outline">Planned</Badge>
                  ) : c.status === 'webhook' ? (
                    <Badge variant="secondary">Via webhook</Badge>
                  ) : null}
                </div>
                <p className="mt-2 flex-1 text-[13px] text-muted-foreground">{c.description}</p>
                {conn?.lastError && (
                  <p className="mt-2 inline-flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {conn.lastError}
                  </p>
                )}
                {conn?.lastSyncAt && !conn.lastError && (
                  <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground" suppressHydrationWarning>
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Last sync {formatDistanceToNowStrict(new Date(conn.lastSyncAt), { addSuffix: true })}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.type === 'HUBSPOT' && !conn && (
                    <Button size="sm" onClick={() => setHubspotOpen(true)}>
                      <Plug className="me-1.5 h-3.5 w-3.5" /> Connect
                    </Button>
                  )}
                  {c.type === 'HUBSPOT' && conn && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => hubspotAction('test')} disabled={busy !== null}>
                        {busy === 'test' && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}Test
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => hubspotAction(conn.isActive ? 'pause' : 'resume')} disabled={busy !== null}>
                        {conn.isActive ? 'Pause' : 'Resume'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setHubspotOpen(true)}>
                        Change token
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => hubspotAction('disconnect')} disabled={busy !== null}>
                        Disconnect
                      </Button>
                    </>
                  )}
                  {c.status === 'webhook' && (
                    <Button size="sm" variant="outline" onClick={() => setAddWebhook({ preset: c.type.toLowerCase() as Preset, key: Date.now() })}>
                      Set up webhook
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="flex flex-col rounded-xl border p-4">
            <p className="font-medium">Order system</p>
            <p className="text-xs text-muted-foreground">Custom API</p>
            <p className="mt-2 flex-1 text-[13px] text-muted-foreground">Let the assistant answer “where is my order?” from your shop or ERP.</p>
            <Button size="sm" variant="outline" className="mt-3 self-start" asChild>
              <Link href="/agent?tab=tools">Configure in AI Agent → Tools</Link>
            </Button>
          </div>
        </div>
      </SettingsSection>

      <WebhooksManager initial={endpoints} addRequest={addWebhook} />

      {hubspotOpen && (
        <HubSpotDialog
          open
          connected={Boolean(connectors.find((c) => c.type === 'HUBSPOT')?.connection)}
          onClose={() => setHubspotOpen(false)}
          onDone={() => {
            setHubspotOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
