import 'server-only';
import { randomUUID } from 'node:crypto';
import { Prisma, type InboundWebhookEvent } from '@prisma/client';
import { recordUsage } from '../../ai/usage';
import { ProviderNotConfiguredError } from '../../ai/provider';
import { MAX_TRANSCRIPTION_BYTES, transcribeAudio } from '../../ai/transcription';
import { runInBackground } from '../../background';
import { prisma } from '../../db';
import { AppError } from '../../errors';
import { emitDomainEvent } from '../../events/domain-events';
import { withLock } from '../../locks';
import { logger } from '../../logger';
import { rateLimit, RATE_LIMITS } from '../../rate-limit';
import { channels, publish } from '../../realtime/bus';
import { newObjectKey, safeFileName, typeForProviderMedia } from '../../storage/files';
import { putObject } from '../../storage/s3';
import { tenantDb, type TenantDb } from '../../tenancy/tenant-db';
import { processInboundMessage } from '../../modules/chat/pipeline';
import type { StoredAttachment } from '../types';
import { findAccountByPhoneNumberId, graphConfigFor, webhookConfig, WhatsAppNotConfiguredError, type RoutedAccount } from './account';
import { whatsappChannelAdapter } from './adapter';
import { createGraphClient, type GraphClient } from './graph-client';
import { describeInbound, nextOutboundStatus, type InboundMedia } from './inbound';
import { parseWebhookPayload, verifyWebhookSignature, waIdToE164, type WebhookEvent } from './webhook';

// Inbound WhatsApp processing.
//
//   POST /api/webhooks/whatsapp → verify signature → split into events → store each one
//   (unique per provider event id = idempotency) → 200 OK → process in the background.
//
// Each stored event is claimed with a lease, processed, and marked PROCESSED / IGNORED,
// or FAILED with a backoff for the scheduler (jobs/whatsapp-jobs.ts) to retry.

export const PROVIDER = 'whatsapp';
/** Seconds after each failed attempt before the next one; after the last, give up. */
const RETRY_SECONDS = [30, 120, 600, 1800];
export const MAX_EVENT_ATTEMPTS = RETRY_SECONDS.length + 1;
/** A claimed event is invisible to other workers for this long. */
const LEASE_MS = 5 * 60 * 1000;
/** Inbound media we download and keep (larger files are referenced, not stored). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

class RetryLaterError extends Error {}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  skipped: number;
  eventIds: string[];
}

/** Verifies and stores a webhook delivery. Throws AppError for bad signatures. */
export async function ingestWhatsAppWebhook(rawBody: string, signature: string | null): Promise<IngestResult> {
  const { appSecret } = webhookConfig();
  if (!appSecret) throw new AppError('INTERNAL', 'WhatsApp webhook is not configured (WHATSAPP_APP_SECRET missing).');
  if (!verifyWebhookSignature(rawBody, signature, appSecret)) {
    throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature.');
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new AppError('BAD_REQUEST', 'Invalid JSON.');
  }
  const { events, skipped } = parseWebhookPayload(body);
  const result: IngestResult = { accepted: 0, duplicates: 0, skipped, eventIds: [] };
  for (const event of events) {
    // Meta redelivers webhooks; the unique (provider, eventId) turns repeats into no-ops.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "InboundWebhookEvent" ("id", "provider", "eventId", "eventType", "payload", "status", "attempts", "nextAttemptAt", "createdAt")
      VALUES (${randomUUID()}, ${PROVIDER}, ${event.eventId}, ${event.kind}, ${JSON.stringify(event)}::jsonb,
              'RECEIVED'::"InboundEventStatus", 0, now(), now())
      ON CONFLICT ("provider", "eventId") DO NOTHING
      RETURNING "id"`;
    if (rows[0]) {
      result.accepted++;
      result.eventIds.push(rows[0].id);
    } else {
      result.duplicates++;
    }
  }
  if (skipped) logger.warn('whatsapp webhook items skipped (malformed)', { skipped });
  return result;
}

/** Ingests and schedules background processing (used by the webhook route). */
export async function receiveWhatsAppWebhook(rawBody: string, signature: string | null) {
  const result = await ingestWhatsAppWebhook(rawBody, signature);
  for (const id of result.eventIds) runInBackground('whatsapp-event', () => processWebhookEvent(id), { eventId: id });
  return result;
}

/** Atomically claims an event for processing (lease), so concurrent workers never double-process. */
async function claim(id: string): Promise<InboundWebhookEvent | null> {
  const now = new Date();
  const claimed = await prisma.inboundWebhookEvent.updateMany({
    where: {
      id,
      status: { in: ['RECEIVED', 'FAILED'] },
      attempts: { lt: MAX_EVENT_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return null;
  return prisma.inboundWebhookEvent.findUnique({ where: { id } });
}

export async function processWebhookEvent(id: string): Promise<'processed' | 'ignored' | 'failed' | 'skipped'> {
  const row = await claim(id);
  if (!row) return 'skipped';
  const event = row.payload as unknown as WebhookEvent | null;
  const log = logger.child({ webhookEventId: row.id, provider: PROVIDER, eventType: row.eventType, attempt: row.attempts });

  const finish = (status: 'PROCESSED' | 'IGNORED', organizationId: string | null, note?: string) =>
    prisma.inboundWebhookEvent.update({
      where: { id: row.id },
      // The payload holds personal data: drop it once handled (data minimization).
      data: { status, organizationId, processedAt: new Date(), nextAttemptAt: null, error: note ?? null, payload: Prisma.DbNull },
    });

  if (!event) {
    await finish('IGNORED', row.organizationId, 'Empty payload');
    return 'ignored';
  }
  const account = await findAccountByPhoneNumberId(event.phoneNumberId);
  if (!account || !account.channel.isActive) {
    log.warn('whatsapp event for unknown or inactive number', { phoneNumberId: event.phoneNumberId });
    await finish('IGNORED', account?.organizationId ?? null, 'Unknown or inactive phone number');
    return 'ignored';
  }
  await prisma.inboundWebhookEvent.update({ where: { id: row.id }, data: { organizationId: account.organizationId } });

  try {
    const outcome =
      event.kind === 'message'
        ? await withLock(`wa:${account.organizationId}:${event.message.from}`, () => handleMessage(account, event))
        : await handleStatus(account, event, row.createdAt);
    await finish(outcome === 'ignored' ? 'IGNORED' : 'PROCESSED', account.organizationId);
    log.info('whatsapp event handled', { organizationId: account.organizationId, outcome });
    return outcome === 'ignored' ? 'ignored' : 'processed';
  } catch (err) {
    const delay = RETRY_SECONDS[row.attempts - 1];
    const giveUp = delay === undefined;
    await prisma.inboundWebhookEvent.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        error: (err as Error).message.slice(0, 500),
        nextAttemptAt: giveUp ? null : new Date(Date.now() + delay * 1000),
      },
    });
    const level = err instanceof RetryLaterError ? 'info' : 'error';
    log[level]('whatsapp event failed', { organizationId: account.organizationId, err: (err as Error).message, willRetry: !giveUp });
    return 'failed';
  }
}

// ── Messages ──────────────────────────────────────────────────────────────

/** Finds or creates the customer behind a WhatsApp number (also links earlier website profiles with that phone). */
export async function resolveWhatsAppCustomer(db: TenantDb, organizationId: string, waId: string, profileName: string | null) {
  const identity = await db.customerIdentity.findUnique({
    where: { organizationId_channel_externalId: { organizationId, channel: 'WHATSAPP', externalId: waId } },
    select: { customer: { select: { id: true, name: true } } },
  });
  if (identity) {
    if (!identity.customer.name && profileName) await db.customer.update({ where: { id: identity.customer.id }, data: { name: profileName } });
    return { customerId: identity.customer.id, created: false };
  }

  const digits = waId.replace(/\D/g, '');
  // A customer who shared this phone number on the website becomes the same profile.
  const [match] = await prisma.$queryRaw<{ id: string; name: string | null }[]>`
    SELECT "id", "name" FROM "Customer"
    WHERE "organizationId" = ${organizationId} AND "mergedIntoId" IS NULL AND "phone" IS NOT NULL
      AND regexp_replace(regexp_replace("phone", '\\D', '', 'g'), '^00', '') = ${digits}
    ORDER BY "createdAt" ASC LIMIT 1`;

  try {
    if (match) {
      await db.customerIdentity.create({ data: { organizationId, customerId: match.id, channel: 'WHATSAPP', externalId: waId } });
      if (!match.name && profileName) await db.customer.update({ where: { id: match.id }, data: { name: profileName } });
      return { customerId: match.id, created: false };
    }
    const customer = await db.customer.create({
      data: {
        organizationId,
        phone: waIdToE164(waId),
        name: profileName,
        isAnonymous: false,
        lastSeenAt: new Date(),
        identities: { create: { organizationId, channel: 'WHATSAPP', externalId: waId } },
      },
      select: { id: true },
    });
    await publish(channels.inbox(organizationId), { type: 'customer.created', customerId: customer.id });
    emitDomainEvent({ type: 'customer.created', organizationId, refs: { customerId: customer.id }, data: { channel: 'WHATSAPP' } });
    return { customerId: customer.id, created: true };
  } catch (err) {
    // Two events for a new number raced: the other one created the identity.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return resolveWhatsAppCustomer(db, organizationId, waId, profileName);
    }
    throw err;
  }
}

async function storeMedia(params: {
  graph: GraphClient;
  db: TenantDb;
  organizationId: string;
  customerId: string;
  media: InboundMedia;
}): Promise<{ attachment: StoredAttachment | null; bytes: Uint8Array | null; note: string | null }> {
  const { graph, media } = params;
  try {
    const info = await graph.getMediaInfo(media.id);
    if (info.file_size && info.file_size > MAX_MEDIA_BYTES) return { attachment: null, bytes: null, note: '(Attachment too large to store.)' };
    const bytes = await graph.downloadMedia(info.url, MAX_MEDIA_BYTES);
    const declared = media.mimeType ?? info.mime_type ?? null;
    const type = typeForProviderMedia(declared, bytes, media.fileName ?? '');
    if (!type) {
      logger.warn('whatsapp media rejected (type not allowed or content mismatch)', { organizationId: params.organizationId, declared });
      return { attachment: null, bytes: null, note: '(The attachment type is not supported.)' };
    }
    const fileName = safeFileName(media.fileName ?? `whatsapp-${media.kind}`, type.ext);
    const key = newObjectKey(params.organizationId, params.customerId, fileName);
    await putObject(key, bytes, type.mime);
    return { attachment: { key, fileName, mimeType: type.mime, size: bytes.byteLength }, bytes, note: null };
  } catch (err) {
    logger.warn('whatsapp media could not be stored', { organizationId: params.organizationId, err: (err as Error).message });
    if ((err as { retryable?: boolean }).retryable) throw new RetryLaterError(`Media download failed: ${(err as Error).message}`);
    return { attachment: null, bytes: null, note: '(The attachment could not be loaded.)' };
  }
}

async function handleMessage(account: RoutedAccount, event: Extract<WebhookEvent, { kind: 'message' }>): Promise<'processed' | 'ignored'> {
  const organizationId = account.organizationId;
  const db = tenantDb(organizationId);
  const described = describeInbound(event.message);
  if (described.ignore) return 'ignored';

  // Already stored (e.g. retry after a crash later in the pipeline): nothing to redo.
  const existing = await db.message.findFirst({ where: { channel: 'WHATSAPP', externalMessageId: event.message.id }, select: { id: true } });
  if (existing) return 'processed';

  const { customerId } = await resolveWhatsAppCustomer(db, organizationId, event.message.from, event.contactName);

  let graph: GraphClient | null = null;
  try {
    graph = createGraphClient(graphConfigFor(account));
  } catch (err) {
    if (!(err instanceof WhatsAppNotConfiguredError)) throw err;
    logger.warn('whatsapp access token missing: storing message without media or reply', { organizationId });
  }
  // Blue ticks + typing indicator while the AI works (best effort).
  graph?.markRead(event.message.id).catch((err) => logger.debug('whatsapp markRead failed', { err: (err as Error).message }));

  let content = described.content;
  const attachments: StoredAttachment[] = [];
  if (described.media && graph) {
    const stored = await storeMedia({ graph, db, organizationId, customerId, media: described.media });
    if (stored.attachment) attachments.push(stored.attachment);
    if (stored.note) content = [content, stored.note].filter(Boolean).join('\n');
    if (described.media.kind === 'audio' && stored.attachment && stored.bytes) {
      content = [content, await transcribe(db, organizationId, stored.attachment, stored.bytes)].filter(Boolean).join('\n');
    }
  } else if (described.media) {
    content = [content, '(Attachment received.)'].filter(Boolean).join('\n');
  }

  const [inbound] = whatsappChannelAdapter.normalizeIncomingMessage({
    organizationId,
    channelId: account.channelId,
    customerId,
    message: event.message,
    described,
    content,
    attachments,
  });

  const bot = account.channel.botId
    ? await db.botConfiguration.findUnique({ where: { id: account.channel.botId } })
    : await db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!bot) throw new Error('No bot configured for this organization');

  // Cost guard: a sender flooding the number gets stored, not answered, past the limit.
  const limited = !(await rateLimit(RATE_LIMITS.whatsappAiPerCustomer, `${organizationId}:${customerId}`)).allowed;

  await processInboundMessage(
    { db, bot, timeZone: account.organization.timezone, businessHours: account.organization.businessHours },
    inbound!,
    () => {},
    { aiReply: bot.isActive && Boolean(graph) && !limited },
  );
  return 'processed';
}

async function transcribe(db: TenantDb, organizationId: string, attachment: StoredAttachment, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_TRANSCRIPTION_BYTES) return '🎤 Voice message (too long to transcribe)';
  const started = Date.now();
  try {
    const { text, model } = await transcribeAudio(bytes, attachment.mimeType, attachment.fileName);
    await recordUsage(db, {
      organizationId,
      kind: 'TRANSCRIPTION',
      model,
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: Date.now() - started,
      estimate: { input: '', output: text },
    });
    return text ? `🎤 Voice message: "${text}"` : '🎤 Voice message (no speech detected)';
  } catch (err) {
    if (!(err instanceof ProviderNotConfiguredError)) logger.warn('voice message transcription failed', { organizationId, err: (err as Error).message });
    return '🎤 Voice message (could not be transcribed)';
  }
}

// ── Delivery statuses ─────────────────────────────────────────────────────

/** Statuses can arrive before we stored the wamid of a message we just sent. */
const STATUS_GRACE_MS = 10 * 60 * 1000;

async function handleStatus(account: RoutedAccount, event: Extract<WebhookEvent, { kind: 'status' }>, receivedAt: Date): Promise<'processed' | 'ignored'> {
  const db = tenantDb(account.organizationId);
  const message = await db.message.findFirst({ where: { channel: 'WHATSAPP', externalMessageId: event.status.id } });
  if (!message) {
    if (Date.now() - receivedAt.getTime() < STATUS_GRACE_MS) throw new RetryLaterError('Message for status not stored yet');
    return 'ignored';
  }
  const next = nextOutboundStatus(message.status, event.status.status);
  if (!next) return 'ignored';
  const error = event.status.errors?.[0];
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  await db.message.update({
    where: { id: message.id },
    data: {
      status: next,
      ...(next === 'FAILED'
        ? { errorCode: error?.code === 131047 ? 'whatsapp_window_closed' : `whatsapp_${error?.code ?? 'failed'}` }
        : {}),
      metadata: {
        ...meta,
        whatsappStatus: {
          status: event.status.status,
          at: new Date(Number(event.status.timestamp) * 1000 || Date.now()).toISOString(),
          ...(error ? { error: { code: error.code ?? null, title: error.title ?? error.message ?? null } } : {}),
        },
      } as Prisma.InputJsonValue,
    },
  });
  await publish(channels.inbox(account.organizationId), { type: 'message.status', conversationId: message.conversationId, messageId: message.id, status: next });
  return 'processed';
}
