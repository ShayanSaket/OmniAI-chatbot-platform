import 'server-only';
import { z } from 'zod';
import { decryptSecret } from '../crypto';
import { logger } from '../logger';
import { OutboundRequestError, safeFetchJson } from '../net/safe-fetch';
import type { TenantDb } from '../tenancy/tenant-db';

// Order-status connector (a "Custom API" integration). Contract for the shop's endpoint:
//
//   GET <urlTemplate with {orderNumber}>?email=<customer email>
//   Authorization: Bearer <api key>          (if configured)
//   200 → { "orderNumber", "status", "email"?, "carrier"?, "trackingUrl"?,
//           "estimatedDelivery"?, "updatedAt"?, "items"?: [{ "name", "quantity" }] }
//   404 → the order does not exist or does not belong to that email
//
// The AI only sees the whitelisted fields below. If the API returns an email that differs
// from the one the customer gave, the order is treated as not found, so a customer can
// never read another customer's order.

export const ORDER_LOOKUP_KIND = 'order_lookup';

export interface OrderLookupConfig {
  integrationId: string;
  urlTemplate: string;
  apiKey: string | null;
}

export const orderLookupConfigSchema = z.object({
  kind: z.literal(ORDER_LOOKUP_KIND),
  urlTemplate: z.string().url().includes('{orderNumber}'),
});

const orderSchema = z.object({
  orderNumber: z.coerce.string().max(64).optional(),
  status: z.string().min(1).max(80),
  email: z.string().max(200).optional().nullable(),
  carrier: z.string().max(80).optional().nullable(),
  trackingUrl: z.string().url().max(500).optional().nullable(),
  estimatedDelivery: z.string().max(80).optional().nullable(),
  updatedAt: z.string().max(80).optional().nullable(),
  items: z
    .array(z.object({ name: z.string().max(200), quantity: z.coerce.number().int().min(0).optional() }))
    .max(50)
    .optional()
    .nullable(),
});

export interface OrderInfo {
  orderNumber: string;
  status: string;
  carrier: string | null;
  trackingUrl: string | null;
  estimatedDelivery: string | null;
  updatedAt: string | null;
  items: { name: string; quantity: number | null }[];
}

export async function findOrderLookupIntegration(db: TenantDb) {
  return db.integration.findFirst({
    where: { type: 'CUSTOM_API', config: { path: ['kind'], equals: ORDER_LOOKUP_KIND } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function loadOrderLookup(db: TenantDb): Promise<OrderLookupConfig | null> {
  const integration = await findOrderLookupIntegration(db);
  if (!integration?.isActive) return null;
  const config = orderLookupConfigSchema.safeParse(integration.config);
  if (!config.success) return null;
  let apiKey: string | null = null;
  if (integration.secretsEncrypted) {
    try {
      apiKey = (JSON.parse(decryptSecret(integration.secretsEncrypted)) as { apiKey?: string }).apiKey ?? null;
    } catch (err) {
      logger.error('order lookup secret could not be decrypted', { integrationId: integration.id, err: (err as Error).message });
      return null;
    }
  }
  return { integrationId: integration.id, urlTemplate: config.data.urlTemplate, apiKey };
}

export class OrderLookupUnavailableError extends Error {}

/** Returns the order, or null when it does not exist or does not match the email. */
export async function lookupOrder(config: OrderLookupConfig, orderNumber: string, email: string): Promise<OrderInfo | null> {
  const url = new URL(config.urlTemplate.replace('{orderNumber}', encodeURIComponent(orderNumber)));
  url.searchParams.set('email', email);
  let response: { status: number; body: unknown };
  try {
    response = await safeFetchJson(url.toString(), {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
  } catch (err) {
    throw new OrderLookupUnavailableError(err instanceof OutboundRequestError ? err.message : 'Order system unreachable');
  }
  if (response.status === 404) return null;
  if (response.status !== 200) throw new OrderLookupUnavailableError(`Order system responded with ${response.status}`);
  const parsed = orderSchema.safeParse(response.body);
  if (!parsed.success) throw new OrderLookupUnavailableError('Order system returned an unexpected response');
  const order = parsed.data;
  if (order.email && order.email.trim().toLowerCase() !== email.trim().toLowerCase()) return null;
  return {
    orderNumber: order.orderNumber ?? orderNumber,
    status: order.status,
    carrier: order.carrier ?? null,
    trackingUrl: order.trackingUrl ?? null,
    estimatedDelivery: order.estimatedDelivery ?? null,
    updatedAt: order.updatedAt ?? null,
    items: (order.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity ?? null })),
  };
}
