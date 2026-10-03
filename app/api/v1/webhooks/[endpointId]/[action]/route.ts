import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { rotateWebhookSecret, sendTestWebhook } from '@/server/modules/webhooks/webhook-service';

type Params = { endpointId: string; action: string };

/** POST /webhooks/:id/test (signed ping) · POST /webhooks/:id/rotate-secret */
export const POST = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('integrations:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `webhook-action:${ctx.organizationId}`);
  if (params.action === 'test') return NextResponse.json({ data: await sendTestWebhook(ctx, params.endpointId) });
  if (params.action === 'rotate-secret') return NextResponse.json({ data: await rotateWebhookSecret(ctx, params.endpointId) });
  throw new AppError('NOT_FOUND', 'Unknown action.');
});
