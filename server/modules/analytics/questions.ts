import 'server-only';
import type { ChannelType, Intent, Prisma } from '@prisma/client';
import type { TopicCluster } from '@/lib/analytics';
import { clusterTopics, keywords } from '@/lib/topics';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';

// Customer questions and whether the AI could answer them, derived from what the AI
// reply recorded (phase 3/4): knowledge retrieval hits, cited sources, data tools used,
// and provider fallbacks. No extra AI calls.

/** Intents that are usually a question the business should be able to answer. */
export const QUESTION_INTENTS: readonly Intent[] = ['FAQ', 'SUPPORT', 'TECHNICAL', 'PRICING', 'SALES', 'DEMO'];
/** Tools that answer from business data rather than the knowledge base. */
const DATA_TOOLS = new Set(['get_product_information', 'get_order_status', 'get_business_hours', 'get_customer_profile']);

export interface CustomerQuestion {
  id: string;
  text: string;
  conversationId: string;
  customerId: string;
  channel: ChannelType;
  intent: Intent | null;
  createdAt: Date;
  isQuestion: boolean;
  /** null: no AI reply (a person handled it, or none yet). */
  answered: boolean | null;
}

interface Row {
  id: string;
  content: string;
  conversationId: string;
  customerId: string;
  channel: ChannelType;
  intent: Intent | null;
  createdAt: Date;
  aiMeta: Prisma.JsonValue | null;
  aiSources: Prisma.JsonValue | null;
  replyBy: 'AI' | 'AGENT' | null;
}

export function isQuestionText(text: string, intent: Intent | null): boolean {
  const t = text.trim();
  if (t.length < 8 || keywords(t).length === 0) return false;
  if (intent) return QUESTION_INTENTS.includes(intent);
  return /[?؟]/.test(t);
}

/** Whether an AI reply actually answered from verified information. */
export function replyAnswered(meta: Prisma.JsonValue | null, sources: Prisma.JsonValue | null): boolean {
  const m = (meta ?? {}) as { fallback?: boolean; retrieval?: { hits?: number }; tools?: { name: string; status: string }[] };
  if (m.fallback) return false;
  if (Array.isArray(sources) && sources.length > 0) return true;
  if ((m.tools ?? []).some((t) => DATA_TOOLS.has(t.name) && t.status === 'SUCCESS')) return true;
  return (m.retrieval?.hits ?? 0) > 0;
}

export async function loadCustomerMessages(ctx: ServiceContext, start: Date, end: Date, limit = 5000): Promise<CustomerQuestion[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT c."id", c."content", c."conversationId", conv."customerId", c."channel", c."intent", c."createdAt",
           a."metadata" AS "aiMeta", a."sources" AS "aiSources", a."senderType"::text AS "replyBy"
    FROM "Message" c
    JOIN "Conversation" conv ON conv."id" = c."conversationId"
    LEFT JOIN LATERAL (
      SELECT m."metadata", m."sources", m."senderType" FROM "Message" m
      WHERE m."conversationId" = c."conversationId" AND m."senderType" IN ('AI', 'AGENT') AND m."createdAt" >= c."createdAt"
      ORDER BY m."createdAt" ASC, m."id" ASC LIMIT 1
    ) a ON true
    WHERE c."organizationId" = ${ctx.organizationId} AND c."senderType" = 'CUSTOMER'
      AND c."createdAt" >= ${start} AND c."createdAt" < ${end} AND length(trim(c."content")) > 0
    ORDER BY c."createdAt" DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    text: r.content.replace(/\s+/g, ' ').trim(),
    conversationId: r.conversationId,
    customerId: r.customerId,
    channel: r.channel,
    intent: r.intent,
    createdAt: r.createdAt,
    isQuestion: isQuestionText(r.content, r.intent),
    // Only AI replies are judged; a team member's reply is not analysed.
    answered: r.replyBy === 'AI' ? replyAnswered(r.aiMeta, r.aiSources) : null,
  }));
}

/** Topic clusters with distinct-customer counts and a few example messages. */
export function toTopicClusters(
  messages: CustomerQuestion[],
  opts: { maxClusters?: number; minSize?: number; examples?: number; /** Label for messages that share no topic (omitted when unset). */ otherLabel?: string } = {},
): TopicCluster[] {
  const clusters = clusterTopics(messages, { maxClusters: opts.maxClusters ?? 8, minSize: opts.minSize ?? 2 });
  if (opts.otherLabel) {
    const grouped = new Set(clusters.flatMap((c) => c.items));
    const rest = messages.filter((m) => !grouped.has(m));
    if (rest.length) clusters.push({ label: opts.otherLabel, terms: [], items: rest });
  }
  return clusters.map((c) => {
    const seen = new Set<string>();
    const examples = [];
    for (const m of c.items) {
      const key = m.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      examples.push({ text: m.text.slice(0, 200), conversationId: m.conversationId, createdAt: m.createdAt.toISOString() });
      if (examples.length >= (opts.examples ?? 3)) break;
    }
    return { label: c.label, terms: c.terms, count: c.items.length, customers: new Set(c.items.map((m) => m.customerId)).size, examples };
  });
}
