import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { deleteCustomerNote } from '@/server/modules/inbox/inbox-service';

export const DELETE = route<{ customerId: string; noteId: string }>(async (_req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  await deleteCustomerNote(ctx, params.customerId, params.noteId);
  return new Response(null, { status: 204 });
});
