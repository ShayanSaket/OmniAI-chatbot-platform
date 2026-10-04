import 'server-only';
import { Prisma, type ChannelType, type Intent } from '@prisma/client';
import type { AnalyticsReport, Metric, PeriodQuery } from '@/lib/analytics';
import { hasPermission } from '@/lib/permissions';
import { topKeywords } from '@/lib/topics';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';
import { forbidden } from '../../errors';
import { bucketKeys, describePeriod, resolvePeriod, type Period } from './period';
import { loadCustomerMessages, toTopicClusters } from './questions';

// Full analytics for a period (spec §17), compared with the preceding period of equal
// length. Everything is computed from stored records; nothing is sampled or estimated
// except AI cost (token prices, see server/ai/pricing.ts).

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const metric = (value: number, previous: number | null): Metric => ({ value, previous });

/** Handoff time survives "return to AI" (which clears handoffRequestedAt) in the metadata. */
const HANDOFF_AT = Prisma.sql`((c."metadata"->'handoff'->>'requestedAt')::timestamptz AT TIME ZONE 'UTC')`;

export function requireAnalytics(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'analytics:view')) throw forbidden();
}

async function periodCounts(ctx: ServiceContext, from: Date, to: Date) {
  const org = ctx.organizationId;
  const [conv, msgs, customers, closed, escalations, leads, converted, response, human, usage] = await Promise.all([
    ctx.db.conversation.groupBy({ by: ['channel'], where: { createdAt: { gte: from, lt: to } }, _count: { _all: true } }),
    ctx.db.message.groupBy({ by: ['senderType'], where: { createdAt: { gte: from, lt: to } }, _count: { _all: true } }),
    prisma.$queryRaw<{ unique: number; created: number }[]>`
      SELECT
        (SELECT COUNT(DISTINCT c."customerId")::int FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
          WHERE m."organizationId" = ${org} AND m."senderType" = 'CUSTOMER' AND m."createdAt" >= ${from} AND m."createdAt" < ${to}) AS "unique",
        (SELECT COUNT(*)::int FROM "Customer" WHERE "organizationId" = ${org} AND "mergedIntoId" IS NULL
          AND "createdAt" >= ${from} AND "createdAt" < ${to}) AS "created"`,
    ctx.db.conversation.groupBy({ by: ['aiResolved'], where: { closedAt: { gte: from, lt: to } }, _count: { _all: true } }),
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM "Conversation" c
      WHERE c."organizationId" = ${org} AND c."metadata" ? 'handoff' AND ${HANDOFF_AT} >= ${from} AND ${HANDOFF_AT} < ${to}`,
    ctx.db.lead.count({ where: { createdAt: { gte: from, lt: to } } }),
    ctx.db.conversation.count({ where: { createdAt: { gte: from, lt: to }, leads: { some: {} } } }),
    prisma.$queryRaw<{ avg: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")))::float AS avg FROM "Conversation"
      WHERE "organizationId" = ${org} AND "firstResponseAt" IS NOT NULL AND "createdAt" >= ${from} AND "createdAt" < ${to}`,
    // Time from a handoff request to the first team reply after it.
    prisma.$queryRaw<{ avg: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM (r."createdAt" - ${HANDOFF_AT})))::float AS avg
      FROM "Conversation" c
      JOIN LATERAL (
        SELECT m."createdAt" FROM "Message" m
        WHERE m."conversationId" = c."id" AND m."senderType" = 'AGENT' AND m."createdAt" >= ${HANDOFF_AT}
        ORDER BY m."createdAt" ASC LIMIT 1
      ) r ON true
      WHERE c."organizationId" = ${org} AND c."metadata" ? 'handoff' AND ${HANDOFF_AT} >= ${from} AND ${HANDOFF_AT} < ${to}`,
    ctx.db.usageRecord.aggregate({
      where: { createdAt: { gte: from, lt: to } },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true, embeddingTokens: true },
    }),
  ]);
  const byChannel = (ch: ChannelType) => conv.find((c) => c.channel === ch)?._count._all ?? 0;
  const bySender = (...types: string[]) => msgs.filter((m) => types.includes(m.senderType)).reduce((s, m) => s + m._count._all, 0);
  const conversations = conv.reduce((s, c) => s + c._count._all, 0);
  const closedTotal = closed.reduce((s, c) => s + c._count._all, 0);
  const aiResolved = closed.find((c) => c.aiResolved)?._count._all ?? 0;
  return {
    conversations,
    website: byChannel('WEBSITE'),
    whatsapp: byChannel('WHATSAPP'),
    received: bySender('CUSTOMER'),
    sent: bySender('AI', 'AGENT'),
    uniqueCustomers: n(customers[0]?.unique),
    newCustomers: n(customers[0]?.created),
    aiResolutionRate: pct(aiResolved, closedTotal),
    escalationRate: pct(n(escalations[0]?.count), conversations),
    leads,
    conversionRate: pct(converted, conversations),
    firstResponse: Math.round(n(response[0]?.avg)),
    humanResponse: human[0]?.avg == null ? null : Math.round(human[0].avg),
    costUsd: Math.round(n(usage._sum.costUsd) * 10_000) / 10_000,
    tokens: n(usage._sum.promptTokens) + n(usage._sum.completionTokens) + n(usage._sum.embeddingTokens),
  };
}

async function series(ctx: ServiceContext, p: Period, timeZone: string) {
  const org = ctx.organizationId;
  const unit = p.bucket === 'hour' ? 'hour' : 'day';
  const fmt = p.bucket === 'hour' ? 'HH24:00' : 'YYYY-MM-DD';
  const bucket = (col: Prisma.Sql) => Prisma.sql`to_char(date_trunc(${unit}, (${col} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), ${fmt})`;
  const [conv, msgs, cost] = await Promise.all([
    prisma.$queryRaw<{ bucket: string; channel: ChannelType; count: number }[]>`
      SELECT ${bucket(Prisma.sql`"createdAt"`)} AS bucket, "channel", COUNT(*)::int AS count FROM "Conversation"
      WHERE "organizationId" = ${org} AND "createdAt" >= ${p.start} AND "createdAt" < ${p.end} GROUP BY 1, 2`,
    prisma.$queryRaw<{ bucket: string; count: number }[]>`
      SELECT ${bucket(Prisma.sql`"createdAt"`)} AS bucket, COUNT(*)::int AS count FROM "Message"
      WHERE "organizationId" = ${org} AND "senderType" <> 'SYSTEM' AND "createdAt" >= ${p.start} AND "createdAt" < ${p.end} GROUP BY 1`,
    prisma.$queryRaw<{ bucket: string; cost: number }[]>`
      SELECT ${bucket(Prisma.sql`"createdAt"`)} AS bucket, SUM("costUsd")::float AS cost FROM "UsageRecord"
      WHERE "organizationId" = ${org} AND "createdAt" >= ${p.start} AND "createdAt" < ${p.end} GROUP BY 1`,
  ]);
  return bucketKeys(p, timeZone).map((key) => {
    const rows = conv.filter((r) => r.bucket === key);
    return {
      bucket: key,
      website: rows.filter((r) => r.channel === 'WEBSITE').reduce((s, r) => s + r.count, 0),
      whatsapp: rows.filter((r) => r.channel === 'WHATSAPP').reduce((s, r) => s + r.count, 0),
      messages: msgs.find((r) => r.bucket === key)?.count ?? 0,
      costUsd: Math.round(n(cost.find((r) => r.bucket === key)?.cost) * 10_000) / 10_000,
    };
  });
}

export async function getAnalyticsReport(ctx: ServiceContext, query: PeriodQuery, timeZone: string, now = new Date()): Promise<AnalyticsReport> {
  requireAnalytics(ctx);
  const p = resolvePeriod(query, timeZone, now);
  const org = ctx.organizationId;
  const range = { gte: p.start, lt: p.end };

  const [cur, prev, chart, intents, sentiment, channelMsgs, leadSources, costKind, costModel, latency, knowledge, topDocs, docs, messages, team] = await Promise.all([
    periodCounts(ctx, p.start, p.end),
    periodCounts(ctx, p.previousStart, p.start),
    series(ctx, p, timeZone),
    ctx.db.message.groupBy({ by: ['intent'], where: { createdAt: range, senderType: 'CUSTOMER', intent: { not: null } }, _count: { _all: true } }),
    prisma.$queryRaw<{ sentiment: string; count: number }[]>`
      SELECT c."metadata"->>'sentiment' AS sentiment, COUNT(*)::int AS count FROM "Conversation" c
      WHERE c."organizationId" = ${org} AND c."createdAt" >= ${p.start} AND c."createdAt" < ${p.end} AND c."metadata" ? 'sentiment'
      GROUP BY 1 ORDER BY 2 DESC`,
    ctx.db.message.groupBy({ by: ['channel'], where: { createdAt: range, senderType: { not: 'SYSTEM' } }, _count: { _all: true } }),
    ctx.db.lead.groupBy({ by: ['source'], where: { createdAt: range }, _count: { _all: true } }),
    ctx.db.usageRecord.groupBy({
      by: ['kind'],
      where: { createdAt: range },
      _count: { _all: true },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true, embeddingTokens: true },
    }),
    ctx.db.usageRecord.groupBy({
      by: ['model'],
      where: { createdAt: range },
      _count: { _all: true },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true, embeddingTokens: true },
    }),
    ctx.db.usageRecord.aggregate({ where: { createdAt: range, kind: 'CHAT', latencyMs: { not: null } }, _avg: { latencyMs: true } }),
    prisma.$queryRaw<{ replies: number; withSources: number; withHits: number }[]>`
      SELECT COUNT(*)::int AS replies,
             COUNT(*) FILTER (WHERE jsonb_typeof("sources") = 'array' AND jsonb_array_length("sources") > 0)::int AS "withSources",
             COUNT(*) FILTER (WHERE COALESCE(("metadata"->'retrieval'->>'hits')::int, 0) > 0)::int AS "withHits"
      FROM "Message" WHERE "organizationId" = ${org} AND "senderType" = 'AI' AND "createdAt" >= ${p.start} AND "createdAt" < ${p.end}`,
    prisma.$queryRaw<{ id: string; citations: number }[]>`
      SELECT s->>'documentId' AS id, COUNT(*)::int AS citations
      FROM "Message" m, jsonb_array_elements(CASE WHEN jsonb_typeof(m."sources") = 'array' THEN m."sources" ELSE '[]'::jsonb END) s
      WHERE m."organizationId" = ${org} AND m."senderType" = 'AI' AND m."createdAt" >= ${p.start} AND m."createdAt" < ${p.end}
      GROUP BY 1 ORDER BY 2 DESC`,
    ctx.db.knowledgeDocument.findMany({ where: { status: 'READY' }, select: { id: true, title: true }, orderBy: { createdAt: 'asc' } }),
    loadCustomerMessages(ctx, p.start, p.end),
    prisma.$queryRaw<{ userId: string; name: string | null; email: string; conversations: number; replies: number; avgFirst: number | null }[]>`
      WITH replies AS (
        SELECT m."senderUserId" AS uid, m."conversationId", m."createdAt" FROM "Message" m
        WHERE m."organizationId" = ${org} AND m."senderType" = 'AGENT' AND m."senderUserId" IS NOT NULL
          AND m."createdAt" >= ${p.start} AND m."createdAt" < ${p.end}
      ), firsts AS (
        SELECT DISTINCT ON (r."conversationId") r.uid, r."createdAt", ${HANDOFF_AT} AS requested
        FROM replies r JOIN "Conversation" c ON c."id" = r."conversationId"
        ORDER BY r."conversationId", r."createdAt"
      )
      SELECT u."id" AS "userId", u."name", u."email",
             (SELECT COUNT(DISTINCT "conversationId")::int FROM replies WHERE uid = u."id") AS conversations,
             (SELECT COUNT(*)::int FROM replies WHERE uid = u."id") AS replies,
             (SELECT AVG(EXTRACT(EPOCH FROM (f."createdAt" - f.requested)))::float FROM firsts f
               WHERE f.uid = u."id" AND f.requested IS NOT NULL AND f."createdAt" >= f.requested) AS "avgFirst"
      FROM "User" u WHERE u."id" IN (SELECT DISTINCT uid FROM replies)
      ORDER BY replies DESC`,
  ]);

  const questions = messages.filter((m) => m.isQuestion);
  const judged = questions.filter((q) => q.answered !== null);
  const unanswered = judged.filter((q) => q.answered === false).length;
  const prevQuestions = await loadCustomerMessages(ctx, p.previousStart, p.start).then((list) => list.filter((m) => m.isQuestion && m.answered !== null));
  const titleOf = new Map(docs.map((d) => [d.id, d.title]));
  const cited = new Set(topDocs.map((d) => d.id));
  const tokensOf = (s: { promptTokens: number | null; completionTokens: number | null; embeddingTokens: number | null }) => n(s.promptTokens) + n(s.completionTokens) + n(s.embeddingTokens);
  const k = knowledge[0];

  return {
    period: describePeriod(p, timeZone),
    kpis: {
      conversations: metric(cur.conversations, prev.conversations),
      websiteConversations: metric(cur.website, prev.website),
      whatsappConversations: metric(cur.whatsapp, prev.whatsapp),
      messagesReceived: metric(cur.received, prev.received),
      messagesSent: metric(cur.sent, prev.sent),
      uniqueCustomers: metric(cur.uniqueCustomers, prev.uniqueCustomers),
      newCustomers: metric(cur.newCustomers, prev.newCustomers),
      aiResolutionRate: metric(cur.aiResolutionRate, prev.aiResolutionRate),
      escalationRate: metric(cur.escalationRate, prev.escalationRate),
      leads: metric(cur.leads, prev.leads),
      conversionRate: metric(cur.conversionRate, prev.conversionRate),
      avgFirstResponseSeconds: metric(cur.firstResponse, prev.firstResponse || null),
      avgHumanResponseSeconds: metric(cur.humanResponse ?? 0, prev.humanResponse),
      answerRate: metric(pct(judged.length - unanswered, judged.length), prevQuestions.length ? pct(prevQuestions.filter((q) => q.answered).length, prevQuestions.length) : null),
      costUsd: metric(cur.costUsd, prev.costUsd),
      tokens: metric(cur.tokens, prev.tokens),
    },
    series: chart,
    intents: intents
      .filter((r): r is typeof r & { intent: Intent } => r.intent !== null)
      .map((r) => ({ intent: r.intent, count: r._count._all }))
      .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent)),
    sentiment: sentiment.filter((s) => s.sentiment).map((s) => ({ sentiment: s.sentiment, count: s.count })),
    channels: (['WEBSITE', 'WHATSAPP'] as const).map((channel) => ({
      channel,
      conversations: channel === 'WEBSITE' ? cur.website : cur.whatsapp,
      messages: channelMsgs.find((m) => m.channel === channel)?._count._all ?? 0,
      leads: leadSources.find((l) => l.source === channel)?._count._all ?? 0,
    })),
    cost: {
      byKind: costKind
        .map((r) => ({ kind: r.kind, calls: r._count._all, tokens: tokensOf(r._sum), costUsd: Math.round(n(r._sum.costUsd) * 10_000) / 10_000 }))
        .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
      byModel: costModel
        .map((r) => ({ model: r.model, calls: r._count._all, tokens: tokensOf(r._sum), costUsd: Math.round(n(r._sum.costUsd) * 10_000) / 10_000 }))
        .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
      perConversationUsd: cur.conversations ? Math.round((cur.costUsd / cur.conversations) * 10_000) / 10_000 : 0,
      avgChatLatencyMs: latency._avg.latencyMs === null ? null : Math.round(latency._avg.latencyMs),
    },
    knowledge: {
      aiReplies: n(k?.replies),
      repliesWithSources: n(k?.withSources),
      retrievalHitRate: pct(n(k?.withHits), n(k?.replies)),
      topDocuments: topDocs
        .filter((d) => titleOf.has(d.id))
        .slice(0, 8)
        .map((d) => ({ id: d.id, title: titleOf.get(d.id)!, citations: d.citations })),
      unusedDocuments: docs.filter((d) => !cited.has(d.id)).slice(0, 8),
    },
    questions: { total: questions.length, unanswered },
    topQuestions: toTopicClusters(questions, { maxClusters: 8 }),
    topKeywords: topKeywords(questions.map((q) => q.text), 15),
    team: team.map((t) => ({
      userId: t.userId,
      name: t.name ?? t.email,
      conversations: n(t.conversations),
      replies: n(t.replies),
      avgFirstReplySeconds: t.avgFirst === null ? null : Math.round(t.avgFirst),
    })),
  };
}

/** Daily (or hourly) metrics as CSV for spreadsheets. */
export async function exportAnalyticsCsv(ctx: ServiceContext, query: PeriodQuery, timeZone: string) {
  const report = await getAnalyticsReport(ctx, query, timeZone);
  const header = [report.period.bucket === 'hour' ? 'Hour' : 'Date', 'Website conversations', 'WhatsApp conversations', 'Messages', 'AI cost (USD)'];
  const rows = report.series.map((s) => [s.bucket, s.website, s.whatsapp, s.messages, s.costUsd.toFixed(4)].join(','));
  return `﻿${[header.join(','), ...rows].join('\r\n')}\r\n`;
}
