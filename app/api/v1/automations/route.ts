import { NextResponse } from 'next/server';
import { automationInputSchema } from '@/lib/automations';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { automationBuilderOptions, createAutomation, listAutomations } from '@/server/modules/automations/automation-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('automations:manage');
  const [automations, options] = await Promise.all([listAutomations(ctx), automationBuilderOptions(ctx)]);
  return NextResponse.json({ data: { automations, options } });
});

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('automations:manage');
  const input = await parseJson(req, automationInputSchema);
  return NextResponse.json({ data: await createAutomation(ctx, input) }, { status: 201 });
});
