import 'server-only';
import { Prisma, type ChannelType } from '@prisma/client';
import type { CustomerFilters, CustomerListItem, CustomerProfile, CustomerUpdateInput, TagItem } from '@/lib/customers';
import { leadReference } from '@/lib/leads';
import { hasPermission, type Permission } from '@/lib/permissions';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';
import { AppError, forbidden, notFound } from '../../errors';
import { logger } from '../../logger';
import { channels, publish } from '../../realtime/bus';
import { customerKeyPrefix } from '../../storage/files';
import { deletePrefix } from '../../storage/s3';
import { mergeMemory, parseCustomerMemory, ticketReference } from '../agent/memory';
import { auditFromContext } from '../audit/audit-service';

// Customer profiles (spec §11), tags, safe merging of duplicate profiles and the GDPR
// tools: export (Art. 15/20) and erasure (Art. 17) of a customer or a conversation.

const PAGE_SIZE = 50;
const OPEN_LEADS = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL'] as const;
const TAG_COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#14b8a6', '#6366f1', '#ec4899', '#64748b'];

function require(ctx: ServiceContext, permission: Permission) {
  if (!hasPermission(ctx.role, permission)) throw forbidden();
}

async function loadCustomer(ctx: ServiceContext, id: string) {
  const customer = await ctx.db.customer.findFirst({ where: { id, mergedIntoId: null } });
  if (!customer) throw notFound('Customer');
  return customer;
}

const digits = (phone: string) => phone.replace(/\D/g, '').replace(/^00/, '');

// ─── List ─────────────────────────────────────────────────────────────

const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  company: true,
  avatarUrl: true,
  isAnonymous: true,
  language: true,
  lastSeenAt: true,
  createdAt: true,
  identities: { select: { channel: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { createdAt: 'asc' } },
  _count: { select: { conversations: true, leads: { where: { status: { in: [...OPEN_LEADS] } } } } },
} satisfies Prisma.CustomerSelect;

function toListItem(c: Prisma.CustomerGetPayload<{ select: typeof LIST_SELECT }>): CustomerListItem {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    avatarUrl: c.avatarUrl,
    isAnonymous: c.isAnonymous,
    language: c.language,
    channels: Array.from(new Set(c.identities.map((i) => i.channel))),
    tags: c.tags.map((t) => t.tag),
    conversationCount: c._count.conversations,
    openLeadCount: c._count.leads,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCustomers(ctx: ServiceContext, filters: CustomerFilters & { cursor?: string }) {
  require(ctx, 'customers:view');
  const and: Prisma.CustomerWhereInput[] = [{ mergedIntoId: null }];
  if (filters.type === 'identified') and.push({ isAnonymous: false });
  if (filters.type === 'anonymous') and.push({ isAnonymous: true });
  if (filters.channel !== 'all') and.push({ identities: { some: { channel: filters.channel } } });
  if (filters.tag) and.push({ tags: { some: { tagId: filters.tag } } });
  if (filters.q) {
    const contains = { contains: filters.q, mode: 'insensitive' as const };
    and.push({ OR: [{ name: contains }, { email: contains }, { phone: contains }, { company: contains }] });
  }
  const orderBy: Prisma.CustomerOrderByWithRelationInput[] =
    filters.sort === 'name'
      ? [{ name: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
      : filters.sort === 'created'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
  // Offset cursor: sort keys can be null, and lists are browsed a few pages deep at most.
  const skip = Math.max(0, Math.min(Number(filters.cursor) || 0, 100_000));
  const where = { AND: and };
  const [rows, total] = await Promise.all([
    ctx.db.customer.findMany({ where, orderBy, skip, take: PAGE_SIZE + 1, select: LIST_SELECT }),
    skip === 0 ? ctx.db.customer.count({ where }) : Promise.resolve(null),
  ]);
  return {
    items: rows.slice(0, PAGE_SIZE).map(toListItem),
    nextCursor: rows.length > PAGE_SIZE ? String(skip + PAGE_SIZE) : null,
    total,
  };
}

// ─── Profile ──────────────────────────────────────────────────────────

/** Other live profiles with the same email (case-insensitive) or phone (digits). */
export async function findDuplicateCustomers(ctx: ServiceContext, customer: { id: string; email: string | null; phone: string | null }) {
  if (!customer.email && !customer.phone) return [];
  const phone = customer.phone ? digits(customer.phone) : null;
  const rows = await prisma.$queryRaw<{ id: string; name: string | null; email: string | null; phone: string | null; createdAt: Date }[]>`
    SELECT "id", "name", "email", "phone", "createdAt" FROM "Customer"
    WHERE "organizationId" = ${ctx.organizationId} AND "mergedIntoId" IS NULL AND "id" <> ${customer.id}
      AND (
        (${customer.email}::text IS NOT NULL AND lower("email") = lower(${customer.email}::text))
        OR (${phone}::text IS NOT NULL AND length(${phone}::text) >= 6 AND "phone" IS NOT NULL
            AND regexp_replace(regexp_replace("phone", '\\D', '', 'g'), '^00', '') = ${phone}::text)
      )
    ORDER BY "createdAt" ASC LIMIT 5`;
  return rows.map((r) => {
    const matchedOn: ('email' | 'phone')[] = [];
    if (customer.email && r.email?.toLowerCase() === customer.email.toLowerCase()) matchedOn.push('email');
    if (phone && r.phone && digits(r.phone) === phone) matchedOn.push('phone');
    return { id: r.id, name: r.name, email: r.email, phone: r.phone, matchedOn, createdAt: r.createdAt.toISOString() };
  });
}

function identityLabel(i: { channel: ChannelType; externalId: string; metadata: Prisma.JsonValue }) {
  if (i.channel === 'WHATSAPP') return `+${i.externalId}`;
  if (i.channel === 'WEBSITE') {
    const meta = (i.metadata ?? {}) as { hostOrigin?: string };
    try {
      return meta.hostOrigin ? `Visitor on ${new URL(meta.hostOrigin).host}` : 'Website visitor';
    } catch {
      return 'Website visitor';
    }
  }
  return i.externalId;
}

export async function getCustomerProfile(ctx: ServiceContext, id: string): Promise<CustomerProfile> {
  require(ctx, 'customers:view');
  const c = await ctx.db.customer.findFirst({
    where: { id, mergedIntoId: null },
    select: {
      ...LIST_SELECT,
      aiSummary: true,
      customFields: true,
      memory: true,
      consentAt: true,
      identities: { select: { id: true, channel: true, externalId: true, metadata: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!c) throw notFound('Customer');
  const [conversations, leads, tickets, appointments, notes, duplicates] = await Promise.all([
    ctx.db.conversation.findMany({
      where: { customerId: id },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      select: {
        id: true,
        channel: true,
        status: true,
        intent: true,
        lastMessagePreview: true,
        createdAt: true,
        lastMessageAt: true,
        assignedTo: { select: { name: true } },
        summaries: { orderBy: { createdAt: 'desc' }, take: 1, select: { summary: true } },
        _count: { select: { messages: { where: { senderType: { not: 'SYSTEM' } } } } },
      },
    }),
    ctx.db.lead.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ctx.db.ticket.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ctx.db.appointment.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ctx.db.customerNote.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 100, include: { author: { select: { name: true, email: true } } } }),
    findDuplicateCustomers(ctx, c),
  ]);
  const memory = parseCustomerMemory(c.memory);
  const customFields = Object.fromEntries(Object.entries((c.customFields ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
  return {
    ...toListItem({ ...c, identities: c.identities.map((i) => ({ channel: i.channel })) }),
    aiSummary: c.aiSummary,
    customFields,
    memory: { productInterests: memory.productInterests, preferences: memory.preferences, facts: memory.facts },
    consentAt: c.consentAt?.toISOString() ?? null,
    identities: c.identities.map((i) => ({ id: i.id, channel: i.channel, label: identityLabel(i), createdAt: i.createdAt.toISOString() })),
    conversations: conversations.map((v) => ({
      id: v.id,
      channel: v.channel,
      status: v.status,
      intent: v.intent,
      lastMessagePreview: v.lastMessagePreview,
      messageCount: v._count.messages,
      summary: v.summaries[0]?.summary ?? null,
      assignedTo: v.assignedTo?.name ?? null,
      createdAt: v.createdAt.toISOString(),
      lastMessageAt: v.lastMessageAt.toISOString(),
    })),
    leads: leads.map((l) => ({
      id: l.id,
      reference: leadReference(l.id),
      status: l.status,
      temperature: l.temperature,
      requestedService: l.requestedService,
      estimatedValue: l.estimatedValue?.toString() ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
    tickets: tickets.map((t) => ({ id: t.id, reference: ticketReference(t.id), subject: t.subject, status: t.status, priority: t.priority, createdAt: t.createdAt.toISOString() })),
    appointments: appointments.map((a) => ({ id: a.id, topic: a.topic, preferredTime: a.preferredTime, status: a.status, startsAt: a.startsAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString() })),
    notes: notes.map((n) => ({ id: n.id, content: n.content, authorId: n.authorId, authorName: n.author ? (n.author.name ?? n.author.email) : null, createdAt: n.createdAt.toISOString() })),
    duplicates,
  };
}

export async function updateCustomer(ctx: ServiceContext, id: string, input: CustomerUpdateInput) {
  require(ctx, 'customers:manage');
  const current = await loadCustomer(ctx, id);
  const data: Prisma.CustomerUpdateInput = {};
  const changed: string[] = [];
  for (const key of ['name', 'email', 'phone', 'company', 'language'] as const) {
    if (input[key] !== undefined && input[key] !== current[key]) {
      data[key] = input[key];
      changed.push(key);
    }
  }
  if (input.customFields) {
    data.customFields = input.customFields;
    changed.push('customFields');
  }
  const email = input.email !== undefined ? input.email : current.email;
  const phone = input.phone !== undefined ? input.phone : current.phone;
  // A profile with a way to reach the person is no longer anonymous.
  if (current.isAnonymous && (email || phone)) data.isAnonymous = false;
  if (changed.length) {
    await ctx.db.customer.update({ where: { id }, data });
    await publish(channels.inbox(ctx.organizationId), { type: 'customer.updated', customerId: id });
    // Field names only: the audit log must not become a copy of personal data.
    await auditFromContext(ctx, 'customer.updated', { type: 'Customer', id }, { fields: changed });
  }
  return getCustomerProfile(ctx, id);
}

// ─── Tags ─────────────────────────────────────────────────────────────

export async function listTags(ctx: ServiceContext): Promise<TagItem[]> {
  require(ctx, 'customers:view');
  const tags = await ctx.db.tag.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { customers: true } } } });
  return tags.map((t) => ({ id: t.id, name: t.name, color: t.color, customerCount: t._count.customers }));
}

/** Replaces a customer's tags by name; unknown names become new tags. */
export async function setCustomerTags(ctx: ServiceContext, customerId: string, names: string[]) {
  require(ctx, 'customers:manage');
  await loadCustomer(ctx, customerId);
  const unique = Array.from(new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()).filter(Boolean);
  const existing = await ctx.db.tag.findMany({ where: { name: { in: unique, mode: 'insensitive' } } });
  const missing = unique.filter((n) => !existing.some((t) => t.name.toLowerCase() === n.toLowerCase()));
  const total = await ctx.db.tag.count();
  if (missing.length) {
    await ctx.db.tag.createMany({
      data: missing.map((name, i) => ({ organizationId: ctx.organizationId, name, color: TAG_COLORS[(total + i) % TAG_COLORS.length]! })),
      skipDuplicates: true,
    });
  }
  const tags = await ctx.db.tag.findMany({ where: { name: { in: unique, mode: 'insensitive' } }, select: { id: true } });
  await ctx.db.$transaction([
    ctx.db.customerTag.deleteMany({ where: { customerId, tagId: { notIn: tags.map((t) => t.id) } } }),
    ctx.db.customerTag.createMany({ data: tags.map((t) => ({ organizationId: ctx.organizationId, customerId, tagId: t.id })), skipDuplicates: true }),
  ]);
  await publish(channels.inbox(ctx.organizationId), { type: 'customer.updated', customerId });
  return getCustomerProfile(ctx, customerId);
}

export async function updateTag(ctx: ServiceContext, tagId: string, input: { name?: string; color?: string }) {
  require(ctx, 'customers:manage');
  const tag = await ctx.db.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw notFound('Tag');
  if (input.name && input.name.toLowerCase() !== tag.name.toLowerCase()) {
    const clash = await ctx.db.tag.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, id: { not: tagId } } });
    if (clash) throw new AppError('CONFLICT', 'A tag with this name already exists.');
  }
  const updated = await ctx.db.tag.update({ where: { id: tagId }, data: input });
  return { id: updated.id, name: updated.name, color: updated.color };
}

export async function deleteTag(ctx: ServiceContext, tagId: string) {
  require(ctx, 'customers:manage');
  const tag = await ctx.db.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw notFound('Tag');
  await ctx.db.tag.delete({ where: { id: tagId } });
  await auditFromContext(ctx, 'tag.deleted', { type: 'Tag', id: tagId }, { name: tag.name });
}

// ─── Tickets & appointments ───────────────────────────────────────────

export async function updateTicket(ctx: ServiceContext, ticketId: string, input: { status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' }) {
  require(ctx, 'customers:manage');
  const ticket = await ctx.db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw notFound('Ticket');
  const updated = await ctx.db.ticket.update({ where: { id: ticketId }, data: input });
  await auditFromContext(ctx, 'ticket.updated', { type: 'Ticket', id: ticketId }, { ...input, previousStatus: ticket.status });
  return { id: updated.id, status: updated.status, priority: updated.priority };
}

export async function updateAppointment(ctx: ServiceContext, appointmentId: string, input: { status: 'REQUESTED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'; startsAt?: string | null }) {
  require(ctx, 'customers:manage');
  const appointment = await ctx.db.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw notFound('Appointment');
  const updated = await ctx.db.appointment.update({
    where: { id: appointmentId },
    data: { status: input.status, ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}) },
  });
  await auditFromContext(ctx, 'appointment.updated', { type: 'Appointment', id: appointmentId }, { status: input.status, previousStatus: appointment.status });
  return { id: updated.id, status: updated.status, startsAt: updated.startsAt?.toISOString() ?? null };
}

// ─── Merge ────────────────────────────────────────────────────────────

/**
 * Merges `sourceId` into `targetId`: conversations, channel identities, leads, tickets,
 * appointments, notes and tags move to the target; empty target fields are filled from
 * the source; long-term memory is combined. The source stays as an empty tombstone
 * pointing at the target, so open widget sessions follow the merged profile.
 *
 * Merging is a team decision: a visitor typing someone's email must never gain access to
 * that person's history, so website contact details only *suggest* a merge (see
 * duplicates on the profile). Channel-verified identities (a WhatsApp number) are linked
 * automatically when the message arrives.
 */
export async function mergeCustomers(ctx: ServiceContext, targetId: string, sourceId: string) {
  require(ctx, 'customers:manage');
  if (targetId === sourceId) throw new AppError('BAD_REQUEST', 'Choose two different customers.');
  const [target, source] = await Promise.all([loadCustomer(ctx, targetId), loadCustomer(ctx, sourceId)]);
  const now = new Date();

  await ctx.db.$transaction(async (tx) => {
    const move = { where: { customerId: sourceId }, data: { customerId: targetId } };
    await tx.customerIdentity.updateMany(move);
    await tx.conversation.updateMany(move);
    await tx.lead.updateMany(move);
    await tx.ticket.updateMany(move);
    await tx.appointment.updateMany(move);
    await tx.customerNote.updateMany(move);
    const sourceTags = await tx.customerTag.findMany({ where: { customerId: sourceId }, select: { tagId: true } });
    await tx.customerTag.createMany({ data: sourceTags.map((t) => ({ organizationId: ctx.organizationId, customerId: targetId, tagId: t.tagId })), skipDuplicates: true });
    await tx.customerTag.deleteMany({ where: { customerId: sourceId } });

    // One open conversation per channel: older duplicates from the source are closed.
    const open = await tx.conversation.findMany({ where: { customerId: targetId, status: { not: 'CLOSED' } }, orderBy: { lastMessageAt: 'desc' }, select: { id: true, channel: true } });
    const seen = new Set<ChannelType>();
    const toClose = open.filter((c) => (seen.has(c.channel) ? true : (seen.add(c.channel), false))).map((c) => c.id);
    if (toClose.length) await tx.conversation.updateMany({ where: { id: { in: toClose } }, data: { status: 'CLOSED', closedAt: now } });

    const memory = mergeMemory(parseCustomerMemory(target.memory), parseCustomerMemory(source.memory));
    await tx.customer.update({
      where: { id: targetId },
      data: {
        name: target.name ?? source.name,
        email: target.email ?? source.email,
        phone: target.phone ?? source.phone,
        company: target.company ?? source.company,
        language: target.language ?? source.language,
        avatarUrl: target.avatarUrl ?? source.avatarUrl,
        aiSummary: target.aiSummary ?? source.aiSummary,
        consentAt: target.consentAt ?? source.consentAt,
        isAnonymous: target.isAnonymous && source.isAnonymous,
        lastSeenAt: [target.lastSeenAt, source.lastSeenAt].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null,
        memory: memory as unknown as Prisma.InputJsonValue,
        customFields: { ...((source.customFields ?? {}) as object), ...((target.customFields ?? {}) as object) } as Prisma.InputJsonValue,
      },
    });
    // The source becomes an empty pointer (no personal data left on it).
    await tx.customer.update({
      where: { id: sourceId },
      data: { mergedIntoId: targetId, name: null, email: null, phone: null, company: null, avatarUrl: null, aiSummary: null, memory: {}, customFields: {}, isAnonymous: true },
    });
    // Earlier merges into the source now point straight at the target (one hop).
    await tx.customer.updateMany({ where: { mergedIntoId: sourceId }, data: { mergedIntoId: targetId } });
  });

  await publish(channels.inbox(ctx.organizationId), { type: 'customer.updated', customerId: targetId });
  await auditFromContext(ctx, 'customer.merged', { type: 'Customer', id: targetId }, { sourceId });
  return getCustomerProfile(ctx, targetId);
}

// ─── GDPR: export & erasure ───────────────────────────────────────────

/** Everything stored about a customer, as portable JSON (right of access / portability). */
export async function exportCustomer(ctx: ServiceContext, id: string) {
  require(ctx, 'customers:manage');
  const c = await ctx.db.customer.findFirst({
    where: { id, mergedIntoId: null },
    include: {
      identities: { select: { channel: true, externalId: true, createdAt: true } },
      tags: { select: { tag: { select: { name: true } } } },
      notes: { select: { content: true, createdAt: true, author: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      leads: { orderBy: { createdAt: 'asc' } },
      tickets: { orderBy: { createdAt: 'asc' } },
      appointments: { orderBy: { createdAt: 'asc' } },
      conversations: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          channel: true,
          status: true,
          intent: true,
          createdAt: true,
          closedAt: true,
          summaries: { select: { summary: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          messages: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { senderType: true, messageType: true, content: true, attachments: true, createdAt: true, senderUser: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!c) throw notFound('Customer');
  await auditFromContext(ctx, 'customer.exported', { type: 'Customer', id });
  const files = (v: unknown) => (Array.isArray(v) ? v.map((a: { fileName?: string; mimeType?: string; size?: number }) => ({ fileName: a.fileName, mimeType: a.mimeType, size: a.size })) : []);
  return {
    exportedAt: new Date().toISOString(),
    format: 'omniai.customer-export.v1',
    customer: {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      company: c.company,
      language: c.language,
      isAnonymous: c.isAnonymous,
      consentAt: c.consentAt,
      customFields: c.customFields,
      memory: c.memory,
      aiSummary: c.aiSummary,
      createdAt: c.createdAt,
      lastSeenAt: c.lastSeenAt,
      tags: c.tags.map((t) => t.tag.name),
      identities: c.identities,
    },
    conversations: c.conversations.map((v) => ({
      ...v,
      messages: v.messages.map((m) => ({
        from: m.senderType === 'AGENT' ? `Team member${m.senderUser?.name ? ` (${m.senderUser.name})` : ''}` : m.senderType.toLowerCase(),
        type: m.messageType,
        content: m.content,
        attachments: files(m.attachments),
        sentAt: m.createdAt,
      })),
    })),
    leads: c.leads.map(({ organizationId: _o, ...l }) => ({ ...l, reference: leadReference(l.id), estimatedValue: l.estimatedValue?.toString() ?? null })),
    tickets: c.tickets.map(({ organizationId: _o, ...t }) => ({ ...t, reference: ticketReference(t.id) })),
    appointments: c.appointments.map(({ organizationId: _o, ...a }) => a),
    notes: c.notes.map((n) => ({ content: n.content, author: n.author?.name ?? null, createdAt: n.createdAt })),
  };
}

async function deleteFiles(prefixes: string[], context: Record<string, unknown>) {
  let deleted = 0;
  for (const prefix of prefixes) {
    try {
      deleted += await deletePrefix(prefix);
    } catch (err) {
      logger.error('file deletion failed; remove manually', { ...context, prefix, err: (err as Error).message });
    }
  }
  return deleted;
}

/**
 * Erases a customer: profile, identities, conversations and messages, leads, tickets,
 * appointments, notes, tags and stored files (also of profiles merged into it). Usage
 * and audit records keep only ids. Cannot be undone.
 */
export async function deleteCustomer(ctx: ServiceContext, id: string) {
  require(ctx, 'customers:delete');
  await loadCustomer(ctx, id);
  const merged = await ctx.db.customer.findMany({ where: { mergedIntoId: id }, select: { id: true } });
  const ids = [id, ...merged.map((m) => m.id)];
  const [conversations, leads, tickets] = await Promise.all([
    ctx.db.conversation.count({ where: { customerId: { in: ids } } }),
    ctx.db.lead.count({ where: { customerId: { in: ids } } }),
    ctx.db.ticket.count({ where: { customerId: { in: ids } } }),
  ]);
  await ctx.db.$transaction([
    // Leads, tickets and appointments copy contact details, so they go too.
    ctx.db.lead.deleteMany({ where: { customerId: { in: ids } } }),
    ctx.db.ticket.deleteMany({ where: { customerId: { in: ids } } }),
    ctx.db.appointment.deleteMany({ where: { customerId: { in: ids } } }),
    ctx.db.customer.deleteMany({ where: { id: { in: ids } } }),
  ]);
  const files = await deleteFiles(
    ids.map((cid) => customerKeyPrefix(ctx.organizationId, cid)),
    { organizationId: ctx.organizationId, customerId: id },
  );
  await publish(channels.inbox(ctx.organizationId), { type: 'customer.deleted', customerId: id });
  await auditFromContext(ctx, 'customer.deleted', { type: 'Customer', id }, { conversations, leads, tickets, files, mergedProfiles: merged.length });
  return { deleted: true, conversations, leads, tickets, files };
}

/** Deletes one conversation with its messages and attachments. Leads and tickets stay. */
export async function deleteConversation(ctx: ServiceContext, conversationId: string) {
  require(ctx, 'customers:delete');
  const conversation = await ctx.db.conversation.findUnique({ where: { id: conversationId }, select: { id: true, customerId: true, channel: true } });
  if (!conversation) throw notFound('Conversation');
  const withFiles = await ctx.db.message.findMany({ where: { conversationId, attachments: { not: Prisma.DbNull } }, select: { attachments: true } });
  const prefixes = new Set<string>();
  const own = customerKeyPrefix(ctx.organizationId, conversation.customerId);
  for (const m of withFiles) {
    for (const a of Array.isArray(m.attachments) ? (m.attachments as { key?: string }[]) : []) {
      // Each upload lives in its own folder: orgs/<org>/customers/<customer>/<uuid>/<file>
      if (a.key?.startsWith(`orgs/${ctx.organizationId}/`)) prefixes.add(a.key.slice(0, a.key.lastIndexOf('/') + 1));
    }
  }
  const messages = await ctx.db.message.count({ where: { conversationId } });
  await ctx.db.conversation.delete({ where: { id: conversationId } });
  const files = await deleteFiles([...prefixes].filter((p) => p.length > own.length), { organizationId: ctx.organizationId, conversationId });
  await publish(channels.inbox(ctx.organizationId), { type: 'conversation.deleted', conversationId });
  await auditFromContext(ctx, 'conversation.deleted', { type: 'Conversation', id: conversationId }, { customerId: conversation.customerId, channel: conversation.channel, messages, files });
  return { deleted: true, messages, files };
}
