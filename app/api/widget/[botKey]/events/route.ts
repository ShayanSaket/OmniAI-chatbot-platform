import type { WidgetEvent } from '@/lib/widget-protocol';
import { requireVisitor } from '@/server/channels/website/widget-auth';
import { route } from '@/server/http';
import { channels, subscribe } from '@/server/realtime/bus';
import { sseResponse } from '@/server/realtime/sse-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Long-lived event stream for a visitor: agent messages, status changes, messages sent
 * from other tabs. Closes after 5 minutes; the widget reconnects and catches up via
 * GET /messages?after=…
 */
export const GET = route<{ botKey: string }>(async (req, { params }) => {
  const visitor = await requireVisitor(req, params.botKey);
  return sseResponse(
    req.signal,
    (writer) => subscribe(channels.visitor(visitor.customerId), (payload) => writer.send(payload as WidgetEvent)),
    { heartbeatMs: 20_000, maxDurationMs: 5 * 60_000 },
  );
});
