// Leads: pipeline statuses, filters, schemas and response shapes. Client-safe.
import { z } from 'zod';
import type { ChannelType, LeadStatus } from './types';

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'] as const satisfies readonly LeadStatus[];
export const OPEN_LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL'] as const;
export const LEAD_TEMPERATURES = ['COLD', 'WARM', 'HOT'] as const;
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number];

export const LEAD_STATUS_INFO: Record<LeadStatus, { label: string; description: string; dot: string }> = {
  NEW: { label: 'New', description: 'Not contacted yet', dot: 'bg-sky-500' },
  CONTACTED: { label: 'Contacted', description: 'First contact made', dot: 'bg-violet-500' },
  QUALIFIED: { label: 'Qualified', description: 'Real need and fit confirmed', dot: 'bg-amber-500' },
  PROPOSAL: { label: 'Proposal', description: 'Offer or quote sent', dot: 'bg-orange-500' },
  WON: { label: 'Won', description: 'Became a customer', dot: 'bg-emerald-500' },
  LOST: { label: 'Lost', description: 'Not pursued further', dot: 'bg-slate-400' },
};

export const PREFERRED_CONTACTS = ['email', 'phone', 'whatsapp'] as const;

export interface LeadFilters {
  q: string;
  status: 'all' | 'open' | LeadStatus;
  temperature: 'all' | LeadTemperature;
  source: 'all' | 'WEBSITE' | 'WHATSAPP' | 'MANUAL';
  assignee: 'anyone' | 'me' | 'unassigned';
}

export const DEFAULT_LEAD_FILTERS: LeadFilters = { q: '', status: 'all', temperature: 'all', source: 'all', assignee: 'anyone' };

const querySchema = z.object({
  q: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().slice(0, 100)),
  status: z.enum(['all', 'open', ...LEAD_STATUSES]).catch('all'),
  temperature: z.enum(['all', ...LEAD_TEMPERATURES]).catch('all'),
  source: z.enum(['all', 'WEBSITE', 'WHATSAPP', 'MANUAL']).catch('all'),
  assignee: z.enum(['anyone', 'me', 'unassigned']).catch('anyone'),
  cursor: z.string().max(40).optional().catch(undefined),
});

export function parseLeadQuery(params: URLSearchParams): LeadFilters & { cursor?: string } {
  return querySchema.parse(Object.fromEntries(['q', 'status', 'temperature', 'source', 'assignee', 'cursor'].map((k) => [k, params.get(k) ?? undefined])));
}

export function leadQueryString(filters: LeadFilters, cursor?: string): string {
  const p = new URLSearchParams();
  (Object.keys(filters) as (keyof LeadFilters)[]).forEach((k) => {
    if (filters[k] !== DEFAULT_LEAD_FILTERS[k]) p.set(k, String(filters[k]));
  });
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const leadFields = {
  name: text(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null))
    .refine((v) => !v || z.string().email().safeParse(v).success, 'Enter a valid email address'),
  phone: text(32).refine((v) => !v || /^\+?[0-9][0-9 ()/-]{5,30}$/.test(v), 'Enter a valid phone number'),
  company: text(120),
  requestedService: text(200),
  message: text(2000),
  preferredContact: z.enum(PREFERRED_CONTACTS).nullable().optional(),
  temperature: z.enum(LEAD_TEMPERATURES).optional(),
  estimatedValue: z.number().min(0).max(9_999_999_999).nullable().optional(),
  assignedToId: z.string().min(1).max(64).nullable().optional(),
};

export const leadCreateSchema = z
  .object({ ...leadFields, status: z.enum(LEAD_STATUSES).optional() })
  .refine((v) => v.email || v.phone, { message: 'Add an email or a phone number', path: ['email'] })
  .refine((v) => v.name || v.company, { message: 'Add a name or a company', path: ['name'] });
export type LeadCreateInput = z.infer<typeof leadCreateSchema>;

export const leadUpdateSchema = z
  .object({ ...leadFields, status: z.enum(LEAD_STATUSES).optional(), lostReason: text(300) })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

export interface LeadItem {
  id: string;
  reference: string;
  status: LeadStatus;
  temperature: LeadTemperature;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  requestedService: string | null;
  message: string | null;
  preferredContact: string | null;
  intent: string | null;
  source: ChannelType | null;
  estimatedValue: number | null;
  lostReason: string | null;
  closedAt: string | null;
  customerId: string | null;
  conversationId: string | null;
  assignedTo: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadStats {
  open: number;
  newThisWeek: number;
  pipelineValue: number;
  wonValue: number;
  /** WON ÷ (WON + LOST) over the last 90 days, null without closed leads. */
  winRate: number | null;
  /** Leads created in the last 90 days that are WON, in percent. */
  conversionRate: number | null;
  byStatus: Record<LeadStatus, number>;
}

export interface LeadActivity {
  id: string;
  action: string;
  actorName: string | null;
  detail: string;
  createdAt: string;
}

export const leadReference = (id: string) => `L-${id.slice(-6).toUpperCase()}`;
