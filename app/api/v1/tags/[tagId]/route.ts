import { NextResponse } from 'next/server';
import { tagUpdateSchema } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteTag, updateTag } from '@/server/modules/customers/customer-service';

type Params = { tagId: string };

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const input = await parseJson(req, tagUpdateSchema);
  return NextResponse.json({ data: await updateTag(ctx, params.tagId, input) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  await deleteTag(ctx, params.tagId);
  return new Response(null, { status: 204 });
});
