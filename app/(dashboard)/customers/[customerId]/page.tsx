import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CustomerProfileView } from '@/components/customers/customer-profile';
import { hasPermission } from '@/lib/permissions';
import { requirePageAuth } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { getCustomerProfile, listTags } from '@/server/modules/customers/customer-service';

export const metadata: Metadata = { title: 'Customer' };

export default async function CustomerPage({ params }: { params: { customerId: string } }) {
  const ctx = await requirePageAuth('customers:view');
  let profile;
  try {
    profile = await getCustomerProfile(ctx, params.customerId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const tags = await listTags(ctx);
  return (
    <CustomerProfileView
      initial={profile}
      allTags={tags}
      me={{ id: ctx.userId }}
      can={{
        manage: hasPermission(ctx.role, 'customers:manage'),
        delete: hasPermission(ctx.role, 'customers:delete'),
        reply: hasPermission(ctx.role, 'conversations:reply'),
        leads: hasPermission(ctx.role, 'leads:view'),
        inbox: hasPermission(ctx.role, 'inbox:access'),
      }}
    />
  );
}
