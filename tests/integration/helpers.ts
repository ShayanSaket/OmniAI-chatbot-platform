import { prisma } from '@/server/db';
import type { ServiceContext } from '@/server/context';
import type { Role } from '@/lib/permissions';
import { tenantDb } from '@/server/tenancy/tenant-db';
import { registerAccount } from '@/server/modules/organizations/provisioning';
import { hashPassword } from '@/server/auth/password';

export { prisma };

/** Empties every application table in the test database. */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createWorkspace(name = 'Test Org') {
  const email = `owner-${unique()}@test.demo`;
  const { user, organization } = await registerAccount({
    name: 'Owner',
    email,
    password: 'Password12345',
    organizationName: name,
  });
  return { owner: user, organization };
}

export async function addUser(organizationId: string, role: Role) {
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${unique()}@test.demo`, name: role, passwordHash: await hashPassword('Password12345') },
  });
  const membership = await prisma.membership.create({ data: { organizationId, userId: user.id, role } });
  return { user, membership };
}

export function contextFor(organizationId: string, userId: string, role: Role): ServiceContext {
  return { organizationId, userId, role, db: tenantDb(organizationId) };
}

export async function createConversation(organizationId: string, overrides: { createdAt?: Date; channel?: 'WEBSITE' | 'WHATSAPP' } = {}) {
  const channelType = overrides.channel ?? 'WEBSITE';
  let channel = await prisma.channel.findFirst({ where: { organizationId, type: channelType } });
  channel ??= await prisma.channel.create({ data: { organizationId, type: channelType, name: channelType } });
  const customer = await prisma.customer.create({ data: { organizationId, name: `Customer ${unique()}` } });
  return prisma.conversation.create({
    data: {
      organizationId,
      customerId: customer.id,
      channelId: channel.id,
      channel: channelType,
      createdAt: overrides.createdAt,
    },
  });
}
