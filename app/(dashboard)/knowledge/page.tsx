import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { KnowledgeManager } from '@/components/knowledge/knowledge-manager';
import { requirePageAuth } from '@/server/auth/session';
import { listKnowledge } from '@/server/modules/knowledge/knowledge-service';

export const metadata: Metadata = { title: 'Knowledge Base' };

export default async function KnowledgeBasePage() {
  const ctx = await requirePageAuth('knowledge:manage');
  const data = await listKnowledge(ctx);
  return (
    <>
      <PageHeader title="Knowledge Base" description="The verified information your AI agent answers from — on the website and on WhatsApp." />
      <KnowledgeManager initial={data} />
    </>
  );
}
