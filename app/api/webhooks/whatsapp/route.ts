import { NextResponse } from 'next/server';
import { webhookConfig } from '@/server/channels/whatsapp/account';
import { receiveWhatsAppWebhook } from '@/server/channels/whatsapp/processor';
import { safeEqual } from '@/server/crypto';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 1_000_000;

/** Meta's verification handshake when the webhook URL is configured. */
export const GET = route(
  async (req) => {
    const p = req.nextUrl.searchParams;
    const { verifyToken } = webhookConfig();
    const token = p.get('hub.verify_token') ?? '';
    if (p.get('hub.mode') !== 'subscribe' || !verifyToken || !safeEqual(token, verifyToken)) {
      throw new AppError('FORBIDDEN', 'Verification failed.');
    }
    return new NextResponse(p.get('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  },
  { csrf: false },
);

/**
 * Inbound messages and delivery statuses. Events are verified, stored (idempotently)
 * and acknowledged immediately; processing happens in the background with retries,
 * so Meta never times out waiting for the AI.
 */
export const POST = route(
  async (req) => {
    const length = Number(req.headers.get('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) throw new AppError('BAD_REQUEST', 'Payload too large.');
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new AppError('BAD_REQUEST', 'Payload too large.');
    const result = await receiveWhatsAppWebhook(raw, req.headers.get('x-hub-signature-256'));
    return NextResponse.json({ received: result.accepted, duplicates: result.duplicates });
  },
  { csrf: false },
);
