import 'server-only';
import type { ChannelType, ConversationStatus, Intent } from '@prisma/client';
import type { AnalyticsRange } from '@/lib/validation';
import { addDays, localDateKey, startOfDayInZone } from '@/lib/time';
import type { ServiceContext } from '../../context';

export interface Kpi {
  value: number;
  /** Value for the previous period of equal length (null when not comparable). */
  previous: number | null;
}

export interface OverviewData {
  range: AnalyticsRange;
  rangeStart: string;
  kpis: {
    totalConversations: Kpi;
    conversationsToday: Kpi;
    aiResolved: Kpi;
    humanEscalations: Kpi;
    activeConversations: Kpi;
    newLeads: Kpi;
    conversionRate: Kpi;
    avgFirstResponseSeconds: Kpi;
    whatsappMessages: Kpi;
    websiteMessages: Kpi;
  };
  series: { bucket: string; website: number; whatsapp: number; other: number }[];
  statusBreakdown: { status: ConversationStatus; count: number }[];
  topIntents: { intent: Intent; count: number }[];
  leadPipeline: { status: string; count: number }[];
  recentConversations: {
    id: string;
    channel: ChannelType;
    status: ConversationStatus;
    intent: Intent | null;
    customerName: string;
    preview: string | null;
    lastMessageAt: string;
    unreadCount: number;
  }[];
}

export function rangeWindow(range: AnalyticsRange, timeZone: string, now = new Date()) {
  const today = startOfDayInZone(now, timeZone);
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  const start = days === 1 ? today : startOfDayInZone(addDays(today, -(days - 1)), timeZone);
  const previousStart = startOfDayInZone(addDays(start, -days), timeZone);
  return { today, start, previousStart, days };
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export async function getOverview(
  ctx: ServiceContext,
  params: { range: AnalyticsRange; timeZone: string; now?: Date },
): Promise<OverviewData> {
  const { db, organizationId } = ctx;
  const { range, timeZone } = params;
  const now = params.now ?? new Date();
  const { today, start, previousStart } = rangeWindow(range, timeZone, now);
  const yesterday = startOfDayInZone(addDays(today, -1), timeZone);
  const inRange = { gte: start };
  const inPrevious = { gte: previousStart, lt: start };

  const conversationsIn = (createdAt: object) => db.conversation.count({ where: { createdAt } });
  const convertedIn = (createdAt: object) => db.conversation.count({ where: { createdAt, leads: { some: {} } } });
  const messagesByChannel = (createdAt: object) =>
    db.message.groupBy({ by: ['channel'], where: { createdAt, senderType: { not: 'SYSTEM' } }, _count: { _all: true } });

  const [
    total,
    totalPrev,
    todayCount,
    yesterdayCount,
    aiResolved,
    aiResolvedPrev,
    escalations,
    escalationsPrev,
    active,
    leads,
    leadsPrev,
    converted,
    convertedPrev,
    messages,
    messagesPrev,
    responseRows,
    seriesRows,
    statusRows,
    intentRows,
    pipelineRows,
    recent,
  ] = await Promise.all([
    conversationsIn(inRange),
    conversationsIn(inPrevious),
    conversationsIn({ gte: today }),
    conversationsIn({ gte: yesterday, lt: today }),
    db.conversation.count({ where: { aiResolved: true, closedAt: inRange } }),
    db.conversation.count({ where: { aiResolved: true, closedAt: inPrevious } }),
    db.conversation.count({ where: { handoffRequestedAt: inRange } }),
    db.conversation.count({ where: { handoffRequestedAt: inPrevious } }),
    db.conversation.count({ where: { status: { not: 'CLOSED' } } }),
    db.lead.count({ where: { createdAt: inRange } }),
    db.lead.count({ where: { createdAt: inPrevious } }),
    convertedIn(inRange),
    convertedIn(inPrevious),
    messagesByChannel(inRange),
    messagesByChannel(inPrevious),
    db.$queryRaw<{ current: number | null; previous: number | null }[]>`
      SELECT
        AVG(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt"))) FILTER (WHERE "createdAt" >= ${start})::float AS current,
        AVG(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt"))) FILTER (WHERE "createdAt" < ${start})::float AS previous
      FROM "Conversation"
      WHERE "organizationId" = ${organizationId}
        AND "firstResponseAt" IS NOT NULL
        AND "createdAt" >= ${previousStart}`,
    range === 'today'
      ? db.$queryRaw<{ bucket: string; channel: ChannelType; count: number }[]>`
          SELECT to_char(date_trunc('hour', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'HH24:00') AS bucket,
                 channel, COUNT(*)::int AS count
          FROM "Conversation"
          WHERE "organizationId" = ${organizationId} AND "createdAt" >= ${start}
          GROUP BY 1, 2`
      : db.$queryRaw<{ bucket: string; channel: ChannelType; count: number }[]>`
          SELECT to_char(date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS bucket,
                 channel, COUNT(*)::int AS count
          FROM "Conversation"
          WHERE "organizationId" = ${organizationId} AND "createdAt" >= ${start}
          GROUP BY 1, 2`,
    db.conversation.groupBy({ by: ['status'], where: { createdAt: inRange }, _count: { _all: true } }),
    db.conversation.groupBy({
      by: ['intent'],
      where: { createdAt: inRange, intent: { not: null } },
      _count: { _all: true },
    }),
    db.lead.groupBy({ by: ['status'], _count: { _all: true } }),
    db.conversation.findMany({
      take: 6,
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true,
        channel: true,
        status: true,
        intent: true,
        lastMessagePreview: true,
        lastMessageAt: true,
        unreadCount: true,
        customer: { select: { name: true, email: true, phone: true } },
      },
    }),
  ]);

  const channelCount = (rows: { channel: ChannelType; _count: { _all: number } }[], channel: ChannelType) =>
    rows.find((r) => r.channel === channel)?._count._all ?? 0;

  // Fill every bucket so charts have a continuous axis.
  const buckets: string[] =
    range === 'today'
      ? Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
      : Array.from({ length: range === '7d' ? 7 : 30 }, (_, i) => localDateKey(addDays(start, i + 0.5), timeZone));
  const series = buckets.map((bucket) => {
    const rows = seriesRows.filter((r) => r.bucket === bucket);
    const of = (c: ChannelType) => rows.filter((r) => r.channel === c).reduce((s, r) => s + r.count, 0);
    const website = of('WEBSITE');
    const whatsapp = of('WHATSAPP');
    return { bucket, website, whatsapp, other: rows.reduce((s, r) => s + r.count, 0) - website - whatsapp };
  });

  const response = responseRows[0];

  return {
    range,
    rangeStart: start.toISOString(),
    kpis: {
      totalConversations: { value: total, previous: totalPrev },
      conversationsToday: { value: todayCount, previous: yesterdayCount },
      aiResolved: { value: aiResolved, previous: aiResolvedPrev },
      humanEscalations: { value: escalations, previous: escalationsPrev },
      activeConversations: { value: active, previous: null },
      newLeads: { value: leads, previous: leadsPrev },
      conversionRate: { value: pct(converted, total), previous: pct(convertedPrev, totalPrev) },
      avgFirstResponseSeconds: {
        value: Math.round(response?.current ?? 0),
        previous: response?.previous == null ? null : Math.round(response.previous),
      },
      whatsappMessages: { value: channelCount(messages, 'WHATSAPP'), previous: channelCount(messagesPrev, 'WHATSAPP') },
      websiteMessages: { value: channelCount(messages, 'WEBSITE'), previous: channelCount(messagesPrev, 'WEBSITE') },
    },
    series,
    statusBreakdown: statusRows.map((r) => ({ status: r.status, count: r._count._all })),
    topIntents: intentRows
      .filter((r): r is typeof r & { intent: Intent } => r.intent !== null)
      .map((r) => ({ intent: r.intent, count: r._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    leadPipeline: pipelineRows.map((r) => ({ status: r.status, count: r._count._all })),
    recentConversations: recent.map((c) => ({
      id: c.id,
      channel: c.channel,
      status: c.status,
      intent: c.intent,
      customerName: c.customer.name ?? c.customer.email ?? c.customer.phone ?? 'Anonymous visitor',
      preview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt.toISOString(),
      unreadCount: c.unreadCount,
    })),
  };
}
