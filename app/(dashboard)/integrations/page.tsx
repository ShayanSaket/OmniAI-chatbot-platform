import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { IntegrationsPage, type ConnectorItem } from '@/components/integrations/integrations-page';
import { requirePageAuth } from '@/server/auth/session';
import { listIntegrations } from '@/server/modules/integrations/integration-service';
import { listWebhookEndpoints } from '@/server/modules/webhooks/webhook-service';

export const metadata: Metadata = { title: 'Integrations' };

export default async function Integrations() {
  const ctx = await requirePageAuth('integrations:manage');
  const [connectors, endpoints] = await Promise.all([listIntegrations(ctx), listWebhookEndpoints(ctx)]);
  return (
    <>
      <PageHeader title="Integrations" description="Webhooks and app connections that move conversations, customers and leads into your other systems." />
      <IntegrationsPage connectors={connectors as ConnectorItem[]} endpoints={endpoints} />
    </>
  );
}
