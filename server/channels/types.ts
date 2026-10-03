import type { ChannelType, Conversation, Message, MessageType } from '@prisma/client';

/** A stored attachment reference (Message.attachments JSON). */
export interface StoredAttachment {
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/** Provider-independent inbound message, produced by a channel adapter. */
export interface NormalizedInboundMessage {
  organizationId: string;
  channel: ChannelType;
  channelId: string;
  customerId: string;
  /** Idempotency key: provider message id or client-generated id. */
  externalMessageId: string;
  content: string;
  messageType: MessageType;
  attachments: StoredAttachment[];
  metadata: Record<string, unknown>;
  receivedAt: Date;
}

export interface DeliveryResult {
  delivered: boolean;
  externalMessageId?: string;
  error?: string;
}

export interface ChannelCapabilities {
  streaming: boolean;
  quickReplies: boolean;
  buttons: boolean;
  attachments: boolean;
  markdown: boolean;
  /** Show knowledge-source names under answers by default. */
  sources: boolean;
}

/**
 * Each channel (website, WhatsApp, later Instagram/Messenger/Telegram/SMS/email) implements
 * this interface. Business logic only talks to adapters, never to provider APIs.
 */
export interface ChannelAdapter<Raw = unknown> {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;
  /** Delivers an outbound message (AI, agent or system) to the customer. */
  sendMessage(conversation: Conversation, message: Message): Promise<DeliveryResult>;
  /** Converts a provider payload into normalized inbound messages. */
  normalizeIncomingMessage(raw: Raw): NormalizedInboundMessage[];
  /** Applies provider delivery/read receipts. */
  handleStatusUpdate?(raw: Raw): Promise<void>;
}
