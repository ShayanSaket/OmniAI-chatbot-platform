import { NextResponse } from 'next/server';
import { knowledgeFaqSchema, knowledgeTextSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import {
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  updateKnowledgeContent,
} from '@/server/modules/knowledge/knowledge-service';

type Params = { documentId: string };

export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('knowledge:manage');
  return NextResponse.json({ data: await getKnowledgeDocument(ctx, params.documentId) });
});

/** Edit an FAQ ({ title, entries }) or text ({ title, content }) source. */
export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('knowledge:manage');
  const raw = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const input = 'entries' in raw ? await parseJson(req, knowledgeFaqSchema) : await parseJson(req, knowledgeTextSchema);
  return NextResponse.json({ data: await updateKnowledgeContent(ctx, params.documentId, input) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('knowledge:manage');
  await deleteKnowledgeDocument(ctx, params.documentId);
  return new NextResponse(null, { status: 204 });
});
