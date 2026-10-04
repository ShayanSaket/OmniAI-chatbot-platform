import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { flushBackgroundTasks } from '@/server/background';
import type { ServiceContext } from '@/server/context';
import { resetEnvCache } from '@/server/env';
import { resetMemoryRateLimits } from '@/server/rate-limit';
import { generateInsightReport, getInsights } from '@/server/modules/analytics/insights-service';
import { exportAnalyticsCsv, getAnalyticsReport } from '@/server/modules/analytics/report-service';
import { getOverview } from '@/server/modules/analytics/overview-service';
import { addUser, contextFor, createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';

const TZ = 'Europe/Berlin';
const NOW = new Date('2026-10-04T12:00:00Z');
const at = (iso: string) => new Date(iso);
const WEEK = { range: '7d' as const };

let ai: MockOpenAI;
let organizationId: string;
let owner: ServiceContext;
let admin: ServiceContext;
let agent: ServiceContext;
let websiteChannel: string;
let whatsappChannel: string;
let doc1: string;

beforeAll(async () => {
  ai = await startMockOpenAI();
});
afterAll(() => ai.close());
afterEach(() => expect(ai.errors).toEqual([]));

type Reply = { hits?: number; sources?: string[]; fallback?: boolean; tools?: { name: string; status: string }[] } | 'agent' | null;

async function conversation(opts: {
  channel?: 'WEBSITE' | 'WHATSAPP';
  createdAt: Date;
  customer?: string;
  closedAt?: Date;
  aiResolved?: boolean;
  firstResponseSec?: number;
  handoffAt?: Date;
  sentiment?: string;
  status?: 'AI_ACTIVE' | 'HUMAN_ACTIVE' | 'CLOSED';
}) {
  const channel = opts.channel ?? 'WEBSITE';
  const customer = await prisma.customer.create({ data: { organizationId, name: opts.customer ?? null, createdAt: opts.createdAt } });
  return prisma.conversation.create({
    data: {
      organizationId,
      customerId: customer.id,
      channel,
      channelId: channel === 'WEBSITE' ? websiteChannel : whatsappChannel,
      createdAt: opts.createdAt,
      status: opts.status ?? (opts.closedAt ? 'CLOSED' : 'AI_ACTIVE'),
      closedAt: opts.closedAt ?? null,
      aiResolved: opts.aiResolved ?? false,
      firstResponseAt: opts.firstResponseSec ? new Date(opts.createdAt.getTime() + opts.firstResponseSec * 1000) : null,
      handoffRequestedAt: opts.handoffAt ?? null,
      metadata: {
        ...(opts.handoffAt ? { handoff: { reason: 'customer_request', requestedAt: opts.handoffAt.toISOString() } } : {}),
        ...(opts.sentiment ? { sentiment: opts.sentiment } : {}),
      },
    },
  });
}

async function exchange(conv: { id: string; channel: string }, text: string, intent: string | null, when: Date, reply: Reply, agentId?: string) {
  await prisma.message.create({ data: { organizationId, conversationId: conv.id, channel: conv.channel as 'WEBSITE', senderType: 'CUSTOMER', content: text, intent: intent as never, createdAt: when } });
  if (!reply) return;
  const replyAt = new Date(when.getTime() + 2000);
  if (reply === 'agent') {
    await prisma.message.create({ data: { organizationId, conversationId: conv.id, channel: conv.channel as 'WEBSITE', senderType: 'AGENT', senderUserId: agentId, content: 'On it', createdAt: replyAt } });
    return;
  }
  await prisma.message.create({
    data: {
      organizationId,
      conversationId: conv.id,
      channel: conv.channel as 'WEBSITE',
      senderType: 'AI',
      content: 'Answer',
      createdAt: replyAt,
      sources: reply.sources ? (reply.sources.map((documentId) => ({ documentId, title: 'Doc', chunkId: 'c' })) as Prisma.InputJsonValue) : undefined,
      metadata: { retrieval: { hits: reply.hits ?? 0 }, ...(reply.fallback ? { fallback: true } : {}), ...(reply.tools ? { tools: reply.tools } : {}) },
    },
  });
}

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  ai.reset();
  Object.assign(process.env, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: ai.url });
  resetEnvCache();
  const ws = await createWorkspace('Metrics Co');
  organizationId = ws.organization.id;
  owner = contextFor(organizationId, ws.owner.id, 'OWNER');
  admin = contextFor(organizationId, (await addUser(organizationId, 'ADMIN')).user.id, 'ADMIN');
  agent = contextFor(organizationId, (await addUser(organizationId, 'AGENT')).user.id, 'AGENT');
  websiteChannel = (await prisma.channel.create({ data: { organizationId, type: 'WEBSITE', name: 'Web' } })).id;
  whatsappChannel = (await prisma.channel.create({ data: { organizationId, type: 'WHATSAPP', name: 'WA' } })).id;
  doc1 = (await prisma.knowledgeDocument.create({ data: { organizationId, title: 'Hosting & privacy', sourceType: 'MANUAL', status: 'READY' } })).id;
  await prisma.knowledgeDocument.create({ data: { organizationId, title: 'Old brochure', sourceType: 'MANUAL', status: 'READY' } });

  // ── Current week (28 Sep – 4 Oct, Berlin) ──
  const c1 = await conversation({ createdAt: at('2026-10-01T08:00:00Z'), firstResponseSec: 4, sentiment: 'neutral' });
  await exchange(c1, 'Hi', null, at('2026-10-01T08:00:00Z'), { hits: 0 });
  await exchange(c1, 'How do I install the widget on WordPress?', 'TECHNICAL', at('2026-10-01T08:01:00Z'), { hits: 0 });
  const c2 = await conversation({ createdAt: at('2026-10-02T09:00:00Z'), firstResponseSec: 6, closedAt: at('2026-10-02T10:00:00Z'), aiResolved: true });
  await exchange(c2, 'Is there an installation guide for Shopify?', 'TECHNICAL', at('2026-10-02T09:00:00Z'), { hits: 0 });
  const c3 = await conversation({ channel: 'WHATSAPP', createdAt: at('2026-10-02T11:00:00Z'), firstResponseSec: 2, closedAt: at('2026-10-03T09:00:00Z') });
  await exchange(c3, 'installation help for my Wix site, mail me at kim@example.com', 'SUPPORT', at('2026-10-02T11:00:00Z'), { fallback: true });
  const c4 = await conversation({ createdAt: at('2026-10-03T07:00:00Z'), firstResponseSec: 8 });
  await exchange(c4, 'What does the Growth plan cost?', 'PRICING', at('2026-10-03T07:00:00Z'), { hits: 0, tools: [{ name: 'get_product_information', status: 'SUCCESS' }] });
  await exchange(c4, 'Where is my data hosted?', 'FAQ', at('2026-10-03T07:05:00Z'), { hits: 2, sources: [doc1] });
  await prisma.lead.create({ data: { organizationId, conversationId: c4.id, customerId: c4.customerId, source: 'WEBSITE', createdAt: at('2026-10-03T07:06:00Z') } });
  const c5 = await conversation({ createdAt: at('2026-10-03T12:00:00Z'), firstResponseSec: 10, handoffAt: at('2026-10-03T12:01:00Z'), status: 'HUMAN_ACTIVE', sentiment: 'negative' });
  await exchange(c5, 'What does the Starter plan cost per month?', 'PRICING', at('2026-10-03T12:00:00Z'), { hits: 1, sources: [doc1] });
  await exchange(c5, 'This is terrible, I was charged twice', 'COMPLAINT', at('2026-10-03T12:00:30Z'), null);
  await prisma.message.create({ data: { organizationId, conversationId: c5.id, channel: 'WEBSITE', senderType: 'AGENT', senderUserId: agent.userId, content: 'Sorry, refunding now', createdAt: at('2026-10-03T12:03:00Z') } });
  await prisma.usageRecord.createMany({
    data: [
      { organizationId, kind: 'CHAT', model: 'gpt-4o-mini', promptTokens: 800, completionTokens: 200, costUsd: 0.012, latencyMs: 1000, createdAt: at('2026-10-02T09:00:00Z') },
      { organizationId, kind: 'CHAT', model: 'gpt-4o-mini', promptTokens: 400, completionTokens: 100, costUsd: 0.006, latencyMs: 2000, createdAt: at('2026-10-03T07:00:00Z') },
      { organizationId, kind: 'EMBEDDING', model: 'text-embedding-3-small', embeddingTokens: 500, costUsd: 0.00001, createdAt: at('2026-10-03T07:00:00Z') },
    ],
  });

  // ── Previous week ──
  const p1 = await conversation({ createdAt: at('2026-09-24T10:00:00Z'), firstResponseSec: 20 });
  await exchange(p1, 'Do you support Shopify integration?', 'FAQ', at('2026-09-24T10:00:00Z'), { hits: 1, sources: [doc1] });
  await prisma.usageRecord.create({ data: { organizationId, kind: 'CHAT', model: 'gpt-4o-mini', promptTokens: 100, completionTokens: 50, costUsd: 0.002, createdAt: at('2026-09-24T10:00:00Z') } });
});

describe('analytics report', () => {
  it('computes KPIs for the period and the previous one', async () => {
    const r = await getAnalyticsReport(admin, WEEK, TZ, NOW);
    expect(r.period).toMatchObject({ label: 'Last 7 days', days: 7, bucket: 'day' });
    expect(r.kpis).toMatchObject({
      conversations: { value: 5, previous: 1 },
      websiteConversations: { value: 4, previous: 1 },
      whatsappConversations: { value: 1, previous: 0 },
      messagesReceived: { value: 8, previous: 1 },
      messagesSent: { value: 8, previous: 1 },
      uniqueCustomers: { value: 5, previous: 1 },
      newCustomers: { value: 5, previous: 1 },
      aiResolutionRate: { value: 50, previous: 0 },
      escalationRate: { value: 20, previous: 0 },
      leads: { value: 1, previous: 0 },
      conversionRate: { value: 20, previous: 0 },
      avgFirstResponseSeconds: { value: 6, previous: 20 },
      avgHumanResponseSeconds: { value: 120, previous: null },
      answerRate: { value: 50, previous: 100 },
      costUsd: { value: 0.018, previous: 0.002 },
      tokens: { value: 2000, previous: 150 },
    });
    expect(r.series).toHaveLength(7);
    expect(r.series.find((s) => s.bucket === '2026-10-03')).toMatchObject({ website: 2, whatsapp: 0, messages: 8, costUsd: 0.006 });
    expect(r.channels).toEqual([
      { channel: 'WEBSITE', conversations: 4, messages: 14, leads: 1 },
      { channel: 'WHATSAPP', conversations: 1, messages: 2, leads: 0 },
    ]);
    expect(r.intents.slice(0, 2)).toEqual([
      { intent: 'PRICING', count: 2 },
      { intent: 'TECHNICAL', count: 2 },
    ]);
    expect(r.sentiment).toEqual(expect.arrayContaining([{ sentiment: 'negative', count: 1 }, { sentiment: 'neutral', count: 1 }]));
  });

  it('reports cost, knowledge usage, top questions and the team', async () => {
    const r = await getAnalyticsReport(admin, WEEK, TZ, NOW);
    expect(r.cost.byKind).toEqual([
      { kind: 'CHAT', calls: 2, tokens: 1500, costUsd: 0.018 },
      { kind: 'EMBEDDING', calls: 1, tokens: 500, costUsd: 0 },
    ]);
    expect(r.cost).toMatchObject({ perConversationUsd: 0.0036, avgChatLatencyMs: 1500 });
    expect(r.knowledge).toMatchObject({
      aiReplies: 7,
      repliesWithSources: 2,
      topDocuments: [{ id: doc1, title: 'Hosting & privacy', citations: 2 }],
      unusedDocuments: [expect.objectContaining({ title: 'Old brochure' })],
    });
    expect(r.questions).toEqual({ total: 6, unanswered: 3 });
    expect(r.topQuestions.map((t) => [t.label, t.count, t.customers])).toEqual([
      ['installation', 3, 3],
      ['plan cost', 2, 2],
    ]);
    expect(r.topKeywords[0]).toEqual({ term: 'installation', count: 3 });
    expect(r.team).toEqual([{ userId: agent.userId, name: 'AGENT', conversations: 1, replies: 1, avgFirstReplySeconds: 120 }]);
  });

  it('supports custom ranges, CSV export and permissions', async () => {
    const r = await getAnalyticsReport(admin, { range: 'custom', from: '2026-10-03', to: '2026-10-03' }, TZ, NOW);
    expect(r.period).toMatchObject({ days: 1, bucket: 'hour', label: '3 Oct 2026' });
    expect(r.kpis.conversations.value).toBe(2);
    expect(r.series).toHaveLength(24);
    const csv = await exportAnalyticsCsv(admin, WEEK, TZ);
    expect(csv.split('\r\n')[0]).toBe('﻿Date,Website conversations,WhatsApp conversations,Messages,AI cost (USD)');
    await expect(getAnalyticsReport(agent, WEEK, TZ, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await createWorkspace('Other');
    const empty = await getAnalyticsReport(contextFor(other.organization.id, other.owner.id, 'OWNER'), WEEK, TZ, NOW);
    expect(empty.kpis.conversations).toEqual({ value: 0, previous: 0 });
    expect(empty.knowledge.topDocuments).toEqual([]);
  });

  it('keeps escalations counted after the conversation went back to the AI', async () => {
    await prisma.conversation.updateMany({ where: { organizationId, handoffRequestedAt: { not: null } }, data: { handoffRequestedAt: null, status: 'AI_ACTIVE' } });
    expect((await getAnalyticsReport(admin, WEEK, TZ, NOW)).kpis.escalationRate.value).toBe(20);
    // The dashboard overview still works alongside.
    expect((await getOverview(admin, { range: '7d', timeZone: TZ, now: NOW })).kpis.totalConversations.value).toBe(5);
  });
});

describe('AI insights', () => {
  it('finds knowledge gaps, frequent questions, complaints and intent trends', async () => {
    const data = await getInsights(admin, WEEK, TZ, NOW);
    expect(data.questions).toEqual({ total: 6, unanswered: 3, answerRate: 50 });
    expect(data.gaps).toHaveLength(1);
    expect(data.gaps[0]).toMatchObject({ label: 'installation', count: 3, customers: 3 });
    expect(data.gaps[0]!.examples.map((e) => e.text)).toContain('Is there an installation guide for Shopify?');
    expect(data.faqs.map((f) => f.label)).toEqual(['plan cost']);
    expect(data.complaintCount).toBe(1);
    expect(data.complaints[0]).toMatchObject({ label: 'Other complaints', count: 1, examples: [expect.objectContaining({ text: 'This is terrible, I was charged twice' })] });
    expect(data.intents.find((i) => i.intent === 'FAQ')).toEqual({ intent: 'FAQ', count: 1, previous: 1 });
    expect(data.report).toBeNull();
  });

  it('writes an AI report from aggregates only, without contact details', async () => {
    let prompt = '';
    ai.respondJson((req) => {
      if (!req.messages[0]?.content?.includes('customer-service analyst')) return undefined;
      prompt = req.messages[1]!.content ?? '';
      return {
        summary: 'The assistant answered half of the questions.',
        insights: [
          { kind: 'knowledge_gap', title: '3 customers asked about installation', detail: 'No installation guide exists in the knowledge base.', action: 'Add an installation guide.' },
          { kind: 'weird', title: 'Pricing questions are common', detail: '', action: '' },
        ],
      };
    });
    const result = await generateInsightReport(admin, WEEK, TZ, NOW);
    expect(result.report?.content.insights.map((i) => i.kind)).toEqual(['knowledge_gap', 'opportunity']);
    expect(prompt).toContain('"topic":"installation"');
    expect(prompt).toContain('[email]');
    expect(prompt).not.toContain('kim@example.com');
    const stored = await getInsights(owner, WEEK, TZ, NOW);
    expect(stored.report).toMatchObject({ content: { summary: 'The assistant answered half of the questions.' }, createdBy: 'ADMIN' });
    expect(await prisma.usageRecord.count({ where: { organizationId, kind: 'SUMMARY' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'insights.generated' } })).toBe(1);
  });

  it('explains when insights cannot be written', async () => {
    ai.respondJson((req) => (req.messages[0]?.content?.includes('customer-service analyst') ? 'not json at all' : undefined));
    await expect(generateInsightReport(admin, WEEK, TZ, NOW)).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/unusable/) });
    await expect(generateInsightReport(admin, { range: 'custom', from: '2026-01-01', to: '2026-01-02' }, TZ, NOW)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    process.env.OPENAI_API_KEY = '';
    resetEnvCache();
    await expect(generateInsightReport(admin, WEEK, TZ, NOW)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/AI provider/) });
    await expect(getInsights(agent, WEEK, TZ, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
