import type { Metadata } from 'next';
import { Target } from 'lucide-react';
import { ModuleRoadmap } from '@/components/common/module-roadmap';
import { requirePageAuth } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Leads' };

export default async function LeadsPage() {
  await requirePageAuth('leads:view');
  return (
    <ModuleRoadmap
      title="Leads"
      description="Buying intent captured by the AI, ready for sales."
      icon={Target}
      phase={7}
      capabilities={[
        'Leads created conversationally by the AI agent',
        'Pipeline: New → Contacted → Qualified → Proposal → Won / Lost',
        'Intent and temperature (cold, warm, hot)',
        'Assignment to team members',
        'Source conversation one click away'
      ]}
    />
  );
}
