import { NextResponse } from 'next/server';
import { businessHoursUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { getBusinessHours, replaceBusinessHours } from '@/server/modules/bot/business-hours-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: await getBusinessHours(ctx) });
});

export const PUT = route(async (req) => {
  const ctx = await requireApiAuth('bot:manage');
  const input = await parseJson(req, businessHoursUpdateSchema);
  return NextResponse.json({ data: await replaceBusinessHours(ctx, input) });
});
