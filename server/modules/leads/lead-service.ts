import 'server-only';
import type { Lead, LeadStatus, Prisma } from '@prisma/client';
import {
  LEAD_STATUSES,
  leadCreateSchema,
  leadReference,
  OPEN_LEAD_STATUSES,
  type LeadActivity,
  type LeadCreateInput,
  type LeadFilters,
  type LeadItem,
  type LeadStats,
  type LeadUpdateInput,
} from '@/lib/leads';
import { hasPermission, type Permission } from '@/lib/permissions';
import type { ServiceContext } from '../../context';
import { AppError, forbidden, notFound } from '../../errors';
import { emitDomainEvent } from '../../events/domain-events';
import { channels, publish } from '../../realtime/bus';
import { auditFromContext } from '../audit/audit-service';
import { notifyMembers } from '../notifications/notification-service';

// Lead management (spec §8): pipeline NEW → CONTACTED → QUALIFIED → PROPOSAL → WON / LOST.

const PAGE_SIZE = 50;
const BOARD_PER_STATUS = 100;
const DAY = 86_400_000;

function require(ctx: ServiceContext, permission: Permission) {
  if (!hasPermission(ctx.role, permission)) throw forbidden();
}

const INCLUDE = { assignedTo: { select: { id: true, name: true } } } as const;
type LeadRow = Lead & { assignedTo: { id: string; name: string | null } | null };

export function toLeadItem(l: LeadRow): LeadItem {
  return {
    id: l.id,
    reference: leadReference(l.id),
    status: l.status,
    temperature: l.temperature,
    name: l.name,
    email: l.email,
    phone: l.phone,
    company: l.company,
    requestedService: l.requestedService,
    message: l.message,
    preferredContact: l.preferredContact,
    intent: l.intent,
    source: l.source,
    estimatedValue: l.estimatedValue === null ? null : Number(l.estimatedValue),
    lostReason: l.lostReason,
    closedAt: l.closedAt?.toISOString() ?? null,
    customerId: l.customerId,
    conversationId: l.conversationId,
    assignedTo: l.assignedTo,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

function leadWhere(ctx: ServiceContext, f: LeadFilters): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];
  if (f.status === 'open') and.push({ status: { in: [...OPEN_LEAD_STATUSES] } });
  else if (f.status !== 'all') and.push({ status: f.status });
  if (f.temperature !== 'all') and.push({ temperature: f.temperature });
  if (f.source === 'MANUAL') and.push({ source: null });
  else if (f.source !== 'all') and.push({ source: f.source });
  if (f.assignee === 'me') and.push({ assignedToId: ctx.userId });
  if (f.assignee === 'unassigned') and.push({ assignedToId: null });
  if (f.q) {
    const contains = { contains: f.q, mode: 'insensitive' as const };
    and.push({ OR: [{ name: contains }, { email: contains }, { phone: contains }, { company: contains }, { requestedService: contains }, { message: contains }] });
  }
  return and.length ? { AND: and } : {};
}

export async function listLeads(ctx: ServiceContext, filters: LeadFilters & { cursor?: string }) {
  require(ctx, 'leads:view');
  const skip = Math.max(0, Math.min(Number(filters.cursor) || 0, 100_000));
  const rows = await ctx.db.lead.findMany({
    where: leadWhere(ctx, filters),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take: PAGE_SIZE + 1,
    include: INCLUDE,
  });
  return { items: rows.slice(0, PAGE_SIZE).map(toLeadItem), nextCursor: rows.length > PAGE_SIZE ? String(skip + PAGE_SIZE) : null };
}

/** Pipeline board: leads per status (filters apply, except status). */
export async function leadBoard(ctx: ServiceContext, filters: LeadFilters) {
  require(ctx, 'leads:view');
  const base = leadWhere(ctx, { ...filters, status: 'all' });
  const columns = await Promise.all(
    LEAD_STATUSES.map(async (status) => {
      const where = { AND: [base, { status }] };
      const [rows, count, value] = await Promise.all([
        ctx.db.lead.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: BOARD_PER_STATUS, include: INCLUDE }),
        ctx.db.lead.count({ where }),
        ctx.db.lead.aggregate({ where, _sum: { estimatedValue: true } }),
      ]);
      return { status, count, value: Number(value._sum.estimatedValue ?? 0), items: rows.map(toLeadItem) };
    }),
  );
  return { columns };
}

export async function leadStats(ctx: ServiceContext, now = new Date()): Promise<LeadStats> {
  require(ctx, 'leads:view');
  const since90 = new Date(now.getTime() - 90 * DAY);
  const [grouped, newThisWeek, pipeline, won, closed90, created90, wonOfCreated90] = await Promise.all([
    ctx.db.lead.groupBy({ by: ['status'], _count: { _all: true } }),
    ctx.db.lead.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
    ctx.db.lead.aggregate({ where: { status: { in: [...OPEN_LEAD_STATUSES] } }, _sum: { estimatedValue: true } }),
    ctx.db.lead.aggregate({ where: { status: 'WON' }, _sum: { estimatedValue: true } }),
    ctx.db.lead.groupBy({ by: ['status'], where: { status: { in: ['WON', 'LOST'] }, closedAt: { gte: since90 } }, _count: { _all: true } }),
    ctx.db.lead.count({ where: { createdAt: { gte: since90 } } }),
    ctx.db.lead.count({ where: { createdAt: { gte: since90 }, status: 'WON' } }),
  ]);
  const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<LeadStatus, number>;
  const won90 = closed90.find((c) => c.status === 'WON')?._count._all ?? 0;
  const lost90 = closed90.find((c) => c.status === 'LOST')?._count._all ?? 0;
  return {
    open: OPEN_LEAD_STATUSES.reduce((sum, s) => sum + byStatus[s], 0),
    newThisWeek,
    pipelineValue: Number(pipeline._sum.estimatedValue ?? 0),
    wonValue: Number(won._sum.estimatedValue ?? 0),
    winRate: won90 + lost90 ? Math.round((won90 / (won90 + lost90)) * 1000) / 10 : null,
    conversionRate: created90 ? Math.round((wonOfCreated90 / created90) * 1000) / 10 : null,
    byStatus,
  };
}

async function requireMember(ctx: ServiceContext, userId: string) {
  const member = await ctx.db.membership.findFirst({ where: { userId }, select: { id: true } });
  if (!member) throw new AppError('VALIDATION_FAILED', 'That person is not a member of this workspace.', { assignedToId: ['Choose a team member'] });
}

async function notifyAssignee(ctx: ServiceContext, lead: LeadRow) {
  if (!lead.assignedToId || lead.assignedToId === ctx.userId) return;
  await notifyMembers(ctx.organizationId, {
    userIds: [lead.assignedToId],
    title: 'Lead assigned to you',
    body: `${lead.name ?? lead.company ?? lead.email ?? 'A lead'}${lead.requestedService ? ` — ${lead.requestedService}` : ''}`,
    link: `/leads?lead=${lead.id}`,
  });
}

export async function getLead(ctx: ServiceContext, id: string): Promise<LeadItem & { activity: LeadActivity[] }> {
  require(ctx, 'leads:view');
  const lead = await ctx.db.lead.findUnique({ where: { id }, include: INCLUDE });
  if (!lead) throw notFound('Lead');
  const audit = await ctx.db.auditLog.findMany({
    where: { entityType: 'Lead', entityId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: { select: { name: true, email: true } } },
  });
  const members = await ctx.db.membership.findMany({ select: { user: { select: { id: true, name: true } } } });
  const nameOf = (userId: unknown) => (typeof userId === 'string' ? (members.find((m) => m.user.id === userId)?.user.name ?? 'a former member') : 'nobody');
  const detail = (action: string, meta: Record<string, unknown>) => {
    if (action === 'lead.created') return 'Created the lead';
    if (action === 'lead.deleted') return 'Deleted the lead';
    const parts: string[] = [];
    if (meta.status) parts.push(`moved it from ${String(meta.previousStatus ?? '?').toLowerCase()} to ${String(meta.status).toLowerCase()}${meta.lostReason ? ` (${String(meta.lostReason)})` : ''}`);
    if ('assignedToId' in meta) parts.push(`assigned it to ${nameOf(meta.assignedToId)}`);
    const fields = (meta.fields as string[] | undefined)?.filter((f) => f !== 'status' && f !== 'assignedToId' && f !== 'lostReason');
    const LABEL: Record<string, string> = { requestedService: 'interest', estimatedValue: 'value', preferredContact: 'preferred contact', message: 'notes' };
    if (fields?.length) parts.push(`updated ${fields.map((f) => LABEL[f] ?? f).join(', ')}`);
    return parts.length ? parts.join('; ').replace(/^./, (c) => c.toUpperCase()) : 'Updated the lead';
  };
  return {
    ...toLeadItem(lead),
    activity: audit.map((a) => ({
      id: a.id,
      action: a.action,
      actorName: a.actor ? (a.actor.name ?? a.actor.email) : null,
      detail: detail(a.action, (a.metadata ?? {}) as Record<string, unknown>),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * Creates a lead by hand (phone call, event, email). Links it to the customer with the
 * same email or phone, or creates that customer profile.
 */
export async function createLead(ctx: ServiceContext, raw: LeadCreateInput) {
  require(ctx, 'leads:manage');
  // Validated here too: a lead must always be reachable, whoever calls the service.
  const input = leadCreateSchema.parse(raw);
  if (input.assignedToId) await requireMember(ctx, input.assignedToId);
  const or: Prisma.CustomerWhereInput[] = [];
  if (input.email) or.push({ email: { equals: input.email, mode: 'insensitive' } });
  if (input.phone) or.push({ phone: input.phone });
  const existing = or.length ? await ctx.db.customer.findFirst({ where: { mergedIntoId: null, OR: or }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : null;
  const customerId =
    existing?.id ??
    (
      await ctx.db.customer.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          company: input.company ?? null,
          isAnonymous: false,
        },
        select: { id: true },
      })
    ).id;
  const status = input.status ?? 'NEW';
  const lead = await ctx.db.lead.create({
    data: {
      organizationId: ctx.organizationId,
      customerId,
      name: input.name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      company: input.company ?? null,
      requestedService: input.requestedService ?? null,
      message: input.message ?? null,
      preferredContact: input.preferredContact ?? null,
      temperature: input.temperature ?? 'WARM',
      estimatedValue: input.estimatedValue ?? null,
      assignedToId: input.assignedToId ?? null,
      status,
      closedAt: status === 'WON' || status === 'LOST' ? new Date() : null,
      source: null,
    },
    include: INCLUDE,
  });
  await auditFromContext(ctx, 'lead.created', { type: 'Lead', id: lead.id }, { source: 'manual' });
  await notifyAssignee(ctx, lead);
  await publish(channels.inbox(ctx.organizationId), { type: 'lead.created', leadId: lead.id });
  emitDomainEvent({ type: 'lead.created', organizationId: ctx.organizationId, refs: { leadId: lead.id, customerId }, data: { channel: 'MANUAL' } });
  return toLeadItem(lead);
}

export async function updateLead(ctx: ServiceContext, id: string, input: LeadUpdateInput) {
  require(ctx, 'leads:manage');
  const current = await ctx.db.lead.findUnique({ where: { id } });
  if (!current) throw notFound('Lead');
  if (input.assignedToId) await requireMember(ctx, input.assignedToId);

  const data: Prisma.LeadUncheckedUpdateInput = {};
  const fields: string[] = [];
  for (const key of ['name', 'email', 'phone', 'company', 'requestedService', 'message', 'preferredContact', 'temperature', 'assignedToId', 'lostReason'] as const) {
    if (input[key] !== undefined && input[key] !== current[key]) {
      (data as Record<string, unknown>)[key] = input[key];
      fields.push(key);
    }
  }
  if (input.estimatedValue !== undefined && input.estimatedValue !== (current.estimatedValue === null ? null : Number(current.estimatedValue))) {
    data.estimatedValue = input.estimatedValue;
    fields.push('estimatedValue');
  }
  const statusChanged = input.status !== undefined && input.status !== current.status;
  if (statusChanged) {
    data.status = input.status;
    fields.push('status');
    const closing = input.status === 'WON' || input.status === 'LOST';
    data.closedAt = closing ? new Date() : null;
    if (input.status !== 'LOST' && input.lostReason === undefined) data.lostReason = null;
  }
  if (!fields.length) return getLead(ctx, id);

  const lead = await ctx.db.lead.update({ where: { id }, data, include: INCLUDE });
  await auditFromContext(ctx, 'lead.updated', { type: 'Lead', id }, {
    fields,
    ...(statusChanged ? { status: lead.status, previousStatus: current.status, ...(lead.lostReason ? { lostReason: lead.lostReason } : {}) } : {}),
    ...(fields.includes('assignedToId') ? { assignedToId: lead.assignedToId } : {}),
  });
  if (fields.includes('assignedToId')) await notifyAssignee(ctx, lead);
  await publish(channels.inbox(ctx.organizationId), { type: 'lead.updated', leadId: id });
  if (statusChanged) {
    emitDomainEvent({
      type: 'lead.status_changed',
      organizationId: ctx.organizationId,
      refs: { leadId: id, ...(lead.customerId ? { customerId: lead.customerId } : {}), ...(lead.conversationId ? { conversationId: lead.conversationId } : {}) },
      data: { from: current.status, to: lead.status },
    });
  }
  return getLead(ctx, id);
}

export async function deleteLead(ctx: ServiceContext, id: string) {
  require(ctx, 'leads:manage');
  const lead = await ctx.db.lead.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!lead) throw notFound('Lead');
  await ctx.db.lead.delete({ where: { id } });
  await auditFromContext(ctx, 'lead.deleted', { type: 'Lead', id }, { status: lead.status });
  await publish(channels.inbox(ctx.organizationId), { type: 'lead.deleted', leadId: id });
}

/** CSV cell: quoted, and neutralized against spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportLeadsCsv(ctx: ServiceContext, filters: LeadFilters) {
  require(ctx, 'leads:view');
  const rows = await ctx.db.lead.findMany({ where: leadWhere(ctx, filters), orderBy: { createdAt: 'desc' }, take: 10_000, include: INCLUDE });
  const header = ['Reference', 'Status', 'Temperature', 'Name', 'Email', 'Phone', 'Company', 'Requested service', 'Message', 'Preferred contact', 'Source', 'Estimated value', 'Assigned to', 'Lost reason', 'Created', 'Closed'];
  const lines = rows.map((l) =>
    [
      leadReference(l.id),
      l.status,
      l.temperature,
      l.name,
      l.email,
      l.phone,
      l.company,
      l.requestedService,
      l.message,
      l.preferredContact,
      l.source ?? 'MANUAL',
      l.estimatedValue?.toString() ?? '',
      l.assignedTo?.name ?? '',
      l.lostReason,
      l.createdAt.toISOString(),
      l.closedAt?.toISOString() ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  await auditFromContext(ctx, 'leads.exported', { type: 'Lead' }, { count: rows.length });
  // BOM so spreadsheet apps detect UTF-8 (names with umlauts, Persian, …).
  return `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
}
