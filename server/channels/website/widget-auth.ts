import 'server-only';
import type { BotConfiguration } from '@prisma/client';
import type { BusinessHoursRule } from '@/lib/business-hours';
import { prisma } from '../../db';
import { env } from '../../env';
import { AppError } from '../../errors';
import { tenantDb, type TenantDb } from '../../tenancy/tenant-db';
import { verifyVisitorToken, type VisitorClaims } from './visitor-token';

export interface ResolvedBot {
  bot: BotConfiguration;
  organization: { id: string; name: string; timezone: string; defaultLanguage: string };
  /** Website channel conversations are attached to. */
  channelId: string;
  businessHours: BusinessHoursRule[];
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ResolvedBot | null; expires: number }>();

/** Public bot key → bot, organization and website channel. Cached briefly per instance. */
export async function resolveBot(botKey: string): Promise<ResolvedBot | null> {
  if (!/^bot_[A-Za-z0-9_-]{8,64}$/.test(botKey)) return null;
  const hit = cache.get(botKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const bot = await prisma.botConfiguration.findUnique({
    where: { publicKey: botKey },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          timezone: true,
          defaultLanguage: true,
          businessHours: { select: { weekday: true, opensAt: true, closesAt: true } },
        },
      },
      channels: { where: { type: 'WEBSITE', isActive: true }, select: { id: true }, take: 1 },
    },
  });

  let value: ResolvedBot | null = null;
  if (bot && bot.isActive && bot.channels[0]) {
    const { organization, channels, ...rest } = bot;
    value = {
      bot: rest,
      organization: {
        id: organization.id,
        name: organization.name,
        timezone: organization.timezone,
        defaultLanguage: organization.defaultLanguage,
      },
      channelId: channels[0].id,
      businessHours: organization.businessHours,
    };
  }
  cache.set(botKey, { value, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > 5_000) cache.delete(cache.keys().next().value!);
  return value;
}

export function invalidateBotCache(botKey?: string) {
  if (botKey) cache.delete(botKey);
  else cache.clear();
}

export async function requireBot(botKey: string): Promise<ResolvedBot> {
  const resolved = await resolveBot(botKey);
  if (!resolved) throw new AppError('NOT_FOUND', 'This chat is not available.');
  return resolved;
}

export interface VisitorContext extends ResolvedBot {
  organizationId: string;
  customerId: string;
  claims: VisitorClaims;
  db: TenantDb;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  const match = header?.match(/^Bearer\s+([A-Za-z0-9_\-.]+)$/);
  return match?.[1] ?? null;
}

/** Authenticates a widget visitor request: valid token, issued for this bot, customer still exists. */
export async function requireVisitor(req: Request, botKey: string): Promise<VisitorContext> {
  const resolved = await requireBot(botKey);
  const token = bearerToken(req);
  const claims = token ? verifyVisitorToken(token, env().AUTH_SECRET) : null;
  if (!claims || claims.botId !== resolved.bot.id) {
    throw new AppError('UNAUTHENTICATED', 'Your chat session has expired. Please reload the page.');
  }
  const db = tenantDb(resolved.organization.id);
  const customer = await db.customer.findUnique({ where: { id: claims.customerId }, select: { id: true, mergedIntoId: true } });
  if (!customer) throw new AppError('UNAUTHENTICATED', 'Your chat session has expired. Please reload the page.');
  // A profile the team merged into another one: the session continues on the merged profile.
  return { ...resolved, organizationId: resolved.organization.id, customerId: customer.mergedIntoId ?? customer.id, claims, db };
}
