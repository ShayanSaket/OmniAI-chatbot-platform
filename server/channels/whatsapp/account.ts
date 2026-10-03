import 'server-only';
import { decryptSecret } from '../../crypto';
import { prisma } from '../../db';
import { env } from '../../env';
import { logger } from '../../logger';
import type { GraphConfig } from './graph-client';

// WhatsApp credentials. App-level secrets (app secret, verify token) and the default
// access token come only from environment variables; a tenant may store its own access
// token, encrypted at rest. Nothing is ever hard-coded or sent to the browser.

export class WhatsAppNotConfiguredError extends Error {
  constructor(message = 'WhatsApp is not configured (missing access token).') {
    super(message);
    this.name = 'WhatsAppNotConfiguredError';
  }
}

export interface AccountCredentialsInput {
  phoneNumberId: string;
  businessAccountId: string;
  accessTokenEncrypted: string | null;
}

export function graphConfigFor(account: AccountCredentialsInput): GraphConfig {
  const e = env();
  let token = e.WHATSAPP_ACCESS_TOKEN ?? null;
  if (account.accessTokenEncrypted) {
    try {
      token = decryptSecret(account.accessTokenEncrypted);
    } catch (err) {
      logger.error('whatsapp access token could not be decrypted', { phoneNumberId: account.phoneNumberId, err: (err as Error).message });
      throw new WhatsAppNotConfiguredError('The stored WhatsApp access token could not be decrypted.');
    }
  }
  if (!token) throw new WhatsAppNotConfiguredError();
  return {
    token,
    phoneNumberId: account.phoneNumberId,
    businessAccountId: account.businessAccountId,
    baseUrl: e.WHATSAPP_GRAPH_URL,
    version: e.WHATSAPP_API_VERSION,
  };
}

/** Routes an inbound webhook to its tenant (phone_number_id is globally unique). */
export function findAccountByPhoneNumberId(phoneNumberId: string) {
  return prisma.whatsAppAccount.findUnique({
    where: { phoneNumberId },
    include: {
      channel: { select: { id: true, isActive: true, botId: true } },
      organization: {
        select: { id: true, timezone: true, businessHours: { select: { weekday: true, opensAt: true, closesAt: true } } },
      },
    },
  });
}
export type RoutedAccount = NonNullable<Awaited<ReturnType<typeof findAccountByPhoneNumberId>>>;

export function webhookConfig() {
  const e = env();
  return { appSecret: e.WHATSAPP_APP_SECRET ?? null, verifyToken: e.WHATSAPP_VERIFY_TOKEN ?? null };
}
