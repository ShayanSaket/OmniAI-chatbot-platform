import { parsePeriodQuery } from '@/lib/analytics';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { exportAnalyticsCsv } from '@/server/modules/analytics/report-service';

export const dynamic = 'force-dynamic';

/** Daily (or hourly) metrics of the period as CSV. */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('analytics:view');
  const csv = await exportAnalyticsCsv(ctx, parsePeriodQuery(req.nextUrl.searchParams), ctx.organization.timezone);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
