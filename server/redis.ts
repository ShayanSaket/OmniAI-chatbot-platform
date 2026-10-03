import 'server-only';
import Redis from 'ioredis';
import { logger } from './logger';

const globalForRedis = globalThis as unknown as { redis?: Redis | null };

/**
 * Shared Redis connection, or null when REDIS_URL is not configured.
 * Commands fail fast (no offline queue) so callers can fall back gracefully.
 */
export function getRedis(): Redis | null {
  if (globalForRedis.redis !== undefined) return globalForRedis.redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    globalForRedis.redis = null;
    return null;
  }
  const client = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  let lastLogged = 0;
  client.on('error', (err) => {
    if (Date.now() - lastLogged > 30_000) {
      lastLogged = Date.now();
      logger.warn('redis error', { err: err.message });
    }
  });
  globalForRedis.redis = client;
  return client;
}
