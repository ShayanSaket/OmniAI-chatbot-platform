import { NextResponse } from 'next/server';
import { customerTagsSchema } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { setCustomerTags } from '@/server/modules/customers/customer-service';

/** Replaces the customer's tags: { tags: string[] } (new names become tags). */
export const PUT = route<{ customerId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const input = await parseJson(req, customerTagsSchema);
  return NextResponse.json({ data: await setCustomerTags(ctx, params.customerId, input.tags) });
});
