import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ANALYTICS_PERIODS, parsePeriodQuery } from '@/lib/analytics';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { generateInsightReport, getInsights } from '@/server/modules/analytics/insights-service';

/** Knowledge gaps, frequent questions, complaints, intent trends and the latest AI report. */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('analytics:view');
  return NextResponse.json({ data: await getInsights(ctx, parsePeriodQuery(req.nextUrl.searchParams), ctx.organization.timezone) });
});

const bodySchema = z.object({
  range: z.enum(ANALYTICS_PERIODS),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
});

/** Writes a new AI insight report for the period. */
export const POST = route(async (req) => {
  const ctx = await requireApiAuth('analytics:view');
  await enforceRateLimit(RATE_LIMITS.insightReport, ctx.organizationId);
  const body = await parseJson(req, bodySchema);
  const query = parsePeriodQuery(new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined) as [string, string][]));
  return NextResponse.json({ data: await generateInsightReport(ctx, query, ctx.organization.timezone) }, { status: 201 });
});
