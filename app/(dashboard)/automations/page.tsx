import type { Metadata } from 'next';
import { AutomationsManager } from '@/components/automations/automations-manager';
import { PageHeader } from '@/components/common/page-header';
import { requirePageAuth } from '@/server/auth/session';
import { automationBuilderOptions, listAutomations } from '@/server/modules/automations/automation-service';

export const metadata: Metadata = { title: 'Automations' };

export default async function AutomationsPage() {
  const ctx = await requirePageAuth('automations:manage');
  const [automations, options] = await Promise.all([listAutomations(ctx), automationBuilderOptions(ctx)]);
  return (
    <>
      <PageHeader title="Automations" description="When something happens in a conversation, act on it automatically — tag, assign, follow up, notify or call your systems." />
      <AutomationsManager initial={automations} options={options} />
    </>
  );
}
