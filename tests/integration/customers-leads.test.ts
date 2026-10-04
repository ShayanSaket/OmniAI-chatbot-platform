import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CUSTOMER_FILTERS, type CustomerFilters } from '@/lib/customers';
import { DEFAULT_LEAD_FILTERS, type LeadFilters } from '@/lib/leads';
import { POST as postSession } from '@/app/api/widget/[botKey]/session/route';
import { flushBackgroundTasks } from '@/server/background';
import { invalidateBotCache } from '@/server/channels/website/widget-auth';
import type { ServiceContext } from '@/server/context';
import { resetEnvCache } from '@/server/env';
import { registerEventConsumer, type DomainEvent } from '@/server/events/domain-events';
import { resetMemoryRateLimits } from '@/server/rate-limit';
import { getObject } from '@/server/storage/s3';
import {
  deleteConversation,
  deleteCustomer,
  deleteTag,
  exportCustomer,
  getCustomerProfile,
  listCustomers,
  listTags,
  mergeCustomers,
  setCustomerTags,
  updateAppointment,
  updateCustomer,
  updateTicket,
} from '@/server/modules/customers/customer-service';
import { addCustomerNote, sendAgentReply, uploadAgentFile } from '@/server/modules/inbox/inbox-service';
import { createLead, csvCell, deleteLead, exportLeadsCsv, getLead, leadBoard, leadStats, listLeads, updateLead } from '@/server/modules/leads/lead-service';
import { addUser, contextFor, createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';
import { finalReply, widgetClient, widgetRequest } from './widget-client';

let ai: MockOpenAI;
let organizationId: string;
let botKey: string;
let owner: ServiceContext;
let admin: ServiceContext;
let agent: ServiceContext;
const events: DomainEvent[] = [];
registerEventConsumer('test-capture', async (e) => {
  events.push(e);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const customers = (ctx: ServiceContext, f: Partial<CustomerFilters> = {}) => listCustomers(ctx, { ...DEFAULT_CUSTOMER_FILTERS, ...f });
const leads = (ctx: ServiceContext, f: Partial<LeadFilters> = {}) => listLeads(ctx, { ...DEFAULT_LEAD_FILTERS, ...f });

beforeAll(async () => {
  ai = await startMockOpenAI();
});
afterAll(() => ai.close());
afterEach(() => expect(ai.errors).toEqual([]));

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  invalidateBotCache();
  ai.reset();
  events.length = 0;
  Object.assign(process.env, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: ai.url });
  resetEnvCache();
  const ws = await createWorkspace('CRM Co');
  organizationId = ws.organization.id;
  owner = contextFor(organizationId, ws.owner.id, 'OWNER');
  admin = contextFor(organizationId, (await addUser(organizationId, 'ADMIN')).user.id, 'ADMIN');
  agent = contextFor(organizationId, (await addUser(organizationId, 'AGENT')).user.id, 'AGENT');
  botKey = (await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId } })).publicKey;
});

/** A website visitor who chatted once (anonymous customer with a conversation). */
async function visitorWithChat(text = 'Hello!') {
  const client = widgetClient(botKey);
  const visitor = await client.visitor();
  finalReply(await client.send(visitor.token, text));
  await flushBackgroundTasks();
  return { client, visitor, customerId: visitor.customer.id };
}

async function identified(data: { name?: string; email?: string; phone?: string; company?: string }, channel?: 'WHATSAPP') {
  return prisma.customer.create({
    data: {
      organizationId,
      isAnonymous: false,
      ...data,
      ...(channel ? { identities: { create: { organizationId, channel, externalId: (data.phone ?? '').replace(/\D/g, '') } } } : {}),
    },
  });
}

describe('customer list and profile', () => {
  it('filters, searches, sorts and counts, without merged tombstones', async () => {
    const web = await visitorWithChat();
    const anna = await identified({ name: 'Anna Berg', email: 'anna@example.com', company: 'Berg GmbH' });
    const kim = await identified({ name: 'Kim Weber', phone: '+49 151 2345678' }, 'WHATSAPP');
    await prisma.lead.create({ data: { organizationId, customerId: anna.id, status: 'NEW' } });
    await prisma.lead.create({ data: { organizationId, customerId: anna.id, status: 'WON' } });
    await prisma.customer.create({ data: { organizationId, name: 'Old Anna', mergedIntoId: anna.id } });
    await setCustomerTags(admin, anna.id, ['VIP']);

    const all = await customers(agent);
    expect(all.total).toBe(3);
    expect(all.items.find((c) => c.id === anna.id)).toMatchObject({ openLeadCount: 1, tags: [{ name: 'VIP' }], isAnonymous: false });
    expect(all.items.find((c) => c.id === web.customerId)).toMatchObject({ channels: ['WEBSITE'], conversationCount: 1, isAnonymous: true });
    expect((await customers(agent, { type: 'anonymous' })).items.map((c) => c.id)).toEqual([web.customerId]);
    expect((await customers(agent, { channel: 'WHATSAPP' })).items.map((c) => c.id)).toEqual([kim.id]);
    expect((await customers(agent, { q: 'berg gmbh' })).items.map((c) => c.id)).toEqual([anna.id]);
    const vip = (await listTags(agent)).find((t) => t.name === 'VIP')!;
    expect((await customers(agent, { tag: vip.id })).items.map((c) => c.id)).toEqual([anna.id]);
    expect((await customers(agent, { sort: 'name' })).items.map((c) => c.name)).toEqual(['Anna Berg', 'Kim Weber', null]);
  });

  it('shows history and flags possible duplicates by email or phone, in any format', async () => {
    const { customerId } = await visitorWithChat();
    await prisma.customer.update({ where: { id: customerId }, data: { email: 'Kim@Example.com', phone: '0049 151 2345678', isAnonymous: false } });
    const kim = await identified({ name: 'Kim Weber', email: 'kim@example.com', phone: '+49 (151) 234-5678' }, 'WHATSAPP');
    await identified({ name: 'Someone else', email: 'other@example.com' });

    const profile = await getCustomerProfile(agent, customerId);
    expect(profile.duplicates).toEqual([expect.objectContaining({ id: kim.id, matchedOn: ['email', 'phone'] })]);
    expect(profile.identities).toEqual([expect.objectContaining({ channel: 'WEBSITE', label: 'Visitor on localhost:3000' })]);
    expect(profile.conversations).toEqual([expect.objectContaining({ channel: 'WEBSITE', messageCount: 2, status: 'AI_ACTIVE' })]);
    expect((await getCustomerProfile(agent, kim.id)).identities[0]).toMatchObject({ channel: 'WHATSAPP', label: '+491512345678' });

    const other = await createWorkspace('Other Co');
    await expect(getCustomerProfile(contextFor(other.organization.id, other.owner.id, 'OWNER'), customerId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets admins edit details and custom fields, logging only field names', async () => {
    const { customerId } = await visitorWithChat();
    await expect(updateCustomer(agent, customerId, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const updated = await updateCustomer(admin, customerId, { name: 'Lea Kraus', email: 'lea@example.com', language: 'de', customFields: { 'Customer no.': 'C-1042', Plan: 'Growth' } });
    expect(updated).toMatchObject({ name: 'Lea Kraus', email: 'lea@example.com', language: 'de', isAnonymous: false, customFields: { 'Customer no.': 'C-1042', Plan: 'Growth' } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'customer.updated' } });
    expect(audit.metadata).toEqual({ fields: ['name', 'email', 'language', 'customFields'] });
    expect(JSON.stringify(audit)).not.toContain('lea@example.com');
  });

  it('manages tags case-insensitively', async () => {
    const a = await identified({ name: 'A', email: 'a@x.de' });
    const b = await identified({ name: 'B', email: 'b@x.de' });
    await setCustomerTags(admin, a.id, ['VIP', 'Reseller']);
    const profile = await setCustomerTags(admin, b.id, ['vip']);
    expect(profile.tags.map((t) => t.name)).toEqual(['VIP']);
    expect(await prisma.tag.count({ where: { organizationId } })).toBe(2);
    expect((await setCustomerTags(admin, a.id, ['Reseller'])).tags.map((t) => t.name)).toEqual(['Reseller']);
    const vip = (await listTags(agent)).find((t) => t.name === 'VIP')!;
    expect(vip.customerCount).toBe(1);
    await expect(setCustomerTags(agent, a.id, ['x'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await deleteTag(admin, vip.id);
    expect((await getCustomerProfile(agent, b.id)).tags).toEqual([]);
  });

  it('updates ticket and appointment status', async () => {
    const c = await identified({ name: 'T', email: 't@x.de' });
    const ticket = await prisma.ticket.create({ data: { organizationId, customerId: c.id, subject: 'Broken widget' } });
    const appt = await prisma.appointment.create({ data: { organizationId, customerId: c.id, topic: 'Demo', preferredTime: 'Tuesday morning' } });
    expect(await updateTicket(admin, ticket.id, { status: 'RESOLVED' })).toMatchObject({ status: 'RESOLVED' });
    expect(await updateAppointment(admin, appt.id, { status: 'CONFIRMED', startsAt: '2026-10-06T09:00:00.000Z' })).toMatchObject({ status: 'CONFIRMED', startsAt: '2026-10-06T09:00:00.000Z' });
    await expect(updateTicket(agent, ticket.id, { status: 'CLOSED' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('merging profiles', () => {
  it('moves history to the kept profile and the visitor session follows', async () => {
    const { client, visitor, customerId: sourceId } = await visitorWithChat('Hi, it is Kim again');
    await prisma.customer.update({ where: { id: sourceId }, data: { email: 'kim@example.com', company: 'Weber AG', memory: { productInterests: ['Growth plan'], preferences: [], facts: [] }, customFields: { Source: 'web' } } });
    await addCustomerNote(agent, sourceId, 'Called about pricing');
    await setCustomerTags(admin, sourceId, ['Prospect']);
    const target = await identified({ name: 'Kim Weber', phone: '+491512345678' }, 'WHATSAPP');
    await prisma.customer.update({ where: { id: target.id }, data: { customFields: { Source: 'whatsapp' }, memory: { productInterests: [], preferences: ['Prefers WhatsApp'], facts: [] } } });
    const earlier = await prisma.customer.create({ data: { organizationId, mergedIntoId: sourceId } });

    await expect(mergeCustomers(agent, target.id, sourceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const merged = await mergeCustomers(admin, target.id, sourceId);
    expect(merged).toMatchObject({
      name: 'Kim Weber',
      email: 'kim@example.com',
      company: 'Weber AG',
      phone: '+491512345678',
      customFields: { Source: 'whatsapp' },
      memory: { productInterests: ['Growth plan'], preferences: ['Prefers WhatsApp'] },
      tags: [{ name: 'Prospect' }],
    });
    expect(merged.channels.sort()).toEqual(['WEBSITE', 'WHATSAPP']);
    expect(merged.conversations).toHaveLength(1);
    expect(merged.notes.map((n) => n.content)).toEqual(['Called about pricing']);

    const tombstone = await prisma.customer.findUniqueOrThrow({ where: { id: sourceId } });
    expect(tombstone).toMatchObject({ mergedIntoId: target.id, name: null, email: null, phone: null, company: null });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: earlier.id } })).mergedIntoId).toBe(target.id);
    await expect(getCustomerProfile(agent, sourceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The open widget keeps working and writes to the merged profile.
    finalReply(await client.send(visitor.token, 'Still there?'));
    await flushBackgroundTasks();
    expect(await prisma.message.count({ where: { conversation: { customerId: sourceId } } })).toBe(0);
    expect(await prisma.message.count({ where: { conversation: { customerId: target.id }, senderType: 'CUSTOMER' } })).toBe(2);
    const res = await postSession(widgetRequest(`/api/widget/${botKey}/session`, { method: 'POST', json: { hostOrigin: 'http://localhost:3000', token: visitor.token } }), { params: { botKey } });
    const session = (await res.json()).data as { token: string; customer: { id: string } };
    expect(session.customer.id).toBe(target.id);
    expect(session.token).not.toBe(visitor.token);
    expect(await prisma.auditLog.count({ where: { action: 'customer.merged', entityId: target.id } })).toBe(1);
  });

  it('keeps one open conversation per channel after a merge', async () => {
    const a = await visitorWithChat('first');
    const b = await visitorWithChat('second');
    await mergeCustomers(admin, a.customerId, b.customerId);
    const open = await prisma.conversation.findMany({ where: { customerId: a.customerId, status: { not: 'CLOSED' } } });
    expect(open).toHaveLength(1);
    expect(await prisma.conversation.count({ where: { customerId: a.customerId } })).toBe(2);
    await expect(mergeCustomers(admin, a.customerId, a.customerId)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('GDPR export and erasure', () => {
  it('exports everything stored about a customer', async () => {
    const { customerId } = await visitorWithChat('My order 123 is late');
    await prisma.lead.create({ data: { organizationId, customerId, requestedService: 'Demo', email: 'x@y.de' } });
    await addCustomerNote(agent, customerId, 'Follow up Monday');
    await expect(exportCustomer(agent, customerId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const data = await exportCustomer(admin, customerId);
    expect(data.format).toBe('omniai.customer-export.v1');
    expect(data.conversations[0]!.messages.map((m) => m.from)).toEqual(['customer', 'ai']);
    expect(data.conversations[0]!.messages[0]!.content).toBe('My order 123 is late');
    expect(data.leads[0]).toMatchObject({ requestedService: 'Demo', reference: expect.stringMatching(/^L-/) });
    expect(data.notes[0]).toMatchObject({ content: 'Follow up Monday' });
    expect(JSON.stringify(data)).not.toContain('organizationId');
    expect(await prisma.auditLog.count({ where: { action: 'customer.exported' } })).toBe(1);
  });

  it('erases the customer, linked records and files; usage stats survive without links', async () => {
    const { customerId } = await visitorWithChat();
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { customerId } });
    const receipt = await uploadAgentFile(agent, conversation.id, new File([PNG], 'invoice.png'));
    await sendAgentReply(agent, conversation.id, { content: '', attachments: [receipt], clientMessageId: 'erase-test-1' });
    await prisma.lead.create({ data: { organizationId, customerId, conversationId: conversation.id, email: 'gone@example.com' } });
    await prisma.ticket.create({ data: { organizationId, customerId, subject: 'Help' } });
    const tombstone = await prisma.customer.create({ data: { organizationId, mergedIntoId: customerId } });
    const usage = await prisma.usageRecord.count({ where: { organizationId } });
    expect(usage).toBeGreaterThan(0);

    await expect(deleteCustomer(agent, customerId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const result = await deleteCustomer(admin, customerId);
    expect(result).toMatchObject({ deleted: true, conversations: 1, leads: 1, tickets: 1, files: 1 });
    for (const id of [customerId, tombstone.id]) expect(await prisma.customer.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.message.count({ where: { organizationId } })).toBe(0);
    expect(await prisma.lead.count({ where: { organizationId } })).toBe(0);
    expect(await prisma.ticket.count({ where: { organizationId } })).toBe(0);
    await expect(getObject(receipt.key)).rejects.toBeTruthy();
    expect(await prisma.usageRecord.count({ where: { organizationId, conversationId: null } })).toBe(usage);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'customer.deleted' } });
    expect(audit.metadata).toMatchObject({ conversations: 1, leads: 1, tickets: 1, files: 1, mergedProfiles: 1 });
  });

  it('deletes a single conversation and keeps the lead', async () => {
    const { customerId } = await visitorWithChat();
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { customerId } });
    const lead = await prisma.lead.create({ data: { organizationId, customerId, conversationId: conversation.id } });
    await expect(deleteConversation(agent, conversation.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await deleteConversation(admin, conversation.id)).toMatchObject({ deleted: true, messages: 2 });
    expect(await prisma.conversation.count({ where: { id: conversation.id } })).toBe(0);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ conversationId: null, customerId });
  });
});

describe('lead management', () => {
  it('creates leads by hand, linked to an existing or a new customer', async () => {
    const anna = await identified({ name: 'Anna Berg', email: 'anna@example.com' });
    await expect(createLead(agent, { name: 'X', email: 'x@y.de' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const linked = await createLead(admin, { name: 'Anna', email: 'ANNA@example.com', requestedService: 'Onboarding', estimatedValue: 1200, assignedToId: owner.userId });
    expect(linked).toMatchObject({ customerId: anna.id, status: 'NEW', source: null, estimatedValue: 1200, assignedTo: { id: owner.userId } });
    const fresh = await createLead(admin, { company: 'Nordwind GmbH', phone: '+49 40 123456' });
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: fresh.customerId! } });
    expect(customer).toMatchObject({ company: 'Nordwind GmbH', phone: '+49 40 123456', isAnonymous: false });
    expect(await prisma.notification.findFirst({ where: { userId: owner.userId, title: 'Lead assigned to you' } })).not.toBeNull();
    await flushBackgroundTasks();
    expect(events.filter((e) => e.type === 'lead.created')).toHaveLength(2);
    await expect(createLead(admin, { name: 'No contact' })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('moves leads through the pipeline with closing dates, activity and events', async () => {
    const lead = await createLead(admin, { name: 'Jonas', email: 'jonas@example.com', estimatedValue: 500 });
    await updateLead(admin, lead.id, { status: 'QUALIFIED' });
    const lost = await updateLead(admin, lead.id, { status: 'LOST', lostReason: 'Chose a competitor' });
    expect(lost).toMatchObject({ status: 'LOST', lostReason: 'Chose a competitor' });
    expect(lost.closedAt).not.toBeNull();
    const reopened = await updateLead(admin, lead.id, { status: 'PROPOSAL', assignedToId: agent.userId });
    expect(reopened).toMatchObject({ status: 'PROPOSAL', lostReason: null, closedAt: null, assignedTo: { id: agent.userId } });
    expect(reopened.activity.map((a) => a.detail)).toEqual([
      'Moved it from lost to proposal; assigned it to AGENT',
      'Moved it from qualified to lost (Chose a competitor)',
      'Moved it from new to qualified',
      'Created the lead',
    ]);
    await flushBackgroundTasks();
    expect(events.filter((e) => e.type === 'lead.status_changed').map((e) => e.data)).toEqual([
      { from: 'NEW', to: 'QUALIFIED' },
      { from: 'QUALIFIED', to: 'LOST' },
      { from: 'LOST', to: 'PROPOSAL' },
    ]);
    // No-op updates change nothing.
    await updateLead(admin, lead.id, { status: 'PROPOSAL' });
    expect(await prisma.auditLog.count({ where: { entityId: lead.id } })).toBe(4);
    await expect(updateLead(admin, lead.id, { assignedToId: (await createWorkspace('X')).owner.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('computes stats, board columns and filters', async () => {
    const mk = (status: 'NEW' | 'QUALIFIED' | 'WON' | 'LOST', value: number, extra: object = {}) =>
      prisma.lead.create({ data: { organizationId, status, estimatedValue: value, closedAt: status === 'WON' || status === 'LOST' ? new Date() : null, ...extra } });
    await mk('NEW', 100, { source: 'WEBSITE', name: 'Web lead', temperature: 'HOT' });
    await mk('QUALIFIED', 300, { source: 'WHATSAPP', assignedToId: admin.userId });
    await mk('WON', 1000);
    await mk('WON', 500);
    await mk('LOST', 700);
    await mk('NEW', 50, { createdAt: new Date(Date.now() - 200 * 86_400_000) });

    const stats = await leadStats(admin);
    expect(stats).toMatchObject({ open: 3, pipelineValue: 450, wonValue: 1500, winRate: 66.7, conversionRate: 40, byStatus: { NEW: 2, QUALIFIED: 1, WON: 2, LOST: 1 } });
    const board = await leadBoard(admin, DEFAULT_LEAD_FILTERS);
    expect(board.columns.map((c) => [c.status, c.count, c.value])).toEqual([
      ['NEW', 2, 150],
      ['CONTACTED', 0, 0],
      ['QUALIFIED', 1, 300],
      ['PROPOSAL', 0, 0],
      ['WON', 2, 1500],
      ['LOST', 1, 700],
    ]);
    expect((await leads(admin, { status: 'open' })).items).toHaveLength(3);
    expect((await leads(admin, { source: 'WHATSAPP' })).items).toHaveLength(1);
    expect((await leads(admin, { source: 'MANUAL' })).items).toHaveLength(4);
    expect((await leads(admin, { temperature: 'HOT' })).items.map((l) => l.name)).toEqual(['Web lead']);
    expect((await leads(admin, { assignee: 'me' })).items).toHaveLength(1);
    expect((await leads(admin, { q: 'web lead' })).items).toHaveLength(1);
    await expect(leadStats(agent)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('exports CSV safely and deletes leads', async () => {
    const lead = await createLead(admin, { name: '=HYPERLINK("http://evil")', email: 'a@b.de', company: 'Müller & "Söhne"' });
    const csv = await exportLeadsCsv(admin, DEFAULT_LEAD_FILTERS);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"Müller & ""Söhne"""');
    expect(csvCell('+49 151')).toBe(`"'+49 151"`);
    expect(csvCell(42)).toBe('"42"');
    await deleteLead(admin, lead.id);
    await expect(getLead(admin, lead.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

