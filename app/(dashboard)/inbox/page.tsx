import type { Metadata } from 'next';
import { Inbox } from 'lucide-react';
import { ModuleRoadmap } from '@/components/common/module-roadmap';
import { requirePageAuth } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Inbox' };

export default async function InboxPage() {
  await requirePageAuth('inbox:access');
  return (
    <ModuleRoadmap
      title="Inbox"
      description="Website and WhatsApp conversations in one place."
      icon={Inbox}
      phase={6}
      capabilities={[
        'Unified list across Website and WhatsApp with unread counts',
        'Filters: channel, AI / human, open / closed, unread',
        'Take over from the AI and reply on the original channel',
        'AI-suggested replies you approve before sending',
        'Conversation summaries for fast handoffs'
      ]}
    />
  );
}
