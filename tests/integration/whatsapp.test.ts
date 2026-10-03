import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as verifyWebhook, POST as postWebhook } from '@/app/api/webhooks/whatsapp/route';
import { flushBackgroundTasks } from '@/server/background';
import { invalidateBotCache } from '@/server/channels/website/widget-auth';
import { deliverWhatsAppMessage } from '@/server/channels/whatsapp/outbound';
import { signWebhookBody } from '@/server/channels/whatsapp/webhook';
import { encryptSecret } from '@/server/crypto';
import { resetEnvCache } from '@/server/env';
import { AppError } from '@/server/errors';
import { retryDueWebhookEvents, retryFailedWhatsAppDeliveries } from '@/server/jobs/whatsapp-jobs';
import { rateLimit, RATE_LIMITS, resetMemoryRateLimits } from '@/server/rate-limit';
import { tenantDb } from '@/server/tenancy/tenant-db';
import {
  connectWhatsApp,
  getWhatsAppSettings,
  sendWhatsAppTemplate,
  syncWhatsAppTemplates,
  testWhatsAppConnection,
} from '@/server/modules/whatsapp/whatsapp-service';
import { contextFor, createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockGraph, type MockGraph } from './mock-graph';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';

const APP_SECRET = 'test-app-secret';
const PHONE_ID = '1000000001';
const WABA_ID = '2000000001';
const CUSTOMER = '4915123456789';

let graph: MockGraph;
let ai: MockOpenAI;
let organizationId: string;
let ownerId: string;
let seq = 0;

function webhookRequest(body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  return new NextRequest(new URL('/api/webhooks/whatsapp', 'http://localhost:3000'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signWebhookBody(raw, secret) },
    body: raw,
  });
}

function payload(value: Record<string, unknown>, phoneNumberId = PHONE_ID) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId, display_phone_number: '+49 30 1234 5672' }, ...value } }] }],
  };
}

function inbound(message: Record<string, unknown>, opts: { from?: string; name?: string; phoneNumberId?: string } = {}) {
  const from = opts.from ?? CUSTOMER;
  return payload(
    {
      contacts: [{ wa_id: from, profile: { name: opts.name ?? 'Kim Weber' } }],
      messages: [{ from, id: `wamid.in.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
    },
    opts.phoneNumberId,
  );
}

const text = (body: string, opts?: Parameters<typeof inbound>[1]) => inbound({ type: 'text', text: { body } }, opts);
const status = (id: string, value: string, errors?: unknown[]) =>
  payload({ statuses: [{ id, status: value, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: CUSTOMER, ...(errors ? { errors } : {}) }] });

async function deliver(body: unknown) {
  const res = await postWebhook(webhookRequest(body), { params: {} });
  expect(res.status).toBe(200);
  await flushBackgroundTasks();
  return res.json() as Promise<{ received: number; duplicates: number }>;
}

async function setupAccount(orgId: string, phoneNumberId = PHONE_ID, token?: string) {
  const channel = await prisma.channel.create({ data: { organizationId: orgId, type: 'WHATSAPP', name: 'WhatsApp' } });
  return prisma.whatsAppAccount.create({
    data: {
      organizationId: orgId,
      channelId: channel.id,
      phoneNumberId,
      businessAccountId: WABA_ID,
      accessTokenEncrypted: token ? encryptSecret(token) : null,
    },
  });
}

const conversationOf = (customerPhone = `+${CUSTOMER}`) =>
  prisma.conversation.findFirstOrThrow({ where: { organizationId, channel: 'WHATSAPP', customer: { phone: customerPhone } }, orderBy: { createdAt: 'desc' } });

beforeAll(async () => {
  graph = await startMockGraph();
  ai = await startMockOpenAI();
});
afterAll(async () => {
  await graph.close();
  await ai.close();
});
afterEach(() => {
  expect(ai.errors).toEqual([]);
});

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  invalidateBotCache();
  graph.reset();
  ai.reset();
  Object.assign(process.env, {
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    WHATSAPP_ACCESS_TOKEN: 'wa-env-token',
    WHATSAPP_GRAPH_URL: graph.url,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: ai.url,
  });
  resetEnvCache();
  const ws = await createWorkspace('WA Co');
  organizationId = ws.organization.id;
  ownerId = ws.owner.id;
  await setupAccount(organizationId);
  // Team always online.
  await prisma.businessHours.deleteMany({ where: { organizationId } });
  await prisma.businessHours.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ organizationId, weekday, opensAt: '00:00', closesAt: '00:00' })) });
});

describe('webhook security', () => {
  it('answers the verification handshake only with the right token', async () => {
    const url = (token: string) => new NextRequest(new URL(`/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`, 'http://localhost:3000'));
    const ok = await verifyWebhook(url('verify-me'), { params: {} });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('12345');
    expect((await verifyWebhook(url('nope'), { params: {} })).status).toBe(403);
  });

  it('rejects unsigned or wrongly signed deliveries without storing anything', async () => {
    const res = await postWebhook(webhookRequest(text('hi'), 'wrong-secret'), { params: {} });
    expect(res.status).toBe(401);
    expect(await prisma.inboundWebhookEvent.count()).toBe(0);
  });
});

describe('inbound messages', () => {
  it('runs a text message through the AI pipeline and replies on WhatsApp', async () => {
    const result = await deliver(text('How much is the Growth plan?'));
    expect(result).toEqual({ received: 1, duplicates: 0 });

    const customer = await prisma.customer.findFirstOrThrow({ where: { organizationId, phone: `+${CUSTOMER}` } });
    expect(customer).toMatchObject({ name: 'Kim Weber', isAnonymous: false });
    const conversation = await conversationOf();
    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' } });
    expect(messages.map((m) => m.senderType)).toEqual(['CUSTOMER', 'AI']);

    // Markdown converted to WhatsApp formatting, sent to the customer's number.
    const [send] = graph.sends();
    expect(send).toMatchObject({ to: CUSTOMER, type: 'text', text: { body: 'Our *Growth* plan costs €399 per month.' } });
    const reply = messages[1]!;
    expect(reply).toMatchObject({ status: 'SENT', externalMessageId: 'wamid.out.1' });
    // Read receipt + typing indicator for the customer's message.
    expect(graph.readReceipts()[0]).toMatchObject({ message_id: messages[0]!.externalMessageId, typing_indicator: { type: 'text' } });
    // The stored event is processed and its personal data dropped.
    const event = await prisma.inboundWebhookEvent.findFirstOrThrow();
    expect(event).toMatchObject({ status: 'PROCESSED', organizationId, payload: null, attempts: 1 });
    // The WhatsApp channel prompt layer was used.
    expect(ai.requests[0]!.messages[0]!.content).toContain('Channel: WhatsApp');
  });

  it('processes a redelivered webhook only once', async () => {
    const body = text('Hello there');
    await deliver(body);
    expect(await deliver(body)).toEqual({ received: 0, duplicates: 1 });
    expect(await prisma.message.count({ where: { organizationId, senderType: 'CUSTOMER' } })).toBe(1);
    expect(ai.requests).toHaveLength(1);
  });

  it('links the number to an existing customer who gave it on the website', async () => {
    const existing = await prisma.customer.create({ data: { organizationId, name: 'Kim from website', phone: '+49 151 2345 6789', email: 'kim@example.com' } });
    await deliver(text('Hi, it is Kim again'));
    expect(await prisma.customer.count({ where: { organizationId } })).toBe(1);
    const identity = await prisma.customerIdentity.findFirstOrThrow({ where: { channel: 'WHATSAPP' } });
    expect(identity).toMatchObject({ customerId: existing.id, externalId: CUSTOMER });
    expect(ai.requests[0]!.messages[0]!.content).toContain('Email: kim@example.com');
  });

  it('stores images, rejects files whose content does not match, and transcribes voice notes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    graph.addMedia('img-1', png, 'image/png');
    await deliver(inbound({ type: 'image', image: { id: 'img-1', mime_type: 'image/png', caption: 'Widget error' } }));
    const image = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'CUSTOMER', messageType: 'IMAGE' } });
    expect(image.content).toBe('Widget error');
    expect(image.attachments).toEqual([expect.objectContaining({ mimeType: 'image/png', size: png.byteLength })]);

    graph.addMedia('fake-1', new TextEncoder().encode('<html><script>alert(1)</script>'), 'image/jpeg');
    await deliver(inbound({ type: 'image', image: { id: 'fake-1', mime_type: 'image/jpeg' } }));
    const fake = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'CUSTOMER', externalMessageId: `wamid.in.${seq}` } });
    expect(fake.attachments).toBeNull();
    expect(fake.content).toContain('not supported');

    graph.addMedia('voice-1', new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0]), 'audio/ogg; codecs=opus');
    ai.setTranscript('Do you offer a free trial?');
    await deliver(inbound({ type: 'audio', audio: { id: 'voice-1', mime_type: 'audio/ogg; codecs=opus', voice: true } }));
    const voice = await prisma.message.findFirstOrThrow({ where: { organizationId, messageType: 'AUDIO' } });
    expect(voice.content).toBe('🎤 Voice message: "Do you offer a free trial?"');
    expect(voice.attachments).toEqual([expect.objectContaining({ mimeType: 'audio/ogg' })]);
    expect(ai.transcriptions).toHaveLength(1);
    expect(await prisma.usageRecord.count({ where: { organizationId, kind: 'TRANSCRIPTION' } })).toBe(1);
    expect(ai.requests.at(-1)!.messages.at(-1)!.content).toContain('free trial');
  });

  it('understands locations', async () => {
    await deliver(inbound({ type: 'location', location: { latitude: 52.52, longitude: 13.405, name: 'NovaTech', address: 'Friedrichstraße 68' } }));
    const m = await prisma.message.findFirstOrThrow({ where: { organizationId, messageType: 'LOCATION' } });
    expect(m.content).toContain('📍 Shared location: NovaTech, Friedrichstraße 68');
    expect(m.metadata).toMatchObject({ location: { latitude: 52.52, longitude: 13.405 } });
  });

  it('turns the AI fallback action into a reply button, and a tap into a handoff', async () => {
    ai.setMode('error');
    await deliver(text('Hello?'));
    const fallback = graph.sends().at(-1)!;
    expect(fallback).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'action:handoff', title: 'Talk to a human' } }] } },
    });

    ai.setMode('ok');
    ai.requests.length = 0;
    await deliver(inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'action:handoff', title: 'Talk to a human' } } }));
    expect(ai.requests).toHaveLength(0);
    const conversation = await conversationOf();
    expect(conversation.status).toBe('WAITING_FOR_AGENT');
    expect((graph.sends().at(-1) as { text: { body: string } }).text.body).toContain('member of our team');

    // Human mode: further messages are stored, the AI stays silent.
    await deliver(text('Thanks, waiting'));
    expect(ai.requests).toHaveLength(0);
  });

  it('does not ask WhatsApp customers for contact details when the team is offline', async () => {
    await prisma.businessHours.deleteMany({ where: { organizationId } });
    invalidateBotCache();
    await deliver(inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'action:handoff', title: 'Talk to a human' } } }));
    const body = (graph.sends().at(-1) as { text: { body: string } }).text.body;
    expect(body).toContain('passed your request on');
    expect(body).not.toContain('Leave your email');
    // Offline: the AI keeps helping.
    expect((await conversationOf()).status).toBe('AI_ACTIVE');
  });

  it('splits long replies within WhatsApp limits', async () => {
    ai.setMode('ok', `${'Lorem ipsum dolor sit amet. '.repeat(200)}`);
    await deliver(text('Tell me everything'));
    const sends = graph.sends();
    expect(sends.length).toBe(2);
    for (const s of sends) expect(((s as { text: { body: string } }).text.body).length).toBeLessThanOrEqual(4096);
    const reply = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'AI' } });
    expect(reply.metadata).toMatchObject({ delivery: { wamids: ['wamid.out.1', 'wamid.out.2'] } });
  });

  it('stores but does not answer senders over the AI rate limit', async () => {
    const customer = await prisma.customer.create({ data: { organizationId, phone: `+${CUSTOMER}` } });
    await prisma.customerIdentity.create({ data: { organizationId, customerId: customer.id, channel: 'WHATSAPP', externalId: CUSTOMER } });
    for (let i = 0; i < RATE_LIMITS.whatsappAiPerCustomer.limit; i++) await rateLimit(RATE_LIMITS.whatsappAiPerCustomer, `${organizationId}:${customer.id}`);
    await deliver(text('spam'));
    expect(await prisma.message.count({ where: { organizationId, senderType: 'CUSTOMER' } })).toBe(1);
    expect(ai.requests).toHaveLength(0);
  });

  it('ignores events for numbers that are not connected', async () => {
    await deliver(text('hi', { phoneNumberId: '9999999999' }));
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.inboundWebhookEvent.findFirstOrThrow()).toMatchObject({ status: 'IGNORED' });
  });

  it('routes each number to its own workspace with its own token', async () => {
    const other = await createWorkspace('Other Co');
    await setupAccount(other.organization.id, '1000000002', 'other-tenant-token');
    graph.acceptTokens(['wa-env-token', 'other-tenant-token']);
    await deliver(text('Hello other', { phoneNumberId: '1000000002', from: '4917000000001' }));
    const otherMessages = await prisma.message.count({ where: { organizationId: other.organization.id } });
    expect(otherMessages).toBe(2);
    expect(await prisma.message.count({ where: { organizationId } })).toBe(0);
    expect(graph.requests.filter((r) => r.path.includes('/1000000002/messages')).every((r) => r.auth === 'Bearer other-tenant-token')).toBe(true);
  });
});

describe('delivery statuses', () => {
  it('moves status forward only and records failures', async () => {
    await deliver(text('Hi'));
    const reply = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'AI' } });
    await deliver(status(reply.externalMessageId!, 'read'));
    await deliver(status(reply.externalMessageId!, 'delivered')); // late, out of order
    expect((await prisma.message.findUniqueOrThrow({ where: { id: reply.id } })).status).toBe('READ');

    await deliver(text('Another'));
    const second = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'AI' }, orderBy: { createdAt: 'desc' } });
    await deliver(status(second.externalMessageId!, 'failed', [{ code: 131047, title: 'Re-engagement message' }]));
    expect(await prisma.message.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'FAILED', errorCode: 'whatsapp_window_closed' });
  });

  it('retries a status that arrives before its message is known', async () => {
    await deliver(status('wamid.out.future', 'delivered'));
    const event = await prisma.inboundWebhookEvent.findFirstOrThrow();
    expect(event).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(event.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // The message gets stored meanwhile; the event becomes due and the job retries it.
    await deliver(text('Hi'));
    const reply = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'AI' } });
    await prisma.message.update({ where: { id: reply.id }, data: { externalMessageId: 'wamid.out.future' } });
    await prisma.inboundWebhookEvent.update({ where: { id: event.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await retryDueWebhookEvents()).toBe(1);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: reply.id } })).status).toBe('DELIVERED');
    expect(await prisma.inboundWebhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'PROCESSED', attempts: 2 });
  });
});

describe('outbound rules and retries', () => {
  async function agentMessage(conversationId: string, content: string) {
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const message = await prisma.message.create({
      data: { organizationId, conversationId, channel: 'WHATSAPP', senderType: 'AGENT', content, status: 'PENDING' },
    });
    return { conversation, message };
  }

  it('refuses free-form messages outside the 24-hour window', async () => {
    await deliver(text('Hi'));
    const conversation = await conversationOf();
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastCustomerMessageAt: new Date(Date.now() - 25 * 3_600_000) } });
    const { conversation: stale, message } = await agentMessage(conversation.id, 'Following up!');
    const before = graph.sends().length;
    const result = await deliverWhatsAppMessage(stale, message);
    expect(result.delivered).toBe(false);
    expect(graph.sends().length).toBe(before);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: 'FAILED', errorCode: 'whatsapp_window_closed' });
  });

  it('retries transient Graph failures in the background', async () => {
    await deliver(text('Hi'));
    const conversation = await conversationOf();
    graph.failSends(3, 503, 131000); // all three in-request attempts fail
    const { conversation: c, message } = await agentMessage(conversation.id, 'Here is the update');
    await deliverWhatsAppMessage(c, message);
    const failed = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'whatsapp_unavailable' });
    expect(failed.metadata).toMatchObject({ delivery: { attempts: 1, retryable: true } });

    // Not due yet → nothing happens; once due → sent.
    expect(await retryFailedWhatsAppDeliveries()).toBe(0);
    await prisma.message.update({ where: { id: message.id }, data: { metadata: { delivery: { attempts: 1, retryable: true, nextAttemptAt: Date.now() - 1 } } } });
    expect(await retryFailedWhatsAppDeliveries()).toBe(1);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: 'SENT', errorCode: null });
  });

  it('does not retry permanent errors such as a rejected token', async () => {
    await deliver(text('Hi'));
    const conversation = await conversationOf();
    graph.acceptTokens(['something-else']);
    const { conversation: c, message } = await agentMessage(conversation.id, 'Hello');
    await deliverWhatsAppMessage(c, message);
    const failed = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'whatsapp_auth' });
    expect(failed.metadata).toMatchObject({ delivery: { retryable: false } });
  });
});

describe('templates and connection management', () => {
  const owner = () => contextFor(organizationId, ownerId, 'OWNER');

  it('syncs templates and sends one outside the 24-hour window', async () => {
    graph.setTemplates([
      { id: 't1', name: 'order_update', language: 'de', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hallo {{1}}, Ihre Anfrage {{2}} ist erledigt.' }] },
      { id: 't2', name: 'promo', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Sale!' }] },
      { id: 't3', name: 'with_image', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Look' }] },
    ]);
    const templates = await syncWhatsAppTemplates(owner());
    expect(templates.map((t) => [t.name, t.variables, t.supported])).toEqual([
      ['order_update', 2, true],
      ['promo', 0, true],
      ['with_image', 0, false],
    ]);

    await deliver(text('Hi'));
    const conversation = await conversationOf();
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastCustomerMessageAt: new Date(Date.now() - 48 * 3_600_000) } });
    const tpl = templates.find((t) => t.name === 'order_update')!;

    await expect(sendWhatsAppTemplate(owner(), conversation.id, { templateId: tpl.id, params: ['Kim'] })).rejects.toBeInstanceOf(AppError);
    const promo = templates.find((t) => t.name === 'promo')!;
    await expect(sendWhatsAppTemplate(owner(), conversation.id, { templateId: promo.id, params: [] })).rejects.toThrow(/approved/);

    const result = await sendWhatsAppTemplate(owner(), conversation.id, { templateId: tpl.id, params: ['Kim', 'T-123'] });
    expect(result).toMatchObject({ delivered: true, status: 'SENT' });
    expect(result.message.content).toBe('Hallo Kim, Ihre Anfrage T-123 ist erledigt.');
    expect(graph.sends().at(-1)).toMatchObject({
      type: 'template',
      template: { name: 'order_update', language: { code: 'de' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Kim' }, { type: 'text', text: 'T-123' }] }] },
    });

    // Templates removed in Meta disappear here on the next sync.
    graph.setTemplates([]);
    expect(await syncWhatsAppTemplates(owner())).toEqual([]);
  });

  it('lets owners connect a number, blocks numbers of other workspaces, and verifies the connection', async () => {
    const other = await createWorkspace('Other Co');
    const otherOwner = contextFor(other.organization.id, other.owner.id, 'OWNER');
    await expect(connectWhatsApp(otherOwner, { phoneNumberId: PHONE_ID, businessAccountId: WABA_ID })).rejects.toThrow(/another workspace/);

    const admin = contextFor(organizationId, ownerId, 'ADMIN');
    await expect(connectWhatsApp(admin, { phoneNumberId: PHONE_ID, businessAccountId: WABA_ID })).rejects.toThrow(/owners/);

    const settings = await connectWhatsApp(owner(), { phoneNumberId: PHONE_ID, businessAccountId: WABA_ID, accessToken: 'own-token-123' });
    expect(settings.account).toMatchObject({ phoneNumberId: PHONE_ID, hasOwnToken: true });
    expect(JSON.stringify(settings)).not.toContain('own-token-123');
    expect(settings.environment).toEqual({ appSecret: true, verifyToken: true, accessToken: true });

    graph.acceptTokens(['own-token-123']);
    expect(await testWhatsAppConnection(owner())).toMatchObject({ verifiedName: 'NovaTech GmbH', qualityRating: 'GREEN' });
    expect((await getWhatsAppSettings(owner())).account).toMatchObject({ verifiedName: 'NovaTech GmbH' });
  });

  it('shows recent webhook activity only for the own workspace', async () => {
    await deliver(text('Hi'));
    await deliver(text('hi', { phoneNumberId: '9999999999' }));
    const settings = await getWhatsAppSettings(owner());
    expect(settings.recentEvents).toHaveLength(1);
    expect(settings.recentEvents[0]).toMatchObject({ eventType: 'message', status: 'PROCESSED' });
    const db = tenantDb(organizationId);
    expect(await db.whatsAppAccount.count()).toBe(1);
  });
});
