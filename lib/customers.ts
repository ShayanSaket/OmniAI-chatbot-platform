// Customers: list filters, edit schemas and response shapes. Client-safe.
import { z } from 'zod';
import type { ChannelType, ConversationStatus } from './types';

export const CUSTOMER_TYPES = ['all', 'identified', 'anonymous'] as const;
export const CUSTOMER_SORTS = ['recent', 'created', 'name'] as const;
export const CUSTOMER_CHANNELS = ['all', 'WEBSITE', 'WHATSAPP'] as const;

export interface CustomerFilters {
  q: string;
  type: (typeof CUSTOMER_TYPES)[number];
  channel: (typeof CUSTOMER_CHANNELS)[number];
  tag: string;
  sort: (typeof CUSTOMER_SORTS)[number];
}

export const DEFAULT_CUSTOMER_FILTERS: CustomerFilters = { q: '', type: 'all', channel: 'all', tag: '', sort: 'recent' };

const querySchema = z.object({
  q: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().slice(0, 100)),
  type: z.enum(CUSTOMER_TYPES).catch('all'),
  channel: z.enum(CUSTOMER_CHANNELS).catch('all'),
  tag: z
    .string()
    .max(64)
    .optional()
    .transform((v) => v ?? '')
    .catch(''),
  sort: z.enum(CUSTOMER_SORTS).catch('recent'),
  cursor: z.string().max(40).optional().catch(undefined),
});

export function parseCustomerQuery(params: URLSearchParams): CustomerFilters & { cursor?: string } {
  return querySchema.parse(Object.fromEntries(['q', 'type', 'channel', 'tag', 'sort', 'cursor'].map((k) => [k, params.get(k) ?? undefined])));
}

export function customerQueryString(filters: CustomerFilters, cursor?: string): string {
  const p = new URLSearchParams();
  (Object.keys(filters) as (keyof CustomerFilters)[]).forEach((k) => {
    if (filters[k] !== DEFAULT_CUSTOMER_FILTERS[k]) p.set(k, String(filters[k]));
  });
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export const MAX_CUSTOM_FIELDS = 30;
export const MAX_TAGS_PER_CUSTOMER = 20;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

export const customFieldsSchema = z
  .record(z.string().trim().min(1, 'Name the field').max(40, 'Field names can be at most 40 characters'), z.string().trim().max(500))
  .refine((v) => Object.keys(v).length <= MAX_CUSTOM_FIELDS, `At most ${MAX_CUSTOM_FIELDS} custom fields`);

export const customerUpdateSchema = z
  .object({
    name: optionalText(100),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v || null))
      .refine((v) => !v || z.string().email().safeParse(v).success, 'Enter a valid email address'),
    phone: optionalText(32).refine((v) => !v || /^\+?[0-9][0-9 ()/-]{5,30}$/.test(v), 'Enter a valid phone number'),
    company: optionalText(120),
    language: z
      .string()
      .regex(/^[a-z]{2}$/, 'Use a two-letter language code')
      .nullable()
      .optional(),
    customFields: customFieldsSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

export const tagNameSchema = z.string().trim().min(1, 'Name the tag').max(40);
export const customerTagsSchema = z.object({ tags: z.array(tagNameSchema).max(MAX_TAGS_PER_CUSTOMER) });
export const tagUpdateSchema = z.object({
  name: tagNameSchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, 'Use a hex color')
    .optional(),
});
export const mergeCustomerSchema = z.object({ sourceId: z.string().min(1).max(64) });

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const APPOINTMENT_STATUSES = ['REQUESTED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'] as const;
export const ticketUpdateSchema = z
  .object({ status: z.enum(TICKET_STATUSES).optional(), priority: z.enum(TICKET_PRIORITIES).optional() })
  .refine((v) => v.status || v.priority, 'Nothing to update');
export const appointmentUpdateSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES),
  startsAt: z.string().datetime().nullable().optional(),
});

// ─── Response shapes ──────────────────────────────────────────────────

export interface TagItem {
  id: string;
  name: string;
  color: string;
  customerCount?: number;
}

export interface CustomerListItem {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  avatarUrl: string | null;
  isAnonymous: boolean;
  language: string | null;
  channels: ChannelType[];
  tags: { id: string; name: string; color: string }[];
  conversationCount: number;
  openLeadCount: number;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface CustomerProfile extends CustomerListItem {
  aiSummary: string | null;
  customFields: Record<string, string>;
  memory: { productInterests: string[]; preferences: string[]; facts: string[] };
  consentAt: string | null;
  identities: { id: string; channel: ChannelType; label: string; createdAt: string }[];
  conversations: {
    id: string;
    channel: ChannelType;
    status: ConversationStatus;
    intent: string | null;
    lastMessagePreview: string | null;
    messageCount: number;
    summary: string | null;
    assignedTo: string | null;
    createdAt: string;
    lastMessageAt: string;
  }[];
  leads: { id: string; reference: string; status: string; temperature: string; requestedService: string | null; estimatedValue: string | null; createdAt: string }[];
  tickets: { id: string; reference: string; subject: string; status: string; priority: string; createdAt: string }[];
  appointments: { id: string; topic: string; preferredTime: string; status: string; startsAt: string | null; createdAt: string }[];
  notes: { id: string; content: string; authorId: string | null; authorName: string | null; createdAt: string }[];
  /** Other profiles with the same email or phone that the team may want to merge. */
  duplicates: { id: string; name: string | null; email: string | null; phone: string | null; matchedOn: ('email' | 'phone')[]; createdAt: string }[];
}
