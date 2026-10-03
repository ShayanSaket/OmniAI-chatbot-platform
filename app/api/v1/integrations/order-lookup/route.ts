import { NextResponse } from 'next/server';
import { orderLookupUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteOrderLookup, getOrderLookupSettings, saveOrderLookup } from '@/server/modules/integrations/order-lookup-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: await getOrderLookupSettings(ctx) });
});

export const PUT = route(async (req) => {
  const ctx = await requireApiAuth('integrations:manage');
  const input = await parseJson(req, orderLookupUpdateSchema);
  return NextResponse.json({ data: await saveOrderLookup(ctx, input) });
});

export const DELETE = route(async () => {
  const ctx = await requireApiAuth('integrations:manage');
  await deleteOrderLookup(ctx);
  return new NextResponse(null, { status: 204 });
});
