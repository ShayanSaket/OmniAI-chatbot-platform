import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { redeliverWebhook } from '@/server/modules/webhooks/webhook-service';

type Params = { deliveryId: string };

export const POST = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('integrations:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `webhook-action:${ctx.organizationId}`);
  return NextResponse.json({ data: await redeliverWebhook(ctx, params.deliveryId) });
});
