import 'server-only';
import type { ChannelType, Conversation, Message, Prisma } from '@prisma/client';
import type { TenantDb } from '../../tenancy/tenant-db';

export const MESSAGE_INCLUDE = { senderUser: { select: { name: true } } } as const;
export const CONVERSATION_INCLUDE = { assignedTo: { select: { name: true } } } as const;

export type ConversationWithAgent = Conversation & { assignedTo: { name: string | null } | null };

export function findActiveConversation(db: TenantDb, customerId: string, channel: ChannelType) {
  return db.conversation.findFirst({
    where: { customerId, channel, status: { not: 'CLOSED' } },
    orderBy: { lastMessageAt: 'desc' },
    include: CONVERSATION_INCLUDE,
  });
}

export async function getOrCreateActiveConversation(
  db: TenantDb,
  params: { organizationId: string; customerId: string; channel: ChannelType; channelId: string },
): Promise<{ conversation: ConversationWithAgent; created: boolean }> {
  const existing = await findActiveConversation(db, params.customerId, params.channel);
  if (existing) return { conversation: existing, created: false };
  const conversation = await db.conversation.create({
    data: {
      organizationId: params.organizationId,
      customerId: params.customerId,
      channel: params.channel,
      channelId: params.channelId,
    },
    include: CONVERSATION_INCLUDE,
  });
  return { conversation, created: true };
}

const preview = (m: { content?: string; attachments?: unknown }) => {
  const text = (m.content ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 140);
  return Array.isArray(m.attachments) && m.attachments.length ? '📎 Attachment' : '';
};

/**
 * Stores a message and updates the conversation's denormalized fields in one transaction.
 * Customer messages bump unread and the WhatsApp service window; the first AI/agent
 * reply sets firstResponseAt.
 */
export async function appendMessage(
  db: TenantDb,
  conversation: Pick<Conversation, 'id' | 'organizationId' | 'channel' | 'firstResponseAt'>,
  data: Omit<Prisma.MessageUncheckedCreateInput, 'organizationId' | 'conversationId' | 'channel'>,
): Promise<Message & { senderUser: { name: string | null } | null }> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: { ...data, organizationId: conversation.organizationId, conversationId: conversation.id, channel: conversation.channel },
      include: MESSAGE_INCLUDE,
    });
    const isCustomer = data.senderType === 'CUSTOMER';
    const isReply = data.senderType === 'AI' || data.senderType === 'AGENT';
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: message.createdAt,
        ...(data.senderType !== 'SYSTEM' ? { lastMessagePreview: preview(data) } : {}),
        ...(isCustomer ? { lastCustomerMessageAt: now, unreadCount: { increment: 1 } } : {}),
        ...(isReply && !conversation.firstResponseAt ? { firstResponseAt: now } : {}),
      },
    });
    return message;
  });
}

export function recentMessages(db: TenantDb, conversationId: string, take = 50) {
  return db.message
    .findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      include: MESSAGE_INCLUDE,
    })
    .then((rows) => rows.reverse());
}
