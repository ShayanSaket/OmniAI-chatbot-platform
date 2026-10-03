import { describe, expect, it } from 'vitest';
import {
  buildTextPayloads,
  buttonTitle,
  markdownToWhatsApp,
  renderTemplateBody,
  splitText,
  templatePlaceholderCount,
} from '@/server/channels/whatsapp/format';
import { classifyGraphError } from '@/server/channels/whatsapp/graph-client';
import { describeInbound, nextOutboundStatus } from '@/server/channels/whatsapp/inbound';
import { isWithinServiceWindow } from '@/server/channels/whatsapp/outbound';
import { parseWebhookPayload, signWebhookBody, verifyWebhookSignature, waIdToE164, type WaMessage } from '@/server/channels/whatsapp/webhook';
import { typeForProviderMedia } from '@/server/storage/files';
import { templateInfo } from '@/server/modules/whatsapp/whatsapp-service';

describe('webhook signature', () => {
  it('accepts only the exact body signed with the app secret', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const sig = signWebhookBody(body, 'secret');
    expect(verifyWebhookSignature(body, sig, 'secret')).toBe(true);
    expect(verifyWebhookSignature(`${body} `, sig, 'secret')).toBe(false);
    expect(verifyWebhookSignature(body, sig, 'other')).toBe(false);
    expect(verifyWebhookSignature(body, null, 'secret')).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=zz', 'secret')).toBe(false);
  });
});

describe('webhook payload parsing', () => {
  const value = (v: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123' }, ...v } }] }],
  });

  it('splits messages and statuses into idempotent events', () => {
    const { events, skipped } = parseWebhookPayload(
      value({
        contacts: [{ wa_id: '4915', profile: { name: 'Kim' } }],
        messages: [
          { from: '4915', id: 'wamid.A', timestamp: '1', type: 'text', text: { body: 'hi' } },
          { id: 'broken' },
        ],
        statuses: [{ id: 'wamid.B', status: 'delivered', timestamp: '2' }],
      }),
    );
    expect(skipped).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'message', eventId: 'wamid.A', phoneNumberId: '123', contactName: 'Kim' }),
      expect.objectContaining({ kind: 'status', eventId: 'wamid.B:delivered' }),
    ]);
  });

  it('ignores other objects and fields', () => {
    expect(parseWebhookPayload({ object: 'page', entry: [] }).events).toEqual([]);
    expect(parseWebhookPayload(value({})).events).toEqual([]);
    expect(waIdToE164('49 151-234')).toBe('+49151234');
  });
});

describe('inbound message types', () => {
  const msg = (m: Partial<WaMessage>): WaMessage => ({ from: '1', id: 'w', timestamp: '1', type: 'text', ...m }) as WaMessage;

  it('maps every WhatsApp type', () => {
    expect(describeInbound(msg({ type: 'text', text: { body: 'Hi' } }))).toMatchObject({ content: 'Hi', messageType: 'TEXT' });
    expect(describeInbound(msg({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'see' } }))).toMatchObject({
      content: 'see',
      messageType: 'IMAGE',
      media: { id: 'm1', kind: 'image', mimeType: 'image/jpeg' },
    });
    expect(describeInbound(msg({ type: 'audio', audio: { id: 'a', mime_type: 'audio/ogg; codecs=opus', voice: true } })).media).toMatchObject({ mimeType: 'audio/ogg', voice: true });
    expect(describeInbound(msg({ type: 'document', document: { id: 'd', filename: 'invoice.pdf' } }))).toMatchObject({ messageType: 'DOCUMENT', media: { fileName: 'invoice.pdf' } });
    expect(describeInbound(msg({ type: 'contacts', contacts: [{ name: { formatted_name: 'Ana' }, phones: [{ phone: '+34 600' }] }] })).content).toBe('Shared contact: Ana +34 600');
    expect(describeInbound(msg({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'x', title: 'Growth', description: '€399' } } }))).toMatchObject({
      content: 'Growth — €399',
      messageType: 'INTERACTIVE',
      action: null,
    });
    expect(describeInbound(msg({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'action:handoff', title: 'Talk to a human' } } })).action).toBe('handoff');
    expect(describeInbound(msg({ type: 'button', button: { text: 'Yes please', payload: 'YES' } }))).toMatchObject({ content: 'Yes please', metadata: { payload: 'YES' } });
    expect(describeInbound(msg({ type: 'reaction', reaction: { emoji: '👍' } })).ignore).toBe(true);
    expect(describeInbound(msg({ type: 'order' })).metadata).toMatchObject({ unsupported: true });
    expect(describeInbound(msg({ type: 'text', text: { body: 'reply' }, context: { id: 'wamid.prev' } })).metadata).toMatchObject({ replyTo: 'wamid.prev' });
  });

  it('only moves delivery status forward', () => {
    expect(nextOutboundStatus('SENT', 'delivered')).toBe('DELIVERED');
    expect(nextOutboundStatus('READ', 'delivered')).toBeNull();
    expect(nextOutboundStatus('DELIVERED', 'failed')).toBe('FAILED');
    expect(nextOutboundStatus('READ', 'failed')).toBeNull();
    expect(nextOutboundStatus('FAILED', 'read')).toBe('READ');
    expect(nextOutboundStatus('SENT', 'deleted')).toBeNull();
  });
});

describe('outbound formatting', () => {
  it('converts Markdown to WhatsApp syntax', () => {
    expect(markdownToWhatsApp('## Plans\n**Growth** costs *only* €399. See [pricing](https://x.example/p) or ~~old~~.\n* one\n* two')).toBe(
      '*Plans*\n*Growth* costs _only_ €399. See pricing (https://x.example/p) or ~old~.\n- one\n- two',
    );
    expect(markdownToWhatsApp('Mail [sales@x.example](mailto:sales@x.example) and keep `code **as is**`')).toBe('Mail sales@x.example and keep `code **as is**`');
    expect(markdownToWhatsApp('```\n**raw**\n```')).toBe('```\n**raw**\n```');
  });

  it('splits at natural boundaries within the limit', () => {
    const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    expect(splitText(text, 4096)).toEqual(['a'.repeat(3000), 'b'.repeat(3000)]);
    expect(splitText('x'.repeat(9000), 4096).map((c) => c.length)).toEqual([4096, 4096, 808]);
  });

  it('puts buttons on the last part within interactive limits', () => {
    const payloads = buildTextPayloads('49', {
      text: `${'word '.repeat(300)}`.trim(),
      replyButtons: [
        { id: 'action:handoff', title: 'Mit einem Menschen sprechen' },
        { id: 'qr:a', title: 'A' },
        { id: 'qr:b', title: 'B' },
        { id: 'qr:c', title: 'C' },
      ],
    });
    const last = payloads.at(-1) as unknown as { type: string; interactive: { body: { text: string }; action: { buttons: { reply: { title: string } }[] } } };
    expect(last.type).toBe('interactive');
    expect(last.interactive.body.text.length).toBeLessThanOrEqual(1024);
    expect(last.interactive.action.buttons).toHaveLength(3);
    expect(last.interactive.action.buttons[0]!.reply.title).toBe('Mit einem Menschen…');
    expect(payloads.slice(0, -1).every((p) => p.type === 'text')).toBe(true);
    expect(buttonTitle('Talk to a human')).toBe('Talk to a human');
  });

  it('uses a link button for a single URL', () => {
    const [p] = buildTextPayloads('49', { text: 'Book here', linkButton: { label: 'Open calendar', url: 'https://cal.example' } });
    expect(p).toMatchObject({ type: 'interactive', interactive: { type: 'cta_url', action: { parameters: { display_text: 'Open calendar', url: 'https://cal.example' } } } });
  });
});

describe('templates, window and errors', () => {
  it('counts and fills template variables', () => {
    expect(templatePlaceholderCount('Hi {{1}}, order {{2}} ships {{ 2 }}')).toBe(2);
    expect(renderTemplateBody('Hi {{1}}, order {{2}}', ['Kim', '#7'])).toBe('Hi Kim, order #7');
    expect(templateInfo([{ type: 'HEADER', format: 'TEXT', text: 'Update' }, { type: 'BODY', text: 'Hi {{1}}' }])).toEqual({ body: 'Hi {{1}}', header: 'Update', variables: 1, supported: true });
    expect(templateInfo([{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, { type: 'BODY', text: 'x' }]).supported).toBe(false);
    expect(templateInfo([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.example/{{1}}' }] }]).supported).toBe(false);
  });

  it('knows the 24-hour customer service window', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    expect(isWithinServiceWindow(new Date('2026-10-02T12:00:01Z'), now)).toBe(true);
    expect(isWithinServiceWindow(new Date('2026-10-02T11:59:59Z'), now)).toBe(false);
    expect(isWithinServiceWindow(null, now)).toBe(false);
  });

  it('classifies Graph errors into retryable and permanent', () => {
    expect(classifyGraphError(400, 131047, 'x')).toMatchObject({ kind: 'window_closed', retryable: false });
    expect(classifyGraphError(401, 190, 'x')).toMatchObject({ kind: 'auth', retryable: false });
    expect(classifyGraphError(400, 130429, 'x')).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(classifyGraphError(500, undefined, 'x')).toMatchObject({ kind: 'unavailable', retryable: true });
    expect(classifyGraphError(400, 131026, 'x')).toMatchObject({ kind: 'undeliverable', retryable: false });
    expect(classifyGraphError(400, 100, 'x')).toMatchObject({ kind: 'invalid_request', retryable: false });
  });
});

describe('provider media types', () => {
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2]);
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const html = new TextEncoder().encode('<script>alert(1)</script>');

  it('accepts allowlisted types whose bytes match', () => {
    expect(typeForProviderMedia('audio/ogg; codecs=opus', ogg, '')?.mime).toBe('audio/ogg');
    expect(typeForProviderMedia('video/mp4', mp4, '')?.mime).toBe('video/mp4');
    expect(typeForProviderMedia('audio/mp4', mp4, '')?.mime).toBe('audio/mp4');
    expect(typeForProviderMedia('image/jpeg', png, '')?.mime).toBe('image/png'); // content wins
  });

  it('rejects mismatches and dangerous types', () => {
    expect(typeForProviderMedia('image/jpeg', html, '')).toBeNull();
    expect(typeForProviderMedia('audio/ogg', html, '')).toBeNull();
    expect(typeForProviderMedia('text/html', html, 'x.html')).toBeNull();
    expect(typeForProviderMedia('image/svg+xml', html, 'x.svg')).toBeNull();
    expect(typeForProviderMedia('application/zip', new Uint8Array([0x50, 0x4b, 3, 4]), 'a.zip')).toBeNull();
  });
});
