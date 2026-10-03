import 'server-only';
import type { IntegrationType, Prisma } from '@prisma/client';
import { hasPermission } from '@/lib/permissions';
import type { ServiceContext } from '../../context';
import { decryptSecret, encryptSecret } from '../../crypto';
import { prisma } from '../../db';
import { AppError, forbidden, notFound } from '../../errors';
import type { DomainEvent } from '../../events/domain-events';
import { buildEventPayload } from '../../events/payload';
import { CONNECTORS, getConnector } from '../../integrations/connectors/registry';
import type { IntegrationConnector } from '../../integrations/connectors/types';
import { logger } from '../../logger';
import { auditFromContext } from '../audit/audit-service';

function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'integrations:manage')) throw forbidden('Only workspace owners can manage integrations.');
}

function connectorContext(connector: IntegrationConnector, integration: { id: string; organizationId: string; config: Prisma.JsonValue; secretsEncrypted: string | null }) {
  const config = connector.configSchema ? connector.configSchema.parse(integration.config ?? {}) : integration.config;
  const rawSecrets = integration.secretsEncrypted ? JSON.parse(decryptSecret(integration.secretsEncrypted)) : {};
  const secrets = connector.secretsSchema ? connector.secretsSchema.parse(rawSecrets) : rawSecrets;
  return { organizationId: integration.organizationId, integrationId: integration.id, config, secrets };
}

/** Event consumer: forwards events to the organization's active connectors. */
export async function dispatchToIntegrations(event: DomainEvent) {
  const integrations = await prisma.integration.findMany({ where: { organizationId: event.organizationId, isActive: true } });
  const targets = integrations
    .map((i) => ({ integration: i, connector: getConnector(i.type) }))
    .filter((t): t is { integration: (typeof integrations)[number]; connector: IntegrationConnector } => Boolean(t.connector?.handleEvent && t.connector.events.includes(event.type)));
  if (!targets.length) return 0;
  const payload = await buildEventPayload(event);
  for (const { integration, connector } of targets) {
    try {
      const outcome = await connector.handleEvent!(connectorContext(connector, integration), payload);
      await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date(), lastError: null } });
      logger.info('integration synced', { organizationId: event.organizationId, integration: integration.type, eventType: event.type, outcome });
    } catch (err) {
      await prisma.integration.update({ where: { id: integration.id }, data: { lastError: `${event.type}: ${(err as Error).message}`.slice(0, 500) } });
      logger.warn('integration sync failed', { organizationId: event.organizationId, integration: integration.type, eventType: event.type, err: (err as Error).message });
    }
  }
  return targets.length;
}

export async function listIntegrations(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'integrations:manage')) throw forbidden();
  const rows = await ctx.db.integration.findMany({ where: { type: { not: 'CUSTOM_API' } } });
  return CONNECTORS.map((c) => {
    const row = rows.find((r) => r.type === c.type);
    return {
      type: c.type,
      name: c.name,
      description: c.description,
      category: c.category,
      status: c.status,
      events: c.events,
      connection: row
        ? {
            isActive: row.isActive,
            config: row.config,
            lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
            lastError: row.lastError,
            connectedAt: row.createdAt.toISOString(),
          }
        : null,
    };
  });
}
export type IntegrationListItem = Awaited<ReturnType<typeof listIntegrations>>[number];

function connectable(type: IntegrationType) {
  const connector = getConnector(type);
  if (!connector || connector.status !== 'available') throw new AppError('BAD_REQUEST', 'This integration cannot be connected directly.');
  return connector;
}

/** Validates credentials with the provider, then stores them encrypted. */
export async function connectIntegration(ctx: ServiceContext, type: IntegrationType, input: { config?: unknown; secrets: unknown }) {
  assertCanManage(ctx);
  const connector = connectable(type);
  const secrets = connector.secretsSchema ? connector.secretsSchema.safeParse(input.secrets) : { success: true as const, data: input.secrets };
  if (!secrets.success) throw new AppError('VALIDATION_FAILED', 'Enter valid credentials.', { secrets: ['Enter valid credentials'] });
  const config = connector.configSchema ? connector.configSchema.parse(input.config ?? {}) : (input.config ?? {});
  try {
    await connector.testConnection?.({ organizationId: ctx.organizationId, integrationId: '', config, secrets: secrets.data });
  } catch (err) {
    throw new AppError('BAD_REQUEST', `Connection failed: ${(err as Error).message}`);
  }
  const existing = await ctx.db.integration.findFirst({ where: { type } });
  const data = {
    name: connector.name,
    config: config as Prisma.InputJsonValue,
    secretsEncrypted: encryptSecret(JSON.stringify(secrets.data)),
    isActive: true,
    lastError: null,
  };
  const row = existing
    ? await ctx.db.integration.update({ where: { id: existing.id }, data })
    : await ctx.db.integration.create({ data: { ...data, organizationId: ctx.organizationId, type } });
  await auditFromContext(ctx, 'integration.connected', { type: 'Integration', id: row.id }, { integration: type });
  return (await listIntegrations(ctx)).find((i) => i.type === type)!;
}

export async function updateIntegration(ctx: ServiceContext, type: IntegrationType, input: { config?: unknown; isActive?: boolean }) {
  assertCanManage(ctx);
  const connector = connectable(type);
  const row = await ctx.db.integration.findFirst({ where: { type } });
  if (!row) throw notFound('Integration');
  await ctx.db.integration.update({
    where: { id: row.id },
    data: {
      ...(input.config !== undefined ? { config: (connector.configSchema ? connector.configSchema.parse(input.config) : input.config) as Prisma.InputJsonValue } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  await auditFromContext(ctx, 'integration.updated', { type: 'Integration', id: row.id }, { integration: type });
  return (await listIntegrations(ctx)).find((i) => i.type === type)!;
}

export async function testIntegration(ctx: ServiceContext, type: IntegrationType) {
  assertCanManage(ctx);
  const connector = connectable(type);
  const row = await ctx.db.integration.findFirst({ where: { type } });
  if (!row) throw notFound('Integration');
  try {
    const result = (await connector.testConnection?.(connectorContext(connector, row))) ?? { ok: true, detail: 'No test available.' };
    await ctx.db.integration.update({ where: { id: row.id }, data: { lastError: null } });
    return result;
  } catch (err) {
    await ctx.db.integration.update({ where: { id: row.id }, data: { lastError: (err as Error).message.slice(0, 500) } });
    return { ok: false, detail: (err as Error).message };
  }
}

export async function disconnectIntegration(ctx: ServiceContext, type: IntegrationType) {
  assertCanManage(ctx);
  const row = await ctx.db.integration.findFirst({ where: { type } });
  if (!row || type === 'CUSTOM_API') throw notFound('Integration');
  await ctx.db.integration.delete({ where: { id: row.id } });
  await auditFromContext(ctx, 'integration.disconnected', { type: 'Integration', id: row.id }, { integration: type });
}
