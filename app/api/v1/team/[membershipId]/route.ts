import { NextResponse } from 'next/server';
import { updateMemberSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { changeMemberRole, removeMember } from '@/server/modules/team/team-service';

type Params = { membershipId: string };

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('team:manage');
  const { role } = await parseJson(req, updateMemberSchema);
  return NextResponse.json({ data: await changeMemberRole(ctx, params.membershipId, role) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('team:manage');
  await removeMember(ctx, params.membershipId);
  return new NextResponse(null, { status: 204 });
});
