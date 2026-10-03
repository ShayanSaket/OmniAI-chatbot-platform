import 'server-only';
import { logger } from '../../logger';
import { OutboundRequestError, safeFetch } from '../../net/safe-fetch';
import { ExtractionError } from './extract';
import { extractHtmlPage, type ExtractedPage } from './html';
import { isAllowed, parseRobots } from './robots';

// Website import: one page, or a page plus the same-site pages it links to.

export const MAX_CRAWL_PAGES = 25;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const SKIP_EXTENSIONS = /\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mp3|docx?|xlsx?|pptx?|css|js|xml|json|ico)(\?|$)/i;

/** A temporary failure: processing is retried later (not shown as a final error). */
export class TransientFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientFetchError';
  }
}

export interface FetchedPage extends ExtractedPage {
  url: string;
}

const robotsCache = new Map<string, { rules: { allow: boolean; pattern: string }[]; at: number }>();

async function robotsFor(origin: string) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
  let parsed = { rules: [] as { allow: boolean; pattern: string }[] };
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { accept: 'text/plain', maxBytes: 256 * 1024, timeoutMs: 5000 });
    if (res.status === 200) parsed = parseRobots(new TextDecoder().decode(res.bytes));
  } catch {
    /* no robots.txt → everything allowed */
  }
  const entry = { ...parsed, at: Date.now() };
  robotsCache.set(origin, entry);
  return entry;
}

/** Fetches and extracts one page. Throws ExtractionError with a user-facing message. */
export async function fetchPage(rawUrl: string, options: { checkRobots?: boolean } = {}): Promise<FetchedPage> {
  const url = new URL(rawUrl);
  if (options.checkRobots !== false) {
    const robots = await robotsFor(url.origin);
    if (!isAllowed(robots, `${url.pathname}${url.search}`)) throw new ExtractionError('The website’s robots.txt does not allow fetching this page.');
  }
  let res;
  try {
    res = await safeFetch(url.toString(), { accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5', maxBytes: MAX_PAGE_BYTES });
  } catch (err) {
    // Network/DNS hiccups and timeouts are retried by the recovery job; policy
    // violations (private address, too large, too many redirects) are final.
    if (err instanceof OutboundRequestError && /^(Request failed|Host name could not be resolved)/.test(err.message)) {
      throw new TransientFetchError(`The page could not be fetched: ${err.message}`);
    }
    throw new ExtractionError(err instanceof OutboundRequestError ? `The page could not be fetched: ${err.message}` : 'The page could not be fetched.');
  }
  if (res.status === 429 || res.status >= 500) throw new TransientFetchError(`The website responded with HTTP ${res.status}.`);
  if (res.status !== 200) throw new ExtractionError(`The page responded with HTTP ${res.status}.`);
  const charset = /charset=([\w-]+)/.exec(res.contentType)?.[1] ?? 'utf-8';
  let body: string;
  try {
    body = new TextDecoder(charset).decode(res.bytes);
  } catch {
    body = new TextDecoder().decode(res.bytes);
  }
  if (res.contentType.startsWith('text/plain')) return { url: res.url, title: null, text: body, links: [], language: null };
  if (!/html|xml/.test(res.contentType) && !/^\s*</.test(body)) throw new ExtractionError('The URL does not point to a web page.');
  const page = extractHtmlPage(body, res.url);
  if (page.text.trim().length < 40) throw new ExtractionError('No readable text was found on the page.');
  return { url: res.url, ...page };
}

/**
 * The start page plus same-site pages it links to (one level deep), respecting
 * robots.txt, up to `maxPages`. Pages that fail are skipped and reported.
 */
export async function crawlSite(startUrl: string, maxPages = MAX_CRAWL_PAGES): Promise<{ pages: FetchedPage[]; failed: { url: string; error: string }[] }> {
  const limit = Math.min(Math.max(maxPages, 1), MAX_CRAWL_PAGES);
  const start = await fetchPage(startUrl);
  const pages: FetchedPage[] = [start];
  const failed: { url: string; error: string }[] = [];
  const seen = new Set([normalize(startUrl), normalize(start.url)]);
  const queue = start.links.filter((l) => !SKIP_EXTENSIONS.test(new URL(l).pathname));
  for (const link of queue) {
    if (pages.length >= limit) break;
    const key = normalize(link);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const page = await fetchPage(link);
      if (!seen.has(normalize(page.url)) || page.url === link) {
        seen.add(normalize(page.url));
        pages.push(page);
      }
    } catch (err) {
      failed.push({ url: link, error: (err as Error).message });
    }
  }
  logger.info('website crawled', { start: new URL(startUrl).origin, pages: pages.length, failed: failed.length });
  return { pages, failed };
}

function normalize(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}
