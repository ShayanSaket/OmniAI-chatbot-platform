import type { Metadata } from 'next';
import { BarChart3 } from 'lucide-react';
import { ModuleRoadmap } from '@/components/common/module-roadmap';
import { requirePageAuth } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Analytics' };

export default async function AnalyticsPage() {
  await requirePageAuth('analytics:view');
  return (
    <ModuleRoadmap
      title="Analytics"
      description="Deep performance analytics and AI insights."
      icon={BarChart3}
      phase={8}
      capabilities={[
        'Custom date ranges and channel comparison',
        'Top questions, unknown questions and topic trends',
        'Knowledge-base coverage gaps',
        'Token usage and AI cost estimates',
        'Escalation and conversion analysis'
      ]}
    />
  );
}
