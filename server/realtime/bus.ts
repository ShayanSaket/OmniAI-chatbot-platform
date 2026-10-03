import 'server-only';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { logger } from '../logger';
import { getRedis } from '../redis';

// Realtime fan-out. With Redis, events published by any app instance reach subscribers
// on every instance (pub/sub). Without Redis, an in-process emitter is used, which is
// correct for a single instance (local development).

type Handler = (payload: unknown) => void;

interface BusState {
  local: EventEmitter;
  subscriber: Redis | null;
  handlers: Map<string, Set<Handler>>;
}

const globalForBus = globalThis as unknown as { realtimeBus?: BusState };

function state(): BusState {
  if (globalForBus.realtimeBus) return globalForBus.realtimeBus;
  const local = new EventEmitter();
  local.setMaxListeners(0);
  const handlers = new Map<string, Set<Handler>>();
  const redis = getRedis();
  let subscriber: Redis | null = null;
  if (redis) {
    subscriber = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    subscriber.on('message', (channel: string, raw: string) => {
      const set = handlers.get(channel);
      if (!set) return;
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      set.forEach((h) => h(payload));
    });
    subscriber.on('error', (err) => logger.warn('realtime subscriber error', { err: err.message }));
  }
  globalForBus.realtimeBus = { local, subscriber, handlers };
  return globalForBus.realtimeBus;
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.publish(channel, JSON.stringify(payload));
      return;
    } catch (err) {
      logger.warn('realtime publish via redis failed; delivering locally', { channel, err: (err as Error).message });
    }
  }
  state().local.emit(channel, payload);
}

/** Subscribes to a channel; returns an unsubscribe function. */
export function subscribe(channel: string, handler: Handler): () => void {
  const s = state();
  s.local.on(channel, handler);
  if (s.subscriber) {
    let set = s.handlers.get(channel);
    if (!set) {
      set = new Set();
      s.handlers.set(channel, set);
      s.subscriber.subscribe(channel).catch((err) => logger.warn('redis subscribe failed', { channel, err: err.message }));
    }
    set.add(handler);
  }
  return () => {
    s.local.off(channel, handler);
    const set = s.handlers.get(channel);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        s.handlers.delete(channel);
        s.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    }
  };
}

export const channels = {
  /** Everything a website visitor's widget needs to hear about. */
  visitor: (customerId: string) => `visitor:${customerId}`,
  /** Organization-wide inbox feed (phase 6). */
  inbox: (organizationId: string) => `inbox:${organizationId}`,
};
