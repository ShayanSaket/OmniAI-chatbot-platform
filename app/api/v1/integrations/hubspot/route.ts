import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hubspotConnectSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { connectIntegration, disconnectIntegration, testIntegration, updateIntegration } from '@/server/modules/integrations/integration-service';

/** Connect (token is verified with HubSpot first). */
export const PUT = route(async (req) => {
  const ctx = await requireApiAuth('integrations:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `integration:${ctx.organizationId}`);
  const { accessToken, syncLeads, syncCustomers } = await parseJson(req, hubspotConnectSchema);
  return NextResponse.json({ data: await connectIntegration(ctx, 'HUBSPOT', { secrets: { accessToken }, config: { syncLeads, syncCustomers } }) });
});

/** Sync options / pause: { syncLeads?, syncCustomers?, isActive? } */
export const PATCH = route(async (req) => {
  const ctx = await requireApiAuth('integrations:manage');
  const input = await parseJson(req, z.object({ syncLeads: z.boolean(), syncCustomers: z.boolean(), isActive: z.boolean() }).partial());
  const { isActive, ...config } = input;
  const hasConfig = config.syncLeads !== undefined || config.syncCustomers !== undefined;
  return NextResponse.json({ data: await updateIntegration(ctx, 'HUBSPOT', { ...(hasConfig ? { config } : {}), isActive }) });
});

/** Connection test. */
export const POST = route(async () => {
  const ctx = await requireApiAuth('integrations:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `integration:${ctx.organizationId}`);
  return NextResponse.json({ data: await testIntegration(ctx, 'HUBSPOT') });
});

export const DELETE = route(async () => {
  const ctx = await requireApiAuth('integrations:manage');
  await disconnectIntegration(ctx, 'HUBSPOT');
  return new NextResponse(null, { status: 204 });
});
