import 'server-only';
import { hasPermission } from '@/lib/permissions';
import type { BusinessHoursUpdateInput } from '@/lib/validation';
import { invalidateBotCache } from '../../channels/website/widget-auth';
import type { ServiceContext } from '../../context';
import { forbidden } from '../../errors';
import { auditFromContext } from '../audit/audit-service';

export async function getBusinessHours(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const [hours, organization] = await Promise.all([
    ctx.db.businessHours.findMany({
      orderBy: [{ weekday: 'asc' }, { opensAt: 'asc' }],
      select: { weekday: true, opensAt: true, closesAt: true },
    }),
    ctx.db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } }),
  ]);
  return { hours, timeZone: organization.timezone };
}

/** Replaces the weekly schedule (an empty list = the team is never online). */
export async function replaceBusinessHours(ctx: ServiceContext, input: BusinessHoursUpdateInput) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
  const unique = input.hours.filter(
    (h, i) => input.hours.findIndex((o) => o.weekday === h.weekday && o.opensAt === h.opensAt && o.closesAt === h.closesAt) === i,
  );
  await ctx.db.$transaction([
    ctx.db.businessHours.deleteMany({}),
    ctx.db.businessHours.createMany({ data: unique.map((h) => ({ ...h, organizationId: ctx.organizationId })) }),
  ]);
  // Widgets cache the bot and its hours briefly; drop the cache so the status updates now.
  const bots = await ctx.db.botConfiguration.findMany({ select: { publicKey: true } });
  bots.forEach((b) => invalidateBotCache(b.publicKey));
  await auditFromContext(ctx, 'business_hours.updated', { type: 'BusinessHours' }, { ranges: unique.length });
  return getBusinessHours(ctx);
}
