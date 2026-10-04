import 'server-only';
import type { Conversation, Customer, Message } from '@prisma/client';
import type { InboxConversationItem, InboxMessage } from '@/lib/inbox';
import { env } from '../../env';
import { signedFileUrl } from '../../storage/files';
import type { StoredAttachment } from '../../channels/types';

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function toInboxMessage(m: Message & { senderUser?: { name: string | null } | null }): InboxMessage {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const delivery = (meta.delivery ?? {}) as { lastError?: string };
  const automation = meta.automation as { name?: string } | undefined;
  const secret = env().AUTH_SECRET;
  return {
    id: m.id,
    senderType: m.senderType,
    messageType: m.messageType,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    status: m.status,
    errorCode: m.errorCode,
    error: m.status === 'FAILED' ? (delivery.lastError ?? null) : null,
    authorName: m.senderType === 'AGENT' ? (m.senderUser?.name ?? null) : null,
    attachments: arr<StoredAttachment>(m.attachments).map((a) => ({ fileName: a.fileName, mimeType: a.mimeType, size: a.size, url: signedFileUrl(secret, a.key) })),
    sources: arr<{ title: string }>(m.sources).map((s) => ({ title: s.title })),
    intent: m.intent,
    label:
      typeof meta.templateName === 'string'
        ? `Template: ${meta.templateName}`
        : automation?.name
          ? `Automation: ${automation.name}`
          : null,
    clientMessageId: typeof meta.clientMessageId === 'string' ? meta.clientMessageId : null,
  };
}

export const INBOX_LIST_INCLUDE = {
  assignedTo: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true, isAnonymous: true } },
} as const;

export function toInboxItem(
  c: Conversation & {
    assignedTo: { id: string; name: string | null } | null;
    customer: Pick<Customer, 'id' | 'name' | 'email' | 'phone' | 'avatarUrl' | 'isAnonymous'>;
  },
): InboxConversationItem {
  return {
    id: c.id,
    channel: c.channel,
    status: c.status,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
    intent: c.intent,
    leadTemperature: c.leadTemperature,
    handoffRequestedAt: c.handoffRequestedAt?.toISOString() ?? null,
    assignedTo: c.assignedTo,
    customer: {
      id: c.customer.id,
      name: c.customer.name,
      email: c.customer.email,
      phone: c.customer.phone,
      avatarUrl: c.customer.avatarUrl,
      isAnonymous: c.customer.isAnonymous,
    },
  };
}
