import { NextResponse } from 'next/server';
import { parseCustomerQuery } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listCustomers } from '@/server/modules/customers/customer-service';

/** ?q&type=identified|anonymous&channel&tag&sort=recent|created|name&cursor */
export const GET = route(async (req) => {
  const ctx = await requireApiAuth('customers:view');
  return NextResponse.json({ data: await listCustomers(ctx, parseCustomerQuery(req.nextUrl.searchParams)) });
});
