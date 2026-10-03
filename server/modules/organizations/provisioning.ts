import 'server-only';
import { Prisma } from '@prisma/client';
import type { RegisterInput } from '@/lib/validation';
import { hashPassword } from '../../auth/password';
import { randomToken } from '../../crypto';
import { prisma } from '../../db';
import { AppError } from '../../errors';
import { recordAudit } from '../audit/audit-service';
import { defaultBusinessHours, defaultPromptLayers } from '../ai/default-prompts';

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

export function newBotPublicKey(): string {
  return `bot_${randomToken(15)}`;
}

/**
 * Creates the organization skeleton every tenant needs: bot configuration, website
 * channel, default prompt layers and business hours. Runs inside the caller's transaction.
 */
export async function provisionOrganization(
  tx: Prisma.TransactionClient,
  params: { name: string; ownerUserId: string; timezone?: string; defaultLanguage?: string },
) {
  const organization = await tx.organization.create({
    data: {
      name: params.name,
      slug: `${slugify(params.name)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`,
      timezone: params.timezone ?? 'Europe/Berlin',
      defaultLanguage: params.defaultLanguage ?? 'en',
    },
  });
  const organizationId = organization.id;

  await tx.membership.create({ data: { organizationId, userId: params.ownerUserId, role: 'OWNER' } });

  const bot = await tx.botConfiguration.create({
    data: {
      organizationId,
      publicKey: newBotPublicKey(),
      companyName: params.name,
      agentName: `${params.name} Assistant`,
      defaultLanguage: organization.defaultLanguage,
    },
  });

  await tx.channel.create({
    data: { organizationId, botId: bot.id, type: 'WEBSITE', name: 'Website chat' },
  });

  await tx.promptConfiguration.createMany({
    // The global policy is organization-wide; the other layers belong to the bot.
    data: defaultPromptLayers().map((p) => ({ ...p, organizationId, botId: p.layer === 'GLOBAL_POLICY' ? null : bot.id })),
  });

  await tx.businessHours.createMany({
    data: defaultBusinessHours().map((h) => ({ ...h, organizationId })),
  });

  return { organization, bot };
}

export async function registerAccount(
  input: RegisterInput,
  meta: { ip?: string; userAgent?: string } = {},
) {
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true },
      });
      const { organization } = await provisionOrganization(tx, {
        name: input.organizationName,
        ownerUserId: user.id,
      });
      await recordAudit(
        {
          organizationId: organization.id,
          actorId: user.id,
          action: 'organization.created',
          entityType: 'Organization',
          entityId: organization.id,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return { user, organization };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('CONFLICT', 'An account with this email already exists. Try signing in instead.');
    }
    throw err;
  }
}
