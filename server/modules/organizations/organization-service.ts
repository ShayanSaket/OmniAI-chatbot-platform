import 'server-only';
import type { OrganizationUpdateInput } from '@/lib/validation';
import type { ServiceContext } from '../../context';
import { forbidden } from '../../errors';
import { hasPermission } from '@/lib/permissions';
import { auditFromContext } from '../audit/audit-service';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  slug: true,
  industry: true,
  website: true,
  timezone: true,
  defaultLanguage: true,
  messageRetentionDays: true,
  createdAt: true,
} as const;

export function getOrganization(ctx: ServiceContext) {
  return ctx.db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: PUBLIC_FIELDS });
}

export async function updateOrganization(ctx: ServiceContext, input: OrganizationUpdateInput) {
  if (!hasPermission(ctx.role, 'organization:manage')) throw forbidden();
  const updated = await ctx.db.organization.update({
    where: { id: ctx.organizationId },
    data: input,
    select: PUBLIC_FIELDS,
  });
  await auditFromContext(ctx, 'organization.updated', { type: 'Organization', id: ctx.organizationId }, {
    fields: Object.keys(input),
  });
  return updated;
}
