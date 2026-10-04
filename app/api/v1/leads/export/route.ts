import { parseLeadQuery } from '@/lib/leads';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { exportLeadsCsv } from '@/server/modules/leads/lead-service';

export const dynamic = 'force-dynamic';

/** CSV download of the leads matching the current filters. */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('leads:view');
  const csv = await exportLeadsCsv(ctx, parseLeadQuery(req.nextUrl.searchParams));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="leads-${day}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
