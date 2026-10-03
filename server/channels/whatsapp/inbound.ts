// Maps WhatsApp message types to our message model. Pure.
import type { MessageType } from '@prisma/client';
import type { WaMessage } from './webhook';

/** Reply-button ids we send (see adapter.ts) and recognize when the customer taps them. */
export const BUTTON_ID = {
  handoff: 'action:handoff',
  quickReplyPrefix: 'qr:',
} as const;

export interface InboundMedia {
  id: string;
  kind: 'image' | 'document' | 'audio' | 'video' | 'sticker';
  mimeType: string | null;
  fileName: string | null;
  voice: boolean;
}

export interface InboundContent {
  content: string;
  messageType: MessageType;
  media: InboundMedia | null;
  metadata: Record<string, unknown>;
  /** The customer tapped "Talk to a human". */
  action: 'handoff' | null;
  /** Nothing to store or answer (reactions, system notices). */
  ignore: boolean;
}

const base = (m: WaMessage): Record<string, unknown> => ({
  whatsappType: m.type,
  ...(m.context?.id ? { replyTo: m.context.id } : {}),
});

export function describeInbound(m: WaMessage): InboundContent {
  const meta = base(m);
  const result = (partial: Partial<InboundContent>): InboundContent => ({
    content: '',
    messageType: 'TEXT',
    media: null,
    metadata: meta,
    action: null,
    ignore: false,
    ...partial,
  });
  const mediaOf = (kind: InboundMedia['kind'], obj: NonNullable<WaMessage['image']>): InboundMedia => ({
    id: obj.id,
    kind,
    mimeType: obj.mime_type?.split(';')[0]?.trim().toLowerCase() ?? null,
    fileName: obj.filename ?? null,
    voice: Boolean(obj.voice),
  });

  switch (m.type) {
    case 'text':
      return result({ content: m.text?.body ?? '' });
    case 'image':
      return m.image ? result({ content: m.image.caption ?? '', messageType: 'IMAGE', media: mediaOf('image', m.image) }) : result({ ignore: true });
    case 'sticker':
      return m.sticker
        ? result({ content: '', messageType: 'IMAGE', media: mediaOf('sticker', m.sticker), metadata: { ...meta, sticker: true } })
        : result({ ignore: true });
    case 'document':
      return m.document
        ? result({ content: m.document.caption ?? '', messageType: 'DOCUMENT', media: mediaOf('document', m.document) })
        : result({ ignore: true });
    case 'audio':
      return m.audio ? result({ content: '', messageType: 'AUDIO', media: mediaOf('audio', m.audio) }) : result({ ignore: true });
    case 'video':
      return m.video ? result({ content: m.video.caption ?? '', messageType: 'VIDEO', media: mediaOf('video', m.video) }) : result({ ignore: true });
    case 'location': {
      const loc = m.location;
      if (!loc) return result({ ignore: true });
      const label = [loc.name, loc.address].filter(Boolean).join(', ');
      return result({
        content: `📍 Shared location${label ? `: ${label}` : ''} (${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)})`,
        messageType: 'LOCATION',
        metadata: { ...meta, location: { latitude: loc.latitude, longitude: loc.longitude, name: loc.name ?? null, address: loc.address ?? null } },
      });
    }
    case 'contacts': {
      const shared = (m.contacts ?? []).map((c) => [c.name?.formatted_name, ...(c.phones ?? []).map((p) => p.phone)].filter(Boolean).join(' '));
      return result({ content: `Shared contact: ${shared.join('; ') || 'unknown'}`, metadata: { ...meta, contacts: shared } });
    }
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      if (!reply) return result({ ignore: true });
      const description = m.interactive?.list_reply?.description;
      if (reply.id === BUTTON_ID.handoff) {
        return result({ content: reply.title, messageType: 'INTERACTIVE', action: 'handoff', metadata: { ...meta, replyId: reply.id } });
      }
      return result({
        content: description ? `${reply.title} — ${description}` : reply.title,
        messageType: 'INTERACTIVE',
        metadata: { ...meta, replyId: reply.id },
      });
    }
    case 'button':
      // Quick-reply button of a template message.
      return m.button ? result({ content: m.button.text, messageType: 'INTERACTIVE', metadata: { ...meta, payload: m.button.payload ?? null } }) : result({ ignore: true });
    case 'reaction':
    case 'system':
    case 'ephemeral':
      return result({ ignore: true });
    default:
      return result({
        content: '(The customer sent a message type that cannot be shown here.)',
        metadata: { ...meta, unsupported: true },
      });
  }
}

/** Status transitions only move forward; "failed" always wins. */
const STATUS_RANK = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 } as const;

export function nextOutboundStatus(
  current: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'RECEIVED',
  incoming: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted',
): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null {
  if (incoming === 'deleted') return null;
  if (incoming === 'failed') return current === 'READ' ? null : 'FAILED';
  const next = incoming.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ';
  if (current === 'FAILED' || current === 'RECEIVED') return next;
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : null;
}
