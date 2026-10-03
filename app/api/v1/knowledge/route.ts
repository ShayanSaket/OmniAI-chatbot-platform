import { NextResponse } from 'next/server';
import { KNOWLEDGE_MAX_FILE_BYTES } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';
import { listKnowledge, uploadKnowledgeFile } from '@/server/modules/knowledge/knowledge-service';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';

export const runtime = 'nodejs';

export const GET = route(async () => {
  const ctx = await requireApiAuth('knowledge:manage');
  return NextResponse.json({ data: await listKnowledge(ctx) });
});

/** Multipart upload: field "file" (PDF, DOCX, TXT, MD; max 20 MB). */
export const POST = route(async (req) => {
  const ctx = await requireApiAuth('knowledge:manage');
  await enforceRateLimit(RATE_LIMITS.knowledgeWrite, ctx.organizationId);
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > KNOWLEDGE_MAX_FILE_BYTES + 64 * 1024) throw new AppError('BAD_REQUEST', 'Files can be at most 20 MB.');
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError('BAD_REQUEST', 'Send the file as multipart/form-data.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('BAD_REQUEST', 'No file was uploaded.');
  return NextResponse.json({ data: await uploadKnowledgeFile(ctx, file) }, { status: 201 });
});
