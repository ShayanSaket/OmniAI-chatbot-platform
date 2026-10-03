// Allowed-origin matching for the website widget.
// Entries: "https://example.com", "https://*.example.com" (any subdomain), "http://localhost:3000".

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isValidOriginPattern(pattern: string): boolean {
  const wildcard = pattern.match(/^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i);
  if (wildcard) return Boolean(normalizeOrigin(`${wildcard[1]}://${wildcard[2]}${wildcard[3] ?? ''}`));
  return normalizeOrigin(pattern) === pattern.replace(/\/$/, '');
}

export function matchesOrigin(origin: string, pattern: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const wildcard = pattern.match(/^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i);
  if (wildcard) {
    const url = new URL(normalized);
    const [, protocol, domain, port] = wildcard;
    return (
      url.protocol === `${protocol!.toLowerCase()}:` &&
      url.hostname.toLowerCase().endsWith(`.${domain!.toLowerCase()}`) &&
      (port ? url.port === port.slice(1) : url.port === '')
    );
  }
  return normalized === normalizeOrigin(pattern);
}

/**
 * An empty allowlist allows any site. The app's own origin is always allowed
 * (dashboard preview, test page, hosted chat page).
 */
export function isOriginAllowed(origin: string | null | undefined, allowlist: string[], appOrigin: string): boolean {
  if (!origin) return false;
  if (normalizeOrigin(origin) === normalizeOrigin(appOrigin)) return true;
  if (allowlist.length === 0) return true;
  return allowlist.some((pattern) => matchesOrigin(origin, pattern));
}
