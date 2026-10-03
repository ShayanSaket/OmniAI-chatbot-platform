// WhatsApp Cloud API webhooks: signature verification and payload parsing. Pure (no
// database, no network), so it is unit-tested directly.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Verifies `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the raw request body
 * with the Meta app secret. Must run on the exact bytes received.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signWebhookBody(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

const media = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

export const waMessageSchema = z
  .object({
    from: z.string(),
    id: z.string().min(1).max(256),
    timestamp: z.string(),
    type: z.string(),
    context: z.object({ id: z.string().optional(), from: z.string().optional() }).partial().optional(),
    text: z.object({ body: z.string() }).optional(),
    image: media.optional(),
    document: media.optional(),
    audio: media.optional(),
    video: media.optional(),
    sticker: media.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
    contacts: z
      .array(
        z
          .object({
            name: z.object({ formatted_name: z.string().optional() }).partial().optional(),
            phones: z.array(z.object({ phone: z.string().optional() }).partial()).optional(),
          })
          .partial(),
      )
      .optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z.object({ id: z.string(), title: z.string(), description: z.string().optional() }).optional(),
      })
      .optional(),
    button: z.object({ payload: z.string().optional(), text: z.string() }).optional(),
    reaction: z.object({ message_id: z.string().optional(), emoji: z.string().optional() }).optional(),
  })
  .passthrough();
export type WaMessage = z.infer<typeof waMessageSchema>;

export const waStatusSchema = z
  .object({
    id: z.string().min(1).max(256),
    status: z.enum(['sent', 'delivered', 'read', 'failed', 'deleted']),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();
export type WaStatus = z.infer<typeof waStatusSchema>;

const valueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string().optional() }),
    contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).partial().optional() })).optional(),
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

export type WebhookEvent =
  | {
      kind: 'message';
      /** Idempotency key: the WhatsApp message id (wamid). */
      eventId: string;
      phoneNumberId: string;
      contactName: string | null;
      message: WaMessage;
    }
  | {
      kind: 'status';
      /** Idempotency key: wamid + status (each transition is one event). */
      eventId: string;
      phoneNumberId: string;
      status: WaStatus;
    };

/**
 * Splits a webhook payload into individual events. Malformed entries are skipped (and
 * counted) instead of failing the whole delivery, so one bad item never blocks others.
 */
export function parseWebhookPayload(body: unknown): { events: WebhookEvent[]; skipped: number } {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return { events: [], skipped: 1 };
  const events: WebhookEvent[] = [];
  let skipped = 0;
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) {
        skipped++;
        continue;
      }
      const { metadata, contacts = [], messages = [], statuses = [] } = value.data;
      for (const raw of messages) {
        const message = waMessageSchema.safeParse(raw);
        if (!message.success) {
          skipped++;
          continue;
        }
        const contact = contacts.find((c) => c.wa_id === message.data.from) ?? contacts[0];
        events.push({
          kind: 'message',
          eventId: message.data.id,
          phoneNumberId: metadata.phone_number_id,
          contactName: contact?.profile?.name?.trim() || null,
          message: message.data,
        });
      }
      for (const raw of statuses) {
        const status = waStatusSchema.safeParse(raw);
        if (!status.success) {
          skipped++;
          continue;
        }
        events.push({ kind: 'status', eventId: `${status.data.id}:${status.data.status}`, phoneNumberId: metadata.phone_number_id, status: status.data });
      }
    }
  }
  return { events, skipped };
}

/** WhatsApp ids are digits without "+"; profiles store E.164. */
export function waIdToE164(waId: string): string {
  return `+${waId.replace(/\D/g, '')}`;
}
