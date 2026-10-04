import 'server-only';
import type { Intent, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { InsightReportContent, InsightsData, PeriodQuery } from '@/lib/analytics';
import { complete, ProviderNotConfiguredError } from '../../ai/provider';
import { recordUsage } from '../../ai/usage';
import type { ServiceContext } from '../../context';
import { env } from '../../env';
import { AppError } from '../../errors';
import { logger } from '../../logger';
import { auditFromContext } from '../audit/audit-service';
import { describePeriod, resolvePeriod } from './period';
import { loadCustomerMessages, toTopicClusters } from './questions';
import { requireAnalytics } from './report-service';

// AI insights (spec §18): what the bot could not answer, what customers ask most, what
// they complain about, and which intents grow. Topics come from local keyword
// clustering; the optional AI report turns those aggregates into recommendations.

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export async function getInsights(ctx: ServiceContext, query: PeriodQuery, timeZone: string, now = new Date()): Promise<InsightsData> {
  requireAnalytics(ctx);
  const p = resolvePeriod(query, timeZone, now);
  const [messages, intentsNow, intentsBefore, report] = await Promise.all([
    loadCustomerMessages(ctx, p.start, p.end),
    ctx.db.message.groupBy({ by: ['intent'], where: { createdAt: { gte: p.start, lt: p.end }, senderType: 'CUSTOMER', intent: { not: null } }, _count: { _all: true } }),
    ctx.db.message.groupBy({ by: ['intent'], where: { createdAt: { gte: p.previousStart, lt: p.start }, senderType: 'CUSTOMER', intent: { not: null } }, _count: { _all: true } }),
    ctx.db.insightReport.findFirst({ orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { name: true, email: true } } } }),
  ]);
  const questions = messages.filter((m) => m.isQuestion);
  const judged = questions.filter((q) => q.answered !== null);
  const unanswered = judged.filter((q) => q.answered === false);
  const answered = judged.filter((q) => q.answered === true);
  const complaints = messages.filter((m) => m.intent === 'COMPLAINT');
  const previous = new Map(intentsBefore.map((r) => [r.intent, r._count._all]));
  return {
    period: describePeriod(p, timeZone),
    questions: { total: questions.length, unanswered: unanswered.length, answerRate: pct(answered.length, judged.length) },
    gaps: toTopicClusters(unanswered, { maxClusters: 8, examples: 4 }),
    faqs: toTopicClusters(answered, { maxClusters: 8 }),
    complaints: toTopicClusters(complaints, { maxClusters: 6, otherLabel: 'Other complaints', examples: 4 }),
    complaintCount: complaints.length,
    intents: intentsNow
      .filter((r): r is typeof r & { intent: Intent } => r.intent !== null)
      .map((r) => ({ intent: r.intent, count: r._count._all, previous: previous.get(r.intent) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent)),
    report: report
      ? {
          id: report.id,
          content: report.content as unknown as InsightReportContent,
          createdAt: report.createdAt.toISOString(),
          periodStart: report.periodStart.toISOString(),
          periodEnd: report.periodEnd.toISOString(),
          createdBy: report.createdBy ? (report.createdBy.name ?? report.createdBy.email) : null,
        }
      : null,
  };
}

const INSIGHT_PROMPT = `You are a customer-service analyst for a small business that uses an AI chat assistant on its website and WhatsApp.
You receive aggregated statistics for a period: unanswered-question topics (the knowledge base had no matching content),
frequent answered topics, complaint topics and intent trends, each with counts and short example messages.
Write practical insights for the business owner. Return only JSON:
{
  "summary": "2–3 sentences on how the assistant performed and the most important next step",
  "insights": [
    { "kind": "knowledge_gap" | "faq" | "complaint" | "trend" | "opportunity",
      "title": "short headline with the number, e.g. '28 customers asked about installation'",
      "detail": "1–2 sentences of evidence from the data, e.g. 'The knowledge base has no installation guide, so the assistant could not answer.'",
      "action": "one concrete step, e.g. 'Add an installation guide (PDF or FAQ) to the knowledge base.'" }
  ]
}
Rules: 3 to 6 insights, most impactful first. Use only the numbers given. Never invent topics, numbers or features.
Do not include personal data (names, emails, phone numbers) even if an example contains it. Write in English.`;

const reportSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  insights: z
    .array(
      z.object({
        kind: z.enum(['knowledge_gap', 'faq', 'complaint', 'trend', 'opportunity']).catch('opportunity'),
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(600).default(''),
        action: z.string().trim().max(400).default(''),
      }),
    )
    .min(1)
    .max(8),
});

/** Strips contact details from example messages before they leave for the AI provider. */
export function redactExample(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d ()/-]{6,}\d/g, '[phone]')
    .slice(0, 160);
}

export async function generateInsightReport(ctx: ServiceContext, query: PeriodQuery, timeZone: string, now = new Date()) {
  requireAnalytics(ctx);
  const data = await getInsights(ctx, query, timeZone, now);
  if (data.questions.total === 0 && data.complaintCount === 0) {
    throw new AppError('BAD_REQUEST', 'There are no customer questions in this period yet. Choose a longer period.');
  }
  const topic = (t: InsightsData['gaps'][number]) => ({ topic: t.label, messages: t.count, customers: t.customers, examples: t.examples.map((e) => redactExample(e.text)) });
  const input = {
    period: data.period.label,
    questions: data.questions,
    unansweredTopics: data.gaps.map(topic),
    frequentAnsweredTopics: data.faqs.map(topic),
    complaints: { total: data.complaintCount, topics: data.complaints.map(topic) },
    intents: data.intents.map((i) => ({ intent: i.intent, now: i.count, previousPeriod: i.previous })),
  };
  const bot = await ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { model: true } });
  const model = bot?.model || env().OPENAI_CHAT_MODEL;
  const started = Date.now();
  let result;
  try {
    result = await complete({
      model,
      messages: [
        { role: 'system', content: INSIGHT_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
      temperature: 0.2,
      maxTokens: 1200,
      json: true,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw new AppError('BAD_REQUEST', 'AI insights need an AI provider. Ask the workspace owner to configure OPENAI_API_KEY on the server.');
    logger.warn('insight report failed', { organizationId: ctx.organizationId, err: (err as Error).message });
    throw new AppError('INTERNAL', 'The AI could not write the insights right now. Please try again.');
  }
  await recordUsage(ctx.db, {
    organizationId: ctx.organizationId,
    kind: 'SUMMARY',
    model,
    usage: result.usage,
    latencyMs: Date.now() - started,
    estimate: { input: INSIGHT_PROMPT + JSON.stringify(input), output: result.text },
  });
  let content: InsightReportContent;
  try {
    content = reportSchema.parse(JSON.parse(result.text));
  } catch {
    logger.warn('insight report was not valid JSON', { organizationId: ctx.organizationId });
    throw new AppError('INTERNAL', 'The AI returned an unusable answer. Please try again.');
  }
  const p = resolvePeriod(query, timeZone, now);
  const saved = await ctx.db.insightReport.create({
    data: {
      organizationId: ctx.organizationId,
      periodStart: p.start,
      periodEnd: p.end,
      content: content as unknown as Prisma.InputJsonValue,
      model,
      createdById: ctx.userId,
    },
  });
  await auditFromContext(ctx, 'insights.generated', { type: 'InsightReport', id: saved.id }, { period: data.period.label });
  return { ...data, report: { id: saved.id, content, createdAt: saved.createdAt.toISOString(), periodStart: saved.periodStart.toISOString(), periodEnd: saved.periodEnd.toISOString(), createdBy: null } };
}
