// Outbound webhook signatures. Pure.
//
//   X-OmniAI-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//
// Receivers recompute the HMAC over the timestamp and the exact raw body, compare in
// constant time, and reject timestamps older than a few minutes (replay protection).
// During secret rotation two v1= values may be present; any match is valid.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-OmniAI-Signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

/** Verification as a receiver would do it (used in tests and documented for customers). */
export function verifySignatureHeader(
  header: string | null,
  body: string,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(computeSignature(secret, t, body), 'hex');
  return signatures.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Retry schedule after a failed attempt (seconds); after the last, the delivery fails. */
export const RETRY_SCHEDULE_SECONDS = [30, 120, 600, 3600, 6 * 3600];
export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;
/** Permanently failed deliveries in a row before an endpoint is switched off. */
export const DISABLE_AFTER_FAILURES = 10;

export function nextRetryDelay(attempts: number): number | null {
  return RETRY_SCHEDULE_SECONDS[attempts - 1] ?? null;
}
