import 'server-only';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { getRedis } from './redis';

// Keyed mutual exclusion. Serializes work per key inside this process (promise chain)
// and across instances with a Redis lock (SET NX PX + compare-and-delete release).
// Used so a customer's WhatsApp messages are processed one at a time, in order.

const local = new Map<string, Promise<unknown>>();

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

async function acquireRedis(key: string, ttlMs: number, waitMs: number): Promise<(() => Promise<void>) | null> {
  const redis = getRedis();
  if (!redis) return null;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      if ((await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX')) === 'OK') {
        return async () => {
          await redis.eval(RELEASE, 1, `lock:${key}`, token).catch(() => undefined);
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    logger.warn('lock wait timed out; continuing without it', { key });
  } catch (err) {
    logger.warn('redis lock unavailable; using process-local lock only', { key, err: (err as Error).message });
  }
  return null;
}

/**
 * Runs `fn` only if no other instance holds `key` (no waiting). For periodic jobs: if a
 * run is already in progress anywhere, this tick is skipped. Returns false if skipped.
 */
export async function runExclusive(key: string, ttlMs: number, fn: () => Promise<unknown>): Promise<boolean> {
  const redis = getRedis();
  const token = randomUUID();
  if (redis) {
    try {
      if ((await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX')) !== 'OK') return false;
    } catch (err) {
      logger.warn('redis unavailable for job lock; running locally', { key, err: (err as Error).message });
    }
  }
  try {
    await fn();
    return true;
  } finally {
    if (redis) await redis.eval(RELEASE, 1, `lock:${key}`, token).catch(() => undefined);
  }
}

export async function withLock<T>(key: string, fn: () => Promise<T>, options: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const previous = local.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const release = await acquireRedis(key, options.ttlMs ?? 120_000, options.waitMs ?? 60_000);
      try {
        return await fn();
      } finally {
        await release?.();
      }
    });
  local.set(key, run);
  try {
    return await run;
  } finally {
    if (local.get(key) === run) local.delete(key);
  }
}
