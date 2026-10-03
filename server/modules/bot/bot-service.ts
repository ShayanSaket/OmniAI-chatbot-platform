import 'server-only';
import type { ChannelType, Prisma } from '@prisma/client';
import { parseAgentBehavior } from '@/lib/agent-tools';
import { isWithinBusinessHours, nextOpening } from '@/lib/business-hours';
import { hasPermission } from '@/lib/permissions';
import type { BotUpdateInput } from '@/lib/validation';
import { estimateTokens } from '../../ai/provider';
import { invalidateBotCache } from '../../channels/website/widget-auth';
import type { ServiceContext } from '../../context';
import { AppError, forbidden, notFound } from '../../errors';
import { loadOrderLookup } from '../../integrations/order-lookup';
import { auditFromContext } from '../audit/audit-service';
import { availableTools } from '../agent/tools/registry';
import { buildSystemPrompt } from '../ai/prompt-builder';

/** The organization's primary bot (multiple bots per organization come later). */
export async function getPrimaryBot(ctx: ServiceContext) {
  const bot = await ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!bot) throw notFound('Bot');
  return bot;
}

export async function updateBot(ctx: ServiceContext, input: BotUpdateInput) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const bot = await getPrimaryBot(ctx);
  const tone = input.tone ?? bot.tone;
  const customTone = input.customTone !== undefined ? input.customTone : bot.customTone;
  if (tone === 'CUSTOM' && !customTone?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Describe the custom tone.', { customTone: ['Describe the custom tone'] });
  }
  const { behavior, quickReplies, allowedOrigins, ...rest } = input;
  const data: Prisma.BotConfigurationUpdateInput = {
    ...rest,
    ...(quickReplies ? { quickReplies } : {}),
    ...(allowedOrigins ? { allowedOrigins: Array.from(new Set(allowedOrigins.map((o) => o.replace(/\/$/, '')))) } : {}),
    // Merge so the Tools and Behavior screens can save independently.
    ...(behavior ? { behavior: { ...parseAgentBehavior(bot.behavior), ...behavior } as Prisma.InputJsonValue } : {}),
  };
  const updated = await ctx.db.botConfiguration.update({ where: { id: bot.id }, data });
  invalidateBotCache(bot.publicKey);
  await auditFromContext(ctx, 'bot.settings_updated', { type: 'BotConfiguration', id: bot.id }, { fields: Object.keys(input) });
  return updated;
}

/**
 * The system prompt exactly as the assistant would receive it on `channel`, with a
 * sample customer and no retrieved knowledge. Lets admins see how their layers compose.
 */
export async function previewSystemPrompt(ctx: ServiceContext, channel: ChannelType) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const bot = await getPrimaryBot(ctx);
  const [layers, organization, hours, orderLookup] = await Promise.all([
    ctx.db.promptConfiguration.findMany({ where: { OR: [{ botId: bot.id }, { botId: null }] } }),
    ctx.db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } }),
    ctx.db.businessHours.findMany({ select: { weekday: true, opensAt: true, closesAt: true } }),
    loadOrderLookup(ctx.db),
  ]);
  const now = new Date();
  const teamOnline = isWithinBusinessHours(hours, organization.timezone, now);
  const tools = availableTools({ bot, behavior: parseAgentBehavior(bot.behavior), orderLookup });
  const prompt = buildSystemPrompt(bot, layers, {
    channel,
    now,
    timeZone: organization.timezone,
    teamOnline,
    nextOpenAt: teamOnline ? null : nextOpening(hours, organization.timezone, now),
    customer: { name: 'Sample Customer', language: bot.defaultLanguage },
    toolsEnabled: tools.length > 0,
  });
  return { prompt, estimatedTokens: estimateTokens(prompt), tools: tools.map((t) => t.name) };
}

/** Recent tool calls by the AI, for transparency in the dashboard. */
export async function listToolExecutions(ctx: ServiceContext, limit = 25) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const rows = await ctx.db.toolExecution.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true,
      toolName: true,
      status: true,
      error: true,
      durationMs: true,
      createdAt: true,
      conversationId: true,
      conversation: { select: { channel: true, customer: { select: { name: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    status: r.status,
    error: r.error,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
    conversationId: r.conversationId,
    channel: r.conversation?.channel ?? null,
    customerName: r.conversation?.customer.name ?? null,
  }));
}
