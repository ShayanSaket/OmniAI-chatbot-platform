// HTML → structured plain text, and main-content extraction for web pages.
// Pure apart from the DOM shim (linkedom); no network access.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'NAV', 'FOOTER', 'ASIDE', 'HEADER']);
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'ADDRESS', 'UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TR', 'HR']);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

/**
 * Converts an HTML fragment to text that keeps structure: headings become "#" lines (the
 * chunker uses them as section locations), list items "- ", table rows "a | b".
 */
export function htmlToText(root: DomNode, options: { skipChrome?: boolean } = {}): string {
  const out: string[] = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };
  const blank = () => {
    flush();
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  const walk = (node: DomNode) => {
    if (node.nodeType === 3) {
      line += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const tag = node.nodeName.toUpperCase();
    if (SKIP.has(tag) && (options.skipChrome !== false || !['NAV', 'FOOTER', 'ASIDE', 'HEADER'].includes(tag))) return;
    if (node.getAttribute?.('aria-hidden') === 'true' || node.getAttribute?.('hidden') !== null && node.getAttribute?.('hidden') !== undefined) return;

    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      blank();
      line = `${'#'.repeat(Number(heading[1]))} `;
      Array.from(node.childNodes).forEach(walk);
      blank();
      return;
    }
    if (tag === 'BR') {
      flush();
      return;
    }
    if (tag === 'LI') {
      flush();
      line = '- ';
      Array.from(node.childNodes).forEach(walk);
      flush();
      return;
    }
    if (tag === 'TR') {
      flush();
      const cells = Array.from(node.childNodes)
        .filter((c) => c.nodeType === 1 && /^T[DH]$/i.test(c.nodeName))
        .map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (cells.length) out.push(cells.join(' | '));
      return;
    }
    const block = BLOCK.has(tag);
    if (block) blank();
    Array.from(node.childNodes).forEach(walk);
    if (block) blank();
  };
  walk(root);
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ExtractedPage {
  title: string | null;
  text: string;
  /** Absolute same-origin links found on the page (for crawling). */
  links: string[];
  language: string | null;
}

/** Extracts the main content of a web page (Readability), falling back to the whole body. */
export function extractHtmlPage(html: string, pageUrl: string): ExtractedPage {
  const { document } = parseHTML(html);
  const base = new URL(pageUrl);
  const links = new Set<string>();
  for (const a of Array.from(document.querySelectorAll('a[href]')) as unknown as { getAttribute(n: string): string | null }[]) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      url.hash = '';
      if (url.origin === base.origin && /^https?:$/.test(url.protocol)) links.add(url.toString());
    } catch {
      /* ignore malformed links */
    }
  }
  const language = (document.documentElement?.getAttribute?.('lang') ?? '').slice(0, 2).toLowerCase() || null;
  const fallbackTitle = (document.querySelector('title')?.textContent ?? '').trim() || null;

  let title = fallbackTitle;
  let text = '';
  try {
    // Readability mutates the document: give it its own copy.
    const article = new Readability(parseHTML(html).document as unknown as Document, { charThreshold: 200 }).parse();
    if (article?.content) {
      title = article.title?.trim() || fallbackTitle;
      text = htmlToText(parseHTML(`<div>${article.content}</div>`).document as unknown as DomNode);
    }
  } catch {
    /* fall back below */
  }
  if (text.length < 200) {
    const body = document.querySelector('main') ?? document.querySelector('body') ?? document;
    const whole = htmlToText(body as unknown as DomNode);
    if (whole.length > text.length) text = whole;
  }
  return { title, text, links: Array.from(links), language };
}

/** HTML fragment (e.g. DOCX converted by mammoth) → structured text. */
export function htmlFragmentToText(html: string): string {
  return htmlToText(parseHTML(`<!doctype html><html><body><div>${html}</div></body></html>`).document as unknown as DomNode, { skipChrome: false });
}
