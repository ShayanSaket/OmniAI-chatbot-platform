import 'server-only';
import type { Role } from '@prisma/client';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';
import { channels, publish } from '../../realtime/bus';

// In-app notifications for team members (bell in the dashboard header).

export interface NotificationInput {
  title: string;
  body?: string;
  link?: string | null;
  /** Recipients by role and/or explicit user ids (members of the organization only). */
  roles?: Role[];
  userIds?: string[];
}

export async function notifyMembers(organizationId: string, input: NotificationInput): Promise<number> {
  const members = await prisma.membership.findMany({
    where: {
      organizationId,
      OR: [...(input.roles?.length ? [{ role: { in: input.roles } }] : []), ...(input.userIds?.length ? [{ userId: { in: input.userIds } }] : [])],
    },
    select: { userId: true },
  });
  const userIds = Array.from(new Set(members.map((m) => m.userId)));
  if (!userIds.length) return 0;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      organizationId,
      userId,
      title: input.title.slice(0, 200),
      body: (input.body ?? '').slice(0, 2000),
      link: input.link ?? null,
    })),
  });
  await publish(channels.inbox(organizationId), { type: 'notification.created', userIds });
  return userIds.length;
}

export async function listNotifications(ctx: ServiceContext, limit = 30) {
  const [items, unread] = await Promise.all([
    ctx.db.notification.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) }),
    ctx.db.notification.count({ where: { userId: ctx.userId, readAt: null } }),
  ]);
  return {
    unread,
    items: items.map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, read: Boolean(n.readAt), createdAt: n.createdAt.toISOString() })),
  };
}

/** Marks the given notifications (or all) of the current user as read. */
export async function markNotificationsRead(ctx: ServiceContext, ids: string[] | 'all') {
  await ctx.db.notification.updateMany({
    where: { userId: ctx.userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
    data: { readAt: new Date() },
  });
  return listNotifications(ctx);
}
