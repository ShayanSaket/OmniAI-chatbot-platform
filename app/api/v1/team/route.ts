import { NextResponse } from 'next/server';
import { addMemberSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { addMember, listMembers } from '@/server/modules/team/team-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('team:view');
  return NextResponse.json({ data: await listMembers(ctx) });
});

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('team:manage');
  const input = await parseJson(req, addMemberSchema);
  return NextResponse.json({ data: await addMember(ctx, input) }, { status: 201 });
});
