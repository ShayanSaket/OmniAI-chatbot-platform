import 'server-only';
import { Prisma, type BotConfiguration, type Intent } from '@prisma/client';
import { parseAgentBehavior } from '@/lib/agent-tools';
import type { BusinessHoursRule } from '@/lib/business-hours';
import { detectLanguage } from '@/lib/language';
import type { WidgetAction, WidgetEvent } from '@/lib/widget-protocol';
import { runInBackground } from '../../background';
import { buildEvent, dispatchEvent, emitDomainEvent } from '../../events/domain-events';
import { runAutomationsForEvent } from '../automations/engine';
import { getChannelAdapter } from '../../channels/registry';
import type { NormalizedInboundMessage } from '../../channels/types';
import { toWidgetConversation, toWidgetMessage } from '../../channels/website/serialize';
import { env } from '../../env';
import { logger } from '../../logger';
import { channels, publish } from '../../realtime/bus';
import type { TenantDb } from '../../tenancy/tenant-db';
import { classifyMessage } from '../agent/classifier';
import { decideEscalation, type EscalationDecision } from '../agent/escalation';
import { summarizeConversation } from '../agent/memory';
import { warmer, type MessageSignals } from '../agent/signals';
import { appendMessage, CONVERSATION_INCLUDE, getOrCreateActiveConversation, MESSAGE_INCLUDE } from './conversation-service';
import { requestHumanHandoff } from './handoff';
import { generateAiReply } from './responder';
import { systemText } from './system-messages';

// Inbound message pipeline (shared by every channel):
//
//   normalize (adapter) → store (idempotent) → conversation → customer memory/language
//   → classify intent (parallel) → human-handoff state → knowledge + tools + AI (agent
//   loop) → guardrails → store reply → escalation rules → deliver → analytics/summaries

export interface PipelineContext {
  db: TenantDb;
  bot: BotConfiguration;
  timeZone: string;
  businessHours: BusinessHoursRule[];
}

export type Emit = (event: WidgetEvent) => void;

let streamCounter = 0;
const CLASSIFICATION_WAIT_MS = 6000;
/** Minimum confidence before a detected language overrides the stored one. */
const LANGUAGE_CONFIDENCE = 0.6;

/** Conversation-level intent keeps the most significant intent seen so far. */
const INTENT_RANK: Record<Intent, number> = {
  OTHER: 0,
  FAQ: 1,
  CONTACT: 2,
  SUPPORT: 3,
  TECHNICAL: 4,
  SALES: 5,
  PRICING: 6,
  DEMO: 7,
  COMPLAINT: 8,
};

export function strongerIntent(current: Intent | null, next: Intent): Intent {
  return !current || INTENT_RANK[next] > INTENT_RANK[current] ? next : current;
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Stores intent / lead temperature / sentiment on the message and the conversation. */
async function applySignals(
  db: TenantDb,
  conversationId: string,
  messageId: string,
  signals: MessageSignals,
  eventRefs: { organizationId: string; customerId: string; channel: string },
) {
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { intent: true, leadTemperature: true, metadata: true },
  });
  const meta = (conversation.metadata ?? {}) as Record<string, unknown>;
  await db.$transaction([
    db.message.update({
      where: { id: messageId },
      data: { intent: signals.intent },
    }),
    db.conversation.update({
      where: { id: conversationId },
      data: {
        intent: strongerIntent(conversation.intent, signals.intent),
        leadTemperature: warmer(conversation.leadTemperature, signals.leadTemperature),
        metadata: {
          ...meta,
          sentiment: signals.sentiment,
          lastSignals: {
            intent: signals.intent,
            sentiment: signals.sentiment,
            escalation: signals.escalation,
            source: signals.source,
            at: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    }),
  ]);
  if (signals.intent !== 'OTHER') {
    emitDomainEvent({
      type: 'intent.detected',
      organizationId: eventRefs.organizationId,
      refs: { conversationId, customerId: eventRefs.customerId, messageId },
      data: { channel: eventRefs.channel, intent: signals.intent, sentiment: signals.sentiment, leadTemperature: signals.leadTemperature },
    });
  }
}

export interface PipelineOptions {
  /** false = store the message but do not generate an AI reply (e.g. rate limited). */
  aiReply?: boolean;
}

export async function processInboundMessage(
  ctx: PipelineContext,
  inbound: NormalizedInboundMessage,
  emit: Emit = () => {},
  options: PipelineOptions = {},
) {
  const { db, bot } = ctx;
  const log = logger.child({ organizationId: inbound.organizationId, channel: inbound.channel });
  const model = bot.model || env().OPENAI_CHAT_MODEL;

  const { conversation, created } = await getOrCreateActiveConversation(db, inbound);

  let customerMessage;
  try {
    customerMessage = await appendMessage(db, conversation, {
      senderType: 'CUSTOMER',
      content: inbound.content,
      messageType: inbound.messageType,
      externalMessageId: inbound.externalMessageId,
      status: 'RECEIVED',
      attachments: inbound.attachments.length ? (inbound.attachments as unknown as Prisma.InputJsonValue) : undefined,
      // Stored at arrival time: provider timestamps have second precision and can sort a
      // new message before the reply it follows. The provider time is kept for reference.
      metadata: { ...inbound.metadata, sentAt: inbound.receivedAt.toISOString() } as Prisma.InputJsonValue,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return replayDuplicate(ctx, inbound, emit);
    }
    throw err;
  }

  const widgetConversation = toWidgetConversation(conversation);
  emit({ type: 'message', message: toWidgetMessage(customerMessage), conversation: widgetConversation });
  await Promise.all([
    // Echo to the visitor's other open widget tabs (website only).
    inbound.channel === 'WEBSITE'
      ? publish(channels.visitor(inbound.customerId), { type: 'message', message: toWidgetMessage(customerMessage), conversation: widgetConversation })
      : Promise.resolve(),
    publish(channels.inbox(inbound.organizationId), {
      type: created ? 'conversation.created' : 'message.received',
      conversationId: conversation.id,
      messageId: customerMessage.id,
    }),
  ]);

  // Language follows the customer: a confident detection updates the profile, so
  // replies and system notices switch when the customer switches.
  const detected = detectLanguage(inbound.content);
  const customer = await db.customer.update({
    where: { id: inbound.customerId },
    data: {
      lastSeenAt: new Date(),
      ...(detected && detected.confidence >= LANGUAGE_CONFIDENCE ? { language: detected.language } : {}),
    },
    select: { language: true },
  });

  // Classification runs in parallel with the reply (no added latency before the first token).
  const context = await db.message.findMany({
    where: { conversationId: conversation.id, id: { not: customerMessage.id }, senderType: { in: ['CUSTOMER', 'AI', 'AGENT'] } },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: { senderType: true, content: true },
  });
  const classification = classifyMessage({
    db,
    organizationId: inbound.organizationId,
    conversationId: conversation.id,
    model,
    text: inbound.content,
    context: context.reverse().map((m) => `${m.senderType === 'CUSTOMER' ? 'Customer' : 'Assistant'}: ${m.content.slice(0, 400)}`),
  });
  const persistSignals = classification
    .then((signals) =>
      applySignals(db, conversation.id, customerMessage.id, signals, {
        organizationId: inbound.organizationId,
        customerId: inbound.customerId,
        channel: inbound.channel,
      }),
    )
    .catch((err) => log.warn('storing message signals failed', { conversationId: conversation.id, err: (err as Error).message }));

  // Domain events. Automations for them run now, before the AI answers, so rules such as
  // "hand refund requests to a human" take effect first. Webhooks and integrations follow
  // in the background (automation runs are unique per event, so nothing runs twice).
  const events = [
    ...(created ? [buildEvent({ type: 'conversation.created', organizationId: inbound.organizationId, refs: { conversationId: conversation.id, customerId: inbound.customerId }, data: { channel: inbound.channel } })] : []),
    buildEvent({
      type: 'message.received',
      organizationId: inbound.organizationId,
      refs: { conversationId: conversation.id, customerId: inbound.customerId, messageId: customerMessage.id },
      data: { channel: inbound.channel },
    }),
  ];
  for (const event of events) {
    await runAutomationsForEvent(event).catch((err) => log.error('automations failed', { eventType: event.type, err: (err as Error).message }));
    runInBackground('domain-event', () => dispatchEvent(event), { eventType: event.type, eventId: event.id });
  }
  const statusNow = (await db.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { status: true } })).status;

  // Human mode: the AI must stay silent. Signals are still stored for the inbox.
  if (conversation.status !== 'AI_ACTIVE' || statusNow !== 'AI_ACTIVE') {
    runInBackground('persist-signals', () => persistSignals, { conversationId: conversation.id });
    log.info('message stored; conversation in human mode, AI skipped', { conversationId: conversation.id, status: conversation.status });
    return { conversation, customerMessage, reply: null };
  }

  // A "Talk to a human" button tap: hand over directly, no AI answer.
  if (inbound.metadata.action === 'handoff' && bot.escalationBehavior !== 'DISABLED') {
    runInBackground('persist-signals', () => persistSignals, { conversationId: conversation.id });
    const result = await requestHumanHandoff({
      db,
      conversation,
      businessHours: ctx.businessHours,
      timeZone: ctx.timeZone,
      reason: 'customer_request',
      detail: { trigger: 'button' },
      language: customer.language ?? bot.defaultLanguage,
    });
    if (result.message) {
      emit({ type: 'message', message: toWidgetMessage(result.message), conversation: toWidgetConversation(result.conversation) });
      await getChannelAdapter(inbound.channel).sendMessage(result.conversation, result.message);
    }
    runInBackground('conversation-summary', () => summarizeConversation({ db, organizationId: inbound.organizationId, conversationId: conversation.id, model, force: true }), {
      conversationId: conversation.id,
    });
    return { conversation: result.conversation, customerMessage, reply: null };
  }

  if (options.aiReply === false) {
    runInBackground('persist-signals', () => persistSignals, { conversationId: conversation.id });
    log.warn('message stored without AI reply', { conversationId: conversation.id });
    return { conversation, customerMessage, reply: null };
  }

  const behavior = parseAgentBehavior(bot.behavior);
  // Set inside beforeStore (a callback), so declared with a cast to avoid narrowing.
  let decision = { kind: 'none' } as EscalationDecision;
  const streamId = `s${Date.now().toString(36)}${(streamCounter++).toString(36)}`;
  const reply = await generateAiReply(
    {
      db,
      organizationId: inbound.organizationId,
      timeZone: ctx.timeZone,
      bot,
      businessHours: ctx.businessHours,
      conversation,
      customerId: inbound.customerId,
      latestText: inbound.content,
      language: customer.language,
    },
    {
      onStart: () => emit({ type: 'assistant.start', streamId }),
      onDelta: (text) => emit({ type: 'assistant.delta', streamId, text }),
      onStatus: (status) => emit({ type: 'assistant.status', streamId, status }),
      beforeStore: async (): Promise<WidgetAction[]> => {
        const signals = await settleWithin(classification, CLASSIFICATION_WAIT_MS);
        decision = decideEscalation({ behavior: bot.escalationBehavior, escalateOn: behavior.escalateOn, signals });
        return decision.kind === 'suggest'
          ? [{ label: systemText(customer.language ?? bot.defaultLanguage).talkToHuman, action: 'handoff' }]
          : [];
      },
    },
  );

  const replyMessage = toWidgetMessage(reply.message);
  emit({ type: 'assistant.done', streamId, message: replyMessage });
  // Deliver through the channel adapter (other open widget tabs; WhatsApp send in phase 5).
  await getChannelAdapter(inbound.channel).sendMessage(conversation, reply.message);

  await persistSignals;

  // Escalation: requested by the model (tool) or by the configured rules.
  const handoff = reply.handoff
    ? { reason: 'ai_escalation' as const, detail: { trigger: reply.handoff.reason, note: reply.handoff.note } }
    : decision.kind === 'handoff'
      ? {
          reason: decision.trigger === 'customer_request' ? ('customer_request' as const) : ('rule' as const),
          detail: { trigger: decision.trigger },
        }
      : null;
  if (handoff) {
    const current = await db.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: CONVERSATION_INCLUDE });
    const result = await requestHumanHandoff({
      db,
      conversation: current,
      businessHours: ctx.businessHours,
      timeZone: ctx.timeZone,
      reason: handoff.reason,
      detail: handoff.detail,
      language: customer.language ?? bot.defaultLanguage,
    });
    if (result.message) {
      emit({ type: 'message', message: toWidgetMessage(result.message), conversation: toWidgetConversation(result.conversation) });
      await getChannelAdapter(inbound.channel).sendMessage(result.conversation, result.message);
    }
    log.info('conversation escalated', { conversationId: conversation.id, reason: handoff.reason, ...handoff.detail, teamOnline: result.teamOnline });
  }

  runInBackground(
    'conversation-summary',
    () => summarizeConversation({ db, organizationId: inbound.organizationId, conversationId: conversation.id, model, force: Boolean(handoff) }),
    { conversationId: conversation.id },
  );
  return { conversation, customerMessage, reply: reply.message };
}

/** A retried client request: re-emit what was stored instead of processing twice. */
async function replayDuplicate(ctx: PipelineContext, inbound: NormalizedInboundMessage, emit: Emit) {
  const existing = await ctx.db.message.findFirstOrThrow({
    where: { channel: inbound.channel, externalMessageId: inbound.externalMessageId },
    include: { ...MESSAGE_INCLUDE, conversation: { include: { assignedTo: { select: { name: true } } } } },
  });
  emit({ type: 'message', message: toWidgetMessage(existing), conversation: toWidgetConversation(existing.conversation) });
  const reply = await ctx.db.message.findFirst({
    where: { conversationId: existing.conversationId, createdAt: { gte: existing.createdAt }, senderType: { in: ['AI', 'AGENT'] } },
    orderBy: { createdAt: 'asc' },
    include: MESSAGE_INCLUDE,
  });
  if (reply) emit({ type: 'assistant.done', streamId: 'replay', message: toWidgetMessage(reply) });
  return { conversation: existing.conversation, customerMessage: existing, reply, duplicate: true as const };
}
