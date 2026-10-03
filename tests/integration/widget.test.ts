import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSseParser } from '@/lib/sse';
import type { UploadReceipt, WidgetEvent } from '@/lib/widget-protocol';
import { invalidateBotCache, requireBot } from '@/server/channels/website/widget-auth';
import { flushBackgroundTasks } from '@/server/background';
import { resetEnvCache } from '@/server/env';
import { resetMemoryRateLimits } from '@/server/rate-limit';
import { channels, subscribe } from '@/server/realtime/bus';
import { startSession } from '@/server/modules/widget/widget-service';
import { POST as postMessage, GET as getMessages } from '@/app/api/widget/[botKey]/messages/route';
import { POST as postSession } from '@/app/api/widget/[botKey]/session/route';
import { POST as postHandoff } from '@/app/api/widget/[botKey]/handoff/route';
import { POST as postRestart } from '@/app/api/widget/[botKey]/conversation/restart/route';
import { POST as postUpload } from '@/app/api/widget/[botKey]/uploads/route';
import { GET as getConfig } from '@/app/api/widget/[botKey]/config/route';
import { GET as getFile } from '@/app/api/files/route';
import { createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';

let mock: MockOpenAI;
let botKey: string;
let organizationId: string;

function useAi(configured = true) {
  if (configured) process.env.OPENAI_API_KEY = 'test-key';
  else delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = mock.url;
  resetEnvCache();
}

const request = (path: string, init: { method?: string; token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) =>
  new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: init.method ?? 'GET',
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

const params = () => ({ params: { botKey } });

async function newVisitor(hostOrigin = 'http://localhost:3000') {
  const res = await postSession(request(`/api/widget/${botKey}/session`, { method: 'POST', json: { hostOrigin, locale: 'de-DE' } }), params());
  expect(res.status).toBe(200);
  const { data } = await res.json();
  return data as { token: string; customer: { id: string }; conversation: unknown; messages: unknown[] };
}

async function readEvents(res: Response): Promise<WidgetEvent[]> {
  const events: WidgetEvent[] = [];
  const parse = createSseParser((e) => events.push(JSON.parse(e.data)));
  parse(await res.text());
  return events;
}

async function send(token: string, content: string, clientMessageId = `cmid-${Math.random().toString(36).slice(2, 12)}`, attachments: UploadReceipt[] = []) {
  const res = await postMessage(
    request(`/api/widget/${botKey}/messages`, { method: 'POST', token, json: { clientMessageId, content, attachments } }),
    params(),
  );
  return { res, clientMessageId };
}

async function setHours(alwaysOpen: boolean) {
  await prisma.businessHours.deleteMany({ where: { organizationId } });
  if (alwaysOpen) {
    await prisma.businessHours.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ organizationId, weekday, opensAt: '00:00', closesAt: '00:00' })),
    });
  }
  invalidateBotCache();
}

beforeAll(async () => {
  mock = await startMockOpenAI();
});
afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  invalidateBotCache();
  mock.setMode('ok', 'Our **Growth** plan costs €399 per month.');
  mock.requests.length = 0;
  useAi(true);
  const ws = await createWorkspace('Widget Co');
  organizationId = ws.organization.id;
  const bot = await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId } });
  botKey = bot.publicKey;
  await setHours(true);
});

describe('widget config & sessions', () => {
  it('serves public config without prompts or internal settings', async () => {
    const res = await getConfig(request(`/api/widget/${botKey}/config`), params());
    const { data } = await res.json();
    expect(data).toMatchObject({ botKey, agentName: 'Widget Co Assistant', team: { online: true } });
    const raw = JSON.stringify(data);
    expect(raw).not.toMatch(/systemInstructions|GLOBAL_POLICY|fallbackResponse|allowedOrigins|organizationId/);
  });

  it('returns 404 for unknown or disabled bots', async () => {
    const res = await getConfig(request('/api/widget/bot_doesnotexist000/config'), { params: { botKey: 'bot_doesnotexist000' } });
    expect(res.status).toBe(404);
    await prisma.botConfiguration.updateMany({ where: { organizationId }, data: { isActive: false } });
    invalidateBotCache();
    expect((await getConfig(request(`/api/widget/${botKey}/config`), params())).status).toBe(404);
  });

  it('creates an anonymous customer once and resumes it with the token', async () => {
    const first = await newVisitor();
    expect(first.token).toBeTruthy();
    const resolved = await requireBot(botKey);
    const again = await startSession(resolved, { token: first.token, hostOrigin: 'http://localhost:3000' });
    expect(again.customer.id).toBe(first.customer.id);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: first.customer.id }, include: { identities: true } });
    expect(customer).toMatchObject({ isAnonymous: true, language: 'de' });
    expect(customer.identities[0]).toMatchObject({ channel: 'WEBSITE' });
    expect(await prisma.conversation.count({ where: { organizationId } })).toBe(0); // created lazily
  });

  it('enforces the allowed-origins list', async () => {
    await prisma.botConfiguration.updateMany({ where: { organizationId }, data: { allowedOrigins: ['https://*.acme.test'] } });
    invalidateBotCache();
    const blocked = await postSession(request(`/api/widget/${botKey}/session`, { method: 'POST', json: { hostOrigin: 'https://evil.test' } }), params());
    expect(blocked.status).toBe(403);
    expect((await newVisitor('https://shop.acme.test')).token).toBeTruthy();
    expect((await newVisitor('http://localhost:3000')).token).toBeTruthy(); // the app itself
  });

  it('rejects missing, forged and cross-bot tokens', async () => {
    expect((await send('', 'hi')).res.status).toBe(401);
    expect((await send('forged.token', 'hi')).res.status).toBe(401);

    const visitor = await newVisitor();
    const other = await createWorkspace('Other Co');
    const otherBot = await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId: other.organization.id } });
    const res = await postMessage(
      request(`/api/widget/${otherBot.publicKey}/messages`, { method: 'POST', token: visitor.token, json: { clientMessageId: 'abcdefgh1', content: 'hi' } }),
      { params: { botKey: otherBot.publicKey } },
    );
    expect(res.status).toBe(401);
  });
});

describe('messaging pipeline', () => {
  it('stores the message, streams the AI reply token by token, and records usage', async () => {
    const visitor = await newVisitor();
    const delivered: WidgetEvent[] = [];
    const unsubscribe = subscribe(channels.visitor(visitor.customer.id), (e) => delivered.push(e as WidgetEvent));

    const { res } = await send(visitor.token, 'Was kostet der Growth-Plan?');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readEvents(res);
    unsubscribe();

    const types = events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(['message', 'assistant.start']);
    expect(types.at(-1)).toBe('assistant.done');
    const middle = types.slice(2, -1);
    expect(middle.length).toBeGreaterThan(1);
    expect(middle.every((t) => t === 'assistant.delta')).toBe(true);
    const deltas = events.filter((e) => e.type === 'assistant.delta').map((e) => (e as { text: string }).text).join('');
    expect(deltas).toBe('Our **Growth** plan costs €399 per month.');
    const done = events.at(-1) as Extract<WidgetEvent, { type: 'assistant.done' }>;
    expect(done.message).toMatchObject({ role: 'ai', content: deltas });

    // Provider received the layered prompt + the customer's message.
    const sent = mock.requests[0]!;
    expect(sent.stream).toBe(true);
    expect(sent.messages[0]!.role).toBe('system');
    expect(sent.messages[0]!.content).toContain('You are "Widget Co Assistant"');
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'Was kostet der Growth-Plan?' });

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { organizationId }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    expect(conversation.messages.map((m) => [m.senderType, m.status])).toEqual([
      ['CUSTOMER', 'READ'],
      ['AI', 'SENT'],
    ]);
    expect(conversation.firstResponseAt).not.toBeNull();
    expect(conversation.lastMessagePreview).toContain('Growth');
    const usage = await prisma.usageRecord.findFirstOrThrow({ where: { organizationId, kind: 'CHAT' } });
    expect(usage).toMatchObject({ kind: 'CHAT', promptTokens: 321, completionTokens: 12, model: 'gpt-4o-mini' });
    expect(Number(usage.costUsd)).toBeGreaterThan(0);

    // Other open tabs receive both messages over the realtime bus.
    expect(delivered.filter((e) => e.type === 'message').map((e) => (e as { message: { role: string } }).message.role)).toEqual(['customer', 'ai']);
  });

  it('is idempotent for retried client messages', async () => {
    const visitor = await newVisitor();
    const first = await send(visitor.token, 'Hello', 'retry-id-123');
    await readEvents(first.res);
    const retry = await send(visitor.token, 'Hello', 'retry-id-123');
    const events = await readEvents(retry.res);
    expect(events.map((e) => e.type)).toEqual(['message', 'assistant.done']);
    expect(await prisma.message.count({ where: { organizationId } })).toBe(2);
    expect(mock.requests).toHaveLength(1);
  });

  it('keeps the AI silent while a human handles the conversation', async () => {
    const visitor = await newVisitor();
    await readEvents((await send(visitor.token, 'Hi')).res);
    await prisma.conversation.updateMany({ where: { organizationId }, data: { status: 'HUMAN_ACTIVE' } });
    const events = await readEvents((await send(visitor.token, 'Are you there?')).res);
    expect(events.map((e) => e.type)).toEqual(['message']);
    expect(mock.requests).toHaveLength(1);
  });

  it('falls back gracefully when the AI provider fails', async () => {
    mock.setMode('error');
    const visitor = await newVisitor();
    const events = await readEvents((await send(visitor.token, 'Hi')).res);
    const done = events.at(-1) as Extract<WidgetEvent, { type: 'assistant.done' }>;
    expect(done.type).toBe('assistant.done');
    // Visitor locale is de-DE → the fallback and its action are in German.
    expect(done.message.content).toMatch(/^Entschuldigung/);
    expect(done.message.actions).toEqual([{ label: 'Mit einem Menschen sprechen', action: 'handoff' }]);
    expect(mock.requests).toHaveLength(2); // one retry
    expect(await prisma.usageRecord.count({ where: { organizationId } })).toBe(0);
    const ai = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'AI' } });
    expect(ai.metadata).toMatchObject({ fallback: true, errorCode: 'AI_PROVIDER_ERROR' });
  });

  it('falls back when no AI provider is configured', async () => {
    useAi(false);
    const visitor = await newVisitor();
    const events = await readEvents((await send(visitor.token, 'Hi')).res);
    expect(events.at(-1)).toMatchObject({ type: 'assistant.done', message: { role: 'ai' } });
    const ai = await prisma.message.findFirstOrThrow({ where: { organizationId, senderType: 'AI' } });
    expect(ai.metadata).toMatchObject({ errorCode: 'AI_NOT_CONFIGURED' });
  });

  it('validates message input', async () => {
    const visitor = await newVisitor();
    expect((await send(visitor.token, '   ')).res.status).toBe(422);
    expect((await send(visitor.token, 'x'.repeat(4001))).res.status).toBe(422);
    expect((await send(visitor.token, 'ok', 'bad id!')).res.status).toBe(422);
  });

  it('serves catch-up history after a given message', async () => {
    const visitor = await newVisitor();
    const events = await readEvents((await send(visitor.token, 'First')).res);
    const firstId = (events[0] as Extract<WidgetEvent, { type: 'message' }>).message.id;
    const res = await getMessages(request(`/api/widget/${botKey}/messages?after=${firstId}`, { token: visitor.token }), params());
    const { data } = await res.json();
    expect(data.messages.map((m: { role: string }) => m.role)).toEqual(['ai']);
  });
});

describe('human handoff & restart', () => {
  it('moves to WAITING_FOR_AGENT during business hours and stops the AI', async () => {
    const visitor = await newVisitor();
    const res = await postHandoff(request(`/api/widget/${botKey}/handoff`, { method: 'POST', token: visitor.token }), params());
    const { data } = await res.json();
    expect(data.conversation).toMatchObject({ status: 'WAITING_FOR_AGENT', handoffRequested: true });
    expect(data.message.role).toBe('system');

    const events = await readEvents((await send(visitor.token, 'Hello?')).res);
    expect(events.map((e) => e.type)).toEqual(['message']);
    expect(mock.requests).toHaveLength(0);
  });

  it('outside business hours: tells the visitor and keeps the AI helping', async () => {
    await setHours(false);
    const visitor = await newVisitor();
    await readEvents((await send(visitor.token, 'Hi')).res);
    const res = await postHandoff(request(`/api/widget/${botKey}/handoff`, { method: 'POST', token: visitor.token }), params());
    const { data } = await res.json();
    expect(data.conversation).toMatchObject({ status: 'AI_ACTIVE', handoffRequested: true });
    expect(data.message.content).toMatch(/nicht erreichbar/); // localized for the de-DE visitor
    const events = await readEvents((await send(visitor.token, 'my email is a@b.de')).res);
    expect(events.at(-1)?.type).toBe('assistant.done');
  });

  it('restart closes the conversation and the next message opens a new one', async () => {
    const visitor = await newVisitor();
    await readEvents((await send(visitor.token, 'One')).res);
    await postRestart(request(`/api/widget/${botKey}/conversation/restart`, { method: 'POST', token: visitor.token }), params());
    const closed = await prisma.conversation.findFirstOrThrow({ where: { organizationId } });
    expect(closed).toMatchObject({ status: 'CLOSED', aiResolved: true });
    await readEvents((await send(visitor.token, 'Two')).res);
    expect(await prisma.conversation.count({ where: { organizationId } })).toBe(2);
  });
});

describe('attachments', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  async function upload(token: string, bytes: Uint8Array, name: string) {
    const form = new FormData();
    form.append('file', new File([bytes], name));
    return postUpload(request(`/api/widget/${botKey}/uploads`, { method: 'POST', token, body: form }), params());
  }

  it('uploads, attaches and serves files through signed URLs', async () => {
    const visitor = await newVisitor();
    const res = await upload(visitor.token, PNG, 'screenshot.png');
    expect(res.status).toBe(201);
    const { data: receipt } = (await res.json()) as { data: UploadReceipt };
    expect(receipt).toMatchObject({ mimeType: 'image/png', fileName: 'screenshot.png', size: PNG.length });

    const events = await readEvents((await send(visitor.token, 'See attached', undefined, [receipt])).res);
    const stored = (events[0] as Extract<WidgetEvent, { type: 'message' }>).message;
    expect(stored.attachments).toHaveLength(1);

    const file = await getFile(new NextRequest(new URL(stored.attachments[0]!.url, 'http://localhost:3000')), { params: {} as never });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it('rejects disallowed file types and forged or foreign receipts', async () => {
    const visitor = await newVisitor();
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    expect((await upload(visitor.token, svg, 'logo.svg')).status).toBe(400);

    const { data: receipt } = (await (await upload(visitor.token, PNG, 'a.png')).json()) as { data: UploadReceipt };
    expect((await send(visitor.token, 'x', undefined, [{ ...receipt, size: 999 }])).res.status).toBe(400);

    const other = await newVisitor();
    expect((await send(other.token, 'stolen', undefined, [receipt])).res.status).toBe(400);
  });

  it('refuses uploads when disabled for the bot', async () => {
    await prisma.botConfiguration.updateMany({ where: { organizationId }, data: { allowAttachments: false } });
    invalidateBotCache();
    const visitor = await newVisitor();
    expect((await upload(visitor.token, PNG, 'a.png')).status).toBe(403);
  });
});
