import 'server-only';
import type { Prisma, WebhookDelivery } from '@prisma/client';
import { runInBackground } from '../../background';
import { decryptSecret } from '../../crypto';
import { prisma } from '../../db';
import type { DomainEvent } from '../../events/domain-events';
import { buildEventPayload } from '../../events/payload';
import { logger } from '../../logger';
import { OutboundRequestError, safePostJson } from '../../net/safe-fetch';
import { notifyMembers } from '../notifications/notification-service';
import { DISABLE_AFTER_FAILURES, MAX_DELIVERY_ATTEMPTS, nextRetryDelay, signatureHeader, SIGNATURE_HEADER } from './signing';

// Outbound webhook delivery:
//   event → one WebhookDelivery per subscribed endpoint (unique per endpoint + event)
//   → POST with signature → DELIVERED, or retry with backoff → FAILED after the last try.
// Deliveries are claimed with a short lease so concurrent workers never send twice.

const LEASE_MS = 2 * 60 * 1000;

/** Creates deliveries for all active endpoints subscribed to the event, then sends them. */
export async function enqueueWebhooksForEvent(event: DomainEvent) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId: event.organizationId, isActive: true, OR: [{ events: { has: event.type } }, { events: { has: '*' } }] },
    select: { id: true },
  });
  if (!endpoints.length) return 0;
  const payload = await buildEventPayload(event);
  return enqueueDeliveries(event.organizationId, endpoints.map((e) => e.id), event.type, event.id, payload as unknown as Prisma.InputJsonValue);
}

export async function enqueueDeliveries(organizationId: string, endpointIds: string[], eventType: string, eventId: string, payload: Prisma.InputJsonValue) {
  await prisma.webhookDelivery.createMany({
    data: endpointIds.map((endpointId) => ({ organizationId, endpointId, event: eventType, eventId, payload, nextAttemptAt: new Date() })),
    skipDuplicates: true,
  });
  const created = await prisma.webhookDelivery.findMany({
    where: { organizationId, eventId, endpointId: { in: endpointIds }, status: 'PENDING', attempts: 0 },
    select: { id: true },
  });
  for (const d of created) runInBackground('webhook-delivery', () => attemptDelivery(d.id), { deliveryId: d.id });
  return created.length;
}

async function claim(id: string): Promise<WebhookDelivery | null> {
  const now = new Date();
  const res = await prisma.webhookDelivery.updateMany({
    where: { id, status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  return res.count === 1 ? prisma.webhookDelivery.findUnique({ where: { id } }) : null;
}

export interface AttemptResult {
  status: 'delivered' | 'retrying' | 'failed' | 'skipped';
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
}

/** Sends one delivery attempt. Safe to call concurrently (claimed with a lease). */
export async function attemptDelivery(id: string): Promise<AttemptResult> {
  const delivery = await claim(id);
  if (!delivery) return { status: 'skipped', responseStatus: null, error: null, durationMs: null };
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
  if (!endpoint || !endpoint.isActive) {
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'FAILED', lastError: 'Endpoint disabled or deleted', nextAttemptAt: null } });
    return { status: 'failed', responseStatus: null, error: 'Endpoint disabled', durationMs: null };
  }

  const body = JSON.stringify(delivery.payload);
  let responseStatus: number | null = null;
  let error: string | null = null;
  let durationMs: number | null = null;
  try {
    const secret = decryptSecret(endpoint.secretEncrypted);
    const res = await safePostJson(endpoint.url, body, {
      headers: {
        [SIGNATURE_HEADER]: signatureHeader(secret, body),
        'X-OmniAI-Event': delivery.event,
        'X-OmniAI-Event-Id': delivery.eventId,
        'X-OmniAI-Delivery': delivery.id,
      },
    });
    responseStatus = res.status;
    durationMs = res.durationMs;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}${res.bodySnippet ? `: ${res.bodySnippet.slice(0, 200)}` : ''}`;
  } catch (err) {
    error = err instanceof OutboundRequestError ? err.message : `Delivery failed: ${(err as Error).message}`;
  }

  if (!error) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id },
        data: { status: 'DELIVERED', responseStatus, durationMs, deliveredAt: new Date(), lastError: null, nextAttemptAt: null },
      }),
      prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { consecutiveFailures: 0, lastDeliveryAt: new Date() } }),
    ]);
    return { status: 'delivered', responseStatus, error: null, durationMs };
  }

  // 410 Gone: the receiver says this URL will never work again.
  const delay = responseStatus === 410 ? null : nextRetryDelay(delivery.attempts);
  if (delay !== null && delivery.attempts < MAX_DELIVERY_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: { responseStatus, durationMs, lastError: error.slice(0, 500), nextAttemptAt: new Date(Date.now() + delay * 1000) },
    });
    logger.info('webhook delivery failed; will retry', { organizationId: delivery.organizationId, deliveryId: id, attempt: delivery.attempts, error });
    return { status: 'retrying', responseStatus, error, durationMs };
  }

  await prisma.webhookDelivery.update({
    where: { id },
    data: { status: 'FAILED', responseStatus, durationMs, lastError: error.slice(0, 500), nextAttemptAt: null },
  });
  const updated = await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { consecutiveFailures: { increment: 1 }, lastDeliveryAt: new Date() },
  });
  logger.warn('webhook delivery failed permanently', { organizationId: delivery.organizationId, deliveryId: id, endpointId: endpoint.id, error });
  if (responseStatus === 410 || updated.consecutiveFailures >= DISABLE_AFTER_FAILURES) {
    const reason = responseStatus === 410 ? 'The receiver answered 410 Gone.' : `${updated.consecutiveFailures} deliveries in a row failed.`;
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { isActive: false, disabledReason: reason } });
    await notifyMembers(delivery.organizationId, {
      roles: ['OWNER'],
      title: 'Webhook endpoint disabled',
      body: `${endpoint.url} was switched off: ${reason} Fix the receiver and re-enable it under Integrations.`,
      link: '/integrations',
    });
  }
  return { status: 'failed', responseStatus, error, durationMs };
}

/** Deliveries whose retry time has come (or that were never attempted). */
export async function retryDueWebhookDeliveries(limit = 50): Promise<number> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let n = 0;
  for (const d of due) if ((await attemptDelivery(d.id)).status !== 'skipped') n++;
  return n;
}
