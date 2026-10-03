// Source citations. The model marks facts taken from knowledge with "[n]" (n = the
// snippet's reference number). Customers never see the markers: a streaming filter
// removes them as text arrives, and the cited numbers become the message's sources.
// Pure — no I/O.

const COMPLETE = /\s*\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;
/** A tail that may still become a citation once more text arrives. */
const PARTIAL_TAIL = /\s*(\[[\d,\s]*)?$/;

/** Numbers cited anywhere in `text`, in order of first appearance. */
export function extractCitations(text: string): number[] {
  const refs: number[] = [];
  for (const match of text.matchAll(COMPLETE)) {
    for (const n of match[1]!.split(',')) {
      const ref = Number(n.trim());
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
}

export function stripCitations(text: string): string {
  return text.replace(COMPLETE, '').replace(/[ \t]+$/gm, '');
}

/**
 * Streaming variant: feed text deltas, receive what is safe to show. Holds back trailing
 * whitespace and a possible unfinished "[12" until the next delta decides it. A complete
 * marker at the very end is also held: "[1](" would be a Markdown link, not a citation.
 */
export function createCitationFilter() {
  let buffer = '';
  return {
    push(delta: string): string {
      buffer += delta;
      const text = buffer.replace(COMPLETE, (m, _refs, offset: number) => (offset + m.length === buffer.length ? m : ''));
      // Hold an unfinished marker, or a finished one at the very end (could precede "(").
      const endMarker = /\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]$/.exec(text);
      const tail = endMarker ?? PARTIAL_TAIL.exec(text);
      const holdFrom = tail && tail[0].length ? tail.index : text.length;
      const out = text.slice(0, holdFrom);
      buffer = text.slice(holdFrom);
      return out;
    },
    /** Releases whatever is held at the end of the stream. */
    flush(): string {
      const out = stripCitations(buffer);
      buffer = '';
      return out;
    },
  };
}
