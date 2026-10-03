import { describe, expect, it } from 'vitest';
import { isWithinBusinessHours, nextOpening } from '@/lib/business-hours';
import { contrastRatio, readableTextColor } from '@/lib/color';
import { parseInline, parseMarkdown, safeHref } from '@/lib/markdown';
import { isOriginAllowed, isValidOriginPattern, matchesOrigin } from '@/lib/origins';
import { createSseParser, encodeSseEvent } from '@/lib/sse';
import { estimateCostUsd } from '@/server/ai/pricing';
import { issueVisitorToken, verifyVisitorToken } from '@/server/channels/website/visitor-token';
import { buildSystemPrompt, temperatureFor } from '@/server/modules/ai/prompt-builder';
import {
  safeFileName,
  signedFileUrl,
  signUploadReceipt,
  sniffFileType,
  verifyFileSignature,
  verifyUploadReceipt,
} from '@/server/storage/files';

const SECRET = 'unit-test-secret-unit-test-secret-1234';

describe('visitor tokens', () => {
  it('round-trips claims', () => {
    const token = issueVisitorToken({ botId: 'bot1', customerId: 'cus1' }, SECRET);
    expect(verifyVisitorToken(token, SECRET)).toMatchObject({ botId: 'bot1', customerId: 'cus1' });
  });

  it('rejects tampering, wrong secrets, junk and expired tokens', () => {
    const token = issueVisitorToken({ botId: 'bot1', customerId: 'cus1' }, SECRET);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, b: 'bot1', c: 'someone-else', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    expect(verifyVisitorToken(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifyVisitorToken(`${payload}.${sig}x`, SECRET)).toBeNull();
    expect(verifyVisitorToken(token, `${SECRET}-other`)).toBeNull();
    expect(verifyVisitorToken('garbage', SECRET)).toBeNull();
    expect(verifyVisitorToken(`${token}.extra`, SECRET)).toBeNull();
    const old = issueVisitorToken({ botId: 'b', customerId: 'c' }, SECRET, Date.now() - 400 * 86_400_000);
    expect(verifyVisitorToken(old, SECRET)).toBeNull();
  });
});

describe('widget origin allowlist', () => {
  const app = 'http://localhost:3000';
  it('matches exact origins and subdomain wildcards', () => {
    expect(matchesOrigin('https://example.com', 'https://example.com')).toBe(true);
    expect(matchesOrigin('https://shop.example.com', 'https://*.example.com')).toBe(true);
    expect(matchesOrigin('https://example.com', 'https://*.example.com')).toBe(false);
    expect(matchesOrigin('https://evilexample.com', 'https://*.example.com')).toBe(false);
    expect(matchesOrigin('http://shop.example.com', 'https://*.example.com')).toBe(false);
    expect(matchesOrigin('https://example.com:8443', 'https://example.com')).toBe(false);
  });

  it('allows any site when the list is empty, and always the app itself', () => {
    expect(isOriginAllowed('https://anything.test', [], app)).toBe(true);
    expect(isOriginAllowed('https://anything.test', ['https://example.com'], app)).toBe(false);
    expect(isOriginAllowed(app, ['https://example.com'], app)).toBe(true);
    expect(isOriginAllowed(null, [], app)).toBe(false);
  });

  it('validates configured patterns', () => {
    expect(isValidOriginPattern('https://example.com')).toBe(true);
    expect(isValidOriginPattern('https://*.example.com')).toBe(true);
    expect(isValidOriginPattern('http://localhost:3000')).toBe(true);
    expect(isValidOriginPattern('https://example.com/path')).toBe(false);
    expect(isValidOriginPattern('example.com')).toBe(false);
    expect(isValidOriginPattern('javascript:alert(1)')).toBe(false);
  });
});

describe('business hours', () => {
  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensAt: '09:00', closesAt: '18:00' }));
  const tz = 'Europe/Berlin';

  it('knows when the team is online (in the organization time zone)', () => {
    expect(isWithinBusinessHours(weekdays, tz, new Date('2026-10-05T07:30:00Z'))).toBe(true); // Mon 09:30 CEST
    expect(isWithinBusinessHours(weekdays, tz, new Date('2026-10-05T06:30:00Z'))).toBe(false); // Mon 08:30
    expect(isWithinBusinessHours(weekdays, tz, new Date('2026-10-05T16:00:00Z'))).toBe(false); // Mon 18:00
    expect(isWithinBusinessHours(weekdays, tz, new Date('2026-10-04T10:00:00Z'))).toBe(false); // Sunday
  });

  it('supports overnight shifts', () => {
    const night = [{ weekday: 5, opensAt: '22:00', closesAt: '02:00' }];
    expect(isWithinBusinessHours(night, 'UTC', new Date('2026-10-09T23:00:00Z'))).toBe(true); // Fri 23:00
    expect(isWithinBusinessHours(night, 'UTC', new Date('2026-10-10T01:30:00Z'))).toBe(true); // Sat 01:30
    expect(isWithinBusinessHours(night, 'UTC', new Date('2026-10-10T02:30:00Z'))).toBe(false);
  });

  it('finds the next opening', () => {
    // Saturday afternoon → Monday 09:00 Berlin (07:00 UTC in summer time).
    expect(nextOpening(weekdays, tz, new Date('2026-10-03T14:00:00Z'))?.toISOString()).toBe('2026-10-05T07:00:00.000Z');
    // Friday evening after the DST switch on 25 Oct → Monday 09:00 CET (08:00 UTC).
    expect(nextOpening(weekdays, tz, new Date('2026-10-23T17:00:00Z'))?.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(nextOpening([], tz)).toBeNull();
  });
});

describe('SSE', () => {
  it('parses events split across arbitrary chunks', () => {
    const wire = encodeSseEvent('assistant.delta', { text: 'Hel\nlo' }) + ': ping\n\n' + encodeSseEvent('done', { ok: true });
    const events: { event: string; data: string }[] = [];
    const feed = createSseParser((e) => events.push(e));
    for (let i = 0; i < wire.length; i += 7) feed(wire.slice(i, i + 7));
    expect(events.map((e) => e.event)).toEqual(['assistant.delta', 'done']);
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'Hel\nlo' });
  });
});

describe('chat markdown', () => {
  it('only links safe protocols', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(parseInline('[click](javascript:alert(1))').some((n) => n.type === 'link')).toBe(false);
  });

  it('treats HTML as plain text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });

  it('parses emphasis, links, autolinks and lists', () => {
    expect(parseInline('**Growth** costs €399, see https://novatech.example/pricing.')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'Growth' }] },
      { type: 'text', text: ' costs €399, see ' },
      { type: 'link', href: 'https://novatech.example/pricing', children: [{ type: 'text', text: 'https://novatech.example/pricing' }] },
      { type: 'text', text: '.' },
    ]);
    const blocks = parseMarkdown('Steps:\n1. One\n2. Two\n\n- a\n- b');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'list']);
  });
});

describe('uploaded files', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const pdf = new TextEncoder().encode('%PDF-1.7 ...');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  it('detects types by content, not by name', () => {
    expect(sniffFileType(png, 'photo.png')?.mime).toBe('image/png');
    expect(sniffFileType(png, 'innocent.pdf')?.mime).toBe('image/png');
    expect(sniffFileType(pdf, 'doc.pdf')?.mime).toBe('application/pdf');
    expect(sniffFileType(svg, 'logo.svg')).toBeNull();
    expect(sniffFileType(svg, 'logo.txt')?.mime).toBe('text/plain'); // served as text/plain + sandboxed
    expect(sniffFileType(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'setup.exe')).toBeNull();
  });

  it('produces safe file names', () => {
    expect(safeFileName('../../etc/passwd', 'txt')).toBe('passwd.txt');
    expect(safeFileName('C:\\Users\\x\\report.final.docx', 'docx')).toBe('reportfinal.docx');
    expect(safeFileName('Rechnung März 2026.PDF', 'pdf')).toBe('Rechnung-Marz-2026.pdf');
  });

  it('binds upload receipts to the uploading customer', () => {
    const r = { key: 'orgs/o/customers/c/u/f.png', mimeType: 'image/png', size: 10, customerId: 'c' };
    const sig = signUploadReceipt(SECRET, r);
    expect(verifyUploadReceipt(SECRET, { ...r, sig })).toBe(true);
    expect(verifyUploadReceipt(SECRET, { ...r, customerId: 'other', sig })).toBe(false);
    expect(verifyUploadReceipt(SECRET, { ...r, size: 11, sig })).toBe(false);
  });

  it('signs expiring download URLs', () => {
    const url = new URL(signedFileUrl(SECRET, 'orgs/o/x.png'), 'http://x');
    const [k, e, s] = ['k', 'e', 's'].map((p) => url.searchParams.get(p)!);
    expect(verifyFileSignature(SECRET, k, Number(e), s)).toBe(true);
    expect(verifyFileSignature(SECRET, 'orgs/other/x.png', Number(e), s)).toBe(false);
    expect(verifyFileSignature(SECRET, k, Number(e), s, (Number(e) + 1) * 1000)).toBe(false);
  });
});

describe('prompt builder', () => {
  const bot = {
    agentName: 'Nova',
    companyName: 'NovaTech GmbH',
    businessDescription: 'Builds chatbots.',
    tone: 'FRIENDLY' as const,
    customTone: null,
    answerLength: 'SHORT' as const,
    defaultLanguage: 'de',
    fallbackResponse: 'I do not know.',
  };
  const ctx = {
    channel: 'WEBSITE' as const,
    now: new Date('2026-10-03T10:00:00Z'),
    timeZone: 'Europe/Berlin',
    teamOnline: false,
    nextOpenAt: new Date('2026-10-05T07:00:00Z'),
    customer: { name: 'Anna', language: 'en' },
  };
  const layer = (layer: 'GLOBAL_POLICY' | 'CHANNEL' | 'BUSINESS_RULES', content: string, channel: 'WEBSITE' | 'WHATSAPP' | null = null, isActive = true) => ({
    layer,
    content,
    channel,
    sortOrder: 0,
    isActive,
  });

  it('composes layers in order and only includes the matching channel', () => {
    const prompt = buildSystemPrompt(bot, [
      layer('BUSINESS_RULES', 'Never invent prices.'),
      layer('GLOBAL_POLICY', 'POLICY TEXT'),
      layer('CHANNEL', 'WEB RULES', 'WEBSITE'),
      layer('CHANNEL', 'WHATSAPP RULES', 'WHATSAPP'),
      layer('BUSINESS_RULES', 'disabled rule', null, false),
    ], ctx);
    const order = ['POLICY TEXT', 'You are "Nova"', 'Warm, friendly', 'WEB RULES', 'Never invent prices.', 'Current time'];
    const positions = order.map((s) => prompt.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).not.toContain('WHATSAPP RULES');
    expect(prompt).not.toContain('disabled rule');
    expect(prompt).toContain('offline until Monday');
    expect(prompt).toContain('Name: Anna');
  });

  it('keeps temperature conservative', () => {
    expect(temperatureFor(0)).toBe(0);
    expect(temperatureFor(1)).toBe(0.9);
    expect(temperatureFor(5)).toBe(0.9);
  });
});

describe('cost estimates and colors', () => {
  it('prices known models, including dated snapshots', () => {
    expect(estimateCostUsd('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75);
    expect(estimateCostUsd('gpt-4o-mini-2024-07-18', 1000, 0)).toBeCloseTo(0.00015);
    expect(estimateCostUsd('unknown-model', 1000, 1000)).toBeNull();
  });

  it('picks readable text for brand colors', () => {
    expect(readableTextColor('#4f46e5')).toBe('#ffffff');
    expect(readableTextColor('#facc15')).toBe('#0f172a');
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21);
  });
});

describe('handoff quick replies', async () => {
  const { isHandoffPhrase } = await import('@/components/widget/i18n');
  it('recognizes "talk to a human" in every supported language', () => {
    for (const phrase of ['Talk to a human', 'mit einem menschen sprechen', 'گفتگو با کارشناس', 'Hablar con una persona', 'Parler à une personne']) {
      expect(isHandoffPhrase(phrase)).toBe(true);
    }
    expect(isHandoffPhrase('Pricing')).toBe(false);
  });
});
