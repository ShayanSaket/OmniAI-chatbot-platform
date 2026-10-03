import 'server-only';
import { randomUUID } from 'node:crypto';
import { isWithinBusinessHours, nextOpening } from '@/lib/business-hours';
import { SUPPORTED_LANGUAGES } from '@/lib/validation';
import type { UploadReceipt, WidgetConfig, WidgetPosition, WidgetSession } from '@/lib/widget-protocol';
import { MAX_UPLOAD_BYTES } from '@/lib/widget-protocol';
import { isOriginAllowed } from '@/lib/origins';
import { toWidgetConversation, toWidgetMessage } from '../../channels/website/serialize';
import { issueVisitorToken, REFRESH_AFTER_SECONDS, verifyVisitorToken } from '../../channels/website/visitor-token';
import type { ResolvedBot, VisitorContext } from '../../channels/website/widget-auth';
import { runInBackground } from '../../background';
import { env } from '../../env';
import { emitDomainEvent } from '../../events/domain-events';
import { AppError } from '../../errors';
import { logger } from '../../logger';
import { channels, publish } from '../../realtime/bus';
import {
  newObjectKey,
  safeFileName,
  signedFileUrl,
  signUploadReceipt,
  sniffFileType,
} from '../../storage/files';
import { putObject } from '../../storage/s3';
import { tenantDb } from '../../tenancy/tenant-db';
import { findActiveConversation, getOrCreateActiveConversation, MESSAGE_INCLUDE, recentMessages } from '../chat/conversation-service';
import { summarizeConversation } from '../agent/memory';
import { requestHumanHandoff } from '../chat/handoff';

/** Only what the public widget needs. Never prompts, rules or internal settings. */
export function publicWidgetConfig(resolved: ResolvedBot, now = new Date()): WidgetConfig {
  const { bot, organization, businessHours } = resolved;
  const online = isWithinBusinessHours(businessHours, organization.timezone, now);
  const quickReplies = Array.isArray(bot.quickReplies) ? (bot.quickReplies as unknown[]).filter((q): q is string => typeof q === 'string') : [];
  return {
    botKey: bot.publicKey,
    agentName: bot.agentName,
    companyName: bot.companyName,
    welcomeMessage: bot.welcomeMessage,
    primaryColor: /^#[0-9a-f]{6}$/i.test(bot.primaryColor) ? bot.primaryColor : '#4f46e5',
    position: (bot.widgetPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right') as WidgetPosition,
    avatarUrl: bot.avatarUrl,
    logoUrl: bot.logoUrl,
    quickReplies: quickReplies.slice(0, 6),
    allowAttachments: bot.allowAttachments,
    showSources: bot.showSourcesWebsite,
    defaultLanguage: bot.defaultLanguage,
    team: {
      online,
      nextOpenAt: online ? null : (nextOpening(businessHours, organization.timezone, now)?.toISOString() ?? null),
    },
  };
}

const SUPPORTED = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.code));

function languageFromLocale(locale: string | undefined): string | null {
  const code = locale?.slice(0, 2).toLowerCase();
  return code && SUPPORTED.has(code) ? code : null;
}

export interface StartSessionInput {
  token?: string | null;
  hostOrigin?: string | null;
  pageUrl?: string | null;
  locale?: string;
}

/**
 * Starts or resumes a visitor session. Verifies the embedding site against the bot's
 * allowed origins, re-uses the customer behind a valid token, or creates an anonymous
 * customer. Conversations are created lazily on the first message (page views alone
 * don't create empty conversations).
 */
export async function startSession(resolved: ResolvedBot, input: StartSessionInput): Promise<WidgetSession> {
  const { bot, organization } = resolved;
  const e = env();
  const appOrigin = new URL(e.APP_URL).origin;
  const hostOrigin = input.hostOrigin || appOrigin;
  if (!isOriginAllowed(hostOrigin, bot.allowedOrigins, appOrigin)) {
    logger.warn('widget blocked on disallowed origin', { organizationId: organization.id, hostOrigin });
    throw new AppError('FORBIDDEN', 'This chat is not enabled for this website.');
  }

  const db = tenantDb(organization.id);
  const claims = input.token ? verifyVisitorToken(input.token, e.AUTH_SECRET) : null;
  let customer =
    claims && claims.botId === bot.id
      ? await db.customer.findUnique({ where: { id: claims.customerId }, select: { id: true, name: true } })
      : null;

  let token = input.token ?? '';
  if (!customer) {
    const created = await db.customer.create({
      data: {
        organizationId: organization.id,
        isAnonymous: true,
        language: languageFromLocale(input.locale),
        lastSeenAt: new Date(),
        identities: {
          create: {
            organizationId: organization.id,
            channel: 'WEBSITE',
            externalId: `visitor_${randomUUID()}`,
            metadata: { hostOrigin, firstPageUrl: input.pageUrl?.slice(0, 500) ?? null, locale: input.locale ?? null },
          },
        },
      },
      select: { id: true, name: true },
    });
    customer = created;
    token = issueVisitorToken({ botId: bot.id, customerId: created.id }, e.AUTH_SECRET);
    await publish(channels.inbox(organization.id), { type: 'customer.created', customerId: created.id });
    emitDomainEvent({ type: 'customer.created', organizationId: organization.id, refs: { customerId: created.id }, data: { channel: 'WEBSITE' } });
  } else if (claims && Date.now() / 1000 - claims.iat > REFRESH_AFTER_SECONDS) {
    token = issueVisitorToken({ botId: bot.id, customerId: customer.id }, e.AUTH_SECRET);
  }

  const conversation = await findActiveConversation(db, customer.id, 'WEBSITE');
  const messages = conversation ? await recentMessages(db, conversation.id, 50) : [];

  return {
    token,
    customer,
    conversation: conversation ? toWidgetConversation(conversation) : null,
    messages: messages.map(toWidgetMessage),
  };
}

export async function messagesSince(visitor: VisitorContext, afterId: string | null) {
  const conversation = await findActiveConversation(visitor.db, visitor.customerId, 'WEBSITE');
  if (!conversation) return { conversation: null, messages: [] };
  let after: Date | undefined;
  if (afterId) {
    const anchor = await visitor.db.message.findFirst({
      where: { id: afterId, conversationId: conversation.id },
      select: { createdAt: true },
    });
    after = anchor?.createdAt;
  }
  const rows = after
    ? await visitor.db.message.findMany({
        where: { conversationId: conversation.id, createdAt: { gt: after } },
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: MESSAGE_INCLUDE,
      })
    : await recentMessages(visitor.db, conversation.id, 50);
  return { conversation: toWidgetConversation(conversation), messages: rows.map(toWidgetMessage) };
}

/** Closes the current conversation; the next message starts a fresh one. */
export async function restartConversation(visitor: VisitorContext) {
  const conversation = await findActiveConversation(visitor.db, visitor.customerId, 'WEBSITE');
  if (conversation) {
    await visitor.db.conversation.update({
      where: { id: conversation.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        aiResolved: conversation.status === 'AI_ACTIVE' && !conversation.handoffRequestedAt,
        metadata: { ...((conversation.metadata as object) ?? {}), closedBy: 'customer' },
      },
    });
    await publish(channels.inbox(visitor.organizationId), { type: 'conversation.closed', conversationId: conversation.id });
    emitDomainEvent({
      type: 'conversation.closed',
      organizationId: visitor.organizationId,
      refs: { conversationId: conversation.id, customerId: visitor.customerId },
      data: { channel: 'WEBSITE', closedBy: 'customer' },
    });
    // Fold the finished conversation into the customer's long-term memory.
    runInBackground(
      'conversation-summary',
      () =>
        summarizeConversation({
          db: visitor.db,
          organizationId: visitor.organizationId,
          conversationId: conversation.id,
          model: visitor.bot.model || env().OPENAI_CHAT_MODEL,
          force: true,
        }),
      { conversationId: conversation.id },
    );
  }
  return { conversation: null, messages: [] };
}

export async function requestHandoffFromWidget(visitor: VisitorContext) {
  // Asking for a human is a valid first action: start the conversation if needed.
  const { conversation } = await getOrCreateActiveConversation(visitor.db, {
    organizationId: visitor.organizationId,
    customerId: visitor.customerId,
    channel: 'WEBSITE',
    channelId: visitor.channelId,
  });
  const result = await requestHumanHandoff({
    db: visitor.db,
    conversation,
    businessHours: visitor.businessHours,
    timeZone: visitor.organization.timezone,
    reason: 'customer_request',
    language:
      (await visitor.db.customer.findUnique({ where: { id: visitor.customerId }, select: { language: true } }))?.language ??
      visitor.bot.defaultLanguage,
  });
  const payload = {
    conversation: toWidgetConversation(result.conversation),
    message: result.message ? toWidgetMessage(result.message) : null,
  };
  if (result.message) {
    await publish(channels.visitor(visitor.customerId), { type: 'message', message: payload.message, conversation: payload.conversation });
  }
  if (!result.alreadyRequested) {
    // Give the team member taking over a summary of what happened so far.
    runInBackground(
      'conversation-summary',
      () =>
        summarizeConversation({
          db: visitor.db,
          organizationId: visitor.organizationId,
          conversationId: conversation.id,
          model: visitor.bot.model || env().OPENAI_CHAT_MODEL,
          force: true,
        }),
      { conversationId: conversation.id },
    );
  }
  return payload;
}

/** Validates (by content, not by declared type), stores and signs an uploaded file. */
export async function uploadVisitorFile(visitor: VisitorContext, file: File): Promise<UploadReceipt> {
  if (!visitor.bot.allowAttachments) throw new AppError('FORBIDDEN', 'File uploads are disabled for this chat.');
  if (file.size === 0) throw new AppError('BAD_REQUEST', 'The file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError('BAD_REQUEST', 'Files can be at most 10 MB.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffFileType(bytes, file.name);
  if (!type) {
    throw new AppError('BAD_REQUEST', 'This file type is not supported. Use images (PNG, JPG, GIF, WebP), PDF, DOCX or text files.');
  }
  const fileName = safeFileName(file.name, type.ext);
  const key = newObjectKey(visitor.organizationId, visitor.customerId, fileName);
  await putObject(key, bytes, type.mime);

  const secret = env().AUTH_SECRET;
  const receipt = { key, mimeType: type.mime, size: bytes.byteLength, customerId: visitor.customerId };
  return {
    key,
    fileName,
    mimeType: type.mime,
    size: bytes.byteLength,
    sig: signUploadReceipt(secret, receipt),
    url: signedFileUrl(secret, key),
  };
}
