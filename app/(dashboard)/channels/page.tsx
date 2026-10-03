import type { Metadata } from 'next';
import { WhatsAppSettings } from '@/components/channels/whatsapp-settings';
import { PageHeader } from '@/components/common/page-header';
import { requirePageAuth } from '@/server/auth/session';
import { getWhatsAppSettings } from '@/server/modules/whatsapp/whatsapp-service';

export const metadata: Metadata = { title: 'Channels' };

export default async function ChannelsPage() {
  const ctx = await requirePageAuth('bot:manage');
  const settings = await getWhatsAppSettings(ctx);
  return (
    <>
      <PageHeader
        title="Channels"
        description="Where customers reach your assistant. The website widget is set up under AI Agent; WhatsApp is connected here."
      />
      <WhatsAppSettings initial={settings} />
    </>
  );
}
