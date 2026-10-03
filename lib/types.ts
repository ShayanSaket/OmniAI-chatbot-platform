// Client-safe string unions mirroring Prisma enums (importing @prisma/client in
// client components would pull server code into the bundle).

export type { Role, Permission } from './permissions';

export type ChannelType =
  | 'WEBSITE'
  | 'WHATSAPP'
  | 'INSTAGRAM'
  | 'MESSENGER'
  | 'TELEGRAM'
  | 'EMAIL'
  | 'SMS';

export type ConversationStatus = 'AI_ACTIVE' | 'WAITING_FOR_AGENT' | 'HUMAN_ACTIVE' | 'CLOSED';

export type Intent =
  | 'FAQ'
  | 'SALES'
  | 'SUPPORT'
  | 'PRICING'
  | 'DEMO'
  | 'CONTACT'
  | 'COMPLAINT'
  | 'TECHNICAL'
  | 'OTHER';

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'PROPOSAL' | 'WON' | 'LOST';

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}
