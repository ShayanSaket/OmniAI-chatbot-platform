import 'server-only';
import type { Message, Prisma } from '@prisma/client';
import { z } from 'zod';
import { complete, ProviderNotConfiguredError } from '../../ai/provider';
import { recordUsage } from '../../ai/usage';
import { logger } from '../../logger';
import type { TenantDb } from '../../tenancy/tenant-db';

// Memory layers
//   short-term   the last HISTORY_WINDOW messages after the latest summary
//   summary      a rolling ConversationSummary, refreshed every SUMMARIZE_EVERY messages
//   long-term    Customer.memory (interests, preferences, facts) + Customer.aiSummary,
//                updated by the summarizer and carried into future conversations

export const HISTORY_WINDOW = 12;
export const SUMMARIZE_EVERY = 12;
const MAX_LIST = 10;

export const customerMemorySchema = z.object({
  productInterests: z.array(z.string().max(120)).max(MAX_LIST).catch([]).default([]),
  preferences: z.array(z.string().max(160)).max(MAX_LIST).catch([]).default([]),
  facts: z.array(z.string().max(200)).max(MAX_LIST).catch([]).default([]),
});
export type CustomerMemory = z.infer<typeof customerMemorySchema>;

export function parseCustomerMemory(value: unknown): CustomerMemory {
  const parsed = customerMemorySchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : { productInterests: [], preferences: [], facts: [] };
}

/** Merges new facts into memory: case-insensitive dedupe, newest kept, capped. */
export function mergeMemory(current: CustomerMemory, update: Partial<CustomerMemory>): CustomerMemory {
  const merge = (a: string[], b: string[] = []) => {
    const out: string[] = [];
    for (const item of [...b, ...a].map((s) => s.trim()).filter(Boolean)) {
      if (!out.some((o) => o.toLowerCase() === item.toLowerCase())) out.push(item);
    }
    return out.slice(0, MAX_LIST);
  };
  return {
    productInterests: merge(current.productInterests, update.productInterests),
    preferences: merge(current.preferences, update.preferences),
    facts: merge(current.facts, update.facts),
  };
}

/**
 * The recent window plus, when the conversation is longer than the window, the latest
 * summary for everything older. The window never depends on the summary, so a weak
 * summary can't hide recent messages.
 */
export async function loadConversationMemory(db: TenantDb, conversationId: string) {
  const [history, total] = await Promise.all([
    db.message
      .findMany({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY_WINDOW })
      .then((rows) => rows.reverse()),
    db.message.count({ where: { conversationId } }),
  ]);
  const summary =
    total > HISTORY_WINDOW
      ? await db.conversationSummary.findFirst({ where: { conversationId }, orderBy: { createdAt: 'desc' }, select: { summary: true } })
      : null;
  return { summary: summary?.summary ?? null, history };
}

export interface CustomerContext {
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    language: string | null;
  };
  memory: CustomerMemory;
  previousSummary: string | null;
  openLeads: { status: string; requestedService: string | null }[];
  openTickets: { reference: string; subject: string; status: string }[];
  appointments: { topic: string; status: string; preferredTime: string }[];
}

export const ticketReference = (id: string) => `T-${id.slice(-6).toUpperCase()}`;

export async function loadCustomerContext(db: TenantDb, customerId: string): Promise<CustomerContext> {
  const customer = await db.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: {
      name: true,
      email: true,
      phone: true,
      company: true,
      language: true,
      memory: true,
      aiSummary: true,
      leads: { where: { status: { notIn: ['WON', 'LOST'] } }, select: { status: true, requestedService: true }, take: 3, orderBy: { createdAt: 'desc' } },
      tickets: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } }, select: { id: true, subject: true, status: true }, take: 3, orderBy: { createdAt: 'desc' } },
      appointments: { where: { status: { in: ['REQUESTED', 'CONFIRMED'] } }, select: { topic: true, status: true, preferredTime: true }, take: 3, orderBy: { createdAt: 'desc' } },
    },
  });
  return {
    profile: { name: customer.name, email: customer.email, phone: customer.phone, company: customer.company, language: customer.language },
    memory: parseCustomerMemory(customer.memory),
    previousSummary: customer.aiSummary,
    openLeads: customer.leads,
    openTickets: customer.tickets.map((t) => ({ reference: ticketReference(t.id), subject: t.subject, status: t.status })),
    appointments: customer.appointments,
  };
}

/** Customer facts as prompt lines (only this customer's own data). */
export function customerFactLines(ctx: CustomerContext): string[] {
  const p = ctx.profile;
  const lines = [
    `Name: ${p.name ?? 'unknown'}`,
    p.email ? `Email: ${p.email}` : 'Email: not provided',
    p.phone ? `Phone: ${p.phone}` : null,
    p.company ? `Company: ${p.company}` : null,
    ctx.memory.productInterests.length ? `Interested in: ${ctx.memory.productInterests.join('; ')}` : null,
    ctx.memory.preferences.length ? `Preferences: ${ctx.memory.preferences.join('; ')}` : null,
    ...ctx.memory.facts.map((f) => `Known: ${f}`),
    ctx.previousSummary ? `Previous conversations: ${ctx.previousSummary}` : null,
    ...ctx.openLeads.map((l) => `Open sales request (${l.status.toLowerCase()}): ${l.requestedService ?? 'general interest'}`),
    ...ctx.openTickets.map((t) => `Open ticket ${t.reference} (${t.status.toLowerCase()}): ${t.subject}`),
    ...ctx.appointments.map((a) => `Appointment ${a.status.toLowerCase()}: ${a.topic} — ${a.preferredTime}`),
  ];
  return lines.filter((l): l is string => Boolean(l));
}

const SUMMARY_PROMPT = `TASK: maintain the running summary of a customer-service conversation for the support team and for the AI's memory.
You receive the previous summary (may be empty) and the new messages. Return only a JSON object:
{
  "summary": "≤ 120 words, third person, factual: who the customer is, what they need, what was answered, what is open, next steps. Mention which contact details were collected (e.g. 'Email collected') without repeating them.",
  "customerFacts": {
    "company": string or null,
    "productInterests": [short phrases],
    "preferences": [e.g. "prefers WhatsApp", "speaks German"],
    "facts": [durable facts useful in future conversations, e.g. "real-estate agency with ~200 inquiries/month"]
  }
}
Only include facts the customer actually stated. Never include passwords, payment data or other sensitive data.`;

const summarySchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  customerFacts: z
    .object({
      company: z.string().trim().max(120).nullable().optional(),
      productInterests: z.array(z.string()).optional(),
      preferences: z.array(z.string()).optional(),
      facts: z.array(z.string()).optional(),
    })
    .partial()
    .default({}),
});

const transcriptLine = (m: Pick<Message, 'senderType' | 'content'>) => {
  const who = m.senderType === 'CUSTOMER' ? 'Customer' : m.senderType === 'AGENT' ? 'Team member' : 'Assistant';
  return `${who}: ${m.content.replace(/\s+/g, ' ').slice(0, 1200)}`;
};

/**
 * Updates the conversation summary and the customer's long-term memory when enough new
 * messages accumulated (or `force` for conversation end / handoff). No-op without an AI
 * provider: a summary is never faked.
 */
export async function summarizeConversation(params: {
  db: TenantDb;
  organizationId: string;
  conversationId: string;
  model: string;
  force?: boolean;
}) {
  const { db, conversationId } = params;
  const latest = await db.conversationSummary.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    select: { summary: true, lastMessageId: true },
  });
  const anchor = latest?.lastMessageId
    ? await db.message.findUnique({ where: { id: latest.lastMessageId }, select: { createdAt: true } })
    : null;
  const fresh = await db.message.findMany({
    where: { conversationId, senderType: { not: 'SYSTEM' }, ...(anchor ? { createdAt: { gt: anchor.createdAt } } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 60,
    select: { id: true, senderType: true, content: true },
  });
  const minimum = params.force ? 2 : SUMMARIZE_EVERY;
  if (fresh.length < minimum) return null;

  const input = [`Previous summary: ${latest?.summary ?? '(none)'}`, '', 'New messages:', ...fresh.map(transcriptLine)].join('\n');
  const started = Date.now();
  let result: { text: string; usage: { promptTokens: number; completionTokens: number } };
  try {
    result = await complete({
      model: params.model,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: input },
      ],
      temperature: 0.1,
      maxTokens: 400,
      json: true,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (!(err instanceof ProviderNotConfiguredError)) {
      logger.warn('conversation summary failed', { organizationId: params.organizationId, conversationId, err: (err as Error).message });
    }
    return null;
  }
  await recordUsage(db, {
    organizationId: params.organizationId,
    conversationId,
    kind: 'SUMMARY',
    model: params.model,
    usage: result.usage,
    latencyMs: Date.now() - started,
    estimate: { input: SUMMARY_PROMPT + input, output: result.text },
  });

  let parsed: z.infer<typeof summarySchema>;
  try {
    parsed = summarySchema.parse(JSON.parse(result.text));
  } catch {
    logger.warn('conversation summary was not valid JSON', { organizationId: params.organizationId, conversationId });
    return null;
  }
  return saveSummary(db, {
    organizationId: params.organizationId,
    conversationId,
    summary: parsed.summary,
    lastMessageId: fresh[fresh.length - 1]!.id,
    facts: parsed.customerFacts,
  });
}

/** Stores a summary and folds customer facts into long-term memory. */
export async function saveSummary(
  db: TenantDb,
  params: {
    organizationId: string;
    conversationId: string;
    summary: string;
    lastMessageId: string | null;
    facts?: { company?: string | null; productInterests?: string[]; preferences?: string[]; facts?: string[] };
  },
) {
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: params.conversationId },
    select: { customerId: true, customer: { select: { memory: true, company: true } } },
  });
  const messageCount = await db.message.count({ where: { conversationId: params.conversationId, senderType: { not: 'SYSTEM' } } });
  const memory = mergeMemory(parseCustomerMemory(conversation.customer.memory), params.facts ?? {});
  const [summary] = await db.$transaction([
    db.conversationSummary.create({
      data: {
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        summary: params.summary,
        messageCount,
        lastMessageId: params.lastMessageId,
      },
    }),
    db.customer.update({
      where: { id: conversation.customerId },
      data: {
        aiSummary: params.summary,
        memory: memory as unknown as Prisma.InputJsonValue,
        ...(!conversation.customer.company && params.facts?.company ? { company: params.facts.company } : {}),
      },
    }),
  ]);
  return summary;
}
