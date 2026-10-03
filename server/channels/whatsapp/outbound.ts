import 'server-only';
import type { Conversation, Message, Prisma } from '@prisma/client';
import { channels, publish } from '../../realtime/bus';
import { logger } from '../../logger';
import { getObject } from '../../storage/s3';
import { tenantDb, type TenantDb } from '../../tenancy/tenant-db';
import type { DeliveryResult, StoredAttachment } from '../types';
import { graphConfigFor, WhatsAppNotConfiguredError } from './account';
import { buildTextPayloads, markdownToWhatsApp, type GraphMessagePayload, type OutboundContent, type ReplyButton } from './format';
import { createGraphClient, WhatsAppApiError } from './graph-client';
import { BUTTON_ID } from './inbound';

/** WhatsApp only allows free-form messages within 24h of the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Background retries for failed sends (minutes after each failed attempt). */
const RETRY_MINUTES = [1, 5, 15, 60];
export const MAX_DELIVERY_ATTEMPTS = RETRY_MINUTES.length + 1;

export function isWithinServiceWindow(lastCustomerMessageAt: Date | null, now = new Date()): boolean {
  return Boolean(lastCustomerMessageAt && now.getTime() - lastCustomerMessageAt.getTime() < SERVICE_WINDOW_MS);
}

interface DeliveryMeta {
  attempts: number;
  retryable?: boolean;
  /** Epoch ms of the next background retry. */
  nextAttemptAt?: number | null;
  lastError?: string;
  sentAt?: string;
  wamids?: string[];
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Translates a stored message into WhatsApp content (text + buttons). */
export function outboundContentFor(message: Message, options: { showSources: boolean }): OutboundContent {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  let text = message.senderType === 'SYSTEM' ? message.content : markdownToWhatsApp(message.content);
  const sources = arr<{ title: string }>(message.sources);
  if (options.showSources && sources.length) text += `\n\n_Sources: ${sources.map((s) => s.title).join(', ')}_`;

  const replyButtons: ReplyButton[] = [
    ...arr<{ label: string; action: string }>(meta.actions)
      .filter((a) => a.action === 'handoff')
      .map((a) => ({ id: BUTTON_ID.handoff, title: a.label })),
    ...arr<string>(meta.quickReplies)
      .filter((q) => typeof q === 'string')
      .map((q) => ({ id: `${BUTTON_ID.quickReplyPrefix}${q.slice(0, 200)}`, title: q })),
  ].slice(0, 3);

  const links = arr<{ label: string; url: string }>(meta.buttons).filter((b) => /^https:\/\//.test(b.url));
  let linkButton: OutboundContent['linkButton'];
  if (links.length === 1 && replyButtons.length === 0) linkButton = links[0];
  else if (links.length) text += `\n\n${links.map((l) => `${l.label}: ${l.url}`).join('\n')}`;

  return { text: text.trim(), replyButtons, linkButton };
}

async function updateDelivery(db: TenantDb, message: Message, data: { status: Message['status']; errorCode?: string | null; externalMessageId?: string; delivery: DeliveryMeta }) {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  return db.message.update({
    where: { id: message.id },
    data: {
      status: data.status,
      errorCode: data.errorCode ?? null,
      ...(data.externalMessageId ? { externalMessageId: data.externalMessageId } : {}),
      metadata: { ...meta, delivery: data.delivery } as unknown as Prisma.InputJsonValue,
    },
  });
}

async function mediaPayloads(client: ReturnType<typeof createGraphClient>, to: string, attachments: StoredAttachment[]): Promise<GraphMessagePayload[]> {
  const out: GraphMessagePayload[] = [];
  for (const a of attachments) {
    const object = await getObject(a.key);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const id = await client.uploadMedia(bytes, a.mimeType, a.fileName);
    const kind = a.mimeType.startsWith('image/') ? 'image' : a.mimeType.startsWith('audio/') ? 'audio' : a.mimeType.startsWith('video/') ? 'video' : 'document';
    out.push({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: kind,
      [kind]: kind === 'document' ? { id, filename: a.fileName } : { id },
    });
  }
  return out;
}

/**
 * Sends a stored outbound message (AI, agent or system) to the customer on WhatsApp and
 * records the result on the message: wamid + SENT, or FAILED with an error code and,
 * for transient errors, a scheduled background retry.
 */
export async function deliverWhatsAppMessage(conversation: Pick<Conversation, 'id' | 'organizationId' | 'customerId' | 'channelId' | 'lastCustomerMessageAt'>, message: Message): Promise<DeliveryResult> {
  const db = tenantDb(conversation.organizationId);
  const previous = ((message.metadata ?? {}) as { delivery?: DeliveryMeta }).delivery;
  if (message.externalMessageId) return { delivered: true, externalMessageId: message.externalMessageId };
  const attempts = (previous?.attempts ?? 0) + 1;
  const log = logger.child({ organizationId: conversation.organizationId, conversationId: conversation.id, messageId: message.id, channel: 'WHATSAPP' });
  /** Parts already delivered (kept across attempts so a retry never duplicates them). */
  const wamids: string[] = [...(previous?.wamids ?? [])];

  const fail = async (errorCode: string, error: string, retryable: boolean) => {
    const canRetry = retryable && attempts < MAX_DELIVERY_ATTEMPTS;
    await updateDelivery(db, message, {
      status: 'FAILED',
      errorCode,
      delivery: {
        attempts,
        retryable: canRetry,
        nextAttemptAt: canRetry ? Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000 : null,
        lastError: error.slice(0, 300),
        ...(wamids.length ? { wamids } : {}),
      },
    });
    await publish(channels.inbox(conversation.organizationId), { type: 'message.failed', conversationId: conversation.id, messageId: message.id, errorCode });
    log.warn('whatsapp delivery failed', { errorCode, error, attempts, willRetry: canRetry });
    return { delivered: false, error };
  };

  const [account, identity, latest] = await Promise.all([
    db.whatsAppAccount.findFirst({ where: { channelId: conversation.channelId }, include: { channel: { select: { botId: true } } } }),
    db.customerIdentity.findFirst({ where: { customerId: conversation.customerId, channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' } }),
    db.conversation.findUnique({ where: { id: conversation.id }, select: { lastCustomerMessageAt: true } }),
  ]);
  if (!account) return fail('whatsapp_not_connected', 'No WhatsApp number is connected for this channel.', false);
  if (!identity) return fail('whatsapp_no_recipient', 'The customer has no WhatsApp number.', false);

  // Template messages are the only thing allowed outside the 24h window.
  if (message.messageType !== 'TEMPLATE' && !isWithinServiceWindow(latest?.lastCustomerMessageAt ?? conversation.lastCustomerMessageAt)) {
    return fail('whatsapp_window_closed', 'The 24-hour customer service window has closed. Send an approved template instead.', false);
  }

  let client;
  try {
    client = createGraphClient(graphConfigFor(account));
  } catch (err) {
    if (err instanceof WhatsAppNotConfiguredError) return fail('whatsapp_not_configured', err.message, false);
    throw err;
  }

  const bot = account.channel.botId
    ? await db.botConfiguration.findUnique({ where: { id: account.channel.botId }, select: { showSourcesWhatsapp: true } })
    : await db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { showSourcesWhatsapp: true } });

  const to = identity.externalId;
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  try {
    const payloads: GraphMessagePayload[] =
      message.messageType === 'TEMPLATE' && meta.template
        ? [{ messaging_product: 'whatsapp', to, type: 'template', template: meta.template }]
        : [
            ...(message.content.trim() ? buildTextPayloads(to, outboundContentFor(message, { showSources: Boolean(bot?.showSourcesWhatsapp) })) : []),
            ...(await mediaPayloads(client, to, arr<StoredAttachment>(message.attachments))),
          ];
    // Parts already sent by an earlier, partially failed attempt are skipped.
    for (const payload of payloads.slice(wamids.length)) wamids.push(await client.sendMessage(payload));
  } catch (err) {
    if (err instanceof WhatsAppApiError) return fail(`whatsapp_${err.kind}`, err.message, err.retryable);
    return fail('whatsapp_error', (err as Error).message, true);
  }

  const [first] = wamids;
  await updateDelivery(db, message, {
    status: 'SENT',
    externalMessageId: first,
    delivery: { attempts, sentAt: new Date().toISOString(), wamids },
  });
  log.info('whatsapp message sent', { parts: wamids.length, attempts });
  return { delivered: true, externalMessageId: first };
}
