import { describe, expect, it } from 'vitest';
import { parsePeriodQuery, periodQueryString } from '@/lib/analytics';
import { clusterTopics, keywords, normalizeTerm, topKeywords } from '@/lib/topics';
import { describePeriod, resolvePeriod } from '@/server/modules/analytics/period';
import { isQuestionText, replyAnswered } from '@/server/modules/analytics/questions';
import { redactExample } from '@/server/modules/analytics/insights-service';

describe('topics', () => {
  it('keeps topic words and drops filler in every language', () => {
    expect(keywords('Hi! How do I install the widget on WordPress, please?')).toEqual(['install', 'widget', 'wordpress']);
    expect(keywords('Hallo, wie kann ich die Rechnung herunterladen?')).toEqual(['rechnung', 'herunterladen']);
    expect(keywords('سلام، قیمت پلن رشد چقدر است؟')).toEqual(['قیمت', 'پلن', 'رشد', 'چقدر']);
    expect(keywords('ok thanks')).toEqual([]);
    expect(keywords('Please send it to anna@immo-schulz.example or see https://example.com/help')).toEqual([]);
    expect(keywords('Sind die Preise inkl. MwSt.?')).toEqual(['preise', 'mwst']);
    expect(normalizeTerm('installation')).toBe('install');
    expect(normalizeTerm('prices')).toBe('price');
    expect(normalizeTerm('business')).toBe('business');
  });

  it('keeps acronyms as written in labels', () => {
    expect(clusterTopics([{ text: 'Do you have an API?' }, { text: 'Is the API documented?' }]).map((c) => c.label)).toEqual(['API']);
  });

  it('groups messages by shared topics, labelled with the words customers used', () => {
    const items = [
      'How do I install the widget on WordPress?',
      'Is there an installation guide for Shopify?',
      'installation help for my Wix site',
      'What does the Growth plan cost?',
      'What does the Starter plan cost per month?',
      'Where is my data hosted?',
    ].map((text) => ({ text }));
    const clusters = clusterTopics(items);
    expect(clusters.map((c) => [c.label, c.items.length])).toEqual([
      ['installation', 3],
      ['plan cost', 2],
    ]);
    expect(topKeywords(items.map((i) => i.text))).toEqual([
      { term: 'installation', count: 3 },
      { term: 'cost', count: 2 },
      { term: 'plan', count: 2 },
    ]);
  });
});

describe('periods', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const tz = 'Europe/Berlin';

  it('resolves presets and compares with the previous period of equal length', () => {
    const p = resolvePeriod({ range: '7d' }, tz, now);
    expect(p.start.toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-04T22:00:00.000Z');
    expect(p.previousStart.toISOString()).toBe('2026-09-20T22:00:00.000Z');
    expect(p).toMatchObject({ days: 7, bucket: 'day' });
    expect(resolvePeriod({ range: 'today' }, tz, now)).toMatchObject({ days: 1, bucket: 'hour' });
  });

  it('clamps custom ranges to today and at most a year', () => {
    const p = resolvePeriod({ range: 'custom', from: '2026-09-01', to: '2026-12-31' }, tz, now);
    expect(p.query).toEqual({ range: 'custom', from: '2026-09-01', to: '2026-10-04' });
    expect(p.days).toBe(34);
    expect(describePeriod(p, tz).label).toBe('1 Sept – 4 Oct 2026');
    const long = resolvePeriod({ range: 'custom', from: '2020-01-01', to: '2026-10-04' }, tz, now);
    expect(long.days).toBe(366);
  });

  it('parses query strings safely', () => {
    expect(parsePeriodQuery(new URLSearchParams('range=bogus'))).toEqual({ range: '30d' });
    expect(parsePeriodQuery(new URLSearchParams('range=custom&from=2026-10-04&to=2026-09-01'))).toEqual({ range: 'custom', from: '2026-09-01', to: '2026-10-04' });
    expect(parsePeriodQuery(new URLSearchParams('range=custom&from=yesterday'))).toEqual({ range: '30d' });
    expect(periodQueryString({ range: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe('range=custom&from=2026-09-01&to=2026-09-30');
  });
});

describe('answer detection', () => {
  it('recognizes questions and verified answers', () => {
    expect(isQuestionText('How do I reset my password?', null)).toBe(true);
    expect(isQuestionText('Thanks a lot', null)).toBe(false);
    expect(isQuestionText('I want the Growth plan', 'SALES')).toBe(true);
    expect(isQuestionText('This is unacceptable service', 'COMPLAINT')).toBe(false);
    expect(replyAnswered({ retrieval: { hits: 0 } }, null)).toBe(false);
    expect(replyAnswered({ retrieval: { hits: 0 } }, [{ documentId: 'd' }])).toBe(true);
    expect(replyAnswered({ retrieval: { hits: 0 }, tools: [{ name: 'get_product_information', status: 'SUCCESS' }] }, null)).toBe(true);
    expect(replyAnswered({ retrieval: { hits: 0 }, tools: [{ name: 'search_knowledge_base', status: 'SUCCESS' }] }, null)).toBe(false);
    expect(replyAnswered({ fallback: true, retrieval: { hits: 3 } }, null)).toBe(false);
  });

  it('removes contact details before examples go to the AI', () => {
    expect(redactExample('Mail me at anna@example.com or call +49 151 2345678')).toBe('Mail me at [email] or call [phone]');
  });
});
