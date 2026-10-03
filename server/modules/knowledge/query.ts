// Keyword-query helpers for full-text retrieval. Pure.
import { ALL_STOPWORDS } from '@/lib/language';

const MAX_TERMS = 12;

/** Distinct meaningful search terms of a question (lowercase, letters/digits only). */
export function queryTerms(text: string): string[] {
  const words = text.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    if (word.length < 3 && !/^\d+$/.test(word)) continue;
    if (ALL_STOPWORDS.has(word) || terms.includes(word)) continue;
    terms.push(word);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/** to_tsquery('simple', …) input: any term, prefix-matched (helps plurals and compounds). */
export function toPrefixTsQuery(terms: string[]): string | null {
  const safe = terms.map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  return safe.length ? safe.map((t) => `${t}:*`).join(' | ') : null;
}

/** Share of the query terms that occur (as a word prefix) in the text. */
export function termCoverage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const words = new Set(text.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []);
  const wordList = Array.from(words);
  const hits = terms.filter((t) => words.has(t) || wordList.some((w) => w.startsWith(t))).length;
  return hits / terms.length;
}
