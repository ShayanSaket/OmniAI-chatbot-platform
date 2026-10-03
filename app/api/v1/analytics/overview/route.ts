import { NextResponse } from 'next/server';
import { analyticsRangeSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { getOverview } from '@/server/modules/analytics/overview-service';

export const GET = route(async (req) => {
  const ctx = await requireApiAuth('analytics:view');
  const range = analyticsRangeSchema.parse(req.nextUrl.searchParams.get('range'));
  return NextResponse.json({ data: await getOverview(ctx, { range, timeZone: ctx.organization.timezone }) });
});
