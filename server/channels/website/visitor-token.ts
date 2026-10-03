import { createHmac } from 'node:crypto';
import { safeEqual } from '../../crypto';

// Website visitors have no account. On first contact the server issues a signed token
// binding (bot, customer); the widget stores it first-party on the host site and sends
// it as a bearer token. Signature-checked, so it cannot be forged for another customer
// or replayed against another bot.

const VERSION = 1;
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export interface VisitorClaims {
  botId: string;
  customerId: string;
  /** Issued-at, seconds. */
  iat: number;
}

function key(secret: string) {
  return createHmac('sha256', secret).update('omniai:widget-visitor-token:v1').digest();
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', key(secret)).update(payload).digest('base64url');
}

export function issueVisitorToken(claims: Omit<VisitorClaims, 'iat'>, secret: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ v: VERSION, b: claims.botId, c: claims.customerId, iat: Math.floor(now / 1000) }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyVisitorToken(token: string, secret: string, now = Date.now()): VisitorClaims | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (data.v !== VERSION || typeof data.b !== 'string' || typeof data.c !== 'string' || typeof data.iat !== 'number') {
      return null;
    }
    if (now / 1000 - data.iat > MAX_AGE_SECONDS) return null;
    return { botId: data.b, customerId: data.c, iat: data.iat };
  } catch {
    return null;
  }
}

/** Tokens older than this are transparently re-issued on session start. */
export const REFRESH_AFTER_SECONDS = 30 * 24 * 60 * 60;
