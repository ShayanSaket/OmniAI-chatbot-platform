import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listTags } from '@/server/modules/customers/customer-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('customers:view');
  return NextResponse.json({ data: await listTags(ctx) });
});
