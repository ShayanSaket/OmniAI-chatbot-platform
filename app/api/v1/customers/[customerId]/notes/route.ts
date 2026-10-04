import { NextResponse } from 'next/server';
import { customerNoteSchema } from '@/lib/inbox';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { addCustomerNote } from '@/server/modules/inbox/inbox-service';

/** Internal note on a customer (never shown to the customer). */
export const POST = route<{ customerId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  const input = await parseJson(req, customerNoteSchema);
  return NextResponse.json({ data: await addCustomerNote(ctx, params.customerId, input.content) }, { status: 201 });
});
