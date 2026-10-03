// Helpers for reading client metadata from incoming requests.

type HeaderSource = Headers | Record<string, string | string[] | undefined> | undefined;

function header(source: HeaderSource, name: string): string | undefined {
  if (!source) return undefined;
  if (typeof (source as Headers).get === 'function') return (source as Headers).get(name) ?? undefined;
  const value = (source as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Client IP (first X-Forwarded-For hop, set by the reverse proxy). */
export function clientIp(source: HeaderSource): string {
  const forwarded = header(source, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return header(source, 'x-real-ip') ?? 'unknown';
}

export function userAgent(source: HeaderSource): string | undefined {
  return header(source, 'user-agent')?.slice(0, 300);
}

export function requestId(source: HeaderSource): string {
  return header(source, 'x-request-id') ?? crypto.randomUUID();
}
