import { NextResponse } from 'next/server';
import { orderLookupTestSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { testOrderLookup } from '@/server/modules/integrations/order-lookup-service';

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('integrations:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `order-test:${ctx.organizationId}`);
  const { orderNumber, email } = await parseJson(req, orderLookupTestSchema);
  return NextResponse.json({ data: await testOrderLookup(ctx, orderNumber, email) });
});
