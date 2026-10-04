import 'server-only';
import { AppError } from './errors';
import { logger } from './logger';
import { getRedis } from './redis';

// Fixed-window rate limiter. Redis-backed (shared across instances) with an
// in-process fallback so a Redis outage degrades protection instead of the app.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export interface RateLimitRule {
  /** Logical bucket, e.g. "login". */
  name: string;
  limit: number;
  windowSeconds: number;
}

const memory = new Map<string, { count: number; resetAt: number }>();

export function memoryHit(key: string, rule: RateLimitRule, now = Date.now()): RateLimitResult {
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
    if (memory.size > 10_000) {
      memory.forEach((v, k) => {
        if (v.resetAt <= now) memory.delete(k);
      });
    }
    return { allowed: true, remaining: rule.limit - 1, resetSeconds: rule.windowSeconds };
  }
  entry.count += 1;
  return {
    allowed: entry.count <= rule.limit,
    remaining: Math.max(0, rule.limit - entry.count),
    resetSeconds: Math.ceil((entry.resetAt - now) / 1000),
  };
}

export function resetMemoryRateLimits() {
  memory.clear();
}

export async function rateLimit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
  const key = `rl:${rule.name}:${identifier}`;
  const redis = getRedis();
  if (redis) {
    try {
      const results = await redis.multi().incr(key).expire(key, rule.windowSeconds, 'NX').ttl(key).exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? rule.windowSeconds);
      return {
        allowed: count <= rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetSeconds: ttl > 0 ? ttl : rule.windowSeconds,
      };
    } catch (err) {
      logger.warn('rate limiter falling back to memory', { err: (err as Error).message });
    }
  }
  return memoryHit(key, rule);
}

/** True when `identifier` has already used up the rule's budget (does not count a hit). */
export async function isRateLimited(rule: RateLimitRule, identifier: string): Promise<boolean> {
  const key = `rl:${rule.name}:${identifier}`;
  const redis = getRedis();
  if (redis) {
    try {
      return Number((await redis.get(key)) ?? 0) >= rule.limit;
    } catch (err) {
      logger.warn('rate limiter falling back to memory', { err: (err as Error).message });
    }
  }
  const entry = memory.get(key);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= rule.limit);
}

/** Counts one hit without enforcing (e.g. record only failed login attempts). */
export async function recordRateLimitHit(rule: RateLimitRule, identifier: string): Promise<void> {
  await rateLimit(rule, identifier);
}

export async function enforceRateLimit(rule: RateLimitRule, identifier: string): Promise<void> {
  const result = await rateLimit(rule, identifier);
  if (!result.allowed) {
    throw new AppError('RATE_LIMITED', `Too many attempts. Try again in ${result.resetSeconds} seconds.`, {
      retryAfter: result.resetSeconds,
    });
  }
}

export const RATE_LIMITS = {
  loginPerIp: { name: 'login-ip', limit: 30, windowSeconds: 15 * 60 },
  /** Failed attempts only (see auth/options.ts). */
  loginPerAccount: { name: 'login-account', limit: 8, windowSeconds: 15 * 60 },
  register: { name: 'register', limit: 5, windowSeconds: 60 * 60 },
  api: { name: 'api', limit: 300, windowSeconds: 60 },
  widgetSession: { name: 'widget-session', limit: 30, windowSeconds: 60 },
  widgetMessagePerVisitor: { name: 'widget-msg-visitor', limit: 20, windowSeconds: 60 },
  widgetMessagePerIp: { name: 'widget-msg-ip', limit: 120, windowSeconds: 60 },
  widgetUpload: { name: 'widget-upload', limit: 10, windowSeconds: 10 * 60 },
  widgetAction: { name: 'widget-action', limit: 20, windowSeconds: 60 },
  /** Knowledge uploads / website imports / re-index per organization. */
  knowledgeWrite: { name: 'knowledge-write', limit: 60, windowSeconds: 10 * 60 },
  /** AI replies per WhatsApp sender (messages beyond this are stored, not answered). */
  whatsappAiPerCustomer: { name: 'wa-ai-customer', limit: 20, windowSeconds: 60 },
  /** AI reply suggestions per team member. */
  inboxSuggestion: { name: 'inbox-suggest', limit: 30, windowSeconds: 60 },
  /** Agent replies per team member. */
  inboxReply: { name: 'inbox-reply', limit: 60, windowSeconds: 60 },
  inboxUpload: { name: 'inbox-upload', limit: 30, windowSeconds: 10 * 60 },
  /** AI insight reports per organization. */
  insightReport: { name: 'insight-report', limit: 10, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>;
