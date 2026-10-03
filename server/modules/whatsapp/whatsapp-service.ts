import 'server-only';
import { Prisma } from '@prisma/client';
import { hasPermission } from '@/lib/permissions';
import type { WhatsAppConnectInput, WhatsAppTemplateSendInput } from '@/lib/validation';
import { graphConfigFor, WhatsAppNotConfiguredError } from '../../channels/whatsapp/account';
import { renderTemplateBody, templatePlaceholderCount } from '../../channels/whatsapp/format';
import { createGraphClient, WhatsAppApiError } from '../../channels/whatsapp/graph-client';
import { deliverWhatsAppMessage, isWithinServiceWindow } from '../../channels/whatsapp/outbound';
import { toWidgetMessage } from '../../channels/website/serialize';
import type { ServiceContext } from '../../context';
import { encryptSecret } from '../../crypto';
import { prisma } from '../../db';
import { env } from '../../env';
import { AppError, forbidden, notFound } from '../../errors';
import { auditFromContext } from '../audit/audit-service';
import { appendMessage, MESSAGE_INCLUDE } from '../chat/conversation-service';

// Dashboard-side WhatsApp management: connection (owners), connection test, templates
// and template sending (agents, for conversations outside the 24-hour window).

function assertCanView(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
}
function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'integrations:manage')) throw forbidden('Only workspace owners can manage the WhatsApp connection.');
}

interface TemplateComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string; url?: string }[];
}

/** Templates we can send: body variables only (no header media/variables, no dynamic URL buttons). */
export function templateInfo(components: unknown) {
  const list = (Array.isArray(components) ? components : []) as TemplateComponent[];
  const body = list.find((c) => c.type?.toUpperCase() === 'BODY')?.text ?? '';
  const header = list.find((c) => c.type?.toUpperCase() === 'HEADER');
  const buttons = list.find((c) => c.type?.toUpperCase() === 'BUTTONS')?.buttons ?? [];
  const headerVariables = header ? header.format?.toUpperCase() !== 'TEXT' || /\{\{/.test(header.text ?? '') : false;
  const dynamicButtons = buttons.some((b) => /\{\{/.test(b.url ?? ''));
  return {
    body,
    header: header?.format?.toUpperCase() === 'TEXT' ? (header.text ?? null) : null,
    variables: templatePlaceholderCount(body),
    supported: !headerVariables && !dynamicButtons,
  };
}

export async function getWhatsAppSettings(ctx: ServiceContext) {
  assertCanView(ctx);
  const e = env();
  const [account, templates, events, failed7d] = await Promise.all([
    ctx.db.whatsAppAccount.findFirst({ orderBy: { createdAt: 'asc' } }),
    ctx.db.whatsAppTemplate.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }] }),
    // Global table: scoped explicitly to this organization.
    prisma.inboundWebhookEvent.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, eventType: true, status: true, attempts: true, error: true, createdAt: true, processedAt: true },
    }),
    ctx.db.message.count({ where: { channel: 'WHATSAPP', status: 'FAILED', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
  ]);
  return {
    connected: Boolean(account),
    canManage: hasPermission(ctx.role, 'integrations:manage'),
    webhookUrl: `${e.APP_URL.replace(/\/$/, '')}/api/webhooks/whatsapp`,
    environment: {
      appSecret: Boolean(e.WHATSAPP_APP_SECRET),
      verifyToken: Boolean(e.WHATSAPP_VERIFY_TOKEN),
      accessToken: Boolean(e.WHATSAPP_ACCESS_TOKEN),
    },
    account: account
      ? {
          phoneNumberId: account.phoneNumberId,
          businessAccountId: account.businessAccountId,
          displayPhoneNumber: account.displayPhoneNumber,
          verifiedName: account.verifiedName,
          qualityRating: account.qualityRating,
          lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
          hasOwnToken: Boolean(account.accessTokenEncrypted),
        }
      : null,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      lastSyncedAt: t.lastSyncedAt.toISOString(),
      ...templateInfo(t.components),
    })),
    recentEvents: events.map((ev) => ({ ...ev, createdAt: ev.createdAt.toISOString(), processedAt: ev.processedAt?.toISOString() ?? null })),
    failedDeliveries7d: failed7d,
  };
}
export type WhatsAppSettings = Awaited<ReturnType<typeof getWhatsAppSettings>>;

export async function connectWhatsApp(ctx: ServiceContext, input: WhatsAppConnectInput) {
  assertCanManage(ctx);
  const taken = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId: input.phoneNumberId }, select: { organizationId: true } });
  if (taken && taken.organizationId !== ctx.organizationId) {
    throw new AppError('CONFLICT', 'This phone number is already connected to another workspace.');
  }
  const bot = await ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const channel =
    (await ctx.db.channel.findFirst({ where: { type: 'WHATSAPP' }, orderBy: { createdAt: 'asc' } })) ??
    (await ctx.db.channel.create({ data: { organizationId: ctx.organizationId, type: 'WHATSAPP', name: 'WhatsApp Business', botId: bot?.id ?? null } }));
  const existing = await ctx.db.whatsAppAccount.findFirst({ where: { channelId: channel.id } });
  const token =
    input.accessToken === undefined ? undefined : input.accessToken ? encryptSecret(input.accessToken) : null;
  const data = {
    phoneNumberId: input.phoneNumberId,
    businessAccountId: input.businessAccountId,
    displayPhoneNumber: input.displayPhoneNumber ?? existing?.displayPhoneNumber ?? null,
    ...(token !== undefined ? { accessTokenEncrypted: token } : {}),
    // A different number invalidates the previous verification.
    ...(existing && existing.phoneNumberId !== input.phoneNumberId ? { verifiedName: null, qualityRating: null, lastVerifiedAt: null } : {}),
  };
  if (existing) await ctx.db.whatsAppAccount.update({ where: { id: existing.id }, data });
  else await ctx.db.whatsAppAccount.create({ data: { ...data, organizationId: ctx.organizationId, channelId: channel.id } });
  await ctx.db.channel.update({
    where: { id: channel.id },
    data: { isActive: true, config: { displayPhoneNumber: data.displayPhoneNumber } as Prisma.InputJsonValue },
  });
  await auditFromContext(ctx, existing ? 'whatsapp.updated' : 'whatsapp.connected', { type: 'Channel', id: channel.id }, {
    phoneNumberId: input.phoneNumberId,
    tokenChanged: input.accessToken !== undefined,
  });
  return getWhatsAppSettings(ctx);
}

export async function disconnectWhatsApp(ctx: ServiceContext) {
  assertCanManage(ctx);
  const account = await ctx.db.whatsAppAccount.findFirst();
  if (!account) throw notFound('WhatsApp connection');
  await ctx.db.whatsAppAccount.delete({ where: { id: account.id } });
  // Conversations stay; the channel stops receiving and sending.
  await ctx.db.channel.update({ where: { id: account.channelId }, data: { isActive: false } });
  await auditFromContext(ctx, 'whatsapp.disconnected', { type: 'Channel', id: account.channelId }, { phoneNumberId: account.phoneNumberId });
}

async function clientFor(ctx: ServiceContext) {
  const account = await ctx.db.whatsAppAccount.findFirst();
  if (!account) throw notFound('WhatsApp connection');
  try {
    return { account, client: createGraphClient(graphConfigFor(account)) };
  } catch (err) {
    if (err instanceof WhatsAppNotConfiguredError) throw new AppError('BAD_REQUEST', err.message);
    throw err;
  }
}

function graphFailure(err: unknown): never {
  if (err instanceof WhatsAppApiError) {
    const hint = err.kind === 'auth' ? ' Check the access token and its permissions (whatsapp_business_messaging, whatsapp_business_management).' : '';
    throw new AppError('BAD_REQUEST', `${err.message}${hint}`);
  }
  throw err;
}

/** Calls Meta with the stored credentials and records the verified business name. */
export async function testWhatsAppConnection(ctx: ServiceContext) {
  assertCanView(ctx);
  const { account, client } = await clientFor(ctx);
  const info = await client.getPhoneNumber().catch(graphFailure);
  await ctx.db.whatsAppAccount.update({
    where: { id: account.id },
    data: {
      verifiedName: info.verified_name ?? null,
      qualityRating: info.quality_rating ?? null,
      displayPhoneNumber: info.display_phone_number ?? account.displayPhoneNumber,
      lastVerifiedAt: new Date(),
    },
  });
  return { verifiedName: info.verified_name ?? null, displayPhoneNumber: info.display_phone_number ?? null, qualityRating: info.quality_rating ?? null };
}

/** Pulls message templates from Meta; templates deleted there are removed here. */
export async function syncWhatsAppTemplates(ctx: ServiceContext) {
  assertCanView(ctx);
  const { client } = await clientFor(ctx);
  const remote = await client.listTemplates().catch(graphFailure);
  const now = new Date();
  await ctx.db.$transaction(async (tx) => {
    for (const t of remote) {
      const data = { category: t.category, status: t.status, components: (t.components ?? []) as Prisma.InputJsonValue, metaTemplateId: t.id ?? null, lastSyncedAt: now };
      await tx.whatsAppTemplate.upsert({
        where: { organizationId_name_language: { organizationId: ctx.organizationId, name: t.name, language: t.language } },
        create: { organizationId: ctx.organizationId, name: t.name, language: t.language, ...data },
        update: data,
      });
    }
    await tx.whatsAppTemplate.deleteMany({ where: { lastSyncedAt: { lt: now } } });
  });
  await auditFromContext(ctx, 'whatsapp.templates_synced', { type: 'WhatsAppTemplate' }, { count: remote.length });
  return (await getWhatsAppSettings(ctx)).templates;
}

/**
 * Sends an approved template into a WhatsApp conversation (the only way to reach a
 * customer after the 24-hour window). Stored as an agent message.
 */
export async function sendWhatsAppTemplate(ctx: ServiceContext, conversationId: string, input: WhatsAppTemplateSendInput) {
  if (!hasPermission(ctx.role, 'conversations:reply')) throw forbidden();
  const [conversation, template] = await Promise.all([
    ctx.db.conversation.findUnique({ where: { id: conversationId } }),
    ctx.db.whatsAppTemplate.findUnique({ where: { id: input.templateId } }),
  ]);
  if (!conversation) throw notFound('Conversation');
  if (conversation.channel !== 'WHATSAPP') throw new AppError('BAD_REQUEST', 'Templates can only be sent in WhatsApp conversations.');
  if (!template) throw notFound('Template');
  if (template.status !== 'APPROVED') throw new AppError('BAD_REQUEST', 'Only templates approved by Meta can be sent.');
  const info = templateInfo(template.components);
  if (!info.supported) throw new AppError('BAD_REQUEST', 'Templates with header media or dynamic link buttons cannot be sent from here yet.');
  if (input.params.length !== info.variables) {
    throw new AppError('VALIDATION_FAILED', `This template needs ${info.variables} variable(s).`, { params: [`Fill in ${info.variables} variable(s)`] });
  }
  const payload = {
    name: template.name,
    language: { code: template.language },
    ...(input.params.length ? { components: [{ type: 'body', parameters: input.params.map((text) => ({ type: 'text', text })) }] } : {}),
  };
  const message = await appendMessage(ctx.db, conversation, {
    senderType: 'AGENT',
    senderUserId: ctx.userId,
    messageType: 'TEMPLATE',
    content: [info.header, renderTemplateBody(info.body, input.params)].filter(Boolean).join('\n\n'),
    status: 'PENDING',
    metadata: { template: payload, templateName: template.name } as Prisma.InputJsonValue,
  });
  const result = await deliverWhatsAppMessage(conversation, message);
  const stored = await ctx.db.message.findUniqueOrThrow({ where: { id: message.id }, include: MESSAGE_INCLUDE });
  return { delivered: result.delivered, error: result.error ?? null, message: toWidgetMessage(stored), status: stored.status };
}

/** Whether free-form replies are currently possible (for the inbox composer, phase 6). */
export async function whatsappWindowState(ctx: ServiceContext, conversationId: string) {
  const conversation = await ctx.db.conversation.findUnique({ where: { id: conversationId }, select: { channel: true, lastCustomerMessageAt: true } });
  if (!conversation) throw notFound('Conversation');
  const open = conversation.channel !== 'WHATSAPP' || isWithinServiceWindow(conversation.lastCustomerMessageAt);
  return {
    open,
    closesAt: conversation.lastCustomerMessageAt ? new Date(conversation.lastCustomerMessageAt.getTime() + 24 * 3_600_000).toISOString() : null,
  };
}
