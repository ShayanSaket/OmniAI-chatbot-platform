import 'server-only';
import type { Conversation, Message } from '@prisma/client';
import type {
  WidgetAction,
  WidgetConversation,
  WidgetLinkButton,
  WidgetMessage,
  WidgetMessageStatus,
  WidgetRole,
} from '@/lib/widget-protocol';
import { env } from '../../env';
import { signedFileUrl } from '../../storage/files';
import type { StoredAttachment } from '../types';

const ROLE: Record<Message['senderType'], WidgetRole> = {
  CUSTOMER: 'customer',
  AI: 'ai',
  AGENT: 'agent',
  SYSTEM: 'system',
};

function status(m: Message): WidgetMessageStatus {
  if (m.status === 'FAILED') return 'failed';
  if (m.senderType === 'CUSTOMER' && m.status === 'READ') return 'read';
  return 'sent';
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function toWidgetMessage(m: Message & { senderUser?: { name: string | null } | null }): WidgetMessage {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const secret = env().AUTH_SECRET;
  return {
    id: m.id,
    role: ROLE[m.senderType],
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    status: status(m),
    clientMessageId: typeof meta.clientMessageId === 'string' ? meta.clientMessageId : undefined,
    attachments: arr<StoredAttachment>(m.attachments).map((a) => ({
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      url: signedFileUrl(secret, a.key),
    })),
    sources: arr<{ title: string }>(m.sources).map((s) => ({ title: s.title })),
    quickReplies: arr<string>(meta.quickReplies).filter((q) => typeof q === 'string'),
    actions: arr<WidgetAction>(meta.actions),
    buttons: arr<WidgetLinkButton>(meta.buttons),
    authorName: m.senderType === 'AGENT' ? (m.senderUser?.name ?? null) : null,
  };
}

export function toWidgetConversation(
  c: Pick<Conversation, 'id' | 'status' | 'handoffRequestedAt'> & { assignedTo?: { name: string | null } | null },
): WidgetConversation {
  return {
    id: c.id,
    status: c.status,
    agentName: c.status === 'HUMAN_ACTIVE' ? (c.assignedTo?.name ?? null) : null,
    handoffRequested: Boolean(c.handoffRequestedAt),
  };
}
