import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { KnowledgeManager } from '@/components/knowledge/knowledge-manager';
import { requirePageAuth } from '@/server/auth/session';
import { listKnowledge } from '@/server/modules/knowledge/knowledge-service';

export const metadata: Metadata = { title: 'Knowledge Base' };

type SearchParams = { add?: string; title?: string; q?: string | string[] };

/** ?add=faq&title=…&q=…&q=… opens the FAQ form pre-filled (from Analytics → AI insights). */
function faqDraft(sp: SearchParams) {
  if (sp.add !== 'faq') return undefined;
  const questions = (Array.isArray(sp.q) ? sp.q : sp.q ? [sp.q] : []).map((q) => q.trim().slice(0, 300)).filter(Boolean).slice(0, 10);
  if (!questions.length) return undefined;
  return { title: (sp.title ?? '').trim().slice(0, 120), entries: questions.map((question) => ({ question, answer: '' })) };
}

export default async function KnowledgeBasePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePageAuth('knowledge:manage');
  const data = await listKnowledge(ctx);
  return (
    <>
      <PageHeader title="Knowledge Base" description="The verified information your AI agent answers from — on the website and on WhatsApp." />
      <KnowledgeManager initial={data} faqDraft={faqDraft(searchParams)} />
    </>
  );
}
