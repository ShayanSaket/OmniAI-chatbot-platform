import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env';

// AES-256-GCM for secrets at rest (per-tenant WhatsApp tokens, webhook secrets,
// integration credentials). Format: v1.<iv>.<tag>.<ciphertext> (base64url).

const VERSION = 'v1';

function key(): Buffer {
  const raw = env().ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not configured');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return buf;
}

export function encryptSecret(plaintext: string, keyOverride?: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOverride ?? key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecret(payload: string, keyOverride?: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', keyOverride ?? key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export function hmacSha256Hex(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** URL-safe random token (e.g. public bot keys). */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}
