import { NextResponse } from 'next/server';
import { mergeCustomerSchema } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { mergeCustomers } from '@/server/modules/customers/customer-service';

/** Merges { sourceId } into this customer. */
export const POST = route<{ customerId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const input = await parseJson(req, mergeCustomerSchema);
  return NextResponse.json({ data: await mergeCustomers(ctx, params.customerId, input.sourceId) });
});
