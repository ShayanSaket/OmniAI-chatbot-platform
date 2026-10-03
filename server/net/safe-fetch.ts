import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../env';
import { logger } from '../logger';

// Outbound HTTP to URLs that tenants configure (order lookup, later webhooks/CRMs).
// Protects against SSRF: in production only https to public addresses is allowed, so a
// tenant cannot make the server call internal services (metadata endpoints, Redis, ...).
// Redirects are refused (they could point inward), responses are size- and time-limited.

export class OutboundRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Validates a tenant-configured URL. Throws OutboundRequestError when not allowed. */
export async function assertPublicUrl(raw: string, options: { allowPrivate?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRequestError('Invalid URL');
  }
  const production = env().NODE_ENV === 'production';
  const allowPrivate = options.allowPrivate ?? !production;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    throw new OutboundRequestError('Only https:// URLs are allowed');
  }
  if (url.username || url.password) throw new OutboundRequestError('URLs must not contain credentials');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
      logger.warn('outbound host lookup failed', { host, err: (err as Error).message, code: (err as NodeJS.ErrnoException).code });
      throw new OutboundRequestError('Host name could not be resolved');
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new OutboundRequestError('URLs must point to a public address');
    }
  }
  return url;
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new OutboundRequestError('Response too large', res.status);
      }
      parts.push(value);
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * GET a tenant-supplied URL (web pages for the knowledge base). Redirects are followed
 * manually so every hop is validated against the SSRF rules.
 */
export async function safeFetch(
  raw: string,
  init: { accept?: string; timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<{ url: string; status: number; contentType: string; bytes: Uint8Array }> {
  let current = raw;
  for (let hop = 0; hop <= (init.maxRedirects ?? 3); hop++) {
    const url = await assertPublicUrl(current);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: init.accept ?? '*/*', 'User-Agent': 'OmniAI-KnowledgeBot/1.0 (+https://omniai.example/bot)' },
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new OutboundRequestError(`Request failed: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location) throw new OutboundRequestError('Redirect without location', res.status);
      current = new URL(location, url).toString();
      continue;
    }
    const bytes = await readLimited(res, init.maxBytes ?? 5 * 1024 * 1024);
    return { url: url.toString(), status: res.status, contentType: (res.headers.get('content-type') ?? '').toLowerCase(), bytes };
  }
  throw new OutboundRequestError('Too many redirects');
}

/**
 * POST JSON to a tenant-configured URL (outbound webhooks). Redirects are not followed
 * (treated as failures), the response body is read only partially for diagnostics.
 */
export async function safePostJson(
  raw: string,
  body: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; durationMs: number; bodySnippet: string }> {
  const url = await assertPublicUrl(raw);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'OmniAI-Webhooks/1.0', ...init.headers },
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const name = (err as Error).name;
    throw new OutboundRequestError(name === 'TimeoutError' ? 'Timed out' : `Request failed: ${(err as Error).message}`);
  }
  let snippet = '';
  try {
    const bytes = await readLimited(res, 64 * 1024).catch(() => new Uint8Array());
    snippet = new TextDecoder().decode(bytes.subarray(0, 500));
  } catch {
    /* body is optional */
  }
  return { status: res.status, durationMs: Date.now() - started, bodySnippet: snippet };
}

export async function safeFetchJson(
  raw: string,
  init: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const url = await assertPublicUrl(raw);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': 'OmniAI/1.0', ...init.headers },
      signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
    });
  } catch (err) {
    throw new OutboundRequestError(`Request failed: ${(err as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new OutboundRequestError('Redirects are not followed', res.status);
  }
  const maxBytes = init.maxBytes ?? 64 * 1024;
  const reader = res.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new OutboundRequestError('Response too large', res.status);
      }
      parts.push(value);
    }
  }
  const text = Buffer.concat(parts).toString('utf8');
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new OutboundRequestError('Response is not JSON', res.status);
    }
  }
  return { status: res.status, body };
}
