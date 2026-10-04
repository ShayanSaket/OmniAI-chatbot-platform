import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { LeadsApp } from '@/components/leads/leads-app';
import { DEFAULT_LEAD_FILTERS } from '@/lib/leads';
import { hasPermission } from '@/lib/permissions';
import { requirePageAuth } from '@/server/auth/session';
import { listInboxMembers } from '@/server/modules/inbox/inbox-service';
import { leadBoard, leadStats } from '@/server/modules/leads/lead-service';

export const metadata: Metadata = { title: 'Leads' };

export default async function LeadsPage({ searchParams }: { searchParams: { lead?: string } }) {
  const ctx = await requirePageAuth('leads:view');
  const [board, stats, members, product] = await Promise.all([
    leadBoard(ctx, DEFAULT_LEAD_FILTERS),
    leadStats(ctx),
    listInboxMembers(ctx),
    ctx.db.product.findFirst({ orderBy: { createdAt: 'asc' }, select: { currency: true } }),
  ]);
  const leadId = typeof searchParams.lead === 'string' && /^[a-z0-9]{10,40}$/i.test(searchParams.lead) ? searchParams.lead : null;
  return (
    <>
      <PageHeader title="Leads" description="Sales opportunities captured by the AI on your website and WhatsApp, and added by your team." />
      <LeadsApp
        initialBoard={board.columns}
        initialStats={stats}
        initialLeadId={leadId}
        members={members}
        currency={/^[A-Z]{3}$/.test(product?.currency ?? '') ? product!.currency : 'EUR'}
        canManage={hasPermission(ctx.role, 'leads:manage')}
        canInbox={hasPermission(ctx.role, 'inbox:access')}
        meId={ctx.userId}
      />
    </>
  );
}
