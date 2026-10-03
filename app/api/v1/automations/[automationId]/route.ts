import { NextResponse } from 'next/server';
import { z } from 'zod';
import { automationInputSchema } from '@/lib/automations';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteAutomation, setAutomationActive, updateAutomation } from '@/server/modules/automations/automation-service';

type Params = { automationId: string };

export const PUT = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('automations:manage');
  const input = await parseJson(req, automationInputSchema);
  return NextResponse.json({ data: await updateAutomation(ctx, params.automationId, input) });
});

/** Toggle: { isActive } */
export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('automations:manage');
  const { isActive } = await parseJson(req, z.object({ isActive: z.boolean() }));
  return NextResponse.json({ data: await setAutomationActive(ctx, params.automationId, isActive) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('automations:manage');
  await deleteAutomation(ctx, params.automationId);
  return new NextResponse(null, { status: 204 });
});
