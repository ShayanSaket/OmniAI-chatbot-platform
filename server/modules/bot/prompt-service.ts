import 'server-only';
import type { PromptLayer } from '@prisma/client';
import { hasPermission } from '@/lib/permissions';
import type { PromptLayerCreateInput, PromptLayerUpdateInput } from '@/lib/validation';
import type { ServiceContext } from '../../context';
import { AppError, forbidden, notFound } from '../../errors';
import { auditFromContext } from '../audit/audit-service';
import { getPrimaryBot } from './bot-service';

const MAX_LAYERS = 40;

/**
 * The global policy holds the non-negotiable safety rules, so only owners may change it.
 * Admins manage the business-specific layers.
 */
function assertCanEdit(ctx: ServiceContext, layer: PromptLayer) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  if (layer === 'GLOBAL_POLICY' && !hasPermission(ctx.role, 'organization:manage')) {
    throw forbidden('Only workspace owners can change the global policy.');
  }
}

export async function listPromptLayers(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const bot = await getPrimaryBot(ctx);
  return ctx.db.promptConfiguration.findMany({
    where: { OR: [{ botId: bot.id }, { botId: null }] },
    orderBy: [{ layer: 'asc' }, { channel: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function createPromptLayer(ctx: ServiceContext, input: PromptLayerCreateInput) {
  assertCanEdit(ctx, input.layer);
  const bot = await getPrimaryBot(ctx);
  if ((await ctx.db.promptConfiguration.count()) >= MAX_LAYERS) {
    throw new AppError('BAD_REQUEST', `A workspace can have at most ${MAX_LAYERS} prompt layers.`);
  }
  const layer = await ctx.db.promptConfiguration.create({
    data: {
      organizationId: ctx.organizationId,
      // The global policy applies to every bot of the organization.
      botId: input.layer === 'GLOBAL_POLICY' ? null : bot.id,
      layer: input.layer,
      channel: input.channel,
      content: input.content,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
  });
  await auditFromContext(ctx, 'prompt.created', { type: 'PromptConfiguration', id: layer.id }, { layer: layer.layer });
  return layer;
}

async function findLayer(ctx: ServiceContext, id: string) {
  const layer = await ctx.db.promptConfiguration.findUnique({ where: { id } });
  if (!layer) throw notFound('Prompt layer');
  return layer;
}

export async function updatePromptLayer(ctx: ServiceContext, id: string, input: PromptLayerUpdateInput) {
  const existing = await findLayer(ctx, id);
  assertCanEdit(ctx, existing.layer);
  const layer = await ctx.db.promptConfiguration.update({ where: { id }, data: input });
  await auditFromContext(ctx, 'prompt.updated', { type: 'PromptConfiguration', id }, { layer: layer.layer, fields: Object.keys(input) });
  return layer;
}

export async function deletePromptLayer(ctx: ServiceContext, id: string) {
  const existing = await findLayer(ctx, id);
  assertCanEdit(ctx, existing.layer);
  if (existing.layer === 'GLOBAL_POLICY') {
    const policies = await ctx.db.promptConfiguration.count({ where: { layer: 'GLOBAL_POLICY' } });
    if (policies <= 1) throw new AppError('BAD_REQUEST', 'The global policy cannot be removed. Edit it or turn it off instead.');
  }
  await ctx.db.promptConfiguration.delete({ where: { id } });
  await auditFromContext(ctx, 'prompt.deleted', { type: 'PromptConfiguration', id }, { layer: existing.layer });
}
