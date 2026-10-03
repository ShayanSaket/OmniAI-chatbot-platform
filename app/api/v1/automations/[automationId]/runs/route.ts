import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listAutomationRuns } from '@/server/modules/automations/automation-service';

type Params = { automationId: string };

export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('automations:manage');
  return NextResponse.json({ data: await listAutomationRuns(ctx, params.automationId) });
});
