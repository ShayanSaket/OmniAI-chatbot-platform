// Unified inbox: filters, request schemas and response shapes. Client-safe.
import { z } from 'zod';
import type { ChannelType, ConversationStatus, Intent } from './types';

export const INBOX_STATUS_FILTERS = ['open', 'closed', 'all'] as const;
export const INBOX_CHANNEL_FILTERS = ['all', 'WEBSITE', 'WHATSAPP'] as const;
/** ai = AI is answering · human = waiting for or handled by a person · waiting = needs someone now */
export const INBOX_MODE_FILTERS = ['any', 'ai', 'human', 'waiting'] as const;
export const INBOX_ASSIGNEE_FILTERS = ['anyone', 'me', 'unassigned'] as const;

export interface InboxFilters {
  status: (typeof INBOX_STATUS_FILTERS)[number];
  channel: (typeof INBOX_CHANNEL_FILTERS)[number];
  mode: (typeof INBOX_MODE_FILTERS)[number];
  assignee: (typeof INBOX_ASSIGNEE_FILTERS)[number];
  unread: boolean;
  q: string;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = { status: 'open', channel: 'all', mode: 'any', assignee: 'anyone', unread: false, q: '' };

const inboxQuerySchema = z.object({
  status: z.enum(INBOX_STATUS_FILTERS).catch('open'),
  channel: z.enum(INBOX_CHANNEL_FILTERS).catch('all'),
  mode: z.enum(INBOX_MODE_FILTERS).catch('any'),
  assignee: z.enum(INBOX_ASSIGNEE_FILTERS).catch('anyone'),
  unread: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  q: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().slice(0, 100)),
  cursor: z.string().max(120).optional().catch(undefined),
});

/** Parses list filters from URL search params; unknown values fall back to defaults. */
export function parseInboxQuery(params: URLSearchParams): InboxFilters & { cursor?: string } {
  const raw = Object.fromEntries(['status', 'channel', 'mode', 'assignee', 'unread', 'q', 'cursor'].map((k) => [k, params.get(k) ?? undefined]));
  return inboxQuerySchema.parse(raw);
}

export function inboxQueryString(filters: InboxFilters, cursor?: string): string {
  const p = new URLSearchParams();
  (Object.keys(filters) as (keyof InboxFilters)[]).forEach((k) => {
    const v = filters[k];
    if (v !== DEFAULT_INBOX_FILTERS[k]) p.set(k, String(v === true ? 1 : v));
  });
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export const MAX_AGENT_ATTACHMENTS = 5;
export const MAX_AGENT_MESSAGE_LENGTH = 4000;

const receiptSchema = z.object({
  key: z.string().min(1).max(500),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().positive(),
  sig: z.string().min(1).max(200),
});

export const agentReplySchema = z
  .object({
    content: z.string().max(MAX_AGENT_MESSAGE_LENGTH, `Messages can be at most ${MAX_AGENT_MESSAGE_LENGTH} characters`).default(''),
    attachments: z.array(receiptSchema).max(MAX_AGENT_ATTACHMENTS).default([]),
    /** Client-generated id: a retried request never sends the message twice. */
    clientMessageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  .refine((v) => v.content.trim().length > 0 || v.attachments.length > 0, { message: 'Write a message or attach a file', path: ['content'] });
export type AgentReplyInput = z.infer<typeof agentReplySchema>;

export const assignSchema = z.object({ assigneeId: z.string().min(1).max(64).nullable() });

export const SUGGESTION_ACTIONS = ['generate', 'shorten', 'friendlier', 'professional', 'translate'] as const;
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number];

export const SUGGESTION_INFO: Record<SuggestionAction, { label: string; needsDraft: boolean }> = {
  generate: { label: 'Generate reply', needsDraft: false },
  shorten: { label: 'Shorten', needsDraft: true },
  friendlier: { label: 'Make friendlier', needsDraft: true },
  professional: { label: 'Make professional', needsDraft: true },
  translate: { label: 'Translate', needsDraft: true },
};

export const suggestionSchema = z
  .object({
    action: z.enum(SUGGESTION_ACTIONS),
    draft: z.string().max(MAX_AGENT_MESSAGE_LENGTH).default(''),
    /** Target language for "translate" (ISO 639-1); defaults to the customer's language. */
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  })
  .refine((v) => !SUGGESTION_INFO[v.action].needsDraft || v.draft.trim().length > 0, { message: 'Write a draft first', path: ['draft'] });
export type SuggestionInput = z.infer<typeof suggestionSchema>;

export const customerNoteSchema = z.object({ content: z.string().trim().min(1, 'Write a note').max(2000) });

// ─── Response shapes ──────────────────────────────────────────────────

export interface InboxCustomer {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  isAnonymous: boolean;
}

export interface InboxConversationItem {
  id: string;
  channel: ChannelType;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  intent: Intent | null;
  leadTemperature: 'COLD' | 'WARM' | 'HOT' | null;
  handoffRequestedAt: string | null;
  assignedTo: { id: string; name: string | null } | null;
  customer: InboxCustomer;
}

export interface InboxCounts {
  open: number;
  waiting: number;
  mine: number;
  unread: number;
}

export type InboxSender = 'CUSTOMER' | 'AI' | 'AGENT' | 'SYSTEM';

export interface InboxMessage {
  id: string;
  senderType: InboxSender;
  messageType: string;
  content: string;
  createdAt: string;
  status: 'PENDING' | 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  errorCode: string | null;
  error: string | null;
  authorName: string | null;
  attachments: { fileName: string; mimeType: string; size: number; url: string }[];
  sources: { title: string }[];
  intent: Intent | null;
  /** e.g. "Template: order_update", "Automation: Refund handoff" */
  label: string | null;
  clientMessageId: string | null;
}

export interface InboxConversationDetail extends InboxConversationItem {
  sentiment: string | null;
  handoffReason: string | null;
  closedAt: string | null;
  createdAt: string;
  customer: InboxCustomer & {
    company: string | null;
    language: string | null;
    whatsappNumber: string | null;
    tags: { name: string; color: string }[];
    facts: string[];
    createdAt: string;
  };
  summary: { text: string; createdAt: string } | null;
  leads: { id: string; status: string; temperature: string; requestedService: string | null; createdAt: string }[];
  tickets: { id: string; reference: string; subject: string; status: string; priority: string; createdAt: string }[];
  appointments: { id: string; status: string; topic: string; preferredTime: string; createdAt: string }[];
  notes: { id: string; content: string; authorId: string | null; authorName: string | null; createdAt: string }[];
  otherConversations: { id: string; channel: ChannelType; status: ConversationStatus; lastMessageAt: string; lastMessagePreview: string | null }[];
  /** WhatsApp only: free-form replies are allowed until this time (24-hour window). */
  window: { open: boolean; closesAt: string | null } | null;
  messages: InboxMessage[];
  hasOlder: boolean;
}

export interface InboxMember {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

/** Best available label for a customer. */
export function customerDisplayName(c: Pick<InboxCustomer, 'id' | 'name' | 'email' | 'phone'>): string {
  return c.name?.trim() || c.email || c.phone || `Visitor ${c.id.slice(-4).toUpperCase()}`;
}

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  AI_ACTIVE: 'AI',
  WAITING_FOR_AGENT: 'Waiting',
  HUMAN_ACTIVE: 'Human',
  CLOSED: 'Closed',
};
