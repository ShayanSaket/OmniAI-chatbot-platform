import { describe, expect, it } from 'vitest';
import { agentReplySchema, customerDisplayName, DEFAULT_INBOX_FILTERS, inboxQueryString, parseInboxQuery, suggestionSchema } from '@/lib/inbox';

describe('inbox filters', () => {
  it('parses query strings and falls back to defaults for unknown values', () => {
    expect(parseInboxQuery(new URLSearchParams(''))).toEqual({ ...DEFAULT_INBOX_FILTERS, cursor: undefined });
    expect(parseInboxQuery(new URLSearchParams('status=closed&channel=WHATSAPP&mode=human&assignee=me&unread=1&q=%20anna%20&cursor=123_abc'))).toEqual({
      status: 'closed',
      channel: 'WHATSAPP',
      mode: 'human',
      assignee: 'me',
      unread: true,
      q: 'anna',
      cursor: '123_abc',
    });
    expect(parseInboxQuery(new URLSearchParams('status=deleted&channel=FAX&mode=x&assignee=boss&unread=yes'))).toMatchObject(DEFAULT_INBOX_FILTERS);
    expect(parseInboxQuery(new URLSearchParams(`q=${'x'.repeat(300)}`)).q).toHaveLength(100);
  });

  it('round-trips filters through the query string, omitting defaults', () => {
    expect(inboxQueryString(DEFAULT_INBOX_FILTERS)).toBe('');
    const filters = { ...DEFAULT_INBOX_FILTERS, channel: 'WEBSITE' as const, unread: true, q: 'refund' };
    const qs = inboxQueryString(filters, '99_id');
    expect(qs).toBe('channel=WEBSITE&unread=1&q=refund&cursor=99_id');
    expect(parseInboxQuery(new URLSearchParams(qs))).toEqual({ ...filters, cursor: '99_id' });
  });
});

describe('inbox inputs', () => {
  it('requires text or an attachment and a safe client id', () => {
    expect(agentReplySchema.safeParse({ content: '  ', clientMessageId: 'abcdefgh12' }).success).toBe(false);
    expect(agentReplySchema.safeParse({ content: 'Hi', clientMessageId: 'short' }).success).toBe(false);
    expect(agentReplySchema.safeParse({ content: 'Hi', clientMessageId: 'has spaces in it' }).success).toBe(false);
    expect(agentReplySchema.parse({ content: 'Hi', clientMessageId: 'abcdefgh12' })).toEqual({ content: 'Hi', clientMessageId: 'abcdefgh12', attachments: [] });
    const file = { key: 'k', fileName: 'a.png', mimeType: 'image/png', size: 10, sig: 's' };
    expect(agentReplySchema.safeParse({ content: '', attachments: [file], clientMessageId: 'abcdefgh12' }).success).toBe(true);
    expect(agentReplySchema.safeParse({ content: 'x', attachments: Array(6).fill(file), clientMessageId: 'abcdefgh12' }).success).toBe(false);
  });

  it('needs a draft for rewrites but not for generating', () => {
    expect(suggestionSchema.safeParse({ action: 'generate' }).success).toBe(true);
    expect(suggestionSchema.safeParse({ action: 'shorten', draft: ' ' }).success).toBe(false);
    expect(suggestionSchema.safeParse({ action: 'translate', draft: 'Hi', language: 'de' }).success).toBe(true);
    expect(suggestionSchema.safeParse({ action: 'translate', draft: 'Hi', language: 'German' }).success).toBe(false);
    expect(suggestionSchema.safeParse({ action: 'send', draft: 'Hi' }).success).toBe(false);
  });

  it('labels customers by the best available detail', () => {
    expect(customerDisplayName({ id: 'c1abcd', name: ' Anna ', email: 'a@x.de', phone: null })).toBe('Anna');
    expect(customerDisplayName({ id: 'c1abcd', name: null, email: 'a@x.de', phone: '+49' })).toBe('a@x.de');
    expect(customerDisplayName({ id: 'c1abcd', name: '', email: null, phone: '+49 151' })).toBe('+49 151');
    expect(customerDisplayName({ id: 'clxyz9abcd', name: null, email: null, phone: null })).toBe('Visitor ABCD');
  });
});
