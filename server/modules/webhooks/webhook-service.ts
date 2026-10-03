import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PING_EVENT } from '@/lib/events';
import { hasPermission } from '@/lib/permissions';
import type { WebhookEndpointInput, WebhookEndpointUpdateInput } from '@/lib/validation';
import type { ServiceContext } from '../../context';
import { encryptSecret } from '../../crypto';
import { prisma } from '../../db';
import { AppError, forbidden, notFound } from '../../errors';
import { WEBHOOK_API_VERSION } from '../../events/payload';
import { assertPublicUrl, OutboundRequestError } from '../../net/safe-fetch';
import { auditFromContext } from '../audit/audit-service';
import { attemptDelivery } from './delivery';
import { generateWebhookSecret } from './signing';

// Webhook endpoints are data egress (customer details leave the system), so only
// workspace owners manage them (integrations:manage). Signing secrets are stored
// encrypted and shown exactly once: on creation and on rotation.

const MAX_ENDPOINTS = 20;

function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'integrations:manage')) throw forbidden('Only workspace owners can manage webhooks.');
}

async function validateUrl(url: string) {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    if (err instanceof OutboundRequestError) throw new AppError('VALIDATION_FAILED', err.message, { url: [err.message] });
    throw err;
  }
}

export async function listWebhookEndpoints(ctx: ServiceContext) {
  assertCanManage(ctx);
  const since = new Date(Date.now() - 24 * 3600_000);
  const [endpoints, stats] = await Promise.all([
    ctx.db.webhookEndpoint.findMany({ orderBy: { createdAt: 'asc' } }),
    ctx.db.webhookDelivery.groupBy({ by: ['endpointId', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  return endpoints.map((e) => {
    const of = (status: string) => stats.find((s) => s.endpointId === e.id && s.status === status)?._count._all ?? 0;
    return {
      id: e.id,
      url: e.url,
      events: e.events,
      description: e.description,
      preset: e.preset,
      isActive: e.isActive,
      disabledReason: e.disabledReason,
      consecutiveFailures: e.consecutiveFailures,
      lastDeliveryAt: e.lastDeliveryAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      last24h: { delivered: of('DELIVERED'), failed: of('FAILED'), pending: of('PENDING') },
    };
  });
}
export type WebhookEndpointDto = Awaited<ReturnType<typeof listWebhookEndpoints>>[number];

export async function createWebhookEndpoint(ctx: ServiceContext, input: WebhookEndpointInput) {
  assertCanManage(ctx);
  await validateUrl(input.url);
  if ((await ctx.db.webhookEndpoint.count()) >= MAX_ENDPOINTS) throw new AppError('BAD_REQUEST', `A workspace can have up to ${MAX_ENDPOINTS} webhook endpoints.`);
  const secret = generateWebhookSecret();
  const endpoint = await ctx.db.webhookEndpoint.create({
    data: {
      organizationId: ctx.organizationId,
      url: input.url,
      events: Array.from(new Set(input.events)),
      description: input.description,
      preset: input.preset,
      secretEncrypted: encryptSecret(secret),
    },
  });
  await auditFromContext(ctx, 'webhook.created', { type: 'WebhookEndpoint', id: endpoint.id }, { url: input.url, events: input.events });
  return { endpoint: (await listWebhookEndpoints(ctx)).find((e) => e.id === endpoint.id)!, secret };
}

async function findEndpoint(ctx: ServiceContext, id: string) {
  const endpoint = await ctx.db.webhookEndpoint.findUnique({ where: { id } });
  if (!endpoint) throw notFound('Webhook endpoint');
  return endpoint;
}

export async function updateWebhookEndpoint(ctx: ServiceContext, id: string, input: WebhookEndpointUpdateInput) {
  assertCanManage(ctx);
  await findEndpoint(ctx, id);
  if (input.url) await validateUrl(input.url);
  await ctx.db.webhookEndpoint.update({
    where: { id },
    data: {
      ...(input.url ? { url: input.url } : {}),
      ...(input.events ? { events: Array.from(new Set(input.events)) } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      // Re-enabling clears the failure streak.
      ...(input.isActive !== undefined ? { isActive: input.isActive, ...(input.isActive ? { consecutiveFailures: 0, disabledReason: null } : {}) } : {}),
    },
  });
  await auditFromContext(ctx, 'webhook.updated', { type: 'WebhookEndpoint', id }, { fields: Object.keys(input) });
  return (await listWebhookEndpoints(ctx)).find((e) => e.id === id)!;
}

export async function rotateWebhookSecret(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  await findEndpoint(ctx, id);
  const secret = generateWebhookSecret();
  await ctx.db.webhookEndpoint.update({ where: { id }, data: { secretEncrypted: encryptSecret(secret) } });
  await auditFromContext(ctx, 'webhook.secret_rotated', { type: 'WebhookEndpoint', id });
  return { secret };
}

export async function deleteWebhookEndpoint(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  const endpoint = await findEndpoint(ctx, id);
  await ctx.db.webhookEndpoint.delete({ where: { id } });
  await auditFromContext(ctx, 'webhook.deleted', { type: 'WebhookEndpoint', id }, { url: endpoint.url });
}

export async function listWebhookDeliveries(ctx: ServiceContext, endpointId: string, limit = 30) {
  assertCanManage(ctx);
  await findEndpoint(ctx, endpointId);
  const rows = await ctx.db.webhookDelivery.findMany({ where: { endpointId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
  return rows.map((d) => ({
    id: d.id,
    event: d.event,
    eventId: d.eventId,
    status: d.status,
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    lastError: d.lastError,
    durationMs: d.durationMs,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    payload: d.payload,
  }));
}

/** Sends a signed "webhook.ping" right away and reports the result. */
export async function sendTestWebhook(ctx: ServiceContext, endpointId: string) {
  assertCanManage(ctx);
  const endpoint = await findEndpoint(ctx, endpointId);
  if (!endpoint.isActive) throw new AppError('BAD_REQUEST', 'Enable the endpoint first.');
  const eventId = `evt_ping_${randomUUID().replace(/-/g, '')}`;
  const payload = {
    id: eventId,
    type: PING_EVENT,
    apiVersion: WEBHOOK_API_VERSION,
    createdAt: new Date().toISOString(),
    organizationId: ctx.organizationId,
    data: { message: 'Test delivery from OmniAI. Verify the X-OmniAI-Signature header with your signing secret.' },
  };
  const delivery = await prisma.webhookDelivery.create({
    data: { organizationId: ctx.organizationId, endpointId, event: PING_EVENT, eventId, payload: payload as Prisma.InputJsonValue, nextAttemptAt: new Date() },
  });
  const result = await attemptDelivery(delivery.id);
  // A test must not leave retries behind.
  if (result.status === 'retrying') await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', nextAttemptAt: null } });
  return { ok: result.status === 'delivered', responseStatus: result.responseStatus, durationMs: result.durationMs, error: result.error };
}

/** Sends a failed (or still retrying) delivery again now. */
export async function redeliverWebhook(ctx: ServiceContext, deliveryId: string) {
  assertCanManage(ctx);
  const delivery = await ctx.db.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw notFound('Delivery');
  if (delivery.status === 'DELIVERED') throw new AppError('BAD_REQUEST', 'This delivery already succeeded.');
  await ctx.db.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() } });
  await auditFromContext(ctx, 'webhook.redelivered', { type: 'WebhookDelivery', id: deliveryId });
  const result = await attemptDelivery(deliveryId);
  return { ok: result.status === 'delivered', responseStatus: result.responseStatus, error: result.error };
}
