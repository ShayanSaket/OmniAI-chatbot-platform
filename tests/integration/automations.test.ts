import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationInput } from '@/lib/automations';
import { flushBackgroundTasks } from '@/server/background';
import { invalidateBotCache } from '@/server/channels/website/widget-auth';
import { resetEnvCache } from '@/server/env';
import { buildEvent, emitDomainEvent } from '@/server/events/domain-events';
import { resetMemoryRateLimits } from '@/server/rate-limit';
import { createAutomation, listAutomationRuns } from '@/server/modules/automations/automation-service';
import { runAutomationsForEvent, scanInactiveConversations } from '@/server/modules/automations/engine';
import { connectIntegration, listIntegrations } from '@/server/modules/integrations/integration-service';
import { listNotifications, markNotificationsRead } from '@/server/modules/notifications/notification-service';
import { retryDueWebhookDeliveries } from '@/server/modules/webhooks/delivery';
import { DISABLE_AFTER_FAILURES, MAX_DELIVERY_ATTEMPTS, verifySignatureHeader } from '@/server/modules/webhooks/signing';
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  redeliverWebhook,
  rotateWebhookSecret,
  sendTestWebhook,
  updateWebhookEndpoint,
} from '@/server/modules/webhooks/webhook-service';
import type { ServiceContext } from '@/server/context';
import { addUser, contextFor, createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';
import { finalReply, widgetClient } from './widget-client';

let ai: MockOpenAI;
let receiver: Server;
let receiverUrl: string;
const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
let receiverStatus = 200;
let hubspot: Server;
let hubspotUrl: string;
const hubspotCalls: { method: string; path: string; auth?: string; body: unknown }[] = [];

let owner: ServiceContext;
let admin: ServiceContext;
let organizationId: string;
let botKey: string;

beforeAll(async () => {
  ai = await startMockOpenAI();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body });
      res.writeHead(receiverStatus).end(receiverStatus === 200 ? 'ok' : 'nope');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  hubspot = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hubspotCalls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.headers.authorization !== 'Bearer pat-good-token') return res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"bad token"}');
      if (req.url!.startsWith('/crm/v3/objects/contacts/batch/upsert')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"results":[{"id":"9001"}]}');
      if (req.url!.startsWith('/crm/v3/objects/contacts')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"results":[]}');
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => hubspot.listen(0, '127.0.0.1', r));
  hubspotUrl = `http://127.0.0.1:${(hubspot.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await ai.close();
  await new Promise<void>((r) => receiver.close(() => r()));
  await new Promise<void>((r) => hubspot.close(() => r()));
});
afterEach(() => expect(ai.errors).toEqual([]));

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  invalidateBotCache();
  ai.reset();
  received.length = 0;
  hubspotCalls.length = 0;
  receiverStatus = 200;
  Object.assign(process.env, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: ai.url, HUBSPOT_API_URL: hubspotUrl });
  resetEnvCache();
  const ws = await createWorkspace('Auto Co');
  organizationId = ws.organization.id;
  owner = contextFor(organizationId, ws.owner.id, 'OWNER');
  admin = contextFor(organizationId, (await addUser(organizationId, 'ADMIN')).user.id, 'ADMIN');
  botKey = (await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId } })).publicKey;
  // Team always online.
  await prisma.businessHours.deleteMany({ where: { organizationId } });
  await prisma.businessHours.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ organizationId, weekday, opensAt: '00:00', closesAt: '00:00' })) });
});

async function makeLead() {
  const customer = await prisma.customer.create({ data: { organizationId, name: 'Anna Berg', email: 'anna@example.com', phone: '+49 151 1' } });
  const lead = await prisma.lead.create({ data: { organizationId, customerId: customer.id, name: 'Anna Berg', email: 'anna@example.com', requestedService: 'Demo' } });
  return { customer, lead };
}

const automation = (input: Partial<AutomationInput> & Pick<AutomationInput, 'trigger' | 'actions'>): AutomationInput => ({
  name: 'Test automation',
  description: null,
  isActive: true,
  conditions: { channels: [], keywords: [], intents: [], teamStatus: 'any', inactiveMinutes: 30, lastMessageFrom: 'any' },
  ...input,
});

describe('outbound webhooks', () => {
  it('delivers subscribed events with a verifiable signature and full payload', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/hook`, events: ['lead.created'], description: 'CRM', preset: 'custom' });
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await listWebhookEndpoints(owner))).not.toContain(secret);

    const { lead, customer } = await makeLead();
    const eventId = emitDomainEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id, customerId: customer.id } });
    emitDomainEvent({ type: 'ticket.created', organizationId, refs: { customerId: customer.id } }); // not subscribed
    await flushBackgroundTasks();

    expect(received).toHaveLength(1);
    const [req] = received;
    expect(verifySignatureHeader(req!.headers['x-omniai-signature'] as string, req!.body, secret)).toBe(true);
    expect(verifySignatureHeader(req!.headers['x-omniai-signature'] as string, `${req!.body} `, secret)).toBe(false);
    expect(req!.headers['x-omniai-event']).toBe('lead.created');
    expect(req!.headers['x-omniai-event-id']).toBe(eventId);
    const body = JSON.parse(req!.body);
    expect(body).toMatchObject({
      id: eventId,
      type: 'lead.created',
      organizationId,
      data: { lead: { id: lead.id, reference: `L-${lead.id.slice(-6).toUpperCase()}`, email: 'anna@example.com' }, customer: { name: 'Anna Berg' } },
    });
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
    expect(delivery).toMatchObject({ status: 'DELIVERED', attempts: 1, responseStatus: 200 });
  });

  it('sends every event of a real conversation to "*" subscribers', async () => {
    await createWebhookEndpoint(owner, { url: `${receiverUrl}/all`, events: ['*'], description: null, preset: 'zapier' });
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    await client.send(visitor.token, 'Hello there');
    await flushBackgroundTasks();
    const types = received.map((r) => JSON.parse(r.body).type).sort();
    expect(types).toEqual(expect.arrayContaining(['conversation.created', 'customer.created', 'message.received']));
    const message = received.map((r) => JSON.parse(r.body)).find((b) => b.type === 'message.received');
    expect(message.data).toMatchObject({ message: { text: 'Hello there', sender: 'customer', channel: 'WEBSITE' }, conversation: { channel: 'WEBSITE' } });
  });

  it('retries failures with backoff, then succeeds', async () => {
    const { endpoint } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/flaky`, events: ['lead.created'], description: null, preset: 'custom' });
    const { lead } = await makeLead();
    receiverStatus = 500;
    emitDomainEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id } });
    await flushBackgroundTasks();
    let delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 1, responseStatus: 500 });
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);

    expect(await retryDueWebhookDeliveries()).toBe(0); // not due yet
    receiverStatus = 200;
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await retryDueWebhookDeliveries()).toBe(1);
    delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
    expect(delivery).toMatchObject({ status: 'DELIVERED', attempts: 2 });
    // Same event id on both attempts (receivers deduplicate on it).
    expect(new Set(received.map((r) => r.headers['x-omniai-event-id'])).size).toBe(1);
  });

  it('gives up after the last attempt and disables endpoints that keep failing', async () => {
    const { endpoint } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/dead`, events: ['lead.created'], description: null, preset: 'custom' });
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { consecutiveFailures: DISABLE_AFTER_FAILURES - 1 } });
    const { lead } = await makeLead();
    receiverStatus = 503;
    emitDomainEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id } });
    await flushBackgroundTasks();
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { attempts: MAX_DELIVERY_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) } });
    await retryDueWebhookDeliveries();

    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: 'FAILED', attempts: MAX_DELIVERY_ATTEMPTS });
    const disabled = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(disabled).toMatchObject({ isActive: false, consecutiveFailures: DISABLE_AFTER_FAILURES });
    expect(disabled.disabledReason).toContain('in a row');
    const ownerNotes = await listNotifications(owner);
    expect(ownerNotes.items[0]).toMatchObject({ title: 'Webhook endpoint disabled', link: '/integrations' });
    expect((await listNotifications(admin)).unread).toBe(0);

    // Re-enabling resets the streak; a manual redelivery then succeeds.
    receiverStatus = 200;
    await updateWebhookEndpoint(owner, endpoint.id, { isActive: true });
    expect((await redeliverWebhook(owner, delivery.id)).ok).toBe(true);
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).consecutiveFailures).toBe(0);
  });

  it('disables an endpoint that answers 410 Gone at once', async () => {
    const { endpoint } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/gone`, events: ['lead.created'], description: null, preset: 'custom' });
    receiverStatus = 410;
    const { lead } = await makeLead();
    emitDomainEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id } });
    await flushBackgroundTasks();
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).isActive).toBe(false);
  });

  it('sends test pings, rotates secrets and is owner-only', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/ping`, events: ['lead.created'], description: null, preset: 'n8n' });
    expect(await sendTestWebhook(owner, endpoint.id)).toMatchObject({ ok: true, responseStatus: 200 });
    expect(JSON.parse(received[0]!.body).type).toBe('webhook.ping');

    const { secret: next } = await rotateWebhookSecret(owner, endpoint.id);
    expect(next).not.toBe(secret);
    await sendTestWebhook(owner, endpoint.id);
    const sig = received[1]!.headers['x-omniai-signature'] as string;
    expect(verifySignatureHeader(sig, received[1]!.body, next)).toBe(true);
    expect(verifySignatureHeader(sig, received[1]!.body, secret)).toBe(false);

    receiverStatus = 500;
    expect(await sendTestWebhook(owner, endpoint.id)).toMatchObject({ ok: false, responseStatus: 500 });
    expect(await prisma.webhookDelivery.count({ where: { status: 'PENDING' } })).toBe(0); // tests leave no retries

    await expect(createWebhookEndpoint(admin, { url: `${receiverUrl}/x`, events: ['*'], description: null, preset: 'custom' })).rejects.toThrow(/owners/);
  });
});

describe('automations', () => {
  it('hands refund requests to a human before the AI answers', async () => {
    await createAutomation(
      admin,
      automation({
        name: 'Refunds go to billing',
        trigger: 'KEYWORD_DETECTED',
        conditions: { channels: [], keywords: ['refund', 'Rückerstattung'], intents: [], teamStatus: 'any', inactiveMinutes: 30, lastMessageFrom: 'any' },
        actions: [{ type: 'ADD_TAG', tag: 'Refund' }, { type: 'REQUEST_HANDOFF' }, { type: 'NOTIFY_TEAM', message: '{{customer.name|A customer}} asked for a refund: {{message.text}}', recipients: 'admins' }],
      }),
    );
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    const events = await client.send(visitor.token, 'I want a refund for my order');
    await flushBackgroundTasks();

    expect(ai.requests).toHaveLength(0); // the AI stayed silent
    expect(events.some((e) => e.type === 'assistant.start')).toBe(false);
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { organizationId } });
    expect(conversation.status).toBe('WAITING_FOR_AGENT');
    const tags = await prisma.customerTag.findMany({ where: { customerId: visitor.customer.id }, include: { tag: true } });
    expect(tags.map((t) => t.tag.name)).toEqual(['Refund']);
    const note = (await listNotifications(admin)).items[0]!;
    expect(note.body).toBe('A customer asked for a refund: I want a refund for my order');
    expect(note.link).toBe(`/inbox?conversation=${conversation.id}`);

    const [auto] = await prisma.automation.findMany({ where: { organizationId } });
    const runs = await listAutomationRuns(admin, auto!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'SUCCESS', eventType: 'message.received' });
    expect(runs[0]!.results.map((r) => r.type)).toEqual(['ADD_TAG', 'REQUEST_HANDOFF', 'NOTIFY_TEAM']);

    // "refunded" is not the keyword "refund": whole words only.
    const other = await client.visitor();
    await client.send(other.token, 'Was my order refunded already?');
    await flushBackgroundTasks();
    expect(await prisma.automationRun.count()).toBe(1);
  });

  it('greets new conversations with a template message', async () => {
    await createAutomation(admin, automation({ trigger: 'CONVERSATION_CREATED', actions: [{ type: 'SEND_MESSAGE', text: 'Hi {{customer.firstName|there}}! A colleague from {{company.name}} reads along.' }] }));
    ai.respond(() => ({ text: 'How can I help?' }));
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    const reply = finalReply(await client.send(visitor.token, 'Hello'));
    expect(reply.content).toBe('How can I help?');
    const messages = await prisma.message.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' }, select: { senderType: true, content: true, metadata: true } });
    expect(messages.map((m) => m.content)).toEqual(['Hello', 'Hi there! A colleague from Auto Co reads along.', 'How can I help?']);
    expect(messages[1]!.metadata).toMatchObject({ automation: { name: 'Test automation' } });
  });

  it('turns pricing questions into leads and forwards them to a webhook', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/sales`, events: ['ticket.created'], description: 'Sales', preset: 'make' });
    const auto = await createAutomation(
      admin,
      automation({
        trigger: 'INTENT_DETECTED',
        conditions: { channels: [], keywords: [], intents: ['PRICING'], teamStatus: 'any', inactiveMinutes: 30, lastMessageFrom: 'any' },
        actions: [{ type: 'CREATE_LEAD', requestedService: 'Pricing inquiry', temperature: 'WARM' }, { type: 'TRIGGER_WEBHOOK', endpointId: endpoint.id }],
      }),
    );
    ai.respondJson((req) =>
      (req.messages[0]!.content ?? '').startsWith('TASK: classify')
        ? { intent: 'PRICING', sentiment: 'neutral', leadTemperature: 'WARM', escalation: 'none', wantsHuman: false, language: 'en', confidence: 0.9 }
        : undefined,
    );
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    await client.send(visitor.token, 'How much is the Growth plan?');
    await flushBackgroundTasks();

    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId } });
    expect(lead).toMatchObject({ requestedService: 'Pricing inquiry', temperature: 'WARM', source: 'WEBSITE' });
    expect(received).toHaveLength(1);
    const body = JSON.parse(received[0]!.body);
    expect(body).toMatchObject({ type: 'intent.detected', data: { intent: 'PRICING', automation: { id: auto.id } } });
    expect(verifySignatureHeader(received[0]!.headers['x-omniai-signature'] as string, received[0]!.body, secret)).toBe(true);
  });

  it('respects channel and team-status conditions', async () => {
    await createAutomation(admin, automation({ trigger: 'MESSAGE_RECEIVED', conditions: { channels: ['WHATSAPP'], keywords: [], intents: [], teamStatus: 'any', inactiveMinutes: 30, lastMessageFrom: 'any' }, actions: [{ type: 'ADD_TAG', tag: 'WA' }] }));
    await createAutomation(admin, automation({ trigger: 'MESSAGE_RECEIVED', conditions: { channels: [], keywords: [], intents: [], teamStatus: 'offline', inactiveMinutes: 30, lastMessageFrom: 'any' }, actions: [{ type: 'ADD_TAG', tag: 'After hours' }] }));
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    await client.send(visitor.token, 'Hi');
    await flushBackgroundTasks();
    expect(await prisma.customerTag.count()).toBe(0);
  });

  it('assigns handed-over conversations round robin and notifies the assignee', async () => {
    const a1 = await addUser(organizationId, 'AGENT');
    const a2 = await addUser(organizationId, 'AGENT');
    await createAutomation(admin, automation({ trigger: 'HANDOFF_REQUESTED', actions: [{ type: 'ASSIGN_AGENT', mode: 'round_robin' }] }));
    const client = widgetClient(botKey);
    for (const text of ['first customer', 'second customer']) {
      const visitor = await client.visitor();
      await client.send(visitor.token, text);
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { customerId: visitor.customer.id } });
      const { POST } = await import('@/app/api/widget/[botKey]/handoff/route');
      const { widgetRequest } = await import('./widget-client');
      await POST(widgetRequest(`/api/widget/${botKey}/handoff`, { method: 'POST', token: visitor.token }), { params: { botKey } });
      await flushBackgroundTasks();
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).assignedToId).not.toBeNull();
    }
    const assignees = (await prisma.conversation.findMany({ where: { organizationId }, select: { assignedToId: true } })).map((c) => c.assignedToId).sort();
    expect(assignees).toEqual([a1.user.id, a2.user.id].sort());
    const agentCtx = contextFor(organizationId, a1.user.id, 'AGENT');
    const notes = await listNotifications(agentCtx);
    // Handoff requests also notify the whole team (phase 6); the assignment notice is separate.
    expect(notes.items.map((n) => n.title)).toContain('Conversation assigned to you');
    expect(notes.items.some((n) => n.title.endsWith('is waiting for a team member'))).toBe(true);
    await markNotificationsRead(agentCtx, 'all');
    expect((await listNotifications(agentCtx)).unread).toBe(0);
  });

  it('runs once per event and never loops on its own events', async () => {
    const auto = await createAutomation(admin, automation({ trigger: 'LEAD_CREATED', actions: [{ type: 'CREATE_TICKET', subject: 'Follow up {{customer.name}}', priority: 'HIGH' }] }));
    const { lead, customer } = await makeLead();
    const event = buildEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id, customerId: customer.id } });
    expect(await runAutomationsForEvent(event)).toBe(1);
    expect(await runAutomationsForEvent(event)).toBe(0); // same event again
    expect(await prisma.ticket.findFirstOrThrow({ where: { organizationId } })).toMatchObject({ subject: 'Follow up Anna Berg', priority: 'HIGH' });

    // Events caused by this automation, or by a long chain, do not trigger it.
    expect(await runAutomationsForEvent(buildEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id }, causedBy: [auto.id] }))).toBe(0);
    expect(await runAutomationsForEvent(buildEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id }, causedBy: ['a', 'b', 'c'] }))).toBe(0);
  });

  it('keeps going when one action cannot run', async () => {
    const { endpoint } = await createWebhookEndpoint(owner, { url: `${receiverUrl}/x`, events: ['ticket.created'], description: null, preset: 'custom' });
    await updateWebhookEndpoint(owner, endpoint.id, { isActive: false });
    await createAutomation(admin, automation({ trigger: 'LEAD_CREATED', actions: [{ type: 'TRIGGER_WEBHOOK', endpointId: endpoint.id }, { type: 'ADD_TAG', tag: 'Lead' }] }));
    const { lead, customer } = await makeLead();
    await runAutomationsForEvent(buildEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id, customerId: customer.id } }));
    const run = await prisma.automationRun.findFirstOrThrow();
    expect(run.status).toBe('SUCCESS');
    expect(run.results).toEqual([
      { type: 'TRIGGER_WEBHOOK', ok: false, skipped: true, detail: 'Webhook endpoint is disabled' },
      { type: 'ADD_TAG', ok: true, detail: 'Tagged “Lead”' },
    ]);
  });

  it('follows up conversations that went quiet, once per quiet period', async () => {
    await createAutomation(
      admin,
      automation({
        trigger: 'CONVERSATION_INACTIVE',
        conditions: { channels: [], keywords: [], intents: [], teamStatus: 'any', inactiveMinutes: 30, lastMessageFrom: 'team' },
        actions: [{ type: 'SEND_MESSAGE', text: 'Is there anything else I can help you with?' }],
      }),
    );
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    await client.send(visitor.token, 'Thanks');
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { organizationId } });
    const quiet = new Date(Date.now() - 31 * 60_000);
    await prisma.message.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: quiet } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: quiet } });

    expect(await scanInactiveConversations()).toBe(1);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: quiet } }); // same quiet period
    expect(await scanInactiveConversations()).toBe(0);
    const last = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' } });
    expect(last.content).toBe('Is there anything else I can help you with?');
  });

  it('validates input and is limited to admins', async () => {
    const agent = contextFor(organizationId, (await addUser(organizationId, 'AGENT')).user.id, 'AGENT');
    await expect(createAutomation(agent, automation({ trigger: 'LEAD_CREATED', actions: [{ type: 'ADD_TAG', tag: 'x' }] }))).rejects.toThrow(/permission/);
    await expect(createAutomation(admin, automation({ trigger: 'LEAD_CREATED', actions: [{ type: 'TRIGGER_WEBHOOK', endpointId: 'nope' }] }))).rejects.toThrow(/webhook endpoint/);
    const { automationInputSchema } = await import('@/lib/automations');
    expect(automationInputSchema.safeParse(automation({ trigger: 'KEYWORD_DETECTED', actions: [{ type: 'ADD_TAG', tag: 'x' }] })).success).toBe(false);
  });
});

describe('HubSpot connector', () => {
  it('verifies the token, then upserts contacts for new leads', async () => {
    await expect(connectIntegration(owner, 'HUBSPOT', { secrets: { accessToken: 'pat-wrong-token' }, config: {} })).rejects.toThrow(/rejected the access token/);
    await connectIntegration(owner, 'HUBSPOT', { secrets: { accessToken: 'pat-good-token' }, config: { syncLeads: true, syncCustomers: false } });
    const listed = (await listIntegrations(owner)).find((i) => i.type === 'HUBSPOT')!;
    expect(listed.connection).toMatchObject({ isActive: true });
    expect(JSON.stringify(listed)).not.toContain('pat-good-token');

    const { lead, customer } = await makeLead();
    emitDomainEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id, customerId: customer.id } });
    await flushBackgroundTasks();
    const upsert = hubspotCalls.find((c) => c.path.includes('batch/upsert'))!;
    expect(upsert.body).toEqual({
      inputs: [{ idProperty: 'email', id: 'anna@example.com', properties: { email: 'anna@example.com', firstname: 'Anna', lastname: 'Berg', lifecyclestage: 'lead', hs_lead_status: 'NEW' } }],
    });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).customFields).toMatchObject({ hubspotContactId: '9001' });
    expect((await prisma.integration.findFirstOrThrow({ where: { organizationId } })).lastSyncAt).not.toBeNull();
  });

  it('records sync errors on the integration', async () => {
    await connectIntegration(owner, 'HUBSPOT', { secrets: { accessToken: 'pat-good-token' }, config: {} });
    await prisma.integration.updateMany({ where: { organizationId }, data: { secretsEncrypted: (await import('@/server/crypto')).encryptSecret(JSON.stringify({ accessToken: 'pat-revoked-token' })) } });
    const { lead, customer } = await makeLead();
    emitDomainEvent({ type: 'lead.created', organizationId, refs: { leadId: lead.id, customerId: customer.id } });
    await flushBackgroundTasks();
    expect((await prisma.integration.findFirstOrThrow({ where: { organizationId } })).lastError).toMatch(/lead.created: HubSpot rejected/);
  });
});
