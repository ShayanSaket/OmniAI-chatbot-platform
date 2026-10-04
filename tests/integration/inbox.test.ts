import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_FILTERS, type InboxFilters } from '@/lib/inbox';
import type { WidgetEvent } from '@/lib/widget-protocol';
import { flushBackgroundTasks } from '@/server/background';
import { invalidateBotCache } from '@/server/channels/website/widget-auth';
import type { ServiceContext } from '@/server/context';
import { encryptSecret } from '@/server/crypto';
import { resetEnvCache } from '@/server/env';
import { channels, subscribe } from '@/server/realtime/bus';
import { resetMemoryRateLimits } from '@/server/rate-limit';
import {
  addCustomerNote,
  assignConversation,
  closeConversation,
  deleteCustomerNote,
  getInboxConversation,
  listInboxConversations,
  markConversationRead,
  reopenConversation,
  retryMessage,
  returnConversationToAi,
  sendAgentReply,
  sendAgentTyping,
  takeOverConversation,
  uploadAgentFile,
} from '@/server/modules/inbox/inbox-service';
import { cleanSuggestion, suggestReply } from '@/server/modules/inbox/suggestions';
import { listSendableTemplates } from '@/server/modules/whatsapp/whatsapp-service';
import { addUser, contextFor, createConversation, createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockGraph, type MockGraph } from './mock-graph';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';
import { finalReply, widgetClient } from './widget-client';

let ai: MockOpenAI;
let graph: MockGraph;
let organizationId: string;
let botKey: string;
let owner: ServiceContext;
let admin: ServiceContext;
let agent: ServiceContext;
let agent2: ServiceContext;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
let cmid = 0;
const reply = (content: string, extra: Partial<{ attachments: never[]; clientMessageId: string }> = {}) => ({
  content,
  attachments: [],
  clientMessageId: `client-msg-${++cmid}`,
  ...extra,
});
const list = (ctx: ServiceContext, f: Partial<InboxFilters> = {}) => listInboxConversations(ctx, { ...DEFAULT_INBOX_FILTERS, ...f });

beforeAll(async () => {
  ai = await startMockOpenAI();
  graph = await startMockGraph();
});
afterAll(async () => {
  await ai.close();
  await graph.close();
});
afterEach(() => expect(ai.errors).toEqual([]));

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  invalidateBotCache();
  ai.reset();
  graph.reset();
  Object.assign(process.env, {
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: ai.url,
    WHATSAPP_ACCESS_TOKEN: 'wa-env-token',
    WHATSAPP_GRAPH_URL: graph.url,
  });
  resetEnvCache();
  const ws = await createWorkspace('Inbox Co');
  organizationId = ws.organization.id;
  owner = contextFor(organizationId, ws.owner.id, 'OWNER');
  admin = contextFor(organizationId, (await addUser(organizationId, 'ADMIN')).user.id, 'ADMIN');
  agent = contextFor(organizationId, (await addUser(organizationId, 'AGENT')).user.id, 'AGENT');
  agent2 = contextFor(organizationId, (await addUser(organizationId, 'AGENT')).user.id, 'AGENT');
  botKey = (await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId } })).publicKey;
  // Team always online.
  await prisma.businessHours.deleteMany({ where: { organizationId } });
  await prisma.businessHours.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ organizationId, weekday, opensAt: '00:00', closesAt: '00:00' })) });
});

/** A website visitor who has had one AI-answered exchange. */
async function websiteConversation(text = 'Hi, what do you offer?') {
  const client = widgetClient(botKey);
  const visitor = await client.visitor();
  finalReply(await client.send(visitor.token, text));
  await flushBackgroundTasks();
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { customerId: visitor.customer.id } });
  return { client, visitor, conversation };
}

function captureVisitor(customerId: string) {
  const events: WidgetEvent[] = [];
  const stop = subscribe(channels.visitor(customerId), (e) => events.push(e as WidgetEvent));
  return { events, stop };
}

describe('human takeover', () => {
  it('stops the AI, delivers agent replies to the widget and can hand back to the AI', async () => {
    const { client, visitor, conversation } = await websiteConversation();
    const aiCalls = ai.requests.length;
    const widget = captureVisitor(visitor.customer.id);

    const taken = await takeOverConversation(agent, conversation.id);
    expect(taken).toMatchObject({ status: 'HUMAN_ACTIVE', assignedTo: { id: agent.userId } });
    expect(taken.messages.at(-1)).toMatchObject({ senderType: 'SYSTEM', content: 'AGENT joined the conversation.' });
    // The open widget learns the new status and who joined.
    expect(widget.events.some((e) => e.type === 'conversation' && e.conversation.status === 'HUMAN_ACTIVE' && e.conversation.agentName === 'AGENT')).toBe(true);

    // The customer writes again: stored, unread, and the AI stays silent.
    const events = await client.send(visitor.token, 'Can a real person check my invoice?');
    expect(events.some((e) => e.type === 'assistant.done')).toBe(false);
    await flushBackgroundTasks();
    expect(ai.requests.length).toBe(aiCalls);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).unreadCount).toBeGreaterThan(0);

    const sent = await sendAgentReply(agent, conversation.id, reply('Sure — I am looking at it now.'));
    expect(sent).toMatchObject({ delivered: true, message: { senderType: 'AGENT', authorName: 'AGENT', status: 'SENT' } });
    expect(widget.events.some((e) => e.type === 'message' && e.message.role === 'agent' && e.message.content === 'Sure — I am looking at it now.' && e.message.authorName === 'AGENT')).toBe(true);
    // Replying marks everything above as read.
    const afterReply = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(afterReply.unreadCount).toBe(0);
    expect(afterReply.firstResponseAt).not.toBeNull();

    const back = await returnConversationToAi(agent, conversation.id);
    expect(back).toMatchObject({ status: 'AI_ACTIVE', handoffRequestedAt: null });
    expect(back.messages.at(-1)?.content).toMatch(/AI assistant again/);
    finalReply(await client.send(visitor.token, 'Thanks! One more question about pricing.'));
    expect(ai.requests.length).toBeGreaterThan(aiCalls);
    widget.stop();

    const audit = await prisma.auditLog.findMany({ where: { organizationId, entityId: conversation.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['conversation.taken_over', 'conversation.returned_to_ai']);
  });

  it('takes over automatically when an agent replies to an AI conversation, and is idempotent per client id', async () => {
    const { conversation } = await websiteConversation();
    const input = reply('Hello from the team');
    const first = await sendAgentReply(agent, conversation.id, input);
    const again = await sendAgentReply(agent, conversation.id, input);
    expect(again.duplicate).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, senderType: 'AGENT' } })).toBe(1);
    const detail = await getInboxConversation(agent, conversation.id);
    expect(detail).toMatchObject({ status: 'HUMAN_ACTIVE', assignedTo: { id: agent.userId } });
    // Join notice comes before the reply.
    expect(detail.messages.slice(-2).map((m) => m.senderType)).toEqual(['SYSTEM', 'AGENT']);
  });

  it('lets only one of two agents win a simultaneous takeover', async () => {
    const { conversation } = await websiteConversation();
    const results = await Promise.allSettled([takeOverConversation(agent, conversation.id), takeOverConversation(agent2, conversation.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
    expect(await prisma.message.count({ where: { conversationId: conversation.id, senderType: 'SYSTEM', metadata: { path: ['event'], equals: 'agent_joined' } } })).toBe(1);
  });

  it('protects a conversation another agent handles, while admins can take it over', async () => {
    const { conversation } = await websiteConversation();
    await takeOverConversation(agent, conversation.id);
    await expect(takeOverConversation(agent2, conversation.id)).rejects.toMatchObject({ code: 'CONFLICT', message: 'AGENT is already handling this conversation.' });
    await expect(returnConversationToAi(agent2, conversation.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // A colleague may still answer without taking ownership.
    await sendAgentReply(agent2, conversation.id, reply('Jumping in to help'));
    expect((await getInboxConversation(agent2, conversation.id)).assignedTo?.id).toBe(agent.userId);
    expect(await takeOverConversation(admin, conversation.id)).toMatchObject({ assignedTo: { id: admin.userId } });
  });

  it('notifies the team when a customer asks for a person', async () => {
    const client = widgetClient(botKey);
    const visitor = await client.visitor();
    ai.respondJson(() => ({ intent: 'SUPPORT', sentiment: 'neutral', leadTemperature: null, escalation: 'none', wantsHuman: true, language: 'en', confidence: 0.95 }));
    await client.send(visitor.token, 'I want to talk to a human please');
    await flushBackgroundTasks();
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { customerId: visitor.customer.id } });
    expect(conversation.status).toBe('WAITING_FOR_AGENT');
    const notes = await prisma.notification.findMany({ where: { organizationId } });
    expect(notes).toHaveLength(4); // owner, admin, two agents
    expect(notes[0]).toMatchObject({ title: expect.stringMatching(/is waiting for a team member$/), link: `/inbox?conversation=${conversation.id}` });
    expect((await list(agent, { mode: 'waiting' })).items.map((i) => i.id)).toEqual([conversation.id]);
  });
});

describe('inbox list', () => {
  it('filters by channel, AI/human, unread, assignee, status and search, with counts', async () => {
    const web = await websiteConversation('Hello there');
    const wa = await createConversation(organizationId, { channel: 'WHATSAPP' });
    await prisma.customer.update({ where: { id: wa.customerId }, data: { name: 'Kim Weber', phone: '+4915111' } });
    await prisma.conversation.update({ where: { id: wa.id }, data: { status: 'WAITING_FOR_AGENT', unreadCount: 2, lastMessagePreview: 'Where is my parcel?' } });
    const closed = await createConversation(organizationId);
    await prisma.conversation.update({ where: { id: closed.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await assignConversation(agent, web.conversation.id, agent.userId);

    const ids = async (f: Partial<InboxFilters>, ctx = agent) => (await list(ctx, f)).items.map((i) => i.id).sort();
    expect(await ids({})).toEqual([web.conversation.id, wa.id].sort());
    expect(await ids({ channel: 'WHATSAPP' })).toEqual([wa.id]);
    expect(await ids({ channel: 'WEBSITE' })).toEqual([web.conversation.id]);
    expect(await ids({ mode: 'ai' })).toEqual([web.conversation.id]);
    expect(await ids({ mode: 'human' })).toEqual([wa.id]);
    expect(await ids({ unread: true })).toEqual([wa.id, web.conversation.id].sort());
    await markConversationRead(agent, web.conversation.id);
    expect(await ids({ unread: true })).toEqual([wa.id]);
    expect(await ids({ assignee: 'me' })).toEqual([web.conversation.id]);
    expect(await ids({ assignee: 'me' }, agent2)).toEqual([]);
    expect(await ids({ assignee: 'unassigned' })).toEqual([wa.id]);
    expect(await ids({ status: 'closed' })).toEqual([closed.id]);
    expect(await ids({ status: 'all' })).toHaveLength(3);
    expect(await ids({ q: 'kim' })).toEqual([wa.id]);
    expect(await ids({ q: 'PARCEL' })).toEqual([wa.id]);

    const result = await list(agent);
    expect(result.counts).toEqual({ open: 2, waiting: 1, mine: 1, unread: 1 });
    const item = result.items.find((i) => i.id === wa.id)!;
    expect(item).toMatchObject({ channel: 'WHATSAPP', status: 'WAITING_FOR_AGENT', unreadCount: 2, customer: { name: 'Kim Weber' }, assignedTo: null });
  });

  it('pages through conversations with a stable cursor', async () => {
    const base = Date.now();
    for (let i = 0; i < 33; i++) {
      const c = await createConversation(organizationId);
      // Two share a timestamp to exercise the id tie-breaker.
      await prisma.conversation.update({ where: { id: c.id }, data: { lastMessageAt: new Date(base - Math.min(i, 31) * 1000) } });
    }
    const first = await list(agent);
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(agent, { cursor: first.nextCursor! } as Partial<InboxFilters>);
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(second.counts).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(33);
  });

  it('marks conversations read and never shows other workspaces', async () => {
    const { conversation } = await websiteConversation();
    expect(conversation.unreadCount).toBe(1);
    await markConversationRead(agent, conversation.id);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).unreadCount).toBe(0);
    expect(await prisma.message.findMany({ where: { conversationId: conversation.id, senderType: 'CUSTOMER' }, select: { status: true } })).toEqual([{ status: 'READ' }]);

    const other = await createWorkspace('Other Co');
    const stranger = contextFor(other.organization.id, other.owner.id, 'OWNER');
    expect((await list(stranger)).items).toEqual([]);
    await expect(getInboxConversation(stranger, conversation.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(takeOverConversation(stranger, conversation.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sendAgentReply(stranger, conversation.id, reply('hi'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('shows the customer profile, summary, records and notes next to the thread', async () => {
    const { conversation, visitor } = await websiteConversation();
    await prisma.customer.update({ where: { id: visitor.customer.id }, data: { name: 'Anna Berg', email: 'anna@example.com', memory: { productInterests: ['WhatsApp integration'], preferences: [], facts: ['Real-estate agency'] } } });
    await prisma.lead.create({ data: { organizationId, customerId: visitor.customer.id, conversationId: conversation.id, requestedService: 'Demo' } });
    await prisma.ticket.create({ data: { organizationId, customerId: visitor.customer.id, subject: 'Invoice question' } });
    await prisma.conversationSummary.create({ data: { organizationId, conversationId: conversation.id, summary: 'Anna asked about plans.', messageCount: 2 } });
    const note = await addCustomerNote(agent, visitor.customer.id, 'Prefers calls after 4pm');

    const detail = await getInboxConversation(agent, conversation.id);
    expect(detail.customer).toMatchObject({ name: 'Anna Berg', email: 'anna@example.com', facts: ['Interested in WhatsApp integration', 'Real-estate agency'] });
    expect(detail.summary?.text).toBe('Anna asked about plans.');
    expect(detail.leads).toMatchObject([{ requestedService: 'Demo', status: 'NEW' }]);
    expect(detail.tickets).toMatchObject([{ subject: 'Invoice question', reference: expect.stringMatching(/^T-/) }]);
    expect(detail.notes).toMatchObject([{ content: 'Prefers calls after 4pm', authorName: 'AGENT', authorId: agent.userId }]);
    expect(detail.window).toBeNull();
    expect(detail.messages.map((m) => m.senderType)).toEqual(['CUSTOMER', 'AI']);

    // Notes stay internal: the widget's message history never contains them.
    const widgetHistory = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(JSON.stringify(widgetHistory)).not.toContain('Prefers calls');

    await expect(deleteCustomerNote(agent2, visitor.customer.id, note.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await deleteCustomerNote(admin, visitor.customer.id, note.id);
    expect(await prisma.customerNote.count()).toBe(0);
  });
});

describe('assignment, closing and reopening', () => {
  it('lets agents assign only themselves and notifies assignees', async () => {
    const { conversation } = await websiteConversation();
    await expect(assignConversation(agent, conversation.id, agent2.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await assignConversation(agent, conversation.id, agent.userId);
    await expect(assignConversation(agent2, conversation.id, null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await assignConversation(agent, conversation.id, null);

    const assigned = await assignConversation(admin, conversation.id, agent2.userId);
    expect(assigned.assignedTo?.id).toBe(agent2.userId);
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: agent2.userId } });
    expect(notification).toMatchObject({ title: 'Conversation assigned to you', link: `/inbox?conversation=${conversation.id}` });
    const history = await prisma.conversationAssignment.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => [h.assigneeId, h.endedAt === null])).toEqual([
      [agent.userId, false],
      [agent2.userId, true],
    ]);

    const outsider = await createWorkspace('Elsewhere');
    await expect(assignConversation(admin, conversation.id, outsider.owner.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('closes with a notice to the visitor, emits the event, and reopens only without another open conversation', async () => {
    const { client, visitor, conversation } = await websiteConversation();
    await takeOverConversation(agent, conversation.id);
    await sendAgentReply(agent, conversation.id, reply('All sorted!'));
    const closed = await closeConversation(agent, conversation.id);
    expect(closed).toMatchObject({ status: 'CLOSED' });
    expect(closed.messages.at(-1)?.content).toMatch(/was closed/);
    await flushBackgroundTasks();
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row).toMatchObject({ aiResolved: false, unreadCount: 0 });
    expect(row.closedAt).not.toBeNull();
    await expect(sendAgentReply(agent, conversation.id, reply('one more thing'))).rejects.toMatchObject({ code: 'CONFLICT' });

    const reopened = await reopenConversation(agent2, conversation.id);
    expect(reopened).toMatchObject({ status: 'HUMAN_ACTIVE', assignedTo: { id: agent2.userId }, closedAt: null });
    await closeConversation(agent2, conversation.id);

    // The visitor starts a new conversation; the old one can no longer be reopened.
    finalReply(await client.send(visitor.token, 'Hello again'));
    await expect(reopenConversation(agent, conversation.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('records AI-resolved conversations when closed without a human', async () => {
    const { conversation } = await websiteConversation();
    await closeConversation(owner, conversation.id);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).aiResolved).toBe(true);
  });
});

describe('attachments and typing', () => {
  it('sends uploaded files and rejects receipts issued for another customer', async () => {
    const { conversation, visitor } = await websiteConversation();
    const receipt = await uploadAgentFile(agent, conversation.id, new File([PNG], 'Screen shot.png', { type: 'image/png' }));
    expect(receipt).toMatchObject({ fileName: 'Screen-shot.png', mimeType: 'image/png' });
    const sent = await sendAgentReply(agent, conversation.id, { ...reply(''), attachments: [receipt] as never[] });
    expect(sent.message).toMatchObject({ messageType: 'IMAGE', attachments: [{ fileName: 'Screen-shot.png', mimeType: 'image/png' }] });

    const other = await websiteConversation('Another visitor');
    await expect(sendAgentReply(agent, other.conversation.id, { ...reply('x'), attachments: [receipt] as never[] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(uploadAgentFile(agent, conversation.id, new File(['MZ fake exe'], 'virus.png', { type: 'image/png' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const widget = captureVisitor(visitor.customer.id);
    expect(await sendAgentTyping(agent, conversation.id)).toEqual({ sent: true });
    expect(widget.events).toEqual([{ type: 'typing', name: 'AGENT' }]);
    widget.stop();
  });
});

describe('WhatsApp conversations', () => {
  async function whatsappConversation(lastCustomerMessageAt: Date) {
    const channel = await prisma.channel.create({ data: { organizationId, type: 'WHATSAPP', name: 'WhatsApp' } });
    await prisma.whatsAppAccount.create({ data: { organizationId, channelId: channel.id, phoneNumberId: '1000000009', businessAccountId: '2000000009', accessTokenEncrypted: encryptSecret('wa-env-token') } });
    const customer = await prisma.customer.create({ data: { organizationId, name: 'Kim Weber', phone: '+4915123456789' } });
    await prisma.customerIdentity.create({ data: { organizationId, customerId: customer.id, channel: 'WHATSAPP', externalId: '4915123456789' } });
    return prisma.conversation.create({
      data: { organizationId, customerId: customer.id, channelId: channel.id, channel: 'WHATSAPP', status: 'WAITING_FOR_AGENT', lastCustomerMessageAt },
    });
  }

  it('replies on WhatsApp inside the 24-hour window, with a join notice first', async () => {
    const conversation = await whatsappConversation(new Date(Date.now() - 60_000));
    const sent = await sendAgentReply(agent, conversation.id, reply('Hi Kim, **your order** ships today.'));
    expect(sent).toMatchObject({ delivered: true, message: { status: 'SENT', senderType: 'AGENT' } });
    const bodies = graph.sends().map((s) => (s.text as { body: string } | undefined)?.body);
    expect(bodies).toEqual(['AGENT joined the conversation.', 'Hi Kim, *your order* ships today.']);
    expect((await getInboxConversation(agent, conversation.id)).window).toMatchObject({ open: true });
  });

  it('refuses free-form replies after the window closes and lists sendable templates', async () => {
    const conversation = await whatsappConversation(new Date(Date.now() - 25 * 3_600_000));
    await expect(sendAgentReply(agent, conversation.id, reply('Are you still there?'))).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'whatsapp_window_closed' } });
    // Taking over sends no notice outside the window (only templates are allowed).
    await takeOverConversation(agent, conversation.id);
    expect(graph.sends()).toEqual([]);
    expect((await getInboxConversation(agent, conversation.id)).window).toMatchObject({ open: false });

    await prisma.whatsAppTemplate.createMany({
      data: [
        { organizationId, name: 'order_update', language: 'en', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} shipped.' }] },
        { organizationId, name: 'promo_image', language: 'en', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Sale!' }] },
        { organizationId, name: 'pending_one', language: 'en', category: 'UTILITY', status: 'PENDING', components: [{ type: 'BODY', text: 'x' }] },
      ],
    });
    expect(await listSendableTemplates(agent)).toMatchObject([{ name: 'order_update', variables: 2 }]);
  });

  it('retries a failed WhatsApp reply on request', async () => {
    const conversation = await whatsappConversation(new Date(Date.now() - 60_000));
    await takeOverConversation(agent, conversation.id);
    graph.failSends(1, 400, 131026); // permanent: undeliverable
    const failed = await sendAgentReply(agent, conversation.id, reply('Your refund is on its way'));
    expect(failed.delivered).toBe(false);
    expect(failed.message).toMatchObject({ status: 'FAILED', error: expect.any(String) });
    const retried = await retryMessage(agent, conversation.id, failed.message.id);
    expect(retried).toMatchObject({ delivered: true, message: { status: 'SENT' } });
    await expect(retryMessage(agent, conversation.id, retried.message.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('AI reply suggestions', () => {
  it('drafts a reply from the conversation and customer context without sending anything', async () => {
    const { conversation, visitor } = await websiteConversation('Do you integrate with WhatsApp? We get 200 inquiries a month.');
    await prisma.customer.update({ where: { id: visitor.customer.id }, data: { name: 'Anna Berg', language: 'de' } });
    await prisma.product.create({ data: { organizationId, name: 'Growth plan', price: 99, currency: 'EUR', priceNote: 'per month' } });
    const messagesBefore = await prisma.message.count({ where: { conversationId: conversation.id } });
    ai.respond((req) => (req.messages[0]?.content?.includes('You draft replies') ? { text: 'Reply: "Hallo Anna, ja – das geht mit unserem Growth plan."' } : undefined));

    const result = await suggestReply(agent, conversation.id, { action: 'generate', draft: '' });
    expect(result.text).toBe('Hallo Anna, ja – das geht mit unserem Growth plan.');
    const request = ai.requests.at(-1)!;
    expect(request.messages[0]!.content).toContain('Write in German');
    expect(request.messages[0]!.content).toContain('named AGENT');
    expect(request.messages[1]!.content).toContain('Growth plan: 99 EUR (per month)');
    expect(request.messages[1]!.content).toContain('Customer: Do you integrate with WhatsApp?');
    expect(request.messages[1]!.content).toContain('Name: Anna Berg');

    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(messagesBefore);
    expect(await prisma.usageRecord.count({ where: { organizationId, kind: 'SUGGESTION' } })).toBe(1);
  });

  it('rewrites and translates drafts, and explains a missing AI provider', async () => {
    const { conversation } = await websiteConversation();
    ai.respond((req) => {
      const system = req.messages[0]?.content ?? '';
      if (system.includes('Translate')) return { text: system.includes('Spanish') ? 'Hola, ¿cómo puedo ayudarte?' : 'wrong language' };
      if (system.includes('shorter')) return { text: 'Short version.' };
      return undefined;
    });
    expect(await suggestReply(agent, conversation.id, { action: 'shorten', draft: 'A long rambling message that goes on.' })).toEqual({ text: 'Short version.' });
    expect(await suggestReply(agent, conversation.id, { action: 'translate', draft: 'Hello, how can I help?', language: 'es' })).toEqual({ text: 'Hola, ¿cómo puedo ayudarte?' });

    process.env.OPENAI_API_KEY = '';
    resetEnvCache();
    await expect(suggestReply(agent, conversation.id, { action: 'shorten', draft: 'Hi' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/AI provider/) });
  });

  it('cleans common wrappers from model output', () => {
    expect(cleanSuggestion('“Sure, happy to help.”')).toBe('Sure, happy to help.');
    expect(cleanSuggestion("Here's a suggested reply: Thanks for waiting!")).toBe('Thanks for waiting!');
    expect(cleanSuggestion('Keep "quotes" inside')).toBe('Keep "quotes" inside');
  });
});
