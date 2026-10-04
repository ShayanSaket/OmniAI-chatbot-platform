import { NextResponse } from 'next/server';
import { customerUpdateSchema } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteCustomer, getCustomerProfile, updateCustomer } from '@/server/modules/customers/customer-service';

type Params = { customerId: string };

export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('customers:view');
  return NextResponse.json({ data: await getCustomerProfile(ctx, params.customerId) });
});

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const input = await parseJson(req, customerUpdateSchema);
  return NextResponse.json({ data: await updateCustomer(ctx, params.customerId, input) });
});

/** GDPR erasure: the customer and everything linked to them. */
export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('customers:delete');
  return NextResponse.json({ data: await deleteCustomer(ctx, params.customerId) });
});
