import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { getOverview } from '@/server/modules/analytics/overview-service';
import { updateOrganization } from '@/server/modules/organizations/organization-service';
import { addMember, changeMemberRole, listMembers, removeMember } from '@/server/modules/team/team-service';
import { addUser, contextFor, createConversation, createWorkspace, prisma, resetDatabase } from './helpers';

describe('team management', () => {
  let orgId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const ws = await createWorkspace();
    orgId = ws.organization.id;
    ownerId = ws.owner.id;
  });

  it('lets an admin add agents but not admins', async () => {
    const admin = await addUser(orgId, 'ADMIN');
    const ctx = contextFor(orgId, admin.user.id, 'ADMIN');
    await expect(
      addMember(ctx, { name: 'Eve', email: 'eve@test.demo', role: 'ADMIN', password: 'Password12345' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const added = await addMember(ctx, { name: 'Ann', email: 'ann@test.demo', role: 'AGENT', password: 'Password12345' });
    expect(added.role).toBe('AGENT');
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'team.member_added' } })).toBe(1);
  });

  it('does not attach existing accounts to another organization', async () => {
    const other = await createWorkspace('Other');
    const ctx = contextFor(orgId, ownerId, 'OWNER');
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: other.owner.id } })).email;
    await expect(addMember(ctx, { name: 'X', email, role: 'AGENT', password: 'Password12345' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('prevents admins from modifying owners and promoting agents', async () => {
    const admin = await addUser(orgId, 'ADMIN');
    const agent = await addUser(orgId, 'AGENT');
    const ownerMembership = await prisma.membership.findFirstOrThrow({ where: { organizationId: orgId, role: 'OWNER' } });
    const ctx = contextFor(orgId, admin.user.id, 'ADMIN');
    await expect(changeMemberRole(ctx, ownerMembership.id, 'AGENT')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(removeMember(ctx, ownerMembership.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(changeMemberRole(ctx, agent.membership.id, 'ADMIN')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await removeMember(ctx, agent.membership.id);
    expect((await listMembers(ctx)).map((m) => m.role).sort()).toEqual(['ADMIN', 'OWNER']);
  });

  it('never ends with zero owners, even when two owners demote each other concurrently', async () => {
    const second = await addUser(orgId, 'OWNER');
    const firstMembership = await prisma.membership.findFirstOrThrow({ where: { organizationId: orgId, userId: ownerId } });

    const results = await Promise.allSettled([
      changeMemberRole(contextFor(orgId, ownerId, 'OWNER'), second.membership.id, 'ADMIN'),
      changeMemberRole(contextFor(orgId, second.user.id, 'OWNER'), firstMembership.id, 'ADMIN'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AppError);
    expect(rejected.reason.code).toBe('CONFLICT');
    expect(await prisma.membership.count({ where: { organizationId: orgId, role: 'OWNER' } })).toBe(1);
  });

  it('cannot manage members of another organization', async () => {
    const other = await createWorkspace('Other');
    const foreign = await prisma.membership.findFirstOrThrow({ where: { organizationId: other.organization.id } });
    const ctx = contextFor(orgId, ownerId, 'OWNER');
    await expect(removeMember(ctx, foreign.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(changeMemberRole(ctx, foreign.id, 'AGENT')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only lets owners change organization settings', async () => {
    const admin = await addUser(orgId, 'ADMIN');
    await expect(updateOrganization(contextFor(orgId, admin.user.id, 'ADMIN'), { name: 'Renamed' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const updated = await updateOrganization(contextFor(orgId, ownerId, 'OWNER'), { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });
});

describe('dashboard overview analytics', () => {
  beforeEach(resetDatabase);

  it('counts only the current organization within the selected range', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

    const today = await createConversation(a.organization.id, { createdAt: new Date(now.getTime() - 60_000) });
    await createConversation(a.organization.id, { createdAt: daysAgo(3), channel: 'WHATSAPP' });
    await createConversation(a.organization.id, { createdAt: daysAgo(10) }); // previous 7-day period
    await createConversation(b.organization.id, { createdAt: daysAgo(1) }); // other tenant
    await prisma.lead.create({ data: { organizationId: a.organization.id, conversationId: today.id, name: 'Lead' } });
    await prisma.conversation.update({
      where: { id: today.id },
      data: { status: 'CLOSED', aiResolved: true, closedAt: now, firstResponseAt: new Date(today.createdAt.getTime() + 4000) },
    });

    const ctx = contextFor(a.organization.id, a.owner.id, 'OWNER');
    const data = await getOverview(ctx, { range: '7d', timeZone: 'Europe/Berlin' });

    expect(data.kpis.totalConversations).toEqual({ value: 2, previous: 1 });
    expect(data.kpis.newLeads.value).toBe(1);
    expect(data.kpis.conversionRate.value).toBe(50);
    expect(data.kpis.aiResolved.value).toBe(1);
    expect(data.kpis.avgFirstResponseSeconds.value).toBe(4);
    expect(data.kpis.activeConversations.value).toBe(2);
    expect(data.series).toHaveLength(7);
    expect(data.series.reduce((s, p) => s + p.website + p.whatsapp, 0)).toBe(2);
    expect(data.recentConversations).toHaveLength(3);
  });
});
