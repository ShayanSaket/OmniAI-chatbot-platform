import { NextResponse } from 'next/server';
import { MAX_UPLOAD_BYTES } from '@/lib/widget-protocol';
import { requireVisitor } from '@/server/channels/website/widget-auth';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { uploadVisitorFile } from '@/server/modules/widget/widget-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ botKey: string }>(async (req, { params }) => {
  const visitor = await requireVisitor(req, params.botKey);
  await enforceRateLimit(RATE_LIMITS.widgetUpload, visitor.customerId);

  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new AppError('BAD_REQUEST', 'Files can be at most 10 MB.');

  let file: FormDataEntryValue | null = null;
  try {
    file = (await req.formData()).get('file');
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a multipart upload with a "file" field.');
  }
  if (!(file instanceof File)) throw new AppError('BAD_REQUEST', 'Expected a multipart upload with a "file" field.');

  return NextResponse.json({ data: await uploadVisitorFile(visitor, file) }, { status: 201 });
});
