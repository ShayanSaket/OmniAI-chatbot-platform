import { NextResponse } from 'next/server';
import { webhookEndpointSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { createWebhookEndpoint, listWebhookEndpoints } from '@/server/modules/webhooks/webhook-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('integrations:manage');
  return NextResponse.json({ data: await listWebhookEndpoints(ctx) });
});

/** Returns the signing secret once: store it now. */
export const POST = route(async (req) => {
  const ctx = await requireApiAuth('integrations:manage');
  const input = await parseJson(req, webhookEndpointSchema);
  return NextResponse.json({ data: await createWebhookEndpoint(ctx, input) }, { status: 201 });
});
