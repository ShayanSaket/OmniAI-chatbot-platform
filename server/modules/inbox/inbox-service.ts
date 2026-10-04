import 'server-only';
import type { Conversation, Prisma } from '@prisma/client';
import {
  customerDisplayName,
  type AgentReplyInput,
  type InboxConversationDetail,
  type InboxCounts,
  type InboxFilters,
  type InboxMember,
} from '@/lib/inbox';
import { hasPermission } from '@/lib/permissions';
import { MAX_UPLOAD_BYTES } from '@/lib/widget-protocol';
import { runInBackground } from '../../background';
import { getChannelAdapter } from '../../channels/registry';
import type { StoredAttachment } from '../../channels/types';
import { toWidgetConversation } from '../../channels/website/serialize';
import { isWithinServiceWindow } from '../../channels/whatsapp/outbound';
import type { ServiceContext } from '../../context';
import { env } from '../../env';
import { AppError, forbidden, notFound } from '../../errors';
import { emitDomainEvent } from '../../events/domain-events';
import { logger } from '../../logger';
import { channels, publish } from '../../realtime/bus';
import {
  customerKeyPrefix,
  newObjectKey,
  safeFileName,
  signedFileUrl,
  signUploadReceipt,
  sniffFileType,
  verifyUploadReceipt,
} from '../../storage/files';
import { putObject } from '../../storage/s3';
import { parseCustomerMemory, summarizeConversation, ticketReference } from '../agent/memory';
import { auditFromContext } from '../audit/audit-service';
import { appendMessage, CONVERSATION_INCLUDE, MESSAGE_INCLUDE } from '../chat/conversation-service';
import { systemText } from '../chat/system-messages';
import { notifyMembers } from '../notifications/notification-service';
import { INBOX_LIST_INCLUDE, toInboxItem, toInboxMessage } from './serialize';

// Unified inbox: one list for every channel, human takeover, replies on the original
// channel, assignment, close/reopen, read state and notes. The AI stays silent whenever
// a conversation is not AI_ACTIVE (enforced by the message pipeline).

const PAGE_SIZE = 30;
const MESSAGE_PAGE = 50;

function requireAccess(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'inbox:access')) throw forbidden();
}

function requireReply(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'conversations:reply')) throw forbidden();
}

async function loadConversation(ctx: ServiceContext, id: string) {
  const conversation = await ctx.db.conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
  if (!conversation) throw notFound('Conversation');
  return conversation;
}

async function memberName(ctx: ServiceContext, userId: string) {
  const member = await ctx.db.membership.findFirst({ where: { userId }, select: { user: { select: { name: true, email: true } } } });
  return member ? (member.user.name ?? member.user.email) : null;
}

function conversationChanged(organizationId: string, conversationId: string) {
  return publish(channels.inbox(organizationId), { type: 'conversation.updated', conversationId });
}

// ─── List ─────────────────────────────────────────────────────────────

function listWhere(ctx: ServiceContext, f: InboxFilters): Prisma.ConversationWhereInput {
  const and: Prisma.ConversationWhereInput[] = [];
  if (f.status === 'open') and.push({ status: { not: 'CLOSED' } });
  if (f.status === 'closed') and.push({ status: 'CLOSED' });
  if (f.channel !== 'all') and.push({ channel: f.channel });
  if (f.mode === 'ai') and.push({ status: 'AI_ACTIVE' });
  if (f.mode === 'human') and.push({ status: { in: ['WAITING_FOR_AGENT', 'HUMAN_ACTIVE'] } });
  if (f.mode === 'waiting') and.push({ status: 'WAITING_FOR_AGENT' });
  if (f.assignee === 'me') and.push({ assignedToId: ctx.userId });
  if (f.assignee === 'unassigned') and.push({ assignedToId: null });
  if (f.unread) and.push({ unreadCount: { gt: 0 } });
  if (f.q) {
    const contains = { contains: f.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { lastMessagePreview: contains },
        { customer: { name: contains } },
        { customer: { email: contains } },
        { customer: { phone: contains } },
        { customer: { company: contains } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [ms, id] = cursor.split('_');
  const at = new Date(Number(ms));
  return id && Number.isFinite(at.getTime()) ? { at, id } : null;
}

export async function listInboxConversations(ctx: ServiceContext, filters: InboxFilters & { cursor?: string }) {
  requireAccess(ctx);
  const cursor = decodeCursor(filters.cursor);
  const where = listWhere(ctx, filters);
  const rows = await ctx.db.conversation.findMany({
    where: cursor
      ? { AND: [where, { OR: [{ lastMessageAt: { lt: cursor.at } }, { lastMessageAt: cursor.at, id: { lt: cursor.id } }] }] }
      : where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
    include: INBOX_LIST_INCLUDE,
  });
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map(toInboxItem),
    nextCursor: rows.length > PAGE_SIZE && last ? `${last.lastMessageAt.getTime()}_${last.id}` : null,
    counts: cursor ? null : await inboxCounts(ctx),
  };
}

export async function inboxCounts(ctx: ServiceContext): Promise<InboxCounts> {
  requireAccess(ctx);
  const open = { status: { not: 'CLOSED' as const } };
  const [openCount, waiting, mine, unread] = await Promise.all([
    ctx.db.conversation.count({ where: open }),
    ctx.db.conversation.count({ where: { status: 'WAITING_FOR_AGENT' } }),
    ctx.db.conversation.count({ where: { ...open, assignedToId: ctx.userId } }),
    ctx.db.conversation.count({ where: { ...open, unreadCount: { gt: 0 } } }),
  ]);
  return { open: openCount, waiting, mine, unread };
}

export async function listInboxMembers(ctx: ServiceContext): Promise<InboxMember[]> {
  requireAccess(ctx);
  const members = await ctx.db.membership.findMany({
    select: { role: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
}

// ─── Detail ───────────────────────────────────────────────────────────

export async function listConversationMessages(ctx: ServiceContext, conversationId: string, opts: { before?: string; after?: string } = {}) {
  requireAccess(ctx);
  const anchorId = opts.before ?? opts.after;
  const anchor = anchorId ? await ctx.db.message.findFirst({ where: { id: anchorId, conversationId }, select: { id: true, createdAt: true } }) : null;
  if (anchorId && !anchor) throw notFound('Message');
  if (opts.after && anchor) {
    const rows = await ctx.db.message.findMany({
      where: { conversationId, OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      include: MESSAGE_INCLUDE,
    });
    return { messages: rows.map(toInboxMessage), hasOlder: false };
  }
  const rows = await ctx.db.message.findMany({
    where: {
      conversationId,
      ...(anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MESSAGE_PAGE + 1,
    include: MESSAGE_INCLUDE,
  });
  return { messages: rows.slice(0, MESSAGE_PAGE).reverse().map(toInboxMessage), hasOlder: rows.length > MESSAGE_PAGE };
}

export async function getInboxConversation(ctx: ServiceContext, id: string): Promise<InboxConversationDetail> {
  requireAccess(ctx);
  const conversation = await ctx.db.conversation.findUnique({
    where: { id },
    include: {
      assignedTo: { select: { id: true, name: true } },
      customer: {
        include: {
          tags: { include: { tag: { select: { name: true, color: true } } }, orderBy: { createdAt: 'asc' } },
          identities: { where: { channel: 'WHATSAPP' }, select: { externalId: true }, take: 1 },
        },
      },
      summaries: { orderBy: { createdAt: 'desc' }, take: 1, select: { summary: true, createdAt: true } },
    },
  });
  if (!conversation) throw notFound('Conversation');
  const customerId = conversation.customerId;
  const [page, leads, tickets, appointments, notes, others] = await Promise.all([
    listConversationMessages(ctx, id),
    ctx.db.lead.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ctx.db.ticket.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ctx.db.appointment.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ctx.db.customerNote.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 20, include: { author: { select: { name: true, email: true } } } }),
    ctx.db.conversation.findMany({
      where: { customerId, id: { not: id } },
      orderBy: { lastMessageAt: 'desc' },
      take: 5,
      select: { id: true, channel: true, status: true, lastMessageAt: true, lastMessagePreview: true },
    }),
  ]);
  const meta = (conversation.metadata ?? {}) as { sentiment?: string; handoff?: { reason?: string; trigger?: string } };
  const memory = parseCustomerMemory(conversation.customer.memory);
  const c = conversation.customer;
  const summary = conversation.summaries[0];
  return {
    ...toInboxItem(conversation),
    sentiment: meta.sentiment ?? null,
    handoffReason: conversation.handoffRequestedAt ? (meta.handoff?.trigger ?? meta.handoff?.reason ?? null) : null,
    closedAt: conversation.closedAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    customer: {
      ...toInboxItem(conversation).customer,
      company: c.company,
      language: c.language,
      whatsappNumber: c.identities[0]?.externalId ?? null,
      tags: c.tags.map((t) => t.tag),
      facts: [...memory.productInterests.map((p) => `Interested in ${p}`), ...memory.preferences, ...memory.facts].slice(0, 12),
      createdAt: c.createdAt.toISOString(),
    },
    summary: summary ? { text: summary.summary, createdAt: summary.createdAt.toISOString() } : c.aiSummary ? { text: c.aiSummary, createdAt: c.updatedAt.toISOString() } : null,
    leads: leads.map((l) => ({ id: l.id, status: l.status, temperature: l.temperature, requestedService: l.requestedService, createdAt: l.createdAt.toISOString() })),
    tickets: tickets.map((t) => ({ id: t.id, reference: ticketReference(t.id), subject: t.subject, status: t.status, priority: t.priority, createdAt: t.createdAt.toISOString() })),
    appointments: appointments.map((a) => ({ id: a.id, status: a.status, topic: a.topic, preferredTime: a.preferredTime, createdAt: a.createdAt.toISOString() })),
    notes: notes.map((n) => ({ id: n.id, content: n.content, authorId: n.authorId, authorName: n.author ? (n.author.name ?? n.author.email) : null, createdAt: n.createdAt.toISOString() })),
    otherConversations: others.map((o) => ({ ...o, lastMessageAt: o.lastMessageAt.toISOString() })),
    window:
      conversation.channel === 'WHATSAPP'
        ? {
            open: isWithinServiceWindow(conversation.lastCustomerMessageAt),
            closesAt: conversation.lastCustomerMessageAt ? new Date(conversation.lastCustomerMessageAt.getTime() + 24 * 3_600_000).toISOString() : null,
          }
        : null,
    messages: page.messages,
    hasOlder: page.hasOlder,
  };
}

/** Clears the unread counter and marks the customer's messages as read. */
export async function markConversationRead(ctx: ServiceContext, id: string) {
  requireAccess(ctx);
  const conversation = await loadConversation(ctx, id);
  if (conversation.unreadCount === 0) return { unreadCount: 0 };
  await ctx.db.$transaction([
    ctx.db.conversation.update({ where: { id }, data: { unreadCount: 0 } }),
    ctx.db.message.updateMany({ where: { conversationId: id, senderType: 'CUSTOMER', status: 'RECEIVED' }, data: { status: 'READ' } }),
  ]);
  await conversationChanged(ctx.organizationId, id);
  return { unreadCount: 0 };
}

// ─── State changes ────────────────────────────────────────────────────

type LoadedConversation = Awaited<ReturnType<typeof loadConversation>>;

/**
 * Tells the customer about a state change on their channel. On WhatsApp, notices are
 * skipped outside the 24-hour window (only templates may be sent then).
 */
async function announce(ctx: ServiceContext, conversation: LoadedConversation, content: string, event: string) {
  if (conversation.channel === 'WHATSAPP' && !isWithinServiceWindow(conversation.lastCustomerMessageAt)) return null;
  const message = await appendMessage(ctx.db, conversation, {
    senderType: 'SYSTEM',
    messageType: 'SYSTEM',
    content,
    status: conversation.channel === 'WHATSAPP' ? 'PENDING' : 'SENT',
    metadata: { event, actorId: ctx.userId },
  });
  await getChannelAdapter(conversation.channel)
    .sendMessage(conversation, message)
    .catch((err) => logger.warn('state notice delivery failed', { conversationId: conversation.id, err: (err as Error).message }));
  return message;
}

/** Pushes the new status/agent to the customer's open widgets without a message. */
async function syncWidget(conversation: LoadedConversation) {
  if (conversation.channel !== 'WEBSITE') return;
  await publish(channels.visitor(conversation.customerId), { type: 'conversation', conversation: toWidgetConversation(conversation) });
}

async function customerLanguage(ctx: ServiceContext, customerId: string) {
  const [customer, bot] = await Promise.all([
    ctx.db.customer.findUnique({ where: { id: customerId }, select: { language: true } }),
    ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { defaultLanguage: true } }),
  ]);
  return customer?.language ?? bot?.defaultLanguage ?? 'en';
}

/** Records an assignment change (history row + notification for the new assignee). */
async function recordAssignment(ctx: ServiceContext, conversation: Pick<Conversation, 'id' | 'assignedToId'>, assigneeId: string | null) {
  await ctx.db.$transaction([
    ctx.db.conversationAssignment.updateMany({ where: { conversationId: conversation.id, endedAt: null }, data: { endedAt: new Date() } }),
    ...(assigneeId
      ? [ctx.db.conversationAssignment.create({ data: { organizationId: ctx.organizationId, conversationId: conversation.id, assigneeId, assignedById: ctx.userId } })]
      : []),
  ]);
}

const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);

/**
 * A team member takes over: the AI stops replying and the customer sees who joined.
 * Taking over someone else's conversation needs conversations:manage.
 */
export async function takeOverConversation(ctx: ServiceContext, id: string) {
  requireReply(ctx);
  const current = await loadConversation(ctx, id);
  if (current.status === 'CLOSED') throw conflict('This conversation is closed. Reopen it first.');
  if (current.status === 'HUMAN_ACTIVE' && current.assignedToId === ctx.userId) return getInboxConversation(ctx, id);
  if (current.status === 'HUMAN_ACTIVE' && current.assignedToId && !hasPermission(ctx.role, 'conversations:manage')) {
    throw conflict(`${current.assignedTo?.name ?? 'Another team member'} is already handling this conversation.`);
  }
  // Optimistic concurrency: two people clicking at once → only one wins.
  const { count } = await ctx.db.conversation.updateMany({
    where: { id, status: current.status, assignedToId: current.assignedToId },
    data: { status: 'HUMAN_ACTIVE', assignedToId: ctx.userId },
  });
  if (count === 0) throw conflict('Someone else just updated this conversation. Refresh and try again.');
  if (current.assignedToId !== ctx.userId) await recordAssignment(ctx, current, ctx.userId);

  const updated = await loadConversation(ctx, id);
  const [name, language] = await Promise.all([memberName(ctx, ctx.userId), customerLanguage(ctx, updated.customerId)]);
  await announce(ctx, updated, systemText(language).agentJoined(name), 'agent_joined');
  await syncWidget(updated);
  await conversationChanged(ctx.organizationId, id);
  await auditFromContext(ctx, 'conversation.taken_over', { type: 'Conversation', id }, { previousStatus: current.status });
  return getInboxConversation(ctx, id);
}

/** Hands the conversation back to the AI assistant. */
export async function returnConversationToAi(ctx: ServiceContext, id: string) {
  requireReply(ctx);
  const current = await loadConversation(ctx, id);
  if (current.status === 'AI_ACTIVE') return getInboxConversation(ctx, id);
  if (current.status === 'CLOSED') throw conflict('This conversation is closed. Reopen it first.');
  if (current.assignedToId && current.assignedToId !== ctx.userId && !hasPermission(ctx.role, 'conversations:manage')) {
    throw conflict(`${current.assignedTo?.name ?? 'Another team member'} is handling this conversation.`);
  }
  const meta = (current.metadata ?? {}) as Record<string, unknown>;
  const { count } = await ctx.db.conversation.updateMany({
    where: { id, status: current.status },
    data: { status: 'AI_ACTIVE', handoffRequestedAt: null, metadata: { ...meta, returnedToAiAt: new Date().toISOString(), returnedToAiBy: ctx.userId } as Prisma.InputJsonValue },
  });
  if (count === 0) throw conflict('Someone else just updated this conversation. Refresh and try again.');
  const updated = await loadConversation(ctx, id);
  await announce(ctx, updated, systemText(await customerLanguage(ctx, updated.customerId)).returnedToAi, 'returned_to_ai');
  await syncWidget(updated);
  await conversationChanged(ctx.organizationId, id);
  await auditFromContext(ctx, 'conversation.returned_to_ai', { type: 'Conversation', id }, { previousStatus: current.status });
  return getInboxConversation(ctx, id);
}

/**
 * Assigns (or unassigns) a team member. Agents may only assign themselves or release
 * their own conversations; assigning others needs conversations:manage.
 */
export async function assignConversation(ctx: ServiceContext, id: string, assigneeId: string | null) {
  requireReply(ctx);
  const current = await loadConversation(ctx, id);
  const manages = hasPermission(ctx.role, 'conversations:manage');
  const selfOnly = assigneeId === ctx.userId || (assigneeId === null && current.assignedToId === ctx.userId);
  if (!manages && !selfOnly) throw forbidden('Only admins can assign conversations to other team members.');
  if (current.assignedToId === assigneeId) return getInboxConversation(ctx, id);
  if (assigneeId && !(await ctx.db.membership.findFirst({ where: { userId: assigneeId }, select: { id: true } }))) {
    throw new AppError('VALIDATION_FAILED', 'That person is not a member of this workspace.', { assigneeId: ['Choose a team member'] });
  }
  await ctx.db.conversation.update({ where: { id }, data: { assignedToId: assigneeId } });
  await recordAssignment(ctx, current, assigneeId);
  const updated = await loadConversation(ctx, id);
  await syncWidget(updated);
  await publish(channels.inbox(ctx.organizationId), { type: 'conversation.assigned', conversationId: id, assigneeId });
  if (assigneeId && assigneeId !== ctx.userId) {
    const customer = await ctx.db.customer.findUnique({ where: { id: current.customerId }, select: { id: true, name: true, email: true, phone: true } });
    await notifyMembers(ctx.organizationId, {
      userIds: [assigneeId],
      title: 'Conversation assigned to you',
      body: `${(await memberName(ctx, ctx.userId)) ?? 'A team member'} assigned you the conversation with ${customer ? customerDisplayName(customer) : 'a customer'}.`,
      link: `/inbox?conversation=${id}`,
    });
  }
  await auditFromContext(ctx, 'conversation.assigned', { type: 'Conversation', id }, { assigneeId, previousAssigneeId: current.assignedToId });
  return getInboxConversation(ctx, id);
}

export async function closeConversation(ctx: ServiceContext, id: string) {
  requireReply(ctx);
  const current = await loadConversation(ctx, id);
  if (current.status === 'CLOSED') return getInboxConversation(ctx, id);
  const agentReplies = await ctx.db.message.count({ where: { conversationId: id, senderType: 'AGENT' } });
  const meta = (current.metadata ?? {}) as Record<string, unknown>;
  const { count } = await ctx.db.conversation.updateMany({
    where: { id, status: current.status },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      unreadCount: 0,
      aiResolved: !current.handoffRequestedAt && agentReplies === 0,
      metadata: { ...meta, closedBy: 'agent', closedById: ctx.userId } as Prisma.InputJsonValue,
    },
  });
  if (count === 0) throw conflict('Someone else just updated this conversation. Refresh and try again.');
  await ctx.db.conversationAssignment.updateMany({ where: { conversationId: id, endedAt: null }, data: { endedAt: new Date() } });
  const updated = await loadConversation(ctx, id);
  // Website visitors see the notice in the open widget; WhatsApp customers are not messaged.
  if (updated.channel === 'WEBSITE') await announce(ctx, updated, systemText(await customerLanguage(ctx, updated.customerId)).conversationClosed, 'closed');
  await syncWidget(updated);
  await conversationChanged(ctx.organizationId, id);
  emitDomainEvent({
    type: 'conversation.closed',
    organizationId: ctx.organizationId,
    refs: { conversationId: id, customerId: updated.customerId },
    data: { channel: updated.channel, closedBy: 'agent' },
  });
  const bot = await ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { model: true } });
  runInBackground(
    'conversation-summary',
    () => summarizeConversation({ db: ctx.db, organizationId: ctx.organizationId, conversationId: id, model: bot?.model || env().OPENAI_CHAT_MODEL, force: true }),
    { conversationId: id },
  );
  await auditFromContext(ctx, 'conversation.closed', { type: 'Conversation', id });
  return getInboxConversation(ctx, id);
}

/**
 * Reopens a closed conversation in human mode, assigned to the person reopening it.
 * A customer can only have one open conversation per channel.
 */
export async function reopenConversation(ctx: ServiceContext, id: string) {
  requireReply(ctx);
  const current = await loadConversation(ctx, id);
  if (current.status !== 'CLOSED') return getInboxConversation(ctx, id);
  const open = await ctx.db.conversation.findFirst({
    where: { customerId: current.customerId, channel: current.channel, status: { not: 'CLOSED' } },
    select: { id: true },
  });
  if (open) throw conflict('This customer already has an open conversation on this channel.', { conversationId: open.id });
  await ctx.db.conversation.update({ where: { id }, data: { status: 'HUMAN_ACTIVE', closedAt: null, assignedToId: ctx.userId } });
  await recordAssignment(ctx, current, ctx.userId);
  await syncWidget(await loadConversation(ctx, id));
  await conversationChanged(ctx.organizationId, id);
  await auditFromContext(ctx, 'conversation.reopened', { type: 'Conversation', id });
  return getInboxConversation(ctx, id);
}

// ─── Replies ──────────────────────────────────────────────────────────

/**
 * Sends a team member's reply on the conversation's own channel. Replying to an AI or
 * waiting conversation takes it over first, so the AI stops answering.
 */
export async function sendAgentReply(ctx: ServiceContext, id: string, input: AgentReplyInput) {
  requireReply(ctx);
  // A retried request returns the message stored the first time.
  const duplicate = await ctx.db.message.findFirst({
    where: { conversationId: id, senderType: 'AGENT', metadata: { path: ['clientMessageId'], equals: input.clientMessageId } },
    include: MESSAGE_INCLUDE,
  });
  if (duplicate) return { message: toInboxMessage(duplicate), delivered: duplicate.status !== 'FAILED', duplicate: true };

  let conversation = await loadConversation(ctx, id);
  if (conversation.status === 'CLOSED') throw conflict('This conversation is closed. Reopen it to reply.');
  if (conversation.channel === 'WHATSAPP' && !isWithinServiceWindow(conversation.lastCustomerMessageAt)) {
    throw conflict('The 24-hour WhatsApp window has closed. Send an approved template instead.', { reason: 'whatsapp_window_closed' });
  }

  const secret = env().AUTH_SECRET;
  const prefix = customerKeyPrefix(ctx.organizationId, conversation.customerId);
  const attachments: StoredAttachment[] = input.attachments.map((a) => {
    if (!a.key.startsWith(prefix) || !verifyUploadReceipt(secret, { ...a, customerId: conversation.customerId })) {
      throw new AppError('BAD_REQUEST', 'An attachment could not be verified. Upload it again.');
    }
    return { key: a.key, fileName: a.fileName, mimeType: a.mimeType, size: a.size };
  });

  if (conversation.status !== 'HUMAN_ACTIVE') {
    await takeOverConversation(ctx, id);
    conversation = await loadConversation(ctx, id);
  }

  const message = await appendMessage(ctx.db, conversation, {
    senderType: 'AGENT',
    senderUserId: ctx.userId,
    content: input.content.trim(),
    messageType: !input.content.trim() && attachments.length ? (attachments[0]!.mimeType.startsWith('image/') ? 'IMAGE' : 'DOCUMENT') : 'TEXT',
    attachments: attachments.length ? (attachments as unknown as Prisma.InputJsonValue) : undefined,
    status: conversation.channel === 'WHATSAPP' ? 'PENDING' : 'SENT',
    metadata: { clientMessageId: input.clientMessageId },
  });
  // Delivery failures are recorded on the message (FAILED + reason) and shown in the inbox.
  const delivery = await getChannelAdapter(conversation.channel)
    .sendMessage(conversation, message)
    .catch((err: Error) => ({ delivered: false, error: err.message }));
  const stored = await ctx.db.message.findUniqueOrThrow({ where: { id: message.id }, include: MESSAGE_INCLUDE });
  // Replying clears the unread state: the agent has seen everything above.
  await ctx.db.conversation.update({ where: { id }, data: { unreadCount: 0 } });
  await ctx.db.message.updateMany({ where: { conversationId: id, senderType: 'CUSTOMER', status: 'RECEIVED' }, data: { status: 'READ' } });
  return { message: toInboxMessage(stored), delivered: delivery.delivered, duplicate: false };
}

/** Manually retries a failed outbound message (e.g. a WhatsApp send that failed). */
export async function retryMessage(ctx: ServiceContext, conversationId: string, messageId: string) {
  requireReply(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  const message = await ctx.db.message.findFirst({ where: { id: messageId, conversationId } });
  if (!message) throw notFound('Message');
  if (message.status !== 'FAILED' || message.senderType === 'CUSTOMER') throw conflict('Only failed outgoing messages can be retried.');
  if (conversation.channel === 'WHATSAPP' && message.messageType !== 'TEMPLATE' && !isWithinServiceWindow(conversation.lastCustomerMessageAt)) {
    throw conflict('The 24-hour WhatsApp window has closed. Send an approved template instead.', { reason: 'whatsapp_window_closed' });
  }
  await ctx.db.message.update({ where: { id: messageId }, data: { status: 'PENDING', errorCode: null } });
  const fresh = await ctx.db.message.findUniqueOrThrow({ where: { id: messageId } });
  const delivery = await getChannelAdapter(conversation.channel)
    .sendMessage(conversation, fresh)
    .catch((err: Error) => ({ delivered: false, error: err.message }));
  if (delivery.delivered && conversation.channel === 'WEBSITE') await ctx.db.message.update({ where: { id: messageId }, data: { status: 'SENT' } });
  const stored = await ctx.db.message.findUniqueOrThrow({ where: { id: messageId }, include: MESSAGE_INCLUDE });
  await publish(channels.inbox(ctx.organizationId), { type: 'message.status', conversationId, messageId, status: stored.status });
  return { message: toInboxMessage(stored), delivered: delivery.delivered };
}

/**
 * Stores a file a team member wants to send. The receipt is bound to this conversation's
 * customer, so it can only be attached to replies in their conversations.
 */
export async function uploadAgentFile(ctx: ServiceContext, conversationId: string, file: File) {
  requireReply(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (file.size === 0) throw new AppError('BAD_REQUEST', 'The file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError('BAD_REQUEST', 'Files can be at most 10 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffFileType(bytes, file.name);
  if (!type) throw new AppError('BAD_REQUEST', 'This file type is not supported. Use images (PNG, JPG, GIF, WebP), PDF, DOCX or text files.');
  const fileName = safeFileName(file.name, type.ext);
  const key = newObjectKey(ctx.organizationId, conversation.customerId, fileName);
  await putObject(key, bytes, type.mime);
  const secret = env().AUTH_SECRET;
  const receipt = { key, mimeType: type.mime, size: bytes.byteLength, customerId: conversation.customerId };
  return { key, fileName, mimeType: type.mime, size: bytes.byteLength, sig: signUploadReceipt(secret, receipt), url: signedFileUrl(secret, key) };
}

/** "Agent is typing…" in the website widget (WhatsApp has no agent typing indicator). */
export async function sendAgentTyping(ctx: ServiceContext, conversationId: string) {
  requireReply(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (conversation.channel !== 'WEBSITE' || conversation.status === 'CLOSED') return { sent: false };
  await publish(channels.visitor(conversation.customerId), { type: 'typing', name: await memberName(ctx, ctx.userId) });
  return { sent: true };
}

// ─── Summary & notes ──────────────────────────────────────────────────

/** Regenerates the conversation summary now (needs an AI provider). */
export async function refreshConversationSummary(ctx: ServiceContext, id: string) {
  requireAccess(ctx);
  await loadConversation(ctx, id);
  const bot = await ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { model: true } });
  const result = await summarizeConversation({ db: ctx.db, organizationId: ctx.organizationId, conversationId: id, model: bot?.model || env().OPENAI_CHAT_MODEL, force: true });
  const latest = await ctx.db.conversationSummary.findFirst({ where: { conversationId: id }, orderBy: { createdAt: 'desc' } });
  return { updated: Boolean(result), summary: latest ? { text: latest.summary, createdAt: latest.createdAt.toISOString() } : null };
}

export async function addCustomerNote(ctx: ServiceContext, customerId: string, content: string) {
  requireReply(ctx);
  const customer = await ctx.db.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw notFound('Customer');
  const note = await ctx.db.customerNote.create({
    data: { organizationId: ctx.organizationId, customerId, authorId: ctx.userId, content },
    include: { author: { select: { name: true, email: true } } },
  });
  return { id: note.id, content: note.content, authorId: note.authorId, authorName: note.author ? (note.author.name ?? note.author.email) : null, createdAt: note.createdAt.toISOString() };
}

export async function deleteCustomerNote(ctx: ServiceContext, customerId: string, noteId: string) {
  requireReply(ctx);
  const note = await ctx.db.customerNote.findFirst({ where: { id: noteId, customerId } });
  if (!note) throw notFound('Note');
  if (note.authorId !== ctx.userId && !hasPermission(ctx.role, 'customers:manage')) throw forbidden('You can only delete your own notes.');
  await ctx.db.customerNote.delete({ where: { id: noteId } });
}
