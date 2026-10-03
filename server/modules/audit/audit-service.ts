import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { logger } from '../../logger';
import type { ServiceContext } from '../../context';

export interface AuditEntry {
  organizationId: string;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
}

/** Writes an audit entry. Never throws: auditing must not break the audited action. */
export async function recordAudit(entry: AuditEntry, tx: Prisma.TransactionClient = prisma): Promise<void> {
  try {
    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata ?? {},
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      },
    });
  } catch (err) {
    logger.error('audit write failed', { action: entry.action, organizationId: entry.organizationId, err });
  }
}

export function auditFromContext(
  ctx: ServiceContext,
  action: string,
  entity?: { type: string; id?: string },
  metadata?: Prisma.InputJsonValue,
) {
  return recordAudit({
    organizationId: ctx.organizationId,
    actorId: ctx.userId,
    action,
    entityType: entity?.type,
    entityId: entity?.id,
    metadata,
    ipAddress: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

export async function listAuditLogs(ctx: ServiceContext, params: { cursor?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const rows = await ctx.db.auditLog.findMany({
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { actor: { select: { id: true, name: true, email: true } } },
  });
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null };
}
