import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { exportCustomer } from '@/server/modules/customers/customer-service';

export const dynamic = 'force-dynamic';

/** GDPR data export (access / portability) as a JSON download. */
export const GET = route<{ customerId: string }>(async (_req, { params }) => {
  const ctx = await requireApiAuth('customers:manage');
  const data = await exportCustomer(ctx, params.customerId);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="customer-${params.customerId}.json"`,
      'Cache-Control': 'no-store',
    },
  });
});
