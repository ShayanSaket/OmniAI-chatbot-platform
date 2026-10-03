import { NextResponse } from 'next/server';
import { webhookEndpointUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteWebhookEndpoint, listWebhookDeliveries, updateWebhookEndpoint } from '@/server/modules/webhooks/webhook-service';

type Params = { endpointId: string };

/** Recent deliveries of this endpoint. */
export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('integrations:manage');
  return NextResponse.json({ data: await listWebhookDeliveries(ctx, params.endpointId) });
});

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('integrations:manage');
  const input = await parseJson(req, webhookEndpointUpdateSchema);
  return NextResponse.json({ data: await updateWebhookEndpoint(ctx, params.endpointId, input) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('integrations:manage');
  await deleteWebhookEndpoint(ctx, params.endpointId);
  return new NextResponse(null, { status: 204 });
});
