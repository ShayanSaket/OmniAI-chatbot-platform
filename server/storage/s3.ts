import 'server-only';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { env } from '../env';
import { AppError } from '../errors';
import { logger } from '../logger';

const globalForS3 = globalThis as unknown as { s3?: S3Client; s3BucketReady?: Promise<void> };

function config() {
  const e = env();
  if (!e.S3_BUCKET || !e.S3_ACCESS_KEY || !e.S3_SECRET_KEY) {
    throw new AppError('BAD_REQUEST', 'File uploads are not configured.');
  }
  return e;
}

function client(): S3Client {
  if (globalForS3.s3) return globalForS3.s3;
  const e = config();
  globalForS3.s3 = new S3Client({
    region: e.S3_REGION,
    endpoint: e.S3_ENDPOINT,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: e.S3_ACCESS_KEY!, secretAccessKey: e.S3_SECRET_KEY! },
  });
  return globalForS3.s3;
}

/** Creates the bucket on first use (local S3-compatible stores start empty). */
async function ensureBucket(): Promise<void> {
  globalForS3.s3BucketReady ??= (async () => {
    const Bucket = config().S3_BUCKET!;
    try {
      await client().send(new HeadBucketCommand({ Bucket }));
    } catch {
      await client().send(new CreateBucketCommand({ Bucket }));
      logger.info('created storage bucket', { bucket: Bucket });
    }
  })().catch((err) => {
    globalForS3.s3BucketReady = undefined;
    throw err;
  });
  return globalForS3.s3BucketReady;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await ensureBucket();
  await client().send(
    new PutObjectCommand({ Bucket: config().S3_BUCKET!, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getObject(key: string) {
  await ensureBucket();
  const res = await client().send(new GetObjectCommand({ Bucket: config().S3_BUCKET!, Key: key }));
  if (!res.Body) throw new AppError('NOT_FOUND', 'File not found.');
  return { body: res.Body.transformToWebStream(), contentType: res.ContentType, contentLength: res.ContentLength };
}

/** Deletes every object under a prefix (GDPR deletion of a customer's files). */
export async function deletePrefix(prefix: string): Promise<number> {
  await ensureBucket();
  const Bucket = config().S3_BUCKET!;
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await client().send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) {
      await client().send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}
