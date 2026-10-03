// Automation definitions shared by the builder UI and the engine. Client-safe.
import { z } from 'zod';

export const AUTOMATION_TRIGGERS = [
  'CONVERSATION_CREATED',
  'MESSAGE_RECEIVED',
  'WHATSAPP_MESSAGE_RECEIVED',
  'KEYWORD_DETECTED',
  'INTENT_DETECTED',
  'LEAD_CREATED',
  'HANDOFF_REQUESTED',
  'CONVERSATION_INACTIVE',
] as const;
export type AutomationTriggerName = (typeof AUTOMATION_TRIGGERS)[number];

export const TRIGGER_INFO: Record<AutomationTriggerName, { label: string; description: string }> = {
  CONVERSATION_CREATED: { label: 'New conversation', description: 'A customer starts a conversation.' },
  MESSAGE_RECEIVED: { label: 'Message received', description: 'Any customer message, on any channel.' },
  WHATSAPP_MESSAGE_RECEIVED: { label: 'New WhatsApp message', description: 'A customer message on WhatsApp.' },
  KEYWORD_DETECTED: { label: 'Keyword detected', description: 'A customer message contains one of your keywords.' },
  INTENT_DETECTED: { label: 'Customer intent', description: 'The AI recognizes an intent, e.g. asking about pricing.' },
  LEAD_CREATED: { label: 'Lead created', description: 'A sales lead is captured.' },
  HANDOFF_REQUESTED: { label: 'Human handoff requested', description: 'A conversation is handed to the team.' },
  CONVERSATION_INACTIVE: { label: 'Conversation inactive', description: 'No new message for a while.' },
};

export const INTENT_NAMES = ['FAQ', 'SALES', 'SUPPORT', 'PRICING', 'DEMO', 'CONTACT', 'COMPLAINT', 'TECHNICAL', 'OTHER'] as const;
export const CHANNEL_NAMES = ['WEBSITE', 'WHATSAPP'] as const;

export const automationConditionsSchema = z
  .object({
    channels: z.array(z.enum(CHANNEL_NAMES)).max(2).default([]),
    keywords: z.array(z.string().trim().min(2).max(60)).max(30).default([]),
    intents: z.array(z.enum(INTENT_NAMES)).max(9).default([]),
    teamStatus: z.enum(['any', 'online', 'offline']).default('any'),
    /** CONVERSATION_INACTIVE: minutes without a new message. */
    inactiveMinutes: z.number().int().min(5).max(7 * 24 * 60).default(30),
    /** CONVERSATION_INACTIVE: who sent the last message. */
    lastMessageFrom: z.enum(['any', 'customer', 'team']).default('any'),
  })
  .default({});
export type AutomationConditions = z.infer<typeof automationConditionsSchema>;

const text = (max: number) => z.string().trim().min(1, 'Required').max(max);

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SEND_MESSAGE'), text: text(1000) }),
  z.object({ type: z.literal('CREATE_LEAD'), requestedService: z.string().trim().max(200).default(''), temperature: z.enum(['COLD', 'WARM', 'HOT']).default('WARM') }),
  z.object({ type: z.literal('ADD_TAG'), tag: text(40) }),
  z.object({ type: z.literal('ASSIGN_AGENT'), mode: z.enum(['user', 'round_robin']), userId: z.string().max(64).optional() }),
  z.object({ type: z.literal('CREATE_TICKET'), subject: text(140), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM') }),
  z.object({ type: z.literal('TRIGGER_WEBHOOK'), endpointId: text(64) }),
  z.object({ type: z.literal('NOTIFY_TEAM'), message: text(500), recipients: z.enum(['everyone', 'admins', 'assignee']).default('admins') }),
  z.object({ type: z.literal('REQUEST_HANDOFF') }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationActionType = AutomationAction['type'];

export const ACTION_INFO: Record<AutomationActionType, { label: string; description: string; needsConversation: boolean }> = {
  SEND_MESSAGE: { label: 'Send message', description: 'Reply to the customer on their channel.', needsConversation: true },
  CREATE_LEAD: { label: 'Create lead', description: 'Add the customer to your sales pipeline.', needsConversation: false },
  ADD_TAG: { label: 'Add tag', description: 'Tag the customer.', needsConversation: false },
  ASSIGN_AGENT: { label: 'Assign agent', description: 'Assign the conversation to a team member.', needsConversation: true },
  CREATE_TICKET: { label: 'Create ticket', description: 'Open a support ticket.', needsConversation: false },
  TRIGGER_WEBHOOK: { label: 'Trigger webhook', description: 'Send the event to one of your webhook endpoints.', needsConversation: false },
  NOTIFY_TEAM: { label: 'Notify team', description: 'In-app notification for team members.', needsConversation: false },
  REQUEST_HANDOFF: { label: 'Hand over to a human', description: 'Stop the AI and ask the team to take over.', needsConversation: true },
};

export const automationInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter a name').max(80),
    description: z.string().trim().max(300).nullable().default(null),
    trigger: z.enum(AUTOMATION_TRIGGERS),
    conditions: automationConditionsSchema,
    actions: z.array(automationActionSchema).min(1, 'Add at least one action').max(10),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.trigger === 'KEYWORD_DETECTED' && !v.conditions.keywords.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conditions', 'keywords'], message: 'Add at least one keyword' });
    }
    if (v.trigger === 'INTENT_DETECTED' && !v.conditions.intents.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conditions', 'intents'], message: 'Choose at least one intent' });
    }
    v.actions.forEach((a, i) => {
      if (a.type === 'ASSIGN_AGENT' && a.mode === 'user' && !a.userId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions', i, 'userId'], message: 'Choose a team member' });
      }
    });
  });
export type AutomationInput = z.infer<typeof automationInputSchema>;

// ── Pure helpers (also used by the engine) ───────────────────────────

/**
 * Fills {{variables}} in message templates. "{{customer.firstName|there}}" falls back to
 * "there" when the value is empty. Unknown variables render as their fallback or "".
 */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_m, key: string, fallback?: string) => {
    const value = vars[key];
    return value !== undefined && value !== null && String(value).trim() ? String(value) : (fallback ?? '').trim();
  });
}

export const TEMPLATE_VARIABLES = [
  'customer.name',
  'customer.firstName',
  'customer.email',
  'customer.phone',
  'conversation.channel',
  'message.text',
  'company.name',
  'agent.name',
] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word (or whole-phrase), case-insensitive keyword match in any script. */
export function matchKeyword(text: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(k)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export interface ConditionFacts {
  channel: string | null;
  text: string | null;
  intent: string | null;
  teamOnline: boolean;
}

/** True when every configured condition holds (empty lists = no restriction). */
export function matchesConditions(conditions: AutomationConditions, facts: ConditionFacts): boolean {
  if (conditions.channels.length && (!facts.channel || !conditions.channels.includes(facts.channel as never))) return false;
  if (conditions.keywords.length && !conditions.keywords.some((k) => matchKeyword(facts.text ?? '', k))) return false;
  if (conditions.intents.length && (!facts.intent || !conditions.intents.includes(facts.intent as never))) return false;
  if (conditions.teamStatus === 'online' && !facts.teamOnline) return false;
  if (conditions.teamStatus === 'offline' && facts.teamOnline) return false;
  return true;
}

export function parseConditions(value: unknown): AutomationConditions {
  const parsed = automationConditionsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : automationConditionsSchema.parse({});
}

export function parseActions(value: unknown): AutomationAction[] {
  const parsed = z.array(automationActionSchema).safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}
