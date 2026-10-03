import { NextResponse } from 'next/server';
import { requireBot } from '@/server/channels/website/widget-auth';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { clientIp } from '@/server/request';
import { sessionSchema } from '@/server/modules/widget/schemas';
import { publicWidgetConfig, startSession } from '@/server/modules/widget/widget-service';

export const dynamic = 'force-dynamic';

/** Starts or resumes a visitor session; returns the visitor token and current conversation. */
export const POST = route<{ botKey: string }>(async (req, { params }) => {
  await enforceRateLimit(RATE_LIMITS.widgetSession, clientIp(req.headers));
  const resolved = await requireBot(params.botKey);
  const input = await parseJson(req, sessionSchema);
  const session = await startSession(resolved, input);
  return NextResponse.json({ data: { ...session, config: publicWidgetConfig(resolved) } });
});
