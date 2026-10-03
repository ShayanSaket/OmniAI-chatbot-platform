import 'server-only';
import type { Conversation, Message } from '@prisma/client';
import type { ChannelAdapter, DeliveryResult, NormalizedInboundMessage, StoredAttachment } from '../types';
import type { InboundContent } from './inbound';
import { deliverWhatsAppMessage } from './outbound';
import type { WaMessage } from './webhook';

/** A WhatsApp message after routing (tenant, customer) and media download. */
export interface ResolvedWhatsAppInbound {
  organizationId: string;
  channelId: string;
  customerId: string;
  message: WaMessage;
  described: InboundContent;
  /** Content after enrichment (e.g. voice-message transcript). */
  content: string;
  attachments: StoredAttachment[];
}

/**
 * WhatsApp Cloud API. Inbound messages arrive via the webhook (processor.ts); outbound
 * messages go through the Graph API with WhatsApp formatting, reply buttons, the 24h
 * service-window rule and retries (outbound.ts).
 */
export const whatsappChannelAdapter: ChannelAdapter<ResolvedWhatsAppInbound> = {
  type: 'WHATSAPP',
  capabilities: { streaming: false, quickReplies: true, buttons: true, attachments: true, markdown: false, sources: false },

  sendMessage(conversation: Conversation, message: Message): Promise<DeliveryResult> {
    return deliverWhatsAppMessage(conversation, message);
  },

  normalizeIncomingMessage(raw: ResolvedWhatsAppInbound): NormalizedInboundMessage[] {
    return [
      {
        organizationId: raw.organizationId,
        channel: 'WHATSAPP',
        channelId: raw.channelId,
        customerId: raw.customerId,
        // The wamid is globally unique: duplicate webhooks hit the unique index.
        externalMessageId: raw.message.id,
        content: raw.content.trim(),
        messageType: raw.described.messageType,
        attachments: raw.attachments,
        metadata: { ...raw.described.metadata, ...(raw.described.action ? { action: raw.described.action } : {}) },
        receivedAt: new Date(Number(raw.message.timestamp) * 1000 || Date.now()),
      },
    ];
  },
};
