// Outbound WhatsApp formatting. Pure.
//
// The AI writes light Markdown for every channel. WhatsApp has its own syntax
// (*bold*, _italic_, ~strike~, ```mono```), no links-with-labels and hard limits:
// 4096 characters per text message, 1024 for an interactive body, max 3 reply buttons
// with 20-character titles.

export const TEXT_LIMIT = 4096;
export const INTERACTIVE_BODY_LIMIT = 1024;
export const MAX_REPLY_BUTTONS = 3;
export const BUTTON_TITLE_LIMIT = 20;

const BOLD_OPEN = '\u0001';
const BOLD_CLOSE = '\u0002';

function convertInline(text: string): string {
  // Protect inline code: WhatsApp renders `code` as monospace too.
  const codes: string[] = [];
  let out = text.replace(/`[^`\n]+`/g, (m) => {
    codes.push(m);
    return `\u0003${codes.length - 1}\u0003`;
  });
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const bare = url.replace(/^mailto:|^tel:/i, '');
    return label.trim() === url || label.trim() === bare ? bare : `${label} (${bare})`;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a?: string, b?: string) => `${BOLD_OPEN}${a ?? b}${BOLD_CLOSE}`);
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '_$1_');
  out = out.replace(/~~([^~\n]+)~~/g, '~$1~');
  out = out.replaceAll(BOLD_OPEN, '*').replaceAll(BOLD_CLOSE, '*');
  return out.replace(/\u0003(\d+)\u0003/g, (_m, i: string) => codes[Number(i)]!);
}

export function markdownToWhatsApp(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      out.push('```');
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      out.push(`*${convertInline(heading[1]!).replace(/\*/g, '')}*`);
      continue;
    }
    const bullet = /^(\s*)[*•+-]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}- ${convertInline(bullet[2]!)}`);
      continue;
    }
    out.push(convertInline(line));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits text into chunks ≤ limit, preferring paragraph, then line, then word boundaries. */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function buttonTitle(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  return clean.length <= BUTTON_TITLE_LIMIT ? clean : `${clean.slice(0, BUTTON_TITLE_LIMIT - 1).trimEnd()}…`;
}

export interface ReplyButton {
  /** Returned to us in the button_reply webhook. */
  id: string;
  title: string;
}

export interface OutboundContent {
  text: string;
  replyButtons?: ReplyButton[];
  /** A single link button (cta_url). */
  linkButton?: { label: string; url: string };
}

export type GraphMessagePayload = Record<string, unknown> & { messaging_product: 'whatsapp'; to: string; type: string };

/**
 * Builds the Graph API payloads for one outbound message: text parts, with the buttons
 * attached to the last part (as an interactive message, which has a shorter body limit).
 */
export function buildTextPayloads(to: string, content: OutboundContent): GraphMessagePayload[] {
  const buttons = (content.replyButtons ?? []).slice(0, MAX_REPLY_BUTTONS);
  const interactive = buttons.length > 0 || Boolean(content.linkButton);
  const parts = splitText(content.text || ' ', TEXT_LIMIT);

  // The interactive body has a lower limit: re-split the last part if needed.
  if (interactive && parts.length && parts[parts.length - 1]!.length > INTERACTIVE_BODY_LIMIT) {
    const last = parts.pop()!;
    parts.push(...splitText(last, INTERACTIVE_BODY_LIMIT));
  }

  return parts.map((body, i): GraphMessagePayload => {
    const isLast = i === parts.length - 1;
    if (!isLast || !interactive) {
      return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: /https?:\/\//.test(body) } };
    }
    if (buttons.length) {
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: buttonTitle(b.title) } })) },
        },
      };
    }
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: body },
        action: { name: 'cta_url', parameters: { display_text: buttonTitle(content.linkButton!.label), url: content.linkButton!.url } },
      },
    };
  });
}

/** Numbered placeholders ({{1}}, {{2}}…) in a template body. */
export function templatePlaceholderCount(body: string): number {
  const numbers = Array.from(body.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (m) => Number(m[1]));
  return numbers.length ? Math.max(...numbers) : 0;
}

export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => params[Number(n) - 1] ?? m);
}
