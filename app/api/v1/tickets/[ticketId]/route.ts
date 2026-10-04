import { NextResponse } from 'next/server';
import { ticketUpdateSchema } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { updateTicket } from '@/server/modules/customers/customer-service';

export const PATCH = route<{ ticketId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const input = await parseJson(req, ticketUpdateSchema);
  return NextResponse.json({ data: await updateTicket(ctx, params.ticketId, input) });
});
