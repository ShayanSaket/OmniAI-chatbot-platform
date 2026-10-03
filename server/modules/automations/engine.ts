import 'server-only';
import type { Automation, Prisma } from '@prisma/client';
import { matchesConditions, parseActions, parseConditions, type AutomationTriggerName } from '@/lib/automations';
import { isWithinBusinessHours } from '@/lib/business-hours';
import { prisma } from '../../db';
import { buildEvent, type DomainEvent } from '../../events/domain-events';
import { logger } from '../../logger';
import { tenantDb } from '../../tenancy/tenant-db';
import { ActionSkipped, executeAction, loadOrgContext, type ActionContext } from './actions';

// Automation engine: event → matching automations (trigger + conditions) → actions in
// order. Each automation runs at most once per event (AutomationRun is unique per
// automation + event). Loop protection: an automation never reacts to events its own
// actions caused, and chains stop after MAX_CHAIN_DEPTH automations.

export const MAX_CHAIN_DEPTH = 3;

export function triggersForEvent(event: Pick<DomainEvent, 'type' | 'data'>): AutomationTriggerName[] {
  switch (event.type) {
    case 'conversation.created':
      return ['CONVERSATION_CREATED'];
    case 'message.received':
      return ['MESSAGE_RECEIVED', 'KEYWORD_DETECTED', ...(event.data.channel === 'WHATSAPP' ? (['WHATSAPP_MESSAGE_RECEIVED'] as const) : [])];
    case 'intent.detected':
      return ['INTENT_DETECTED'];
    case 'lead.created':
      return ['LEAD_CREATED'];
    case 'human_handoff.requested':
      return ['HANDOFF_REQUESTED'];
    case 'conversation.inactive':
      return ['CONVERSATION_INACTIVE'];
    default:
      return [];
  }
}

interface EventContext {
  conversationId: string | null;
  customerId: string | null;
  channel: string | null;
  text: string | null;
  intent: string | null;
  vars: Record<string, string | null>;
  org: Awaited<ReturnType<typeof loadOrgContext>> & { botCompany: string | null };
  teamOnline: boolean;
}

async function loadEventContext(event: DomainEvent): Promise<EventContext> {
  const db = tenantDb(event.organizationId);
  const [org, conversation, message, bot] = await Promise.all([
    loadOrgContext(event.organizationId),
    event.refs.conversationId
      ? db.conversation.findUnique({ where: { id: event.refs.conversationId }, select: { id: true, channel: true, intent: true, customerId: true, assignedTo: { select: { name: true } } } })
      : null,
    event.refs.messageId ? db.message.findUnique({ where: { id: event.refs.messageId }, select: { content: true } }) : null,
    db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { companyName: true } }),
  ]);
  const customerId = event.refs.customerId ?? conversation?.customerId ?? null;
  const customer = customerId ? await db.customer.findUnique({ where: { id: customerId }, select: { name: true, email: true, phone: true } }) : null;
  const channel = conversation?.channel ?? (typeof event.data.channel === 'string' ? event.data.channel : null);
  return {
    conversationId: conversation?.id ?? event.refs.conversationId ?? null,
    customerId,
    channel,
    text: message?.content ?? null,
    intent: (typeof event.data.intent === 'string' ? event.data.intent : null) ?? conversation?.intent ?? null,
    org: { ...org, botCompany: bot?.companyName ?? null },
    teamOnline: isWithinBusinessHours(org.businessHours, org.timezone),
    vars: {
      'customer.name': customer?.name ?? null,
      'customer.firstName': customer?.name?.split(/\s+/)[0] ?? null,
      'customer.email': customer?.email ?? null,
      'customer.phone': customer?.phone ?? null,
      'conversation.channel': channel === 'WHATSAPP' ? 'WhatsApp' : channel === 'WEBSITE' ? 'website chat' : null,
      'message.text': message?.content ?? null,
      'company.name': bot?.companyName ?? org.name,
      'agent.name': conversation?.assignedTo?.name ?? null,
    },
  };
}

/** Runs one automation for one event (no-op if it already ran for this event). */
export async function runAutomation(automation: Automation, event: DomainEvent, ctx: EventContext) {
  // Claim the (automation, event) pair; a second claim inserts nothing → already ran.
  const { count } = await prisma.automationRun.createMany({
    data: [{ organizationId: event.organizationId, automationId: automation.id, eventId: event.id, eventType: event.type, status: 'SKIPPED', conversationId: ctx.conversationId }],
    skipDuplicates: true,
  });
  if (count === 0) return null;
  const runId = (await prisma.automationRun.findUniqueOrThrow({ where: { automationId_eventId: { automationId: automation.id, eventId: event.id } }, select: { id: true } })).id;

  const started = Date.now();
  const actionCtx: ActionContext = {
    db: tenantDb(event.organizationId),
    organizationId: event.organizationId,
    automation: { id: automation.id, name: automation.name },
    event,
    conversationId: ctx.conversationId,
    customerId: ctx.customerId,
    vars: ctx.vars,
    org: { timezone: ctx.org.timezone, businessHours: ctx.org.businessHours, defaultLanguage: ctx.org.defaultLanguage },
  };
  const results: { type: string; ok: boolean; skipped?: boolean; detail: string }[] = [];
  for (const action of parseActions(automation.actions)) {
    try {
      results.push({ type: action.type, ok: true, detail: await executeAction(actionCtx, action) });
    } catch (err) {
      const skipped = err instanceof ActionSkipped;
      results.push({ type: action.type, ok: false, skipped, detail: (err as Error).message.slice(0, 300) });
      if (!skipped) logger.warn('automation action failed', { organizationId: event.organizationId, automationId: automation.id, action: action.type, err: (err as Error).message });
    }
  }
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const succeeded = results.filter((r) => r.ok).length;
  const status = failed === 0 ? (succeeded ? 'SUCCESS' : 'SKIPPED') : succeeded ? 'PARTIAL' : 'FAILED';
  await prisma.$transaction([
    prisma.automationRun.update({
      where: { id: runId },
      data: { status, results: results as unknown as Prisma.InputJsonValue, durationMs: Date.now() - started, error: failed ? results.find((r) => !r.ok && !r.skipped)!.detail : null },
    }),
    prisma.automation.update({ where: { id: automation.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } }),
  ]);
  logger.info('automation ran', { organizationId: event.organizationId, automationId: automation.id, eventType: event.type, status, ms: Date.now() - started });
  return status;
}

/** Event consumer: runs every active automation whose trigger and conditions match. */
export async function runAutomationsForEvent(event: DomainEvent) {
  const triggers = triggersForEvent(event);
  if (!triggers.length || event.causedBy.length >= MAX_CHAIN_DEPTH) return 0;
  const automations = await prisma.automation.findMany({
    where: { organizationId: event.organizationId, isActive: true, trigger: { in: triggers } },
    orderBy: { createdAt: 'asc' },
  });
  const eligible = automations.filter((a) => !event.causedBy.includes(a.id));
  if (!eligible.length) return 0;
  const ctx = await loadEventContext(event);
  let ran = 0;
  for (const automation of eligible) {
    // A KEYWORD_DETECTED automation without keywords would match everything: never run it.
    const conditions = parseConditions(automation.conditions);
    if (automation.trigger === 'KEYWORD_DETECTED' && !conditions.keywords.length) continue;
    if (!matchesConditions(conditions, { channel: ctx.channel, text: ctx.text, intent: ctx.intent, teamOnline: ctx.teamOnline })) continue;
    if ((await runAutomation(automation, event, ctx)) !== null) ran++;
  }
  return ran;
}

/** Window after the threshold in which a conversation still counts as "just went quiet". */
const INACTIVITY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Job: fires CONVERSATION_INACTIVE automations for conversations that crossed the
 * automation's inactivity threshold recently. The event id includes the last message
 * time, so each quiet period triggers once.
 */
export async function scanInactiveConversations(): Promise<number> {
  const automations = await prisma.automation.findMany({ where: { isActive: true, trigger: 'CONVERSATION_INACTIVE' } });
  let fired = 0;
  for (const automation of automations) {
    const conditions = parseConditions(automation.conditions);
    const cutoff = new Date(Date.now() - conditions.inactiveMinutes * 60_000);
    const conversations = await prisma.conversation.findMany({
      where: {
        organizationId: automation.organizationId,
        status: { not: 'CLOSED' },
        lastMessageAt: { lte: cutoff, gte: new Date(cutoff.getTime() - INACTIVITY_WINDOW_MS) },
        ...(conditions.channels.length ? { channel: { in: conditions.channels } } : {}),
      },
      select: { id: true, customerId: true, channel: true, lastMessageAt: true },
      take: 200,
    });
    for (const conversation of conversations) {
      if (conditions.lastMessageFrom !== 'any') {
        const last = await prisma.message.findFirst({
          where: { conversationId: conversation.id, senderType: { not: 'SYSTEM' } },
          orderBy: { createdAt: 'desc' },
          select: { senderType: true },
        });
        const fromCustomer = last?.senderType === 'CUSTOMER';
        if ((conditions.lastMessageFrom === 'customer') !== fromCustomer) continue;
      }
      const event = buildEvent({
        id: `inactive_${automation.id}_${conversation.id}_${conversation.lastMessageAt.getTime()}`,
        type: 'conversation.inactive',
        organizationId: automation.organizationId,
        refs: { conversationId: conversation.id, customerId: conversation.customerId },
        data: { channel: conversation.channel, inactiveMinutes: conditions.inactiveMinutes },
      });
      const ctx = await loadEventContext(event);
      if (!matchesConditions({ ...conditions, keywords: [], intents: [] }, { channel: ctx.channel, text: null, intent: null, teamOnline: ctx.teamOnline })) continue;
      if ((await runAutomation(automation, event, ctx)) !== null) fired++;
    }
  }
  return fired;
}
