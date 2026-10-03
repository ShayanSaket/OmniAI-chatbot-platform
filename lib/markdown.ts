// A deliberately small, safe Markdown subset for chat messages. It parses to a tree that
// is rendered with React elements — never innerHTML — so message content cannot inject
// markup. Links are restricted to http(s), mailto and tel.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'codeblock'; text: string };

const SAFE_PROTOCOL = /^(https?:|mailto:|tel:)/i;

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!SAFE_PROTOCOL.test(trimmed)) return null;
  try {
    // Validate absolute http(s) URLs; mailto/tel pass through.
    if (/^https?:/i.test(trimmed)) new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

// Order matters: code first (its content is literal), then links, bold, italic, bare URLs.
const INLINE = /(`[^`\n]+`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*|_([^_\n]+)_)|((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ type: 'text', text: text.slice(last, index) });
    if (m[1]) out.push({ type: 'code', text: m[1].slice(1, -1) });
    else if (m[2]) {
      const href = safeHref(m[4]!);
      out.push(href ? { type: 'link', href, children: parseInline(m[3]!) } : { type: 'text', text: m[3]! });
    } else if (m[5]) out.push({ type: 'strong', children: parseInline(m[6]!) });
    else if (m[7]) out.push({ type: 'em', children: parseInline((m[8] ?? m[9])!) });
    else if (m[10]) {
      const raw = m[10];
      const href = safeHref(raw.startsWith('www.') ? `https://${raw}` : raw);
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: raw }] } : { type: 'text', text: raw });
    }
    last = index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'list', ...list });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i++]!);
      blocks.push({ type: 'codeblock', text: code.join('\n') });
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(parseInline((bullet ?? numbered)![1]!));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    // Headings are rendered as bold paragraphs (chat bubbles have no heading hierarchy).
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    paragraph.push(heading ? `**${heading[1]}**` : line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Plain-text rendering (previews, notifications, WhatsApp fallback). */
export function markdownToPlainText(source: string): string {
  return source
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}
