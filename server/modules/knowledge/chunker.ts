// Splits plain text / Markdown into retrieval chunks. Pure (no I/O) and deterministic.
//
// Strategy: split into blocks at headings and blank lines, remember the heading path as
// the chunk location, then pack blocks into chunks of ~TARGET characters. Oversized
// blocks are split at sentence boundaries. Consecutive chunks of the same section
// overlap by one block so an answer that spans a boundary is still retrievable.

export interface TextChunk {
  index: number;
  content: string;
  /** Heading path, e.g. "Pricing FAQ › Enterprise". */
  location: string | null;
  tokenCount: number;
  /** 1-based page for paginated sources (PDF). */
  pageNumber: number | null;
}

const TARGET = 900;
const MAX = 1400;

interface Block {
  text: string;
  location: string | null;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitLong(text: string): string[] {
  if (text.length <= MAX) return [text];
  const sentences = text.match(/[^.!?。؟\n]+[.!?。؟]*\s*/g) ?? [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > TARGET) {
      out.push(current.trim());
      current = '';
    }
    // A single sentence longer than MAX is hard-wrapped.
    if (sentence.length > MAX) {
      for (let i = 0; i < sentence.length; i += TARGET) out.push(sentence.slice(i, i + TARGET).trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

function toBlocks(text: string, title?: string): Block[] {
  const headings: string[] = [];
  const blocks: Block[] = [];
  // A first heading that repeats the document title is not repeated in the path.
  const location = () =>
    [title, ...headings]
      .filter((part, i, all): part is string => Boolean(part) && (i === 0 || part!.toLowerCase() !== all[i - 1]?.toLowerCase()))
      .join(' › ') || null;
  for (const raw of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = raw.split('\n');
    const body: string[] = [];
    for (const line of lines) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        if (body.length) {
          blocks.push({ text: body.join('\n').trim(), location: location() });
          body.length = 0;
        }
        const depth = heading[1]!.length;
        headings.length = Math.min(headings.length, depth - 1);
        headings[depth - 1] = heading[2]!;
        continue;
      }
      body.push(line);
    }
    const joined = body.join('\n').trim();
    if (joined) for (const part of splitLong(joined)) blocks.push({ text: part, location: location() });
  }
  return blocks;
}

export function chunkText(text: string, options: { title?: string } = {}): TextChunk[] {
  const blocks = toBlocks(text, options.title);
  const chunks: TextChunk[] = [];
  let current: Block[] = [];

  const flush = () => {
    if (!current.length) return;
    const content = current.map((b) => b.text).join('\n\n');
    chunks.push({ index: chunks.length, content, location: current[0]!.location, tokenCount: estimateTokenCount(content), pageNumber: null });
  };

  for (const block of blocks) {
    const size = current.reduce((n, b) => n + b.text.length + 2, 0);
    const sameSection = current.length === 0 || current[current.length - 1]!.location === block.location;
    if (current.length && (size + block.text.length > TARGET || !sameSection)) {
      flush();
      const last = current[current.length - 1]!;
      // Overlap: carry the last block into the next chunk when it's in the same section.
      current = sameSection && last.text.length < TARGET / 2 && current.length > 1 ? [last] : [];
    }
    current.push(block);
  }
  flush();
  return chunks;
}

/** Chunks page by page so every chunk knows its page (for "page 4" citations). */
export function chunkPages(pages: { page: number; text: string }[], options: { title?: string } = {}): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const page of pages) {
    for (const chunk of chunkText(page.text, options)) {
      chunks.push({ ...chunk, index: chunks.length, pageNumber: page.page });
    }
  }
  return chunks;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/** One chunk per question/answer pair: an FAQ answer is never split from its question. */
export function chunkFaq(entries: FaqEntry[], options: { title?: string } = {}): TextChunk[] {
  return entries
    .map((e) => ({ q: e.question.trim(), a: e.answer.trim() }))
    .filter((e) => e.q && e.a)
    .map((e, index) => {
      const content = `Q: ${e.q}\nA: ${e.a}`;
      return { index, content, location: options.title ?? null, tokenCount: estimateTokenCount(content), pageNumber: null };
    });
}

/** Parses "Q: … / A: …" text into FAQ entries (used for pasted FAQs and seed data). */
export function parseFaqText(text: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  let current: FaqEntry | null = null;
  let field: 'question' | 'answer' | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const q = /^\s*(?:Q|Question|Frage|F)\s*[:.]\s*(.*)$/i.exec(line);
    const a = /^\s*(?:A|Answer|Antwort)\s*[:.]\s*(.*)$/i.exec(line);
    if (q) {
      if (current?.question && current.answer) entries.push(current);
      current = { question: q[1]!, answer: '' };
      field = 'question';
    } else if (a && current) {
      current.answer = a[1]!;
      field = 'answer';
    } else if (current && field && line.trim()) {
      current[field] += `\n${line.trim()}`;
    }
  }
  if (current?.question && current.answer) entries.push(current);
  return entries.map((e) => ({ question: e.question.trim(), answer: e.answer.trim() }));
}
