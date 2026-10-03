import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hmacSha256Hex, safeEqual } from '@/server/crypto';
import { assertSameOrigin } from '@/server/http';
import { redact } from '@/server/logger';
import { memoryHit, resetMemoryRateLimits } from '@/server/rate-limit';
import { hashPassword, verifyPassword } from '@/server/auth/password';
import { safeCallbackUrl } from '@/lib/urls';
import { AppError } from '@/server/errors';

describe('secret encryption', () => {
  it('round-trips with the configured key', () => {
    const token = 'EAAG-whatsapp-token-ü-✓';
    const sealed = encryptSecret(token);
    expect(sealed).not.toContain(token);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(decryptSecret(sealed)).toBe(token);
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const sealed = encryptSecret('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
  });
});

describe('hmac + constant-time compare', () => {
  it('produces stable signatures', () => {
    expect(hmacSha256Hex('k', 'body')).toBe(hmacSha256Hex('k', 'body'));
    expect(safeEqual(hmacSha256Hex('k', 'body'), hmacSha256Hex('k', 'body'))).toBe(true);
    expect(safeEqual(hmacSha256Hex('k', 'body'), hmacSha256Hex('k', 'bodY'))).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('Correct-Horse-1');
    expect(hash).not.toContain('Correct');
    expect(await verifyPassword('Correct-Horse-1', hash)).toBe(true);
    expect(await verifyPassword('wrong-password-1', hash)).toBe(false);
  });

  it('returns false for unknown users without throwing', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
  });
});

describe('log redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      user: 'a',
      password: 'p',
      nested: { accessToken: 't', apiKey: 'k', headers: { authorization: 'Bearer x', cookie: 'c' } },
      list: [{ secret: 's', ok: 1 }],
    });
    expect(JSON.stringify(out)).not.toMatch(/"p"|"t"|"k"|Bearer|"c"|"s"/);
    expect(out).toMatchObject({ user: 'a', list: [{ ok: 1 }] });
  });
});

describe('rate limiter (memory fallback)', () => {
  it('allows up to the limit within a window, then blocks, then resets', () => {
    resetMemoryRateLimits();
    const rule = { name: 't', limit: 3, windowSeconds: 60 };
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => memoryHit('k', rule, t0).allowed)).toEqual([true, true, true]);
    expect(memoryHit('k', rule, t0 + 1000).allowed).toBe(false);
    expect(memoryHit('other', rule, t0).allowed).toBe(true);
    expect(memoryHit('k', rule, t0 + 61_000).allowed).toBe(true);
  });
});

describe('CSRF same-origin check', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost:3000/api/x', { method: 'POST', headers });

  it('accepts same-origin and origin-less requests', () => {
    expect(() => assertSameOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: 'localhost:3000' }))).not.toThrow();
  });

  it('blocks cross-origin and cross-site requests', () => {
    expect(() => assertSameOrigin(req({ host: 'localhost:3000', origin: 'https://evil.example' }))).toThrow(AppError);
    expect(() => assertSameOrigin(req({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))).toThrow(AppError);
    expect(() => assertSameOrigin(req({ host: 'localhost:3000', origin: 'not a url' }))).toThrow(AppError);
  });
});

describe('post-login redirect', () => {
  it('only allows same-site relative paths', () => {
    expect(safeCallbackUrl('/settings?tab=team')).toBe('/settings?tab=team');
    expect(safeCallbackUrl('https://evil.example')).toBe('/');
    expect(safeCallbackUrl('//evil.example')).toBe('/');
    expect(safeCallbackUrl('/\\evil.example')).toBe('/');
    expect(safeCallbackUrl(null)).toBe('/');
  });
});

describe('login lockout counts failures only', () => {
  it('blocks after the failure budget without counting checks', async () => {
    const { isRateLimited, recordRateLimitHit } = await import('@/server/rate-limit');
    resetMemoryRateLimits();
    const rule = { name: 'login-test', limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 10; i++) expect(await isRateLimited(rule, 'a@b.c')).toBe(false); // checks are free
    for (let i = 0; i < 3; i++) await recordRateLimitHit(rule, 'a@b.c');
    expect(await isRateLimited(rule, 'a@b.c')).toBe(true);
    expect(await isRateLimited(rule, 'other@b.c')).toBe(false);
  });
});
