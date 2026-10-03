import 'server-only';
import { canGrantRole, checkMemberChange, type Role } from '@/lib/permissions';
import type { AddMemberInput } from '@/lib/validation';
import { hashPassword } from '../../auth/password';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';
import { AppError, forbidden, notFound } from '../../errors';
import { auditFromContext } from '../audit/audit-service';

const DENIAL_MESSAGES = {
  SELF_CHANGE: 'You cannot change or remove your own membership.',
  INSUFFICIENT_ROLE: 'You do not have permission to manage this member.',
  CANNOT_GRANT_ROLE: 'You cannot grant that role.',
} as const;

export async function listMembers(ctx: ServiceContext) {
  const members = await ctx.db.membership.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, lastLoginAt: true } },
    },
  });
  return members;
}

export async function addMember(ctx: ServiceContext, input: AddMemberInput) {
  if (!canGrantRole(ctx.role, input.role)) throw forbidden(DENIAL_MESSAGES.CANNOT_GRANT_ROLE);

  // Existing accounts are not silently attached to another organization; that needs
  // an invitation the user accepts (planned with email delivery).
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) {
    throw new AppError('CONFLICT', 'A user with this email already has an account. Invitations for existing accounts are not supported yet.');
  }

  const passwordHash = await hashPassword(input.password);
  const membership = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash } });
    return tx.membership.create({
      data: { organizationId: ctx.organizationId, userId: user.id, role: input.role },
      select: { id: true, role: true, createdAt: true, user: { select: { id: true, name: true, email: true, lastLoginAt: true } } },
    });
  });

  await auditFromContext(ctx, 'team.member_added', { type: 'Membership', id: membership.id }, {
    email: input.email,
    role: input.role,
  });
  return membership;
}

async function loadTarget(ctx: ServiceContext, membershipId: string) {
  const target = await ctx.db.membership.findUnique({
    where: { id: membershipId },
    select: { id: true, role: true, userId: true },
  });
  if (!target) throw notFound('Member');
  return target;
}

type Tx = Parameters<Parameters<ServiceContext['db']['$transaction']>[0]>[0];

/** Locks the organization's owner rows so concurrent demotions cannot remove the last owner. */
async function assertOwnerRemains(tx: Tx, organizationId: string, target: { role: Role }, nextRole: Role | null) {
  if (target.role !== 'OWNER' || nextRole === 'OWNER') return;
  const owners = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Membership"
    WHERE "organizationId" = ${organizationId} AND role = 'OWNER'
    FOR UPDATE`;
  if (owners.length <= 1) throw new AppError('CONFLICT', 'An organization must keep at least one owner.');
}

export async function changeMemberRole(ctx: ServiceContext, membershipId: string, role: Role) {
  const target = await loadTarget(ctx, membershipId);
  const denial = checkMemberChange({
    actorRole: ctx.role,
    actorIsTarget: target.userId === ctx.userId,
    targetRole: target.role,
    newRole: role,
  });
  if (denial) throw forbidden(DENIAL_MESSAGES[denial]);
  const updated = await ctx.db.$transaction(async (tx) => {
    await assertOwnerRemains(tx, ctx.organizationId, target, role);
    return tx.membership.update({ where: { id: membershipId }, data: { role }, select: { id: true, role: true } });
  });
  await auditFromContext(ctx, 'team.role_changed', { type: 'Membership', id: membershipId }, {
    from: target.role,
    to: role,
  });
  return updated;
}

export async function removeMember(ctx: ServiceContext, membershipId: string) {
  const target = await loadTarget(ctx, membershipId);
  const denial = checkMemberChange({
    actorRole: ctx.role,
    actorIsTarget: target.userId === ctx.userId,
    targetRole: target.role,
  });
  if (denial) throw forbidden(DENIAL_MESSAGES[denial]);
  await ctx.db.$transaction(async (tx) => {
    await assertOwnerRemains(tx, ctx.organizationId, target, null);
    await tx.membership.delete({ where: { id: membershipId } });
  });
  await auditFromContext(ctx, 'team.member_removed', { type: 'Membership', id: membershipId }, {
    role: target.role,
  });
}
