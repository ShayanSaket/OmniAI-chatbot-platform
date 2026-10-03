import { NextResponse } from 'next/server';
import { knowledgeSearchSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { testKnowledgeSearch } from '@/server/modules/knowledge/knowledge-service';

/** Retrieval tester: what the assistant would find for a question. */
export const POST = route(async (req) => {
  const ctx = await requireApiAuth('knowledge:manage');
  const { query } = await parseJson(req, knowledgeSearchSchema);
  return NextResponse.json({ data: await testKnowledgeSearch(ctx, query) });
});
