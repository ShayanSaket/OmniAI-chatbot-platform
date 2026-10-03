import { describe, expect, it } from 'vitest';
import { automationInputSchema, matchesConditions, matchKeyword, parseConditions, renderTemplate } from '@/lib/automations';
import { EVENT_TYPES, isEventType } from '@/lib/events';
import { webhookEndpointSchema } from '@/lib/validation';
import { triggersForEvent } from '@/server/modules/automations/engine';
import {
  computeSignature,
  generateWebhookSecret,
  MAX_DELIVERY_ATTEMPTS,
  nextRetryDelay,
  signatureHeader,
  verifySignatureHeader,
} from '@/server/modules/webhooks/signing';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"lead.created"}';

  it('verifies the exact body within the time tolerance', () => {
    const now = 1_800_000_000;
    const header = signatureHeader(secret, body, now);
    expect(header).toBe(`t=${now},v1=${computeSignature(secret, now, body)}`);
    expect(verifySignatureHeader(header, body, secret, { now })).toBe(true);
    expect(verifySignatureHeader(header, body, secret, { now: now + 299 })).toBe(true);
    expect(verifySignatureHeader(header, body, secret, { now: now + 301 })).toBe(false); // replayed later
    expect(verifySignatureHeader(header, body.replace('lead', 'Lead'), secret, { now })).toBe(false);
    expect(verifySignatureHeader(header, body, 'other', { now })).toBe(false);
    expect(verifySignatureHeader('v1=abc', body, secret, { now })).toBe(false);
    expect(verifySignatureHeader(null, body, secret)).toBe(false);
  });

  it('accepts any of several v1 signatures (secret rotation)', () => {
    const now = 1_800_000_000;
    const header = `t=${now},v1=${computeSignature('old', now, body)},v1=${computeSignature(secret, now, body)}`;
    expect(verifySignatureHeader(header, body, secret, { now })).toBe(true);
  });

  it('generates strong secrets and a bounded retry schedule', () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
    expect([1, 2, 3, 4, 5].map(nextRetryDelay)).toEqual([30, 120, 600, 3600, 21600]);
    expect(nextRetryDelay(MAX_DELIVERY_ATTEMPTS)).toBeNull();
  });
});

describe('automation templates and conditions', () => {
  it('renders variables with fallbacks', () => {
    const vars = { 'customer.firstName': 'Anna', 'customer.email': null, 'company.name': 'NovaTech' };
    expect(renderTemplate('Hi {{customer.firstName}}, thanks for contacting {{ company.name }}!', vars)).toBe('Hi Anna, thanks for contacting NovaTech!');
    expect(renderTemplate('Reply to {{customer.email|your email}}', vars)).toBe('Reply to your email');
    expect(renderTemplate('Hi {{customer.firstName|there}}', {})).toBe('Hi there');
    expect(renderTemplate('{{unknown.var}}x', vars)).toBe('x');
  });

  it('matches whole keywords and phrases in any script, case-insensitively', () => {
    expect(matchKeyword('I want a REFUND please', 'refund')).toBe(true);
    expect(matchKeyword('Was it refunded?', 'refund')).toBe(false);
    expect(matchKeyword('Ich möchte eine Rückerstattung.', 'rückerstattung')).toBe(true);
    expect(matchKeyword('Can I talk to a human agent?', 'human agent')).toBe(true);
    expect(matchKeyword('بازپرداخت لطفا', 'بازپرداخت')).toBe(true);
    expect(matchKeyword('price (EUR)', 'price (eur)')).toBe(true); // regex characters are literal
  });

  it('applies every configured condition', () => {
    const c = parseConditions({ channels: ['WHATSAPP'], keywords: ['refund'], intents: [], teamStatus: 'online' });
    const facts = { channel: 'WHATSAPP', text: 'refund now', intent: null, teamOnline: true };
    expect(matchesConditions(c, facts)).toBe(true);
    expect(matchesConditions(c, { ...facts, channel: 'WEBSITE' })).toBe(false);
    expect(matchesConditions(c, { ...facts, text: 'hello' })).toBe(false);
    expect(matchesConditions(c, { ...facts, teamOnline: false })).toBe(false);
    expect(matchesConditions(parseConditions({ intents: ['PRICING', 'DEMO'] }), { ...facts, intent: 'DEMO' })).toBe(true);
    expect(matchesConditions(parseConditions(null), { channel: null, text: null, intent: null, teamOnline: false })).toBe(true);
  });

  it('maps events to triggers', () => {
    expect(triggersForEvent({ type: 'message.received', data: { channel: 'WHATSAPP' } })).toEqual(['MESSAGE_RECEIVED', 'KEYWORD_DETECTED', 'WHATSAPP_MESSAGE_RECEIVED']);
    expect(triggersForEvent({ type: 'message.received', data: { channel: 'WEBSITE' } })).toEqual(['MESSAGE_RECEIVED', 'KEYWORD_DETECTED']);
    expect(triggersForEvent({ type: 'customer.created', data: {} })).toEqual([]);
  });

  it('validates automations and webhook endpoints', () => {
    const base = { name: 'New lead alert', trigger: 'LEAD_CREATED', conditions: {}, actions: [{ type: 'NOTIFY_TEAM', message: 'New lead' }] };
    expect(automationInputSchema.parse(base).actions[0]).toEqual({ type: 'NOTIFY_TEAM', message: 'New lead', recipients: 'admins' });
    expect(automationInputSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
    expect(automationInputSchema.safeParse({ ...base, actions: [{ type: 'DELETE_EVERYTHING' }] }).success).toBe(false);
    expect(automationInputSchema.safeParse({ ...base, actions: [{ type: 'ASSIGN_AGENT', mode: 'user' }] }).success).toBe(false);
    expect(automationInputSchema.safeParse({ ...base, trigger: 'INTENT_DETECTED' }).success).toBe(false);
    expect(webhookEndpointSchema.safeParse({ url: 'https://hooks.zapier.com/x', events: ['lead.created', '*'] }).success).toBe(true);
    expect(webhookEndpointSchema.safeParse({ url: 'https://x.example', events: ['lead.deleted'] }).success).toBe(false);
    expect(webhookEndpointSchema.safeParse({ url: 'ftp://x.example', events: ['*'] }).success).toBe(false);
    expect(EVENT_TYPES.every(isEventType)).toBe(true);
  });
});
