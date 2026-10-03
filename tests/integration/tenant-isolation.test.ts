import { beforeEach, describe, expect, it } from 'vitest';
import { TenantViolationError } from '@/server/tenancy/scope';
import { tenantDb } from '@/server/tenancy/tenant-db';
import { createConversation, createWorkspace, prisma, resetDatabase } from './helpers';

describe('tenant isolation', () => {
  let orgA: string;
  let orgB: string;
  let customerB: string;
  let conversationB: string;

  beforeEach(async () => {
    await resetDatabase();
    orgA = (await createWorkspace('Org A')).organization.id;
    orgB = (await createWorkspace('Org B')).organization.id;
    await prisma.customer.create({ data: { organizationId: orgA, name: 'Alice (A)', email: 'alice@a.test' } });
    customerB = (await prisma.customer.create({ data: { organizationId: orgB, name: 'Bob (B)', email: 'bob@b.test' } })).id;
    conversationB = (await createConversation(orgB)).id;
  });

  it('only lists the current organization’s rows', async () => {
    const db = tenantDb(orgA);
    const customers = await db.customer.findMany();
    expect(customers.map((c) => c.name)).toEqual(['Alice (A)']);
    expect(await db.conversation.count()).toBe(0);
    expect(await db.customer.findFirst({ where: { email: 'bob@b.test' } })).toBeNull();
  });

  it('cannot fetch another tenant’s row by id', async () => {
    const db = tenantDb(orgA);
    expect(await db.customer.findUnique({ where: { id: customerB } })).toBeNull();
    expect(await db.conversation.findUnique({ where: { id: conversationB } })).toBeNull();
  });

  it('cannot update or delete another tenant’s row by id', async () => {
    const db = tenantDb(orgA);
    await expect(db.customer.update({ where: { id: customerB }, data: { name: 'hacked' } })).rejects.toMatchObject({ code: 'P2025' });
    await expect(db.customer.delete({ where: { id: customerB } })).rejects.toMatchObject({ code: 'P2025' });
    const { count } = await db.customer.deleteMany({});
    expect(count).toBe(1);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerB } })).name).toBe('Bob (B)');
  });

  it('cannot create rows in, or move rows to, another tenant', async () => {
    const db = tenantDb(orgA);
    await expect(db.tag.create({ data: { name: 'x', organizationId: orgB } })).rejects.toBeInstanceOf(TenantViolationError);
    const tag = await db.tag.create({ data: { name: 'mine', organizationId: orgA } });
    expect(tag.organizationId).toBe(orgA);
    await expect(db.tag.update({ where: { id: tag.id }, data: { organizationId: orgB } })).rejects.toBeInstanceOf(
      TenantViolationError,
    );
  });

  it('cannot read another organization record', async () => {
    const db = tenantDb(orgA);
    await expect(db.organization.findUnique({ where: { id: orgB } })).rejects.toBeInstanceOf(TenantViolationError);
    expect((await db.organization.findUniqueOrThrow({ where: { id: orgA } })).name).toBe('Org A');
  });

  it('keeps tenant scoping inside interactive transactions', async () => {
    const db = tenantDb(orgA);
    const seen = await db.$transaction(async (tx) => tx.customer.findMany());
    expect(seen.map((c) => c.organizationId)).toEqual([orgA]);
  });
});
