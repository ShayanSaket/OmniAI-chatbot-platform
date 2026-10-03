import { beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '@/server/auth/password';
import { AppError } from '@/server/errors';
import { registerAccount } from '@/server/modules/organizations/provisioning';
import { prisma, resetDatabase } from './helpers';

const input = { name: 'Jane Doe', email: 'jane@acme.test', password: 'Password12345', organizationName: 'ACME GmbH' };

describe('account registration', () => {
  beforeEach(resetDatabase);

  it('creates the user, organization and everything the tenant needs', async () => {
    const { user, organization } = await registerAccount(input);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toContain(input.password);
    expect(await verifyPassword(input.password, stored.passwordHash)).toBe(true);

    const membership = await prisma.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    });
    expect(membership.role).toBe('OWNER');

    const bot = await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId: organization.id } });
    expect(bot.companyName).toBe('ACME GmbH');
    expect(bot.publicKey).toMatch(/^bot_[A-Za-z0-9_-]{20}$/);

    const channel = await prisma.channel.findFirstOrThrow({ where: { organizationId: organization.id } });
    expect(channel).toMatchObject({ type: 'WEBSITE', botId: bot.id });

    const layers = await prisma.promptConfiguration.findMany({ where: { organizationId: organization.id } });
    expect(layers.map((l) => `${l.layer}:${l.channel ?? ''}`).sort()).toEqual([
      'CHANNEL:WEBSITE',
      'CHANNEL:WHATSAPP',
      'GLOBAL_POLICY:',
    ]);

    expect(await prisma.businessHours.count({ where: { organizationId: organization.id } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { organizationId: organization.id, action: 'organization.created' } })).toBe(1);
  });

  it('rejects a duplicate email without creating a second organization', async () => {
    await registerAccount(input);
    await expect(registerAccount({ ...input, organizationName: 'Other' })).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<AppError>);
    expect(await prisma.organization.count()).toBe(1);
  });

  it('gives organizations with the same name distinct slugs', async () => {
    const a = await registerAccount(input);
    const b = await registerAccount({ ...input, email: 'john@acme.test' });
    expect(a.organization.slug).not.toBe(b.organization.slug);
    expect(a.organization.slug.startsWith('acme-gmbh-')).toBe(true);
  });
});
