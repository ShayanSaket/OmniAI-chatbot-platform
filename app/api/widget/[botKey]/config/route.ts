import { NextResponse } from 'next/server';
import { requireBot } from '@/server/channels/website/widget-auth';
import { route } from '@/server/http';
import { publicWidgetConfig } from '@/server/modules/widget/widget-service';

export const dynamic = 'force-dynamic';

/** Public widget configuration (appearance + team availability). No secrets. */
export const GET = route<{ botKey: string }>(async (_req, { params }) => {
  const resolved = await requireBot(params.botKey);
  return NextResponse.json(
    { data: publicWidgetConfig(resolved) },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' } },
  );
});
