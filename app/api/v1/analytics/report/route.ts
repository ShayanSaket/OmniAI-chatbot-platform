import { NextResponse } from 'next/server';
import { parsePeriodQuery } from '@/lib/analytics';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { getAnalyticsReport } from '@/server/modules/analytics/report-service';

/** Full analytics: ?range=today|7d|30d|90d or ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('analytics:view');
  return NextResponse.json({ data: await getAnalyticsReport(ctx, parsePeriodQuery(req.nextUrl.searchParams), ctx.organization.timezone) });
});
