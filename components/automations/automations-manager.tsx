'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { CheckCircle2, CircleSlash, Loader2, MoreHorizontal, Plus, Sparkles, Workflow, XCircle } from 'lucide-react';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api-client';
import { ACTION_INFO, TRIGGER_INFO, type AutomationAction, type AutomationInput } from '@/lib/automations';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AutomationBuilder, EMPTY_AUTOMATION, type BuilderOptions } from './automation-builder';

export interface AutomationItem extends AutomationInput {
  id: string;
  runCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

interface RunItem {
  id: string;
  eventType: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  results: { type: string; ok: boolean; skipped?: boolean; detail: string }[];
  createdAt: string;
  durationMs: number | null;
}

const cond = (over: Partial<AutomationInput['conditions']>): AutomationInput['conditions'] => ({ ...EMPTY_AUTOMATION.conditions, ...over });

const TEMPLATES: { title: string; description: string; value: AutomationInput }[] = [
  {
    title: 'Hand refund requests to a human',
    description: 'Keywords like “refund” stop the AI, tag the customer and alert admins.',
    value: {
      ...EMPTY_AUTOMATION,
      name: 'Refund requests go to the team',
      trigger: 'KEYWORD_DETECTED',
      conditions: cond({ keywords: ['refund', 'Rückerstattung', 'chargeback'] }),
      actions: [
        { type: 'ADD_TAG', tag: 'Refund' },
        { type: 'REQUEST_HANDOFF' },
        { type: 'NOTIFY_TEAM', message: '{{customer.name|A customer}} asked for a refund: {{message.text}}', recipients: 'admins' },
      ],
    },
  },
  {
    title: 'Pricing questions become leads',
    description: 'When the AI detects a pricing or demo question, create a lead and tag it.',
    value: {
      ...EMPTY_AUTOMATION,
      name: 'Pricing interest → lead',
      trigger: 'INTENT_DETECTED',
      conditions: cond({ intents: ['PRICING', 'DEMO'] }),
      actions: [
        { type: 'CREATE_LEAD', requestedService: 'Pricing / demo inquiry', temperature: 'WARM' },
        { type: 'ADD_TAG', tag: 'Pricing' },
      ],
    },
  },
  {
    title: 'Assign handoffs automatically',
    description: 'Every handed-over conversation goes to the agent with the fewest open chats.',
    value: { ...EMPTY_AUTOMATION, name: 'Round-robin handoffs', trigger: 'HANDOFF_REQUESTED', actions: [{ type: 'ASSIGN_AGENT', mode: 'round_robin' }] },
  },
  {
    title: 'Follow up quiet conversations',
    description: 'If the customer hasn’t answered for an hour, check in once.',
    value: {
      ...EMPTY_AUTOMATION,
      name: 'Gentle follow-up',
      trigger: 'CONVERSATION_INACTIVE',
      conditions: cond({ inactiveMinutes: 60, lastMessageFrom: 'team' }),
      actions: [{ type: 'SEND_MESSAGE', text: 'Hi {{customer.firstName|there}}, is there anything else I can help you with?' }],
    },
  },
  {
    title: 'After-hours WhatsApp notice',
    description: 'Tell WhatsApp customers outside business hours that the team follows up.',
    value: {
      ...EMPTY_AUTOMATION,
      name: 'WhatsApp after hours',
      trigger: 'CONVERSATION_CREATED',
      conditions: cond({ channels: ['WHATSAPP'], teamStatus: 'offline' }),
      actions: [{ type: 'SEND_MESSAGE', text: 'Thanks for your message! Our team is offline right now — our AI assistant can help, and a colleague will follow up during business hours.' }],
    },
  },
];

function describeAction(a: AutomationAction) {
  return ACTION_INFO[a.type].label;
}

function RunsSheet({ automation, onClose }: { automation: AutomationItem | null; onClose: () => void }) {
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const load = useCallback(async (id: string) => {
    setRuns(null);
    try {
      const res = await api<{ data: RunItem[] }>(`/api/v1/automations/${id}/runs`);
      setRuns(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load runs');
      setRuns([]);
    }
  }, []);
  useEffect(() => {
    if (automation) void load(automation.id);
  }, [automation, load]);
  return (
    <Sheet
      open={automation !== null}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{automation?.name}</SheetTitle>
          <SheetDescription>Recent runs and what each action did.</SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-3">
          {!runs ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            runs.map((r) => (
              <div key={r.id} className="rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={r.status === 'SUCCESS' ? 'default' : r.status === 'SKIPPED' ? 'secondary' : 'destructive'}>{humanize(r.status)}</Badge>
                  <span className="text-muted-foreground">{r.eventType}</span>
                  <span className="ms-auto text-xs text-muted-foreground" suppressHydrationWarning>
                    {formatDistanceToNowStrict(new Date(r.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <ul className="mt-2 space-y-1">
                  {r.results.map((x, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px]">
                      {x.ok ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      ) : x.skipped ? (
                        <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      )}
                      <span>
                        <span className="font-medium">{ACTION_INFO[x.type as keyof typeof ACTION_INFO]?.label ?? x.type}:</span> {x.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function AutomationsManager({ initial, options }: { initial: AutomationItem[]; options: BuilderOptions }) {
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<{ value: AutomationInput; id: string | null; key: number } | null>(null);
  const [deleting, setDeleting] = useState<AutomationItem | null>(null);
  const [runsFor, setRunsFor] = useState<AutomationItem | null>(null);

  const refresh = async () => {
    try {
      const res = await api<{ data: { automations: AutomationItem[] } }>('/api/v1/automations');
      setItems(res.data.automations);
    } catch {
      /* keep */
    }
  };

  async function toggle(a: AutomationItem, isActive: boolean) {
    setItems((list) => list.map((x) => (x.id === a.id ? { ...x, isActive } : x)));
    try {
      await api(`/api/v1/automations/${a.id}`, { method: 'PATCH', json: { isActive } });
    } catch (err) {
      setItems((list) => list.map((x) => (x.id === a.id ? { ...x, isActive: !isActive } : x)));
      toast.error(err instanceof Error ? err.message : 'Could not update');
    }
  }

  async function remove(a: AutomationItem) {
    try {
      await api(`/api/v1/automations/${a.id}`, { method: 'DELETE' });
      toast.success('Automation deleted');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  const openBuilder = (value: AutomationInput, id: string | null) => setEditing({ value, id, key: Date.now() });

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="me-auto">
            <h2 className="text-base font-semibold tracking-tight">Your automations</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Rules that run on every channel, before the AI answers.</p>
          </div>
          <Button onClick={() => openBuilder(EMPTY_AUTOMATION, null)}>
            <Plus className="me-2 h-4 w-4" /> New automation
          </Button>
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center">
            <Workflow className="h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No automations yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Start from a template below or build your own.</p>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {items.map((a) => (
              <div key={a.id} className={cn('flex flex-wrap items-center gap-3 p-4', !a.isActive && 'opacity-70')}>
                <Switch checked={a.isActive} onCheckedChange={(v) => toggle(a, v)} aria-label={`${a.name} active`} />
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => openBuilder(a, a.id)}>
                  <p className="truncate font-medium">{a.name}</p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">{TRIGGER_INFO[a.trigger].label}</span>
                    {a.conditions.keywords.length ? ` · “${a.conditions.keywords.slice(0, 3).join('”, “')}”` : ''}
                    {a.conditions.intents.length ? ` · ${a.conditions.intents.map(humanize).join(', ')}` : ''}
                    {' → '}
                    {a.actions.map(describeAction).join(', ')}
                  </p>
                </button>
                <button type="button" className="text-end text-xs text-muted-foreground hover:text-foreground" onClick={() => setRunsFor(a)}>
                  <p>
                    {a.runCount} run{a.runCount === 1 ? '' : 's'}
                    {a.lastRunStatus && a.lastRunStatus !== 'SUCCESS' ? ` · last ${humanize(a.lastRunStatus).toLowerCase()}` : ''}
                  </p>
                  {a.lastRunAt && (
                    <p suppressHydrationWarning>last {formatDistanceToNowStrict(new Date(a.lastRunAt), { addSuffix: true })}</p>
                  )}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${a.name}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openBuilder(a, a.id)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setRunsFor(a)}>Run history</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openBuilder({ ...a, name: `${a.name} (copy)`, isActive: false }, null)}>Duplicate</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(a)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Sparkles className="h-4 w-4 text-primary" /> Templates
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.title}
              type="button"
              onClick={() => openBuilder(tpl.value, null)}
              className="rounded-xl border bg-card p-4 text-start shadow-sm shadow-black/[0.02] transition-colors hover:border-primary/50 hover:bg-primary/[0.02]"
            >
              <p className="text-sm font-medium">{tpl.title}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{tpl.description}</p>
            </button>
          ))}
        </div>
      </section>

      {editing && (
        <AutomationBuilder
          key={editing.key}
          open
          initial={editing.value}
          automationId={editing.id}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      <RunsSheet automation={runsFor} onClose={() => setRunsFor(null)} />
      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>It stops running immediately and its run history is removed. To pause it, switch it off instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove(deleting)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
