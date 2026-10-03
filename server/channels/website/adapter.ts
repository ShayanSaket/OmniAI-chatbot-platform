import 'server-only';
import type { Conversation, Message } from '@prisma/client';
import { MAX_ATTACHMENTS } from '@/lib/widget-protocol';
import { channels, publish } from '../../realtime/bus';
import type { ChannelAdapter, DeliveryResult, NormalizedInboundMessage, StoredAttachment } from '../types';
import { toWidgetConversation, toWidgetMessage } from './serialize';

export interface WebsiteInboundPayload {
  organizationId: string;
  channelId: string;
  customerId: string;
  clientMessageId: string;
  content: string;
  attachments: StoredAttachment[];
  pageUrl?: string;
}

/**
 * Website live chat. Inbound messages arrive via the widget API; outbound messages are
 * pushed to the visitor's open widgets over SSE (via the realtime bus). AI replies are
 * additionally streamed token-by-token on the request that triggered them.
 */
export const websiteChannelAdapter: ChannelAdapter<WebsiteInboundPayload> = {
  type: 'WEBSITE',
  capabilities: { streaming: true, quickReplies: true, buttons: true, attachments: true, markdown: true, sources: true },

  async sendMessage(conversation: Conversation, message: Message): Promise<DeliveryResult> {
    await publish(channels.visitor(conversation.customerId), {
      type: 'message',
      message: toWidgetMessage(message),
      // Carries status changes (e.g. waiting for an agent) to every open widget.
      conversation: toWidgetConversation(conversation),
    });
    return { delivered: true };
  },

  normalizeIncomingMessage(raw: WebsiteInboundPayload): NormalizedInboundMessage[] {
    const attachments = raw.attachments.slice(0, MAX_ATTACHMENTS);
    return [
      {
        organizationId: raw.organizationId,
        channel: 'WEBSITE',
        channelId: raw.channelId,
        customerId: raw.customerId,
        // Scoped by customer so client ids can never collide across visitors.
        externalMessageId: `web:${raw.customerId}:${raw.clientMessageId}`,
        content: raw.content.trim(),
        messageType: attachments.length && !raw.content.trim() ? (attachments[0]!.mimeType.startsWith('image/') ? 'IMAGE' : 'DOCUMENT') : 'TEXT',
        attachments,
        metadata: { clientMessageId: raw.clientMessageId, ...(raw.pageUrl ? { pageUrl: raw.pageUrl } : {}) },
        receivedAt: new Date(),
      },
    ];
  },
};
