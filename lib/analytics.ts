// Analytics periods and response shapes. Client-safe.
import type { ChannelType, Intent } from './types';

export const ANALYTICS_PERIODS = ['today', '7d', '30d', '90d', 'custom'] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const MAX_CUSTOM_DAYS = 366;

export interface PeriodQuery {
  range: AnalyticsPeriod;
  /** YYYY-MM-DD in the organization's time zone (custom ranges). */
  from?: string;
  to?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string | null | undefined): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function parsePeriodQuery(params: URLSearchParams): PeriodQuery {
  const range = params.get('range');
  const from = params.get('from');
  const to = params.get('to');
  if (range === 'custom' || (!range && validDate(from) && validDate(to))) {
    if (validDate(from) && validDate(to)) return from <= to ? { range: 'custom', from, to } : { range: 'custom', from: to, to: from };
    return { range: '30d' };
  }
  return { range: (ANALYTICS_PERIODS as readonly string[]).includes(range ?? '') ? (range as AnalyticsPeriod) : '30d' };
}

export function periodQueryString(q: PeriodQuery): string {
  const p = new URLSearchParams({ range: q.range });
  if (q.range === 'custom' && q.from && q.to) {
    p.set('from', q.from);
    p.set('to', q.to);
  }
  return p.toString();
}

export interface Metric {
  value: number;
  /** Same metric over the preceding period of equal length (null when not comparable). */
  previous: number | null;
}

export interface ResolvedPeriod {
  query: PeriodQuery;
  start: string;
  end: string;
  previousStart: string;
  days: number;
  bucket: 'hour' | 'day';
  label: string;
}

export interface TopicExample {
  text: string;
  conversationId: string;
  createdAt: string;
}

export interface TopicCluster {
  label: string;
  terms: string[];
  /** Questions / messages in this topic. */
  count: number;
  /** Distinct customers who asked. */
  customers: number;
  examples: TopicExample[];
}

export interface AnalyticsReport {
  period: ResolvedPeriod;
  kpis: {
    conversations: Metric;
    websiteConversations: Metric;
    whatsappConversations: Metric;
    messagesReceived: Metric;
    messagesSent: Metric;
    uniqueCustomers: Metric;
    newCustomers: Metric;
    aiResolutionRate: Metric;
    escalationRate: Metric;
    leads: Metric;
    conversionRate: Metric;
    avgFirstResponseSeconds: Metric;
    avgHumanResponseSeconds: Metric;
    answerRate: Metric;
    costUsd: Metric;
    tokens: Metric;
  };
  series: { bucket: string; website: number; whatsapp: number; messages: number; costUsd: number }[];
  intents: { intent: Intent; count: number }[];
  sentiment: { sentiment: string; count: number }[];
  channels: { channel: ChannelType; conversations: number; messages: number; leads: number }[];
  cost: {
    byKind: { kind: string; calls: number; tokens: number; costUsd: number }[];
    byModel: { model: string; calls: number; tokens: number; costUsd: number }[];
    perConversationUsd: number;
    avgChatLatencyMs: number | null;
  };
  knowledge: {
    aiReplies: number;
    repliesWithSources: number;
    retrievalHitRate: number;
    topDocuments: { id: string; title: string; citations: number }[];
    unusedDocuments: { id: string; title: string }[];
  };
  questions: { total: number; unanswered: number };
  topQuestions: TopicCluster[];
  topKeywords: { term: string; count: number }[];
  team: { userId: string; name: string; conversations: number; replies: number; avgFirstReplySeconds: number | null }[];
}

export interface InsightItem {
  kind: 'knowledge_gap' | 'faq' | 'complaint' | 'trend' | 'opportunity';
  title: string;
  detail: string;
  action: string;
}

export interface InsightReportContent {
  summary: string;
  insights: InsightItem[];
}

export interface InsightsData {
  period: ResolvedPeriod;
  questions: { total: number; unanswered: number; answerRate: number };
  gaps: TopicCluster[];
  faqs: TopicCluster[];
  complaints: TopicCluster[];
  complaintCount: number;
  intents: { intent: Intent; count: number; previous: number }[];
  report: { id: string; content: InsightReportContent; createdAt: string; periodStart: string; periodEnd: string; createdBy: string | null } | null;
}
