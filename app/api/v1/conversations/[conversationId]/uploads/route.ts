import { NextResponse } from 'next/server';
import { MAX_UPLOAD_BYTES } from '@/lib/widget-protocol';
import { requireApiAuth } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { uploadAgentFile } from '@/server/modules/inbox/inbox-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Multipart upload ("file") of an attachment for a reply in this conversation. */
export const POST = route<{ conversationId: string }>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  await enforceRateLimit(RATE_LIMITS.inboxUpload, ctx.userId);
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new AppError('BAD_REQUEST', 'Files can be at most 10 MB.');
  let file: FormDataEntryValue | null = null;
  try {
    file = (await req.formData()).get('file');
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a multipart upload with a "file" field.');
  }
  if (!(file instanceof File)) throw new AppError('BAD_REQUEST', 'Expected a multipart upload with a "file" field.');
  return NextResponse.json({ data: await uploadAgentFile(ctx, params.conversationId, file) }, { status: 201 });
});
