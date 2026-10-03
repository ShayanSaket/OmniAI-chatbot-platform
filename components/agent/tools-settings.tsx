'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNowStrict } from 'date-fns';
import { CheckCircle2, Loader2, Plug, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AGENT_TOOLS, type AgentToolName } from '@/lib/agent-tools';
import { api } from '@/lib/api-client';
import { orderLookupTestSchema, orderLookupUpdateSchema } from '@/lib/validation';
import { Field, fieldErrorsFrom, SettingsSection } from './form-parts';

export interface OrderLookupState {
  configured: boolean;
  isActive: boolean;
  urlTemplate: string;
  hasApiKey: boolean;
  canManage: boolean;
}

export interface ToolExecutionRow {
  id: string;
  toolName: string;
  status: 'SUCCESS' | 'FAILED' | 'DENIED';
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  channel: string | null;
  customerName: string | null;
}

const GROUPS = ['Knowledge', 'Customer', 'Sales & support', 'Escalation'] as const;
const toolLabel = (name: string) => AGENT_TOOLS.find((t) => t.name === name)?.label ?? name;

function OrderLookupCard({ initial, onChange }: { initial: OrderLookupState; onChange: (s: OrderLookupState) => void }) {
  const [state, setState] = useState(initial);
  const [urlTemplate, setUrlTemplate] = useState(initial.urlTemplate);
  const [apiKey, setApiKey] = useState('');
  const [isActive, setIsActive] = useState(initial.configured ? initial.isActive : true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [test, setTest] = useState({ orderNumber: '', email: '' });
  const [testResult, setTestResult] = useState<string | null>(null);

  const apply = (next: OrderLookupState) => {
    setState(next);
    onChange(next);
  };

  async function save(removeKey = false) {
    const parsed = orderLookupUpdateSchema.safeParse({ urlTemplate, isActive, ...(removeKey ? { apiKey: null } : apiKey ? { apiKey } : {}) });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setBusy('save');
    try {
      const res = await api<{ data: OrderLookupState }>('/api/v1/integrations/order-lookup', { method: 'PUT', json: parsed.data });
      apply(res.data);
      setApiKey('');
      toast.success(removeKey ? 'API key removed' : 'Order lookup saved');
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    const parsed = orderLookupTestSchema.safeParse(test);
    if (!parsed.success) {
      setTestResult(parsed.error.issues[0]?.message ?? 'Enter an order number and email');
      return;
    }
    setBusy('test');
    setTestResult(null);
    try {
      const res = await api<{ data: { ok: boolean; found?: boolean; order?: { status: string } | null; error?: string } }>(
        '/api/v1/integrations/order-lookup/test',
        { method: 'POST', json: parsed.data },
      );
      const r = res.data;
      setTestResult(!r.ok ? `Connection failed: ${r.error}` : r.found ? `Found: status “${r.order?.status}”` : 'Connected, but no order matches this number and email.');
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('remove');
    try {
      await api('/api/v1/integrations/order-lookup', { method: 'DELETE' });
      apply({ ...state, configured: false, isActive: false, urlTemplate: '', hasApiKey: false });
      setUrlTemplate('');
      toast.success('Order lookup disconnected');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  }

  const status = state.configured ? (state.isActive ? 'Connected' : 'Paused') : 'Not connected';

  return (
    <SettingsSection
      title="Order lookup connection"
      description="Lets the assistant answer “Where is my order?” from your shop or ERP. Customers must give the order number and the email used for the order."
      action={<Badge variant={state.configured && state.isActive ? 'default' : 'secondary'}>{status}</Badge>}
    >
      {!state.canManage ? (
        <p className="text-sm text-muted-foreground">
          {state.configured ? `Endpoint: ${state.urlTemplate}` : 'No order system is connected.'} Only workspace owners can change this connection.
        </p>
      ) : (
        <div className="space-y-4">
          <Field
            label="Endpoint URL"
            htmlFor="orderUrl"
            error={errors.urlTemplate}
            hint={
              <>
                We call <code className="text-xs">GET</code> this URL with <code className="text-xs">{'{orderNumber}'}</code> replaced and{' '}
                <code className="text-xs">?email=…</code> added, expecting JSON with at least <code className="text-xs">status</code>. Return 404 when the
                order doesn’t exist or doesn’t belong to that email.
              </>
            }
          >
            <Input
              id="orderUrl"
              className="font-mono text-[13px]"
              placeholder="https://shop.example.com/api/orders/{orderNumber}"
              value={urlTemplate}
              onChange={(e) => setUrlTemplate(e.target.value)}
            />
          </Field>
          <Field
            label="API key"
            htmlFor="orderKey"
            error={errors.apiKey}
            hint={
              state.hasApiKey ? (
                <>
                  A key is stored (encrypted). Enter a new one to replace it, or{' '}
                  <button type="button" className="underline underline-offset-2" onClick={() => save(true)}>
                    remove it
                  </button>
                  .
                </>
              ) : (
                'Optional. Sent as “Authorization: Bearer …”. Stored encrypted and never shown again.'
              )
            }
          >
            <Input
              id="orderKey"
              type="password"
              autoComplete="off"
              placeholder={state.hasApiKey ? '•••••••••••• (stored)' : 'Optional'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={isActive} onCheckedChange={setIsActive} aria-label="Connection active" />
              Active
            </label>
            <div className="flex gap-2">
              {state.configured && (
                <Button variant="ghost" onClick={disconnect} disabled={busy !== null}>
                  {busy === 'remove' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                  Disconnect
                </Button>
              )}
              <Button onClick={() => save()} disabled={busy !== null}>
                {busy === 'save' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {state.configured ? 'Save connection' : 'Connect'}
              </Button>
            </div>
          </div>

          {state.configured && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3.5">
              <p className="text-sm font-medium">Test with a real order</p>
              <div className="flex flex-wrap gap-2">
                <Input className="h-9 w-36" placeholder="Order number" value={test.orderNumber} onChange={(e) => setTest((t) => ({ ...t, orderNumber: e.target.value }))} />
                <Input className="h-9 w-56" type="email" placeholder="Customer email" value={test.email} onChange={(e) => setTest((t) => ({ ...t, email: e.target.value }))} />
                <Button variant="outline" size="sm" className="h-9" onClick={runTest} disabled={busy !== null}>
                  {busy === 'test' ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Plug className="me-2 h-4 w-4" />}
                  Test
                </Button>
              </div>
              {testResult && (
                <p className="text-sm text-muted-foreground" role="status">
                  {testResult}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function ActivityLog({ initial }: { initial: ToolExecutionRow[] }) {
  const [rows, setRows] = useState(initial);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true);
    try {
      const res = await api<{ data: ToolExecutionRow[] }>('/api/v1/bot/tool-executions?limit=25');
      setRows(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }
  return (
    <SettingsSection
      title="Recent tool activity"
      description="Every action the assistant took, whether it succeeded, and why it didn’t."
      action={
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading} aria-label="Refresh activity">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No tool calls yet. Try the assistant on the test page.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="hidden sm:table-cell">Customer</TableHead>
                <TableHead className="text-end">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{toolLabel(r.toolName)}</TableCell>
                  <TableCell>
                    {r.status === 'SUCCESS' ? (
                      <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" /> Done{r.durationMs !== null ? ` · ${r.durationMs} ms` : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                        <XCircle className="h-4 w-4 text-amber-500" />
                        {r.status === 'DENIED' ? 'Not allowed' : (r.error ?? 'Failed').replace(/_/g, ' ')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {r.customerName ?? 'Visitor'}
                    {r.channel ? ` · ${r.channel === 'WHATSAPP' ? 'WhatsApp' : 'Website'}` : ''}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-end text-sm text-muted-foreground">
                    {/* Relative time differs between server render and hydration by design. */}
                    <time dateTime={r.createdAt} title={new Date(r.createdAt).toISOString()} suppressHydrationWarning>
                      {formatDistanceToNowStrict(new Date(r.createdAt), { addSuffix: true })}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsSection>
  );
}

export function ToolsSettings({
  disabledTools: initialDisabled,
  escalationDisabled,
  orderLookup: initialOrderLookup,
  executions,
}: {
  disabledTools: AgentToolName[];
  escalationDisabled: boolean;
  orderLookup: OrderLookupState;
  executions: ToolExecutionRow[];
}) {
  const router = useRouter();
  const [disabled, setDisabled] = useState<AgentToolName[]>(initialDisabled);
  const [pending, setPending] = useState<AgentToolName | null>(null);
  const [orderLookup, setOrderLookup] = useState(initialOrderLookup);

  async function toggle(name: AgentToolName, enabled: boolean) {
    const previous = disabled;
    const next = enabled ? disabled.filter((n) => n !== name) : [...disabled, name];
    setDisabled(next);
    setPending(name);
    try {
      await api('/api/v1/bot', { method: 'PATCH', json: { behavior: { disabledTools: next } } });
      toast.success(`${toolLabel(name)} ${enabled ? 'enabled' : 'disabled'}`);
      router.refresh();
    } catch (err) {
      setDisabled(previous);
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setPending(null);
    }
  }

  const orderReady = orderLookup.configured && orderLookup.isActive;

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Business tools"
        description="What the assistant may look up and do. Every action is validated on the server, limited to the current customer, and logged below. The AI only confirms an action after it succeeded."
      >
        <div className="space-y-6">
          {GROUPS.map((group) => (
            <div key={group} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</h3>
              <div className="grid gap-2 lg:grid-cols-2">
                {AGENT_TOOLS.filter((t) => t.group === group).map((tool) => {
                  const enabled = !disabled.includes(tool.name);
                  const blockedBy =
                    tool.name === 'request_human_agent' && escalationDisabled
                      ? 'Off while human escalation is set to “Never escalate” (Behavior tab).'
                      : tool.name === 'get_order_status' && !orderReady
                        ? 'Needs an active order lookup connection (below).'
                        : null;
                  return (
                    <div key={tool.name} className="flex items-start justify-between gap-4 rounded-lg border p-3.5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor={`tool-${tool.name}`} className="text-sm font-medium">
                            {tool.label}
                          </label>
                          {tool.readOnly ? <Badge variant="outline">Read-only</Badge> : <Badge variant="secondary">Takes action</Badge>}
                        </div>
                        <p className="mt-0.5 text-[13px] text-muted-foreground">{tool.description}</p>
                        {blockedBy && enabled && <p className="mt-1 text-[12px] font-medium text-amber-600 dark:text-amber-400">{blockedBy}</p>}
                      </div>
                      <Switch
                        id={`tool-${tool.name}`}
                        checked={enabled}
                        disabled={pending !== null}
                        onCheckedChange={(v) => toggle(tool.name, v)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <OrderLookupCard initial={initialOrderLookup} onChange={setOrderLookup} />
      <ActivityLog initial={executions} />
    </div>
  );
}
