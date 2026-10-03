import { env } from '@/server/env';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';
import { getObject } from '@/server/storage/s3';
import { typeForMime, verifyFileSignature } from '@/server/storage/files';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Serves stored files through short-lived signed URLs (no public bucket). Responses are
 * sandboxed so a file can never execute script in our origin.
 */
export const GET = route(async (req) => {
  const p = req.nextUrl.searchParams;
  const key = p.get('k') ?? '';
  const exp = Number(p.get('e'));
  const sig = p.get('s') ?? '';
  if (!key || !verifyFileSignature(env().AUTH_SECRET, key, exp, sig)) {
    throw new AppError('NOT_FOUND', 'File not found or link expired.');
  }

  let object;
  try {
    object = await getObject(key);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('NOT_FOUND', 'File not found.');
  }
  const type = typeForMime(object.contentType ?? '');
  const fileName = key.split('/').pop() ?? 'file';

  return new Response(object.body, {
    headers: {
      'Content-Type': type?.mime ?? 'application/octet-stream',
      ...(object.contentLength ? { 'Content-Length': String(object.contentLength) } : {}),
      'Content-Disposition': `${type?.inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-site',
    },
  });
});
