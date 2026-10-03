import 'server-only';
import type { Prisma } from '@prisma/client';
import { hasPermission } from '@/lib/permissions';
import type { OrderLookupUpdateInput } from '@/lib/validation';
import type { ServiceContext } from '../../context';
import { decryptSecret, encryptSecret } from '../../crypto';
import { AppError, forbidden, notFound } from '../../errors';
import {
  findOrderLookupIntegration,
  lookupOrder,
  ORDER_LOOKUP_KIND,
  OrderLookupUnavailableError,
} from '../../integrations/order-lookup';
import { assertPublicUrl, OutboundRequestError } from '../../net/safe-fetch';
import { auditFromContext } from '../audit/audit-service';

// The order-lookup connection holds an API key, so only workspace owners manage it
// (integrations:manage). The key is stored encrypted and never returned to the browser.

function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'integrations:manage')) throw forbidden('Only workspace owners can manage connections.');
}

function storedKey(secretsEncrypted: string | null): string | null {
  if (!secretsEncrypted) return null;
  try {
    return (JSON.parse(decryptSecret(secretsEncrypted)) as { apiKey?: string }).apiKey ?? null;
  } catch {
    return null;
  }
}

export async function getOrderLookupSettings(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const integration = await findOrderLookupIntegration(ctx.db);
  const config = (integration?.config ?? {}) as { urlTemplate?: string };
  return {
    configured: Boolean(integration),
    isActive: integration?.isActive ?? false,
    urlTemplate: config.urlTemplate ?? '',
    hasApiKey: Boolean(integration?.secretsEncrypted),
    canManage: hasPermission(ctx.role, 'integrations:manage'),
  };
}
export type OrderLookupSettings = Awaited<ReturnType<typeof getOrderLookupSettings>>;

export async function saveOrderLookup(ctx: ServiceContext, input: OrderLookupUpdateInput) {
  assertCanManage(ctx);
  try {
    await assertPublicUrl(input.urlTemplate.replace('{orderNumber}', 'TEST'));
  } catch (err) {
    if (err instanceof OutboundRequestError) {
      throw new AppError('VALIDATION_FAILED', err.message, { urlTemplate: [err.message] });
    }
    throw err;
  }
  const existing = await findOrderLookupIntegration(ctx.db);
  const apiKey = input.apiKey === undefined ? storedKey(existing?.secretsEncrypted ?? null) : input.apiKey || null;
  const data = {
    name: 'Order lookup',
    config: { kind: ORDER_LOOKUP_KIND, urlTemplate: input.urlTemplate } as Prisma.InputJsonValue,
    secretsEncrypted: apiKey ? encryptSecret(JSON.stringify({ apiKey })) : null,
    isActive: input.isActive,
  };
  const integration = existing
    ? await ctx.db.integration.update({ where: { id: existing.id }, data })
    : await ctx.db.integration.create({ data: { ...data, organizationId: ctx.organizationId, type: 'CUSTOM_API' } });
  await auditFromContext(ctx, existing ? 'integration.updated' : 'integration.created', { type: 'Integration', id: integration.id }, {
    kind: ORDER_LOOKUP_KIND,
    isActive: input.isActive,
    apiKeyChanged: input.apiKey !== undefined,
  });
  return getOrderLookupSettings(ctx);
}

export async function deleteOrderLookup(ctx: ServiceContext) {
  assertCanManage(ctx);
  const existing = await findOrderLookupIntegration(ctx.db);
  if (!existing) throw notFound('Order lookup connection');
  await ctx.db.integration.delete({ where: { id: existing.id } });
  await auditFromContext(ctx, 'integration.deleted', { type: 'Integration', id: existing.id }, { kind: ORDER_LOOKUP_KIND });
}

/** Lets an owner verify the connection with a real order (works before it is enabled). */
export async function testOrderLookup(ctx: ServiceContext, orderNumber: string, email: string) {
  assertCanManage(ctx);
  const integration = await findOrderLookupIntegration(ctx.db);
  if (!integration) throw notFound('Order lookup connection');
  const config = {
    integrationId: integration.id,
    urlTemplate: (integration.config as { urlTemplate: string }).urlTemplate,
    apiKey: storedKey(integration.secretsEncrypted),
  };
  try {
    const order = await lookupOrder(config, orderNumber, email);
    return { ok: true as const, found: Boolean(order), order };
  } catch (err) {
    if (err instanceof OrderLookupUnavailableError) return { ok: false as const, error: err.message };
    throw err;
  }
}
