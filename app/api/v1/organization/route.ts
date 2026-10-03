import { NextResponse } from 'next/server';
import { organizationUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { getOrganization, updateOrganization } from '@/server/modules/organizations/organization-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth();
  return NextResponse.json({ data: await getOrganization(ctx) });
});

export const PATCH = route(async (req) => {
  const ctx = await requireApiAuth('organization:manage');
  const input = await parseJson(req, organizationUpdateSchema);
  return NextResponse.json({ data: await updateOrganization(ctx, input) });
});
