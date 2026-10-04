import { NextResponse } from 'next/server';
import { leadUpdateSchema } from '@/lib/leads';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteLead, getLead, updateLead } from '@/server/modules/leads/lead-service';

type Params = { leadId: string };

export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('leads:view');
  return NextResponse.json({ data: await getLead(ctx, params.leadId) });
});

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('leads:manage');
  const input = await parseJson(req, leadUpdateSchema);
  return NextResponse.json({ data: await updateLead(ctx, params.leadId, input) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('leads:manage');
  await deleteLead(ctx, params.leadId);
  return new Response(null, { status: 204 });
});
