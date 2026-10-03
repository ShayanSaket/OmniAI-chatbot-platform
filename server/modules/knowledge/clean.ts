// Text cleaning for extracted documents. Pure.
//
// PDFs and web pages carry noise: hyphenated line breaks, repeated page headers/footers,
// page numbers, control characters, runs of whitespace. Cleaning before chunking makes
// chunks denser and embeddings better.

export interface PageText {
  page: number;
  text: string;
}

export function normalizeWhitespace(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Joins words hyphenated across line breaks ("cus-\ntomer" → "customer"). */
export function dehyphenate(text: string): string {
  return text.replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2');
}

/** Joins hard-wrapped lines inside paragraphs (PDF extraction breaks lines at the page width). */
export function unwrapLines(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n');
      // Keep lists, headings and short label lines as separate lines.
      const structured = lines.some((l) => /^\s*([-*•]|\d+[.)]|#{1,6}\s|Q:|A:)/.test(l));
      if (structured) return para;
      return lines.reduce((acc, line) => {
        if (!acc) return line;
        return /[.!?:;。؟]$/.test(acc) && /^\p{Lu}/u.test(line) && line.length < 60 ? `${acc}\n${line}` : `${acc} ${line}`;
      }, '');
    })
    .join('\n\n');
}

/**
 * Comparison key for header/footer detection. Lines ending in a number ("Handbook –
 * Page 3") are compared with the number masked; all other lines must repeat exactly,
 * so real content that merely mentions numbers is never mistaken for boilerplate.
 */
const lineKey = (line: string) => {
  const t = line.trim().toLowerCase();
  return /\d+\s*$/.test(t) && t.length < 60 ? t.replace(/\d+\s*$/, '#') : t;
};

/**
 * Removes lines that repeat on most pages (running headers/footers, "Page 3 of 10").
 * Needs at least 3 pages to tell boilerplate from content.
 */
export function stripRepeatedLines(pages: PageText[]): PageText[] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  for (const p of pages) {
    const edges = new Set([...p.text.split('\n').slice(0, 3), ...p.text.split('\n').slice(-3)].map(lineKey).filter((k) => k.length > 0 && k.length < 120));
    edges.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
  }
  const boilerplate = new Set(Array.from(counts).filter(([, n]) => n >= Math.max(3, pages.length * 0.6)).map(([k]) => k));
  return pages.map((p) => ({
    page: p.page,
    text: p.text
      .split('\n')
      .filter((line) => !boilerplate.has(lineKey(line)) && !/^\s*(page\s*)?\d+\s*(\/|of|von)?\s*\d*\s*$/i.test(line))
      .join('\n'),
  }));
}

export function cleanText(text: string): string {
  return normalizeWhitespace(unwrapLines(dehyphenate(normalizeWhitespace(text))));
}

export function cleanPages(pages: PageText[]): PageText[] {
  return stripRepeatedLines(pages.map((p) => ({ page: p.page, text: normalizeWhitespace(p.text) })))
    .map((p) => ({ page: p.page, text: cleanText(p.text) }))
    .filter((p) => p.text.length > 0);
}
