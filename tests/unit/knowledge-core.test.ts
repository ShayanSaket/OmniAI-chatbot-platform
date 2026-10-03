import { describe, expect, it } from 'vitest';
import { chunkFaq, chunkPages, parseFaqText } from '@/server/modules/knowledge/chunker';
import { cleanPages, cleanText, dehyphenate } from '@/server/modules/knowledge/clean';
import { extractHtmlPage, htmlFragmentToText } from '@/server/modules/knowledge/html';
import { embeddingInput } from '@/server/modules/knowledge/ingest';
import { diversify, fuseRankings } from '@/server/modules/knowledge/retrieval';
import { isAllowed, parseRobots } from '@/server/modules/knowledge/robots';

describe('text cleaning', () => {
  it('joins hyphenated words and hard-wrapped lines, keeps lists', () => {
    expect(dehyphenate('our cus-\ntomers')).toBe('our customers');
    expect(cleanText('The plan includes   unlimited\nconversations and\npriority support.\n\n- item one\n- item two')).toBe(
      'The plan includes unlimited conversations and priority support.\n\n- item one\n- item two',
    );
    expect(cleanText('a\u0000b​c d')).toBe('abc d');
  });

  it('removes running headers, footers and page numbers', () => {
    const pages = [1, 2, 3, 4].map((n) => ({ page: n, text: `ACME Handbook – Confidential\nContent of page ${n} is unique here.\nPage ${n} of 4` }));
    const cleaned = cleanPages(pages);
    expect(cleaned.map((p) => p.text)).toEqual([1, 2, 3, 4].map((n) => `Content of page ${n} is unique here.`));
    // Too few pages to tell boilerplate apart: nothing is removed.
    expect(cleanPages(pages.slice(0, 2))[0]!.text).toContain('ACME Handbook');
  });
});

describe('chunking variants', () => {
  it('keeps page numbers', () => {
    const chunks = chunkPages([
      { page: 1, text: 'First page text.' },
      { page: 3, text: 'Third page text.' },
    ]);
    expect(chunks.map((c) => [c.index, c.pageNumber])).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });

  it('parses and chunks FAQs one pair at a time', () => {
    const entries = parseFaqText('Q: How much?\nA: €149 per month.\nBilled monthly.\n\nFrage: Gibt es eine Testphase?\nAntwort: Ja, 14 Tage.\nQ: no answer here');
    expect(entries).toEqual([
      { question: 'How much?', answer: '€149 per month.\nBilled monthly.' },
      { question: 'Gibt es eine Testphase?', answer: 'Ja, 14 Tage.' },
    ]);
    expect(chunkFaq(entries, { title: 'FAQ' }).map((c) => c.content)).toEqual(['Q: How much?\nA: €149 per month.\nBilled monthly.', 'Q: Gibt es eine Testphase?\nA: Ja, 14 Tage.']);
  });

  it('gives embeddings the document and section as context', () => {
    expect(embeddingInput({ title: 'Handbook' }, { content: 'Body', location: 'Handbook › Setup' })).toBe('Handbook › Setup\n\nBody');
    expect(embeddingInput({ title: 'Handbook' }, { content: 'Body', location: null })).toBe('Handbook\n\nBody');
  });
});

describe('HTML extraction', () => {
  const html = `<!doctype html><html lang="de"><head><title>Hilfe</title><style>.x{}</style></head><body>
    <nav>NAV LINKS <a href="/a">A</a></nav>
    <main><h1>Installation</h1><p>Fügen Sie den Code <strong>vor</strong> dem schließenden Body-Tag ein. Danach erscheint das Widget auf jeder Seite Ihrer Website automatisch.</p>
    <ul><li>Schritt eins</li><li>Schritt zwei</li></ul>
    <table><tr><th>Plan</th><th>Preis</th></tr><tr><td>Pro</td><td>49 €</td></tr></table>
    <script>alert(1)</script><a href="/b#top">B</a><a href="https://other.example/c">C</a><a href="mailto:x@y.z">mail</a></main>
    <footer>FOOTER</footer></body></html>`;

  it('keeps structure, drops chrome and scripts, collects same-site links', () => {
    const page = extractHtmlPage(html, 'https://help.example/start');
    expect(page.language).toBe('de');
    expect(page.text).toContain('Fügen Sie den Code vor dem schließenden Body-Tag ein.');
    expect(page.text).toContain('- Schritt eins');
    expect(page.text).toContain('Pro | 49 €');
    expect(page.text).not.toMatch(/NAV LINKS|FOOTER|alert/);
    expect(page.links.sort()).toEqual(['https://help.example/a', 'https://help.example/b']);
  });

  it('turns converted Word HTML into headed text', () => {
    expect(htmlFragmentToText('<h1>Guide</h1><p>Intro</p><h2>Setup</h2><ol><li>One</li></ol>')).toBe('# Guide\n\nIntro\n\n## Setup\n\n- One');
  });
});

describe('robots.txt', () => {
  const robots = parseRobots(`
    User-agent: Googlebot
    Disallow: /

    User-agent: *
    Disallow: /private
    Disallow: /*.pdf$
    Allow: /private/press
  `);

  it('applies the wildcard group with longest-match precedence', () => {
    expect(isAllowed(robots, '/pricing')).toBe(true);
    expect(isAllowed(robots, '/private/notes')).toBe(false);
    expect(isAllowed(robots, '/private/press/2026')).toBe(true);
    expect(isAllowed(robots, '/docs/manual.pdf')).toBe(false);
    expect(isAllowed(robots, '/docs/manual.pdf?x=1')).toBe(true);
  });

  it('prefers a group naming our crawler', () => {
    const specific = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: OmniAI\nAllow: /');
    expect(isAllowed(specific, '/anything')).toBe(true);
    expect(isAllowed(parseRobots(''), '/x')).toBe(true);
  });
});

describe('rank fusion', () => {
  it('rewards items found by both retrievers and limits per-document results', () => {
    const scores = fuseRankings([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]]);
    const order = Array.from(scores.entries()).sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order[0]).toBe('b');

    const ranked = [
      { id: 1, documentId: 'd1' },
      { id: 2, documentId: 'd1' },
      { id: 3, documentId: 'd1' },
      { id: 4, documentId: 'd2' },
    ];
    expect(diversify(ranked, 4).map((r) => r.id)).toEqual([1, 2, 4]);
    expect(diversify(ranked, 2).map((r) => r.id)).toEqual([1, 2]);
  });
});
