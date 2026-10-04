import { NextResponse } from 'next/server';
import { leadCreateSchema, parseLeadQuery } from '@/lib/leads';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { createLead, leadBoard, leadStats, listLeads } from '@/server/modules/leads/lead-service';

/** ?view=board → columns per status; otherwise a filtered page. First pages include stats. */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('leads:view');
  const p = req.nextUrl.searchParams;
  const filters = parseLeadQuery(p);
  if (p.get('view') === 'board') {
    const [board, stats] = await Promise.all([leadBoard(ctx, filters), leadStats(ctx)]);
    return NextResponse.json({ data: { ...board, stats } });
  }
  const [list, stats] = await Promise.all([listLeads(ctx, filters), filters.cursor ? Promise.resolve(null) : leadStats(ctx)]);
  return NextResponse.json({ data: { ...list, stats } });
});

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('leads:manage');
  const input = await parseJson(req, leadCreateSchema);
  return NextResponse.json({ data: await createLead(ctx, input) }, { status: 201 });
});
