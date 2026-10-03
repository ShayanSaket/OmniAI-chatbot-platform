import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { ModuleRoadmap } from '@/components/common/module-roadmap';
import { requirePageAuth } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Customers' };

export default async function CustomersPage() {
  await requirePageAuth('customers:view');
  return (
    <ModuleRoadmap
      title="Customers"
      description="Every person who has talked to your business, across channels."
      icon={Users}
      phase={7}
      capabilities={[
        'Profiles with contact details, language, tags and custom fields',
        'Channel identities linked to one customer',
        'Conversation, lead and ticket history',
        'AI-generated customer summary and notes',
        'GDPR export and deletion'
      ]}
    />
  );
}
