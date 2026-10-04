import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { CustomersTable } from '@/components/customers/customers-table';
import { parseCustomerQuery } from '@/lib/customers';
import { requirePageAuth } from '@/server/auth/session';
import { listCustomers, listTags } from '@/server/modules/customers/customer-service';

export const metadata: Metadata = { title: 'Customers' };

export default async function CustomersPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const ctx = await requirePageAuth('customers:view');
  const params = new URLSearchParams(Object.entries(searchParams).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));
  const { cursor: _cursor, ...filters } = parseCustomerQuery(params);
  const [initial, tags] = await Promise.all([listCustomers(ctx, filters), listTags(ctx)]);
  return (
    <>
      <PageHeader title="Customers" description="Everyone who has talked to your business, across website chat and WhatsApp." />
      <CustomersTable initial={initial} initialFilters={filters} tags={tags} />
    </>
  );
}
