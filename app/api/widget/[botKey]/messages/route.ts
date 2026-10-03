import { NextResponse } from 'next/server';
import { websiteChannelAdapter } from '@/server/channels/website/adapter';
import { requireVisitor } from '@/server/channels/website/widget-auth';
import { env } from '@/server/env';
import { AppError } from '@/server/errors';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { sseResponse } from '@/server/realtime/sse-response';
import { clientIp } from '@/server/request';
import { customerKeyPrefix, verifyUploadReceipt } from '@/server/storage/files';
import { processInboundMessage } from '@/server/modules/chat/pipeline';
import { sendMessageSchema } from '@/server/modules/widget/schemas';
import { messagesSince } from '@/server/modules/widget/widget-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { botKey: string };

/** History catch-up: messages after `after` (or the latest 50). */
export const GET = route<Params>(async (req, { params }) => {
  const visitor = await requireVisitor(req, params.botKey);
  const data = await messagesSince(visitor, req.nextUrl.searchParams.get('after'));
  return NextResponse.json({ data });
});

/**
 * Sends a visitor message. The response is an SSE stream: the stored message, then the
 * AI reply token by token, then the stored reply. If the client disconnects mid-stream
 * the reply is still generated and stored (and pushed to the events stream).
 */
export const POST = route<Params>(async (req, { params, log }) => {
  const visitor = await requireVisitor(req, params.botKey);
  await enforceRateLimit(RATE_LIMITS.widgetMessagePerIp, clientIp(req.headers));
  await enforceRateLimit(RATE_LIMITS.widgetMessagePerVisitor, visitor.customerId);
  const input = await parseJson(req, sendMessageSchema);

  const secret = env().AUTH_SECRET;
  const prefix = customerKeyPrefix(visitor.organizationId, visitor.customerId);
  for (const a of input.attachments) {
    if (!a.key.startsWith(prefix) || !verifyUploadReceipt(secret, { ...a, customerId: visitor.customerId })) {
      throw new AppError('BAD_REQUEST', 'One of the attachments is invalid. Please upload it again.');
    }
  }

  const [inbound] = websiteChannelAdapter.normalizeIncomingMessage({
    organizationId: visitor.organizationId,
    channelId: visitor.channelId,
    customerId: visitor.customerId,
    clientMessageId: input.clientMessageId,
    content: input.content,
    attachments: input.attachments.map(({ key, fileName, mimeType, size }) => ({ key, fileName, mimeType, size })),
    pageUrl: input.pageUrl,
  });

  return sseResponse(req.signal, async (writer) => {
    try {
      await processInboundMessage(
        { db: visitor.db, bot: visitor.bot, timeZone: visitor.organization.timezone, businessHours: visitor.businessHours },
        inbound!,
        writer.send,
      );
    } catch (err) {
      log.error('widget message processing failed', { err, organizationId: visitor.organizationId });
      writer.send({ type: 'error', code: 'INTERNAL', message: 'Your message could not be processed. Please try again.' });
    } finally {
      writer.close();
    }
  });
});
