'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/agent/form-parts';
import { api } from '@/lib/api-client';
import {
  ACTION_INFO,
  AUTOMATION_TRIGGERS,
  automationInputSchema,
  CHANNEL_NAMES,
  INTENT_NAMES,
  TEMPLATE_VARIABLES,
  TRIGGER_INFO,
  type AutomationAction,
  type AutomationActionType,
  type AutomationInput,
} from '@/lib/automations';
import { humanize } from '@/lib/format';

export interface BuilderOptions {
  members: { userId: string; role: string; name: string }[];
  endpoints: { id: string; label: string; isActive: boolean }[];
}

const DEFAULT_ACTION: Record<AutomationActionType, AutomationAction> = {
  SEND_MESSAGE: { type: 'SEND_MESSAGE', text: '' },
  CREATE_LEAD: { type: 'CREATE_LEAD', requestedService: '', temperature: 'WARM' },
  ADD_TAG: { type: 'ADD_TAG', tag: '' },
  ASSIGN_AGENT: { type: 'ASSIGN_AGENT', mode: 'round_robin' },
  CREATE_TICKET: { type: 'CREATE_TICKET', subject: '', priority: 'MEDIUM' },
  TRIGGER_WEBHOOK: { type: 'TRIGGER_WEBHOOK', endpointId: '' },
  NOTIFY_TEAM: { type: 'NOTIFY_TEAM', message: '', recipients: 'admins' },
  REQUEST_HANDOFF: { type: 'REQUEST_HANDOFF' },
};

export const EMPTY_AUTOMATION: AutomationInput = {
  name: '',
  description: null,
  trigger: 'MESSAGE_RECEIVED',
  conditions: { channels: [], keywords: [], intents: [], teamStatus: 'any', inactiveMinutes: 30, lastMessageFrom: 'any' },
  actions: [],
  isActive: true,
};

function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on ? Array.from(new Set([...list, value])) : list.filter((v) => v !== value);
}

function ActionEditor({ action, options, onChange }: { action: AutomationAction; options: BuilderOptions; onChange: (a: AutomationAction) => void }) {
  switch (action.type) {
    case 'SEND_MESSAGE':
      return (
        <Textarea rows={3} placeholder="Hi {{customer.firstName|there}}, …" value={action.text} onChange={(e) => onChange({ ...action, text: e.target.value })} aria-label="Message" />
      );
    case 'CREATE_LEAD':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          <Input placeholder="Requested service (optional)" value={action.requestedService} onChange={(e) => onChange({ ...action, requestedService: e.target.value })} aria-label="Requested service" />
          <Select value={action.temperature} onValueChange={(v) => onChange({ ...action, temperature: v as 'COLD' | 'WARM' | 'HOT' })}>
            <SelectTrigger aria-label="Lead temperature">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['COLD', 'WARM', 'HOT'] as const).map((t) => (
                <SelectItem key={t} value={t}>
                  {humanize(t)} lead
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case 'ADD_TAG':
      return <Input placeholder="Tag name, e.g. Pricing" value={action.tag} maxLength={40} onChange={(e) => onChange({ ...action, tag: e.target.value })} aria-label="Tag" />;
    case 'ASSIGN_AGENT':
      return (
        <Select
          value={action.mode === 'round_robin' ? 'round_robin' : (action.userId ?? '')}
          onValueChange={(v) => onChange(v === 'round_robin' ? { type: 'ASSIGN_AGENT', mode: 'round_robin' } : { type: 'ASSIGN_AGENT', mode: 'user', userId: v })}
        >
          <SelectTrigger aria-label="Assignee">
            <SelectValue placeholder="Choose a team member" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="round_robin">Round robin (agent with the fewest open chats)</SelectItem>
            {options.members.map((m) => (
              <SelectItem key={m.userId} value={m.userId}>
                {m.name} · {humanize(m.role)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'CREATE_TICKET':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          <Input placeholder="Subject, e.g. Refund request from {{customer.name}}" value={action.subject} onChange={(e) => onChange({ ...action, subject: e.target.value })} aria-label="Ticket subject" />
          <Select value={action.priority} onValueChange={(v) => onChange({ ...action, priority: v as typeof action.priority })}>
            <SelectTrigger aria-label="Priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {humanize(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case 'TRIGGER_WEBHOOK':
      return options.endpoints.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Add a webhook endpoint under Integrations first.</p>
      ) : (
        <Select value={action.endpointId} onValueChange={(v) => onChange({ ...action, endpointId: v })}>
          <SelectTrigger aria-label="Webhook endpoint">
            <SelectValue placeholder="Choose an endpoint" />
          </SelectTrigger>
          <SelectContent>
            {options.endpoints.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.label}
                {e.isActive ? '' : ' (disabled)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'NOTIFY_TEAM':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_170px]">
          <Input placeholder="{{customer.name|A customer}} asked about …" value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })} aria-label="Notification text" />
          <Select value={action.recipients} onValueChange={(v) => onChange({ ...action, recipients: v as typeof action.recipients })}>
            <SelectTrigger aria-label="Recipients">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admins">Owners & admins</SelectItem>
              <SelectItem value="everyone">Whole team</SelectItem>
              <SelectItem value="assignee">Assigned agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case 'REQUEST_HANDOFF':
      return <p className="text-[13px] text-muted-foreground">The AI stops replying and the conversation waits for a team member (outside business hours the customer is told when you’re back).</p>;
  }
}

export function AutomationBuilder({
  open,
  initial,
  automationId,
  options,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: AutomationInput;
  automationId: string | null;
  options: BuilderOptions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<AutomationInput>(initial);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof AutomationInput>(k: K, v: AutomationInput[K]) => setValue((s) => ({ ...s, [k]: v }));
  const setCond = <K extends keyof AutomationInput['conditions']>(k: K, v: AutomationInput['conditions'][K]) => setValue((s) => ({ ...s, conditions: { ...s.conditions, [k]: v } }));
  const setAction = (i: number, a: AutomationAction) => setValue((s) => ({ ...s, actions: s.actions.map((x, j) => (j === i ? a : x)) }));
  const moveAction = (i: number, d: -1 | 1) =>
    setValue((s) => {
      const actions = [...s.actions];
      [actions[i], actions[i + d]] = [actions[i + d]!, actions[i]!];
      return { ...s, actions };
    });

  const addKeyword = () => {
    const k = keywordDraft.trim();
    if (k.length >= 2 && !value.conditions.keywords.includes(k)) setCond('keywords', [...value.conditions.keywords, k]);
    setKeywordDraft('');
  };

  async function save() {
    const parsed = automationInputSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the automation');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api(automationId ? `/api/v1/automations/${automationId}` : '/api/v1/automations', { method: automationId ? 'PUT' : 'POST', json: parsed.data });
      toast.success(automationId ? 'Automation saved' : 'Automation created', { description: value.isActive ? 'It runs from the next matching event.' : 'It is switched off.' });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const t = value.trigger;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{automationId ? 'Edit automation' : 'New automation'}</DialogTitle>
          <DialogDescription>When something happens, check the conditions, then run the actions in order.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Name" htmlFor="auto-name">
            <Input id="auto-name" placeholder="Hand refund requests to billing" value={value.name} onChange={(e) => set('name', e.target.value)} />
          </Field>

          <div className="space-y-2 rounded-lg border p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">1 · When</p>
            <Select value={t} onValueChange={(v) => set('trigger', v as AutomationInput['trigger'])}>
              <SelectTrigger aria-label="Trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_TRIGGERS.map((tr) => (
                  <SelectItem key={tr} value={tr}>
                    {TRIGGER_INFO[tr].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[13px] text-muted-foreground">{TRIGGER_INFO[t].description}</p>
            {t === 'CONVERSATION_INACTIVE' && (
              <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
                No new message for
                <Input type="number" min={5} max={10080} className="h-8 w-24" value={value.conditions.inactiveMinutes} onChange={(e) => setCond('inactiveMinutes', Math.max(5, Number(e.target.value) || 5))} aria-label="Minutes" />
                minutes, and the last message came from
                <Select value={value.conditions.lastMessageFrom} onValueChange={(v) => setCond('lastMessageFrom', v as 'any' | 'customer' | 'team')}>
                  <SelectTrigger className="h-8 w-40" aria-label="Last message from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">anyone</SelectItem>
                    <SelectItem value="customer">the customer</SelectItem>
                    <SelectItem value="team">the AI or team</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">2 · Only if</p>
            {(t === 'KEYWORD_DETECTED' || t === 'MESSAGE_RECEIVED' || t === 'WHATSAPP_MESSAGE_RECEIVED') && (
              <Field label={t === 'KEYWORD_DETECTED' ? 'The message contains one of these words' : 'Message contains (optional)'} hint="Whole words, any language, not case-sensitive.">
                <div className="flex flex-wrap gap-1.5">
                  {value.conditions.keywords.map((k) => (
                    <span key={k} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs">
                      {k}
                      <button type="button" aria-label={`Remove ${k}`} onClick={() => setCond('keywords', value.conditions.keywords.filter((x) => x !== k))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input placeholder="e.g. refund" value={keywordDraft} onChange={(e) => setKeywordDraft(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? (e.preventDefault(), addKeyword()) : undefined)} aria-label="Keyword" />
                  <Button type="button" variant="outline" onClick={addKeyword}>
                    Add
                  </Button>
                </div>
              </Field>
            )}
            {(t === 'INTENT_DETECTED' || t === 'MESSAGE_RECEIVED' || t === 'LEAD_CREATED') && (
              <Field label={t === 'INTENT_DETECTED' ? 'The customer’s intent is' : 'Intent (optional)'}>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {INTENT_NAMES.filter((i) => i !== 'OTHER').map((i) => (
                    <label key={i} className="flex items-center gap-1.5 text-sm">
                      <Checkbox checked={value.conditions.intents.includes(i)} onCheckedChange={(v) => setCond('intents', toggle(value.conditions.intents, i, v === true))} />
                      {humanize(i)}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Channel">
                <div className="flex gap-4 pt-1">
                  {CHANNEL_NAMES.map((c) => (
                    <label key={c} className="flex items-center gap-1.5 text-sm">
                      <Checkbox checked={value.conditions.channels.includes(c)} onCheckedChange={(v) => setCond('channels', toggle(value.conditions.channels, c, v === true))} />
                      {c === 'WEBSITE' ? 'Website' : 'WhatsApp'}
                    </label>
                  ))}
                </div>
                <p className="text-[12px] text-muted-foreground">None selected = all channels.</p>
              </Field>
              <Field label="Team status">
                <Select value={value.conditions.teamStatus} onValueChange={(v) => setCond('teamStatus', v as 'any' | 'online' | 'offline')}>
                  <SelectTrigger aria-label="Team status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any time</SelectItem>
                    <SelectItem value="online">During business hours</SelectItem>
                    <SelectItem value="offline">Outside business hours</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">3 · Then</p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={value.actions.length >= 10}>
                    <Plus className="me-1.5 h-4 w-4" /> Add action
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(Object.keys(ACTION_INFO) as AutomationActionType[]).map((type) => (
                    <DropdownMenuItem key={type} onSelect={() => set('actions', [...value.actions, DEFAULT_ACTION[type]])}>
                      <div>
                        <p className="text-sm">{ACTION_INFO[type].label}</p>
                        <p className="text-xs text-muted-foreground">{ACTION_INFO[type].description}</p>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {value.actions.length === 0 && <p className="text-sm text-muted-foreground">Add at least one action.</p>}
            {value.actions.map((action, i) => (
              <div key={i} className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {i + 1}. {ACTION_INFO[action.type].label}
                  </span>
                  <div className="ms-auto flex">
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} onClick={() => moveAction(i, -1)} aria-label="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === value.actions.length - 1} onClick={() => moveAction(i, 1)} aria-label="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => set('actions', value.actions.filter((_, j) => j !== i))} aria-label="Remove action">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <ActionEditor action={action} options={options} onChange={(a) => setAction(i, a)} />
              </div>
            ))}
            <p className="text-[12px] text-muted-foreground">
              Variables: {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(' ')} · fallback: {'{{customer.firstName|there}}'}
            </p>
          </div>

          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={value.isActive} onCheckedChange={(v) => set('isActive', v)} aria-label="Active" />
            Active
          </label>
          {error && <p className="text-[13px] font-medium text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {automationId ? 'Save automation' : 'Create automation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
