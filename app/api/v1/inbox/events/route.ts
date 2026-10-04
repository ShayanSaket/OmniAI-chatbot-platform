import type { WidgetEvent } from '@/lib/widget-protocol';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { channels, subscribe } from '@/server/realtime/bus';
import { sseResponse } from '@/server/realtime/sse-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live inbox feed for the signed-in member's organization. Events carry ids only (no
 * message content); the client refetches what changed. Closes after 5 minutes and the
 * client reconnects, so a removed member loses access within that time.
 */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('inbox:access');
  return sseResponse(
    req.signal,
    (writer) => subscribe(channels.inbox(ctx.organizationId), (payload) => writer.send(payload as WidgetEvent)),
    { heartbeatMs: 20_000, maxDurationMs: 5 * 60_000 },
  );
});
