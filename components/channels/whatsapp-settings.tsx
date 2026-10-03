'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNowStrict } from 'date-fns';
import { AlertTriangle, CheckCircle2, Copy, Loader2, MessageCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field, fieldErrorsFrom, SettingsSection } from '@/components/agent/form-parts';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { whatsappConnectSchema } from '@/lib/validation';

export interface WhatsAppSettingsData {
  connected: boolean;
  canManage: boolean;
  webhookUrl: string;
  environment: { appSecret: boolean; verifyToken: boolean; accessToken: boolean };
  account: {
    phoneNumberId: string;
    businessAccountId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    qualityRating: string | null;
    lastVerifiedAt: string | null;
    hasOwnToken: boolean;
  } | null;
  templates: {
    id: string;
    name: string;
    language: string;
    category: string;
    status: string;
    body: string;
    variables: number;
    supported: boolean;
  }[];
  recentEvents: { id: string; eventType: string; status: string; attempts: number; error: string | null; createdAt: string }[];
  failedDeliveries7d: number;
}

function Ago({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()} suppressHydrationWarning>
      {formatDistanceToNowStrict(new Date(iso), { addSuffix: true })}
    </time>
  );
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <li className="flex items-start gap-2.5">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
    </li>
  );
}

const STATUS_STYLE: Record<string, string> = {
  APPROVED: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  PENDING: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  REJECTED: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
};

export function WhatsAppSettings({ initial }: { initial: WhatsAppSettingsData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [form, setForm] = useState({
    phoneNumberId: initial.account?.phoneNumberId ?? '',
    businessAccountId: initial.account?.businessAccountId ?? '',
    displayPhoneNumber: initial.account?.displayPhoneNumber ?? '',
    accessToken: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'sync' | 'disconnect' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const env = data.environment;
  const account = data.account;

  async function save(clearToken = false) {
    const parsed = whatsappConnectSchema.safeParse({
      phoneNumberId: form.phoneNumberId,
      businessAccountId: form.businessAccountId,
      displayPhoneNumber: form.displayPhoneNumber.trim() || null,
      ...(clearToken ? { accessToken: null } : form.accessToken ? { accessToken: form.accessToken } : {}),
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setBusy('save');
    try {
      const res = await api<{ data: WhatsAppSettingsData }>('/api/v1/channels/whatsapp', { method: 'PUT', json: parsed.data });
      setData(res.data);
      setForm((f) => ({ ...f, accessToken: '' }));
      toast.success(clearToken ? 'Using the access token from the server environment' : data.connected ? 'Connection updated' : 'WhatsApp number connected', {
        description: 'Run “Test connection” to confirm Meta accepts the credentials.',
      });
      router.refresh();
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy('test');
    try {
      const res = await api<{ data: { verifiedName: string | null; displayPhoneNumber: string | null; qualityRating: string | null } }>(
        '/api/v1/channels/whatsapp/test',
        { method: 'POST' },
      );
      toast.success(`Connected to ${res.data.verifiedName ?? 'WhatsApp'}`, { description: res.data.displayPhoneNumber ?? undefined });
      const fresh = await api<{ data: WhatsAppSettingsData }>('/api/v1/channels/whatsapp');
      setData(fresh.data);
    } catch (err) {
      toast.error('Connection test failed', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function syncTemplates() {
    setBusy('sync');
    try {
      const res = await api<{ data: WhatsAppSettingsData['templates'] }>('/api/v1/channels/whatsapp/templates', { method: 'POST' });
      setData((d) => ({ ...d, templates: res.data }));
      toast.success(`${res.data.length} template${res.data.length === 1 ? '' : 's'} synced from Meta`);
    } catch (err) {
      toast.error('Template sync failed', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      await api('/api/v1/channels/whatsapp', { method: 'DELETE' });
      setData((d) => ({ ...d, connected: false, account: null }));
      toast.success('WhatsApp disconnected', { description: 'Existing conversations are kept.' });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  }

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(data.webhookUrl);
      toast.success('Webhook URL copied');
    } catch {
      toast.error('Copy failed: select the URL and copy it manually');
    }
  };

  const ready = data.connected && env.appSecret && env.verifyToken && (env.accessToken || account?.hasOwnToken);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:flex-row sm:items-center sm:p-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#25D366]/10 text-[#128C4B]">
          <MessageCircle className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">WhatsApp Business</h2>
            <Badge variant={ready ? 'default' : 'secondary'}>{ready ? 'Live' : data.connected ? 'Setup incomplete' : 'Not connected'}</Badge>
            {account?.qualityRating && <Badge variant="outline">Quality: {account.qualityRating.toLowerCase()}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {account
              ? `${account.verifiedName ?? 'Unverified name'} · ${account.displayPhoneNumber ?? `Phone number ID ${account.phoneNumberId}`}`
              : 'Connect your WhatsApp Business number. Messages then run through the same AI agent, knowledge base and inbox as website chat.'}
          </p>
          {account?.lastVerifiedAt && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Last verified <Ago iso={account.lastVerifiedAt} />
            </p>
          )}
        </div>
        {data.connected && (
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={testConnection} disabled={busy !== null}>
              {busy === 'test' ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="me-2 h-4 w-4" />}
              Test connection
            </Button>
            {data.canManage && (
              <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy !== null}>
                Disconnect
              </Button>
            )}
          </div>
        )}
      </section>

      {data.failedDeliveries7d > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {data.failedDeliveries7d} WhatsApp message{data.failedDeliveries7d === 1 ? '' : 's'} could not be delivered in the last 7 days. Temporary errors
            are retried automatically; messages outside the 24-hour window need a template.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SettingsSection title="1. Server configuration" description="Set once in the server environment by whoever deploys OmniAI. Values are never shown here.">
          <ul className="space-y-3">
            <Check ok={env.appSecret} label="App secret" hint="WHATSAPP_APP_SECRET: verifies that webhooks really come from Meta." />
            <Check ok={env.verifyToken} label="Verify token" hint="WHATSAPP_VERIFY_TOKEN: any random string; enter the same value in Meta." />
            <Check
              ok={env.accessToken || Boolean(account?.hasOwnToken)}
              label="Access token"
              hint={account?.hasOwnToken ? 'Using this workspace’s own token (stored encrypted).' : 'WHATSAPP_ACCESS_TOKEN: a system-user token, or set one per workspace below.'}
            />
          </ul>
        </SettingsSection>

        <SettingsSection title="2. Webhook in Meta" description="In your Meta app: WhatsApp → Configuration → Webhook.">
          <Field label="Callback URL" hint="Use the verify token from the server configuration, then subscribe to the “messages” field.">
            <div className="flex gap-2">
              <Input readOnly value={data.webhookUrl} className="font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" size="icon" onClick={copyWebhook} aria-label="Copy webhook URL">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </Field>
          {data.webhookUrl.startsWith('http://') && (
            <p className="text-[13px] text-amber-700 dark:text-amber-400">Meta requires a public HTTPS URL. For local testing use a tunnel such as cloudflared or ngrok.</p>
          )}
        </SettingsSection>
      </div>

      <SettingsSection
        title="3. Phone number"
        description="Find both IDs in Meta Business Manager → WhatsApp Manager → Phone numbers, or in your app’s WhatsApp → API Setup."
      >
        {!data.canManage ? (
          <p className="text-sm text-muted-foreground">
            {account ? `Phone number ID ${account.phoneNumberId} · Business account ${account.businessAccountId}. ` : 'No number connected. '}Only workspace owners can change
            the connection.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Phone number ID" htmlFor="wa-phone-id" error={errors.phoneNumberId}>
                <Input id="wa-phone-id" inputMode="numeric" className="font-mono text-[13px]" value={form.phoneNumberId} onChange={(e) => setForm((f) => ({ ...f, phoneNumberId: e.target.value.trim() }))} />
              </Field>
              <Field label="WhatsApp Business account ID" htmlFor="wa-waba" error={errors.businessAccountId}>
                <Input id="wa-waba" inputMode="numeric" className="font-mono text-[13px]" value={form.businessAccountId} onChange={(e) => setForm((f) => ({ ...f, businessAccountId: e.target.value.trim() }))} />
              </Field>
              <Field label="Display number" htmlFor="wa-display" error={errors.displayPhoneNumber} hint="Optional, filled in by the connection test.">
                <Input id="wa-display" value={form.displayPhoneNumber} placeholder="+49 30 1234567" onChange={(e) => setForm((f) => ({ ...f, displayPhoneNumber: e.target.value }))} />
              </Field>
            </div>
            <Field
              label="Access token for this workspace"
              htmlFor="wa-token"
              error={errors.accessToken}
              hint={
                account?.hasOwnToken ? (
                  <>
                    A token is stored (encrypted). Enter a new one to replace it, or{' '}
                    <button type="button" className="underline underline-offset-2" onClick={() => save(true)}>
                      use the server token instead
                    </button>
                    .
                  </>
                ) : (
                  'Optional. Leave empty to use WHATSAPP_ACCESS_TOKEN from the server environment.'
                )
              }
            >
              <Input
                id="wa-token"
                type="password"
                autoComplete="off"
                placeholder={account?.hasOwnToken ? '•••••••••••• (stored)' : 'Optional'}
                value={form.accessToken}
                onChange={(e) => setForm((f) => ({ ...f, accessToken: e.target.value }))}
              />
            </Field>
            <div className="flex justify-end">
              <Button onClick={() => save()} disabled={busy !== null}>
                {busy === 'save' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {data.connected ? 'Save connection' : 'Connect number'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Message templates"
        description="WhatsApp only allows free-form replies within 24 hours of the customer’s last message. After that, your team can reach out with a template approved by Meta (from the inbox)."
        action={
          data.connected ? (
            <Button variant="outline" size="sm" onClick={syncTemplates} disabled={busy !== null}>
              {busy === 'sync' ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <RefreshCw className="me-2 h-4 w-4" />}
              Sync from Meta
            </Button>
          ) : null
        }
      >
        {data.templates.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {data.connected ? 'No templates yet. Create them in WhatsApp Manager, then sync.' : 'Connect a number to sync templates.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Text</TableHead>
                  <TableHead className="text-end">Variables</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <p className="font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.language} · {t.category.toLowerCase()}
                        {!t.supported && ' · media/links: send from WhatsApp Manager'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_STYLE[t.status] ?? 'bg-muted text-muted-foreground')}>
                        {t.status.toLowerCase()}
                      </span>
                    </TableCell>
                    <TableCell className="hidden max-w-md md:table-cell">
                      <p className="line-clamp-2 text-[13px] text-muted-foreground">{t.body}</p>
                    </TableCell>
                    <TableCell className="text-end text-sm">{t.variables}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Recent webhook activity" description="Messages and delivery updates received from Meta. Failed events are retried automatically with backoff.">
        {data.recentEvents.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing received yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-end">Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentEvents.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">{e.eventType === 'status' ? 'Delivery update' : 'Message'}</TableCell>
                    <TableCell className="text-sm">
                      {e.status === 'PROCESSED' ? (
                        <span className="text-emerald-600 dark:text-emerald-400">Processed</span>
                      ) : e.status === 'IGNORED' ? (
                        <span className="text-muted-foreground">Ignored{e.error ? `: ${e.error}` : ''}</span>
                      ) : e.status === 'FAILED' ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          Failed (attempt {e.attempts}){e.error ? `: ${e.error}` : ''}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Queued</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-end text-sm text-muted-foreground">
                      <Ago iso={e.createdAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription>
              The assistant stops receiving and answering WhatsApp messages for this number. Conversations and customers are kept. You can reconnect any
              time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={disconnect}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
