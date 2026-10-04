import { NextResponse } from 'next/server';
import { appointmentUpdateSchema } from '@/lib/customers';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { updateAppointment } from '@/server/modules/customers/customer-service';

export const PATCH = route<{ appointmentId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const input = await parseJson(req, appointmentUpdateSchema);
  return NextResponse.json({ data: await updateAppointment(ctx, params.appointmentId, input) });
});
