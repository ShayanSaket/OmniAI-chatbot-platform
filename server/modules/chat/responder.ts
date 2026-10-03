import 'server-only';
import type { BotConfiguration, Conversation, Message, Prisma } from '@prisma/client';
import { parseAgentBehavior } from '@/lib/agent-tools';
import { isWithinBusinessHours, nextOpening, type BusinessHoursRule } from '@/lib/business-hours';
import type { WidgetAction } from '@/lib/widget-protocol';
import { ProviderNotConfiguredError, type ChatMessage } from '../../ai/provider';
import { recordUsage } from '../../ai/usage';
import { env } from '../../env';
import { loadOrderLookup } from '../../integrations/order-lookup';
import { logger } from '../../logger';
import type { TenantDb } from '../../tenancy/tenant-db';
import { runAgent, type AgentRunResult } from '../agent/agent-runner';
import { detectPromptInjection, guardOutput, INJECTION_REMINDER } from '../agent/guardrails';
import { customerFactLines, loadConversationMemory, loadCustomerContext } from '../agent/memory';
import { availableTools } from '../agent/tools/registry';
import { KnowledgeRefs, type ToolContext } from '../agent/tools/types';
import { buildSystemPrompt, maxTokensFor, temperatureFor } from '../ai/prompt-builder';
import { recordKnowledgeUsage, searchKnowledge } from '../knowledge/retrieval';
import { appendMessage } from './conversation-service';
import { systemText } from './system-messages';

/** Knowledge snippets retrieved automatically for every customer message. */
const AUTO_RETRIEVAL_LIMIT = 4;
const HISTORY_MESSAGE_CHARS = 2000;

export interface ReplyContext {
  db: TenantDb;
  organizationId: string;
  timeZone: string;
  bot: BotConfiguration;
  businessHours: BusinessHoursRule[];
  conversation: Pick<Conversation, 'id' | 'organizationId' | 'channel' | 'firstResponseAt' | 'status' | 'leadTemperature'>;
  customerId: string;
  /** The customer's latest message (retrieval query, injection check). */
  latestText: string;
  /** Customer language (ISO 639-1) for fallback texts. */
  language: string | null;
}

export interface ReplyCallbacks {
  onStart?: () => void;
  onDelta?: (text: string) => void;
  onStatus?: (status: 'searching' | 'working') => void;
  /** Awaited just before the reply is stored: extra buttons (e.g. a suggested handoff). */
  beforeStore?: () => Promise<WidgetAction[]>;
}

function toChatHistory(messages: Message[]): ChatMessage[] {
  return messages
    .filter((m) => m.senderType !== 'SYSTEM')
    .map((m): ChatMessage => {
      const attachments = Array.isArray(m.attachments) ? (m.attachments as { fileName: string }[]) : [];
      const note = attachments.length ? `\n[Attached: ${attachments.map((a) => a.fileName).join(', ')}]` : '';
      const content = m.content.length > HISTORY_MESSAGE_CHARS ? `${m.content.slice(0, HISTORY_MESSAGE_CHARS)}…` : m.content;
      if (m.senderType === 'CUSTOMER') return { role: 'user', content: `${content}${note}`.trim() };
      if (m.senderType === 'AGENT') return { role: 'assistant', content: `[Human team member] ${content}` };
      return { role: 'assistant', content };
    })
    .filter((m) => m.content.length > 0);
}

function secretValues(): string[] {
  const e = env();
  const dbPassword = (() => {
    try {
      return decodeURIComponent(new URL(e.DATABASE_URL).password);
    } catch {
      return undefined;
    }
  })();
  return [
    e.OPENAI_API_KEY,
    e.AUTH_SECRET,
    e.ENCRYPTION_KEY,
    e.WHATSAPP_ACCESS_TOKEN,
    e.WHATSAPP_APP_SECRET,
    e.WHATSAPP_VERIFY_TOKEN,
    e.S3_SECRET_KEY,
    dbPassword,
  ].filter(
    (v): v is string => Boolean(v),
  );
}

function dedupeActions(actions: WidgetAction[]): WidgetAction[] {
  return actions.filter((a, i) => actions.findIndex((b) => b.action === a.action) === i);
}

/**
 * Generates, streams and stores the AI reply for a conversation: memory + knowledge +
 * tools → agent loop → guardrails → stored message with sources. Never throws for
 * provider problems: on failure it stores a graceful localized fallback with a
 * "Talk to a human" action, so the customer is never left without an answer.
 */
export async function generateAiReply(ctx: ReplyContext, callbacks: ReplyCallbacks = {}) {
  const { db, bot, conversation } = ctx;
  const now = new Date();
  const teamOnline = isWithinBusinessHours(ctx.businessHours, ctx.timeZone, now);
  const model = bot.model || env().OPENAI_CHAT_MODEL;
  const behavior = parseAgentBehavior(bot.behavior);
  const language = ctx.language ?? bot.defaultLanguage;
  const t = systemText(language);

  const [layers, memory, customer, orderLookup, retrieved] = await Promise.all([
    db.promptConfiguration.findMany({ where: { OR: [{ botId: bot.id }, { botId: null }] } }),
    loadConversationMemory(db, conversation.id),
    loadCustomerContext(db, ctx.customerId),
    loadOrderLookup(db),
    ctx.latestText.trim()
      ? searchKnowledge(ctx.organizationId, ctx.latestText, { limit: AUTO_RETRIEVAL_LIMIT }).catch((err) => {
          logger.warn('knowledge retrieval failed', { organizationId: ctx.organizationId, err: (err as Error).message });
          return [];
        })
      : Promise.resolve([]),
  ]);

  const knowledge = new KnowledgeRefs();
  const snippets = retrieved.map((chunk) => ({
    ref: knowledge.add(chunk),
    title: chunk.title,
    location: chunk.pageNumber ? `${chunk.location ?? chunk.title}, page ${chunk.pageNumber}` : chunk.location,
    content: chunk.content,
  }));

  let transcript: string | null = null;
  const toolCtx: ToolContext = {
    db,
    organizationId: ctx.organizationId,
    bot,
    behavior,
    conversation: { id: conversation.id, channel: conversation.channel, status: conversation.status, leadTemperature: conversation.leadTemperature },
    customerId: ctx.customerId,
    timeZone: ctx.timeZone,
    businessHours: ctx.businessHours,
    language,
    knowledge,
    orderLookup,
    customerTranscript: async () => {
      transcript ??= (
        await db.message.findMany({
          where: { conversationId: conversation.id, senderType: 'CUSTOMER' },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { content: true },
        })
      )
        .map((m) => m.content)
        .join('\n');
      return transcript;
    },
    handoff: null,
    suggestHandoff: false,
  };
  const tools = availableTools(toolCtx);
  const injectionSuspected = detectPromptInjection(ctx.latestText);

  const system = buildSystemPrompt(bot, layers, {
    channel: conversation.channel,
    now,
    timeZone: ctx.timeZone,
    teamOnline,
    nextOpenAt: teamOnline ? null : nextOpening(ctx.businessHours, ctx.timeZone, now),
    customer: { name: customer.profile.name, language: customer.profile.language },
    customerLines: customerFactLines(customer),
    conversationSummary: memory.summary,
    knowledge: snippets,
    toolsEnabled: tools.length > 0,
    securityNotice: injectionSuspected ? INJECTION_REMINDER : null,
  });
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...toChatHistory(memory.history)];

  callbacks.onStart?.();
  const started = Date.now();
  let run: AgentRunResult | null = null;
  let failure: { code: string; detail: string } | null = null;

  try {
    run = await runAgent({
      model,
      temperature: temperatureFor(bot.creativity),
      maxTokens: maxTokensFor(bot.answerLength),
      messages,
      tools,
      toolCtx,
      onDelta: callbacks.onDelta,
      onStatus: callbacks.onStatus,
    });
    if (!run.text) failure = { code: 'EMPTY_COMPLETION', detail: 'The model returned no text.' };
  } catch (err) {
    failure =
      err instanceof ProviderNotConfiguredError
        ? { code: 'AI_NOT_CONFIGURED', detail: err.message }
        : { code: 'AI_PROVIDER_ERROR', detail: (err as Error).message };
  }
  const latencyMs = Date.now() - started;
  const log = logger.child({ organizationId: ctx.organizationId, conversationId: conversation.id, channel: conversation.channel });

  let text: string;
  let guardFlags: string[] = [];
  let sources: { documentId: string; title: string; chunkId: string }[] = [];
  if (failure || !run) {
    log.warn('ai reply failed; sending fallback', { code: failure?.code, detail: failure?.detail, latencyMs });
    // Discard partial output: a half answer is worse than an honest fallback. The client
    // replaces streamed text with the stored message from the final event.
    text = teamOnline ? t.fallbackOnline : t.fallbackOffline;
  } else {
    const protectedText = layers
      .filter((l) => l.isActive && (l.layer === 'GLOBAL_POLICY' || l.layer === 'BUSINESS_RULES' || l.layer === 'CHANNEL'))
      .map((l) => l.content);
    const guarded = guardOutput(
      run.text,
      {
        secrets: secretValues(),
        protectedText,
        allowedContext: [system, ...memory.history.map((m) => m.content), ...run.toolOutputs].join('\n'),
      },
      t.cannotShareInternals,
    );
    text = guarded.text;
    guardFlags = guarded.flags;
    if (guardFlags.length) log.warn('output guard modified the reply', { flags: guardFlags });
    if (!guardFlags.includes('prompt_leak')) {
      for (const ref of run.citations) {
        const chunk = knowledge.get(ref);
        if (chunk && !sources.some((s) => s.documentId === chunk.documentId)) {
          sources.push({ documentId: chunk.documentId, title: chunk.title, chunkId: chunk.chunkId });
        }
      }
    } else {
      sources = [];
    }
  }

  const extraActions = (await callbacks.beforeStore?.().catch(() => [])) ?? [];
  const handoffAction: WidgetAction = { label: t.talkToHuman, action: 'handoff' };
  const actions = dedupeActions([
    ...(failure ? [handoffAction] : []),
    ...(toolCtx.suggestHandoff && !toolCtx.handoff ? [handoffAction] : []),
    ...extraActions,
  ]);

  const toolResults = run?.toolResults ?? [];
  const message = await appendMessage(db, conversation, {
    senderType: 'AI',
    content: text.trim(),
    status: 'SENT',
    sources: sources.length ? (sources as unknown as Prisma.InputJsonValue) : undefined,
    metadata: {
      model,
      ...(failure ? { fallback: true, errorCode: failure.code } : {}),
      ...(actions.length ? { actions } : {}),
      ...(toolResults.length ? { tools: toolResults.map((r) => ({ name: r.toolName, status: r.status })) } : {}),
      ...(run ? { rounds: run.rounds } : {}),
      ...(guardFlags.length ? { guard: guardFlags } : {}),
      ...(injectionSuspected ? { injectionSuspected: true } : {}),
      // For knowledge-gap analytics: did retrieval find anything for this question?
      retrieval: { hits: snippets.length, topScore: retrieved[0]?.score ?? null, topSimilarity: retrieved[0]?.similarity ?? null },
    } as unknown as Prisma.InputJsonValue,
  });

  if (toolResults.length) {
    await db.toolExecution.updateMany({
      where: { id: { in: toolResults.map((r) => r.executionId) } },
      data: { messageId: message.id },
    });
  }

  if (run && !failure) {
    // The AI has now read everything the customer sent.
    await db.message.updateMany({
      where: { conversationId: conversation.id, senderType: 'CUSTOMER', status: 'RECEIVED' },
      data: { status: 'READ' },
    });
    const usage = await recordUsage(db, {
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      kind: 'CHAT',
      model,
      usage: run.usage,
      latencyMs,
      estimate: { input: messages.map((m) => m.content).join('\n'), output: text },
    });
    await recordKnowledgeUsage(ctx.organizationId, sources.map((s) => s.documentId));
    log.info('ai reply generated', {
      model,
      latencyMs,
      rounds: run.rounds,
      tools: toolResults.map((r) => `${r.toolName}:${r.status}`),
      retrieved: snippets.length,
      cited: sources.length,
      ...usage,
    });
  }

  return {
    message,
    failed: Boolean(failure),
    failureCode: failure?.code ?? null,
    /** Handoff requested by the model through request_human_agent. */
    handoff: toolCtx.handoff,
    toolNames: toolResults.filter((r) => r.status === 'SUCCESS').map((r) => r.toolName),
  };
}
