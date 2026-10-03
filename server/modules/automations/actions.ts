import 'server-only';
import type { Prisma, Role } from '@prisma/client';
import { renderTemplate, type AutomationAction } from '@/lib/automations';
import type { BusinessHoursRule } from '@/lib/business-hours';
import { getChannelAdapter } from '../../channels/registry';
import { prisma } from '../../db';
import { emitDomainEvent, type DomainEvent } from '../../events/domain-events';
import { buildEventPayload } from '../../events/payload';
import { channels, publish } from '../../realtime/bus';
import type { TenantDb } from '../../tenancy/tenant-db';
import { appendMessage, CONVERSATION_INCLUDE } from '../chat/conversation-service';
import { requestHumanHandoff } from '../chat/handoff';
import { notifyMembers } from '../notifications/notification-service';
import { enqueueDeliveries } from '../webhooks/delivery';

// Automation actions. Each one acts only inside the event's organization and reports a
// short, human-readable outcome for the run history.

export interface ActionContext {
  db: TenantDb;
  organizationId: string;
  automation: { id: string; name: string };
  event: DomainEvent;
  conversationId: string | null;
  customerId: string | null;
  vars: Record<string, string | null>;
  org: { timezone: string; businessHours: BusinessHoursRule[]; defaultLanguage: string };
}

export class ActionSkipped extends Error {}

const causedBy = (ctx: ActionContext) => [...ctx.event.causedBy, ctx.automation.id];

async function requireConversation(ctx: ActionContext) {
  if (!ctx.conversationId) throw new ActionSkipped('No conversation for this event');
  const conversation = await ctx.db.conversation.findUnique({ where: { id: ctx.conversationId }, include: CONVERSATION_INCLUDE });
  if (!conversation) throw new ActionSkipped('Conversation no longer exists');
  return conversation;
}

function requireCustomer(ctx: ActionContext) {
  if (!ctx.customerId) throw new ActionSkipped('No customer for this event');
  return ctx.customerId;
}

async function sendMessage(ctx: ActionContext, action: Extract<AutomationAction, { type: 'SEND_MESSAGE' }>) {
  const conversation = await requireConversation(ctx);
  if (conversation.status === 'CLOSED') throw new ActionSkipped('Conversation is closed');
  const content = renderTemplate(action.text, ctx.vars).trim();
  if (!content) throw new ActionSkipped('Message is empty after filling in variables');
  const message = await appendMessage(ctx.db, conversation, {
    senderType: 'AI',
    content,
    status: 'SENT',
    metadata: { automation: ctx.automation } as Prisma.InputJsonValue,
  });
  const delivery = await getChannelAdapter(conversation.channel).sendMessage(conversation, message);
  if (!delivery.delivered) throw new Error(`Message stored but not delivered: ${delivery.error ?? 'unknown error'}`);
  return `Sent: “${content.slice(0, 60)}${content.length > 60 ? '…' : ''}”`;
}

async function createLead(ctx: ActionContext, action: Extract<AutomationAction, { type: 'CREATE_LEAD' }>) {
  const customerId = requireCustomer(ctx);
  const existing = await ctx.db.lead.findFirst({
    where: { customerId, status: { in: ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL'] }, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) },
    select: { id: true },
  });
  if (existing) throw new ActionSkipped('An open lead already exists');
  const customer = await ctx.db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { name: true, email: true, phone: true, company: true } });
  const conversation = ctx.conversationId ? await ctx.db.conversation.findUnique({ where: { id: ctx.conversationId }, select: { channel: true } }) : null;
  const lead = await ctx.db.lead.create({
    data: {
      organizationId: ctx.organizationId,
      customerId,
      conversationId: ctx.conversationId,
      ...customer,
      requestedService: renderTemplate(action.requestedService, ctx.vars) || null,
      message: ctx.vars['message.text'] ?? null,
      temperature: action.temperature,
      source: conversation?.channel ?? null,
    },
  });
  await publish(channels.inbox(ctx.organizationId), { type: 'lead.created', leadId: lead.id, conversationId: ctx.conversationId });
  emitDomainEvent({ type: 'lead.created', organizationId: ctx.organizationId, refs: { leadId: lead.id, customerId, conversationId: ctx.conversationId }, causedBy: causedBy(ctx) });
  return `Lead L-${lead.id.slice(-6).toUpperCase()} created`;
}

async function addTag(ctx: ActionContext, action: Extract<AutomationAction, { type: 'ADD_TAG' }>) {
  const customerId = requireCustomer(ctx);
  const name = renderTemplate(action.tag, ctx.vars).trim().slice(0, 40);
  const tag = await ctx.db.tag.upsert({
    where: { organizationId_name: { organizationId: ctx.organizationId, name } },
    create: { organizationId: ctx.organizationId, name },
    update: {},
  });
  await ctx.db.customerTag.upsert({
    where: { customerId_tagId: { customerId, tagId: tag.id } },
    create: { organizationId: ctx.organizationId, customerId, tagId: tag.id },
    update: {},
  });
  return `Tagged “${name}”`;
}

/** Round robin: the eligible member with the fewest open conversations (agents first). */
async function pickAssignee(ctx: ActionContext): Promise<string | null> {
  const members = await ctx.db.membership.findMany({ where: { role: 'AGENT' }, orderBy: { createdAt: 'asc' }, select: { userId: true } });
  const pool = members.length ? members : await ctx.db.membership.findMany({ where: { role: { in: ['ADMIN', 'OWNER'] } }, orderBy: { createdAt: 'asc' }, select: { userId: true } });
  if (!pool.length) return null;
  const load = await ctx.db.conversation.groupBy({
    by: ['assignedToId'],
    where: { status: { not: 'CLOSED' }, assignedToId: { in: pool.map((m) => m.userId) } },
    _count: { _all: true },
  });
  const count = new Map(load.map((l) => [l.assignedToId, l._count._all]));
  return [...pool].sort((a, b) => (count.get(a.userId) ?? 0) - (count.get(b.userId) ?? 0))[0]!.userId;
}

async function assignAgent(ctx: ActionContext, action: Extract<AutomationAction, { type: 'ASSIGN_AGENT' }>) {
  const conversation = await requireConversation(ctx);
  const userId = action.mode === 'user' ? action.userId! : await pickAssignee(ctx);
  if (!userId) throw new ActionSkipped('No team member available');
  const member = await ctx.db.membership.findFirst({ where: { userId }, select: { user: { select: { name: true, email: true } } } });
  if (!member) throw new ActionSkipped('That team member is no longer in this workspace');
  if (conversation.assignedToId === userId) throw new ActionSkipped('Already assigned to this team member');
  await ctx.db.$transaction([
    ctx.db.conversationAssignment.updateMany({ where: { conversationId: conversation.id, endedAt: null }, data: { endedAt: new Date() } }),
    ctx.db.conversationAssignment.create({ data: { organizationId: ctx.organizationId, conversationId: conversation.id, assigneeId: userId } }),
    ctx.db.conversation.update({ where: { id: conversation.id }, data: { assignedToId: userId } }),
  ]);
  await publish(channels.inbox(ctx.organizationId), { type: 'conversation.assigned', conversationId: conversation.id, assigneeId: userId });
  await notifyMembers(ctx.organizationId, {
    userIds: [userId],
    title: 'Conversation assigned to you',
    body: `${ctx.vars['customer.name'] ?? 'A customer'} on ${conversation.channel === 'WHATSAPP' ? 'WhatsApp' : 'the website'} (automation “${ctx.automation.name}”).`,
    link: `/inbox?conversation=${conversation.id}`,
  });
  return `Assigned to ${member.user.name ?? member.user.email}`;
}

async function createTicket(ctx: ActionContext, action: Extract<AutomationAction, { type: 'CREATE_TICKET' }>) {
  const customerId = requireCustomer(ctx);
  const ticket = await ctx.db.ticket.create({
    data: {
      organizationId: ctx.organizationId,
      customerId,
      conversationId: ctx.conversationId,
      subject: renderTemplate(action.subject, ctx.vars).slice(0, 140) || 'Support request',
      description: ctx.vars['message.text'] ?? null,
      priority: action.priority,
    },
  });
  await publish(channels.inbox(ctx.organizationId), { type: 'ticket.created', ticketId: ticket.id, conversationId: ctx.conversationId });
  emitDomainEvent({ type: 'ticket.created', organizationId: ctx.organizationId, refs: { ticketId: ticket.id, customerId, conversationId: ctx.conversationId }, causedBy: causedBy(ctx) });
  return `Ticket T-${ticket.id.slice(-6).toUpperCase()} created`;
}

async function triggerWebhook(ctx: ActionContext, action: Extract<AutomationAction, { type: 'TRIGGER_WEBHOOK' }>) {
  const endpoint = await ctx.db.webhookEndpoint.findUnique({ where: { id: action.endpointId }, select: { id: true, url: true, isActive: true } });
  if (!endpoint) throw new ActionSkipped('Webhook endpoint not found');
  if (!endpoint.isActive) throw new ActionSkipped('Webhook endpoint is disabled');
  const payload = await buildEventPayload(ctx.event);
  const body = { ...payload, data: { ...payload.data, automation: ctx.automation } };
  // Distinct event id: the same event may also reach this endpoint through its subscriptions.
  await enqueueDeliveries(ctx.organizationId, [endpoint.id], ctx.event.type, `${ctx.event.id}:${ctx.automation.id}`, body as unknown as Prisma.InputJsonValue);
  return `Queued for ${new URL(endpoint.url).host}`;
}

async function notifyTeam(ctx: ActionContext, action: Extract<AutomationAction, { type: 'NOTIFY_TEAM' }>) {
  const conversation = ctx.conversationId ? await ctx.db.conversation.findUnique({ where: { id: ctx.conversationId }, select: { assignedToId: true } }) : null;
  // "assignee" falls back to admins when nobody is assigned.
  const target: { roles?: Role[]; userIds?: string[] } =
    action.recipients === 'everyone'
      ? { roles: ['OWNER', 'ADMIN', 'AGENT'] }
      : action.recipients === 'assignee' && conversation?.assignedToId
        ? { userIds: [conversation.assignedToId] }
        : { roles: ['OWNER', 'ADMIN'] };
  const sent = await notifyMembers(ctx.organizationId, {
    ...target,
    title: ctx.automation.name,
    body: renderTemplate(action.message, ctx.vars),
    link: ctx.conversationId ? `/inbox?conversation=${ctx.conversationId}` : null,
  });
  return `${sent} team member${sent === 1 ? '' : 's'} notified`;
}

async function requestHandoff(ctx: ActionContext) {
  const conversation = await requireConversation(ctx);
  const customer = await ctx.db.customer.findUnique({ where: { id: conversation.customerId }, select: { language: true } });
  const result = await requestHumanHandoff({
    db: ctx.db,
    conversation,
    businessHours: ctx.org.businessHours,
    timeZone: ctx.org.timezone,
    reason: 'rule',
    detail: { trigger: 'automation', automation: ctx.automation.name },
    language: customer?.language ?? ctx.org.defaultLanguage,
    causedBy: causedBy(ctx),
  });
  if (result.alreadyRequested) throw new ActionSkipped('A team member was already requested');
  if (result.message) await getChannelAdapter(conversation.channel).sendMessage(result.conversation, result.message);
  return result.teamOnline ? 'Handed over to the team' : 'Handoff recorded (team offline)';
}

export async function executeAction(ctx: ActionContext, action: AutomationAction): Promise<string> {
  switch (action.type) {
    case 'SEND_MESSAGE':
      return sendMessage(ctx, action);
    case 'CREATE_LEAD':
      return createLead(ctx, action);
    case 'ADD_TAG':
      return addTag(ctx, action);
    case 'ASSIGN_AGENT':
      return assignAgent(ctx, action);
    case 'CREATE_TICKET':
      return createTicket(ctx, action);
    case 'TRIGGER_WEBHOOK':
      return triggerWebhook(ctx, action);
    case 'NOTIFY_TEAM':
      return notifyTeam(ctx, action);
    case 'REQUEST_HANDOFF':
      return requestHandoff(ctx);
  }
}

/** Organization facts the engine needs once per event. */
export async function loadOrgContext(organizationId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true, timezone: true, defaultLanguage: true, businessHours: { select: { weekday: true, opensAt: true, closesAt: true } } },
  });
  return org;
}
