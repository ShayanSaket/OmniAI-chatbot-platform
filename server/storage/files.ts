import { createHmac, randomUUID } from 'node:crypto';
import { safeEqual } from '../crypto';

// File-type sniffing, safe naming, upload receipts and signed download URLs.

export interface AllowedType {
  mime: string;
  ext: string;
  /** Rendered inline (images, PDF) vs. downloaded. */
  inline: boolean;
}

const TYPES: Record<string, AllowedType> = {
  png: { mime: 'image/png', ext: 'png', inline: true },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', inline: true },
  gif: { mime: 'image/gif', ext: 'gif', inline: true },
  webp: { mime: 'image/webp', ext: 'webp', inline: true },
  pdf: { mime: 'application/pdf', ext: 'pdf', inline: true },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', inline: false },
  txt: { mime: 'text/plain', ext: 'txt', inline: false },
  // Provider media (WhatsApp): accepted only via typeForProviderMedia, never from widget uploads.
  ogg: { mime: 'audio/ogg', ext: 'ogg', inline: true },
  mp3: { mime: 'audio/mpeg', ext: 'mp3', inline: true },
  m4a: { mime: 'audio/mp4', ext: 'm4a', inline: true },
  aac: { mime: 'audio/aac', ext: 'aac', inline: true },
  amr: { mime: 'audio/amr', ext: 'amr', inline: false },
  mp4: { mime: 'video/mp4', ext: 'mp4', inline: true },
  '3gp': { mime: 'video/3gpp', ext: '3gp', inline: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', inline: false },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', inline: false },
};

const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
/** ISO base media file ("ftyp" box at offset 4): mp4, m4a, 3gp. */
const isFtyp = (b: Uint8Array) => startsWith(b, [0x66, 0x74, 0x79, 0x70], 4);

/**
 * Accepts media from a trusted provider (WhatsApp) by its declared MIME type, but only
 * from an allowlist and only when the bytes carry that type's signature. Images and PDFs
 * go through the same content sniffing as visitor uploads.
 */
export function typeForProviderMedia(declaredMime: string | null, bytes: Uint8Array, fileName: string): AllowedType | null {
  const mime = (declaredMime ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime.startsWith('image/') || mime === 'application/pdf') {
    const sniffed = sniffFileType(bytes, fileName);
    return sniffed && sniffed.mime !== 'text/plain' ? sniffed : null;
  }
  switch (mime) {
    case 'audio/ogg':
    case 'audio/opus':
      return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]) ? TYPES.ogg! : null;
    case 'audio/mpeg':
      return startsWith(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) ? TYPES.mp3! : null;
    case 'audio/mp4':
      return isFtyp(bytes) ? TYPES.m4a! : null;
    case 'audio/aac':
      return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0 ? TYPES.aac! : isFtyp(bytes) ? TYPES.m4a! : null;
    case 'audio/amr':
      return startsWith(bytes, [0x23, 0x21, 0x41, 0x4d, 0x52]) ? TYPES.amr! : null;
    case 'video/mp4':
      return isFtyp(bytes) ? TYPES.mp4! : null;
    case 'video/3gpp':
      return isFtyp(bytes) ? TYPES['3gp']! : null;
    case TYPES.docx!.mime:
      return isZip(bytes) ? TYPES.docx! : null;
    case TYPES.xlsx!.mime:
      return isZip(bytes) ? TYPES.xlsx! : null;
    case TYPES.pptx!.mime:
      return isZip(bytes) ? TYPES.pptx! : null;
    case 'text/plain':
      return isProbablyText(bytes) ? TYPES.txt! : null;
    default:
      return null;
  }
}

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);

/**
 * Detects the file type from its content (magic bytes), ignoring the client-declared
 * type. Anything not on the allowlist (SVG, HTML, executables, archives…) is rejected.
 */
export function sniffFileType(bytes: Uint8Array, fileName: string): AllowedType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES.png!;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return TYPES.jpeg!;
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return TYPES.gif!;
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return TYPES.webp!;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return TYPES.pdf!;
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && /\.docx$/i.test(fileName)) return TYPES.docx!;
  if (/\.(txt|md|csv)$/i.test(fileName) && isProbablyText(bytes)) return TYPES.txt!;
  return null;
}

function isProbablyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  for (const b of sample) if (b === 0) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

export function safeFileName(name: string, ext: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base || 'file'}.${ext}`;
}

export function newObjectKey(organizationId: string, customerId: string, fileName: string): string {
  return `orgs/${organizationId}/customers/${customerId}/${randomUUID()}/${fileName}`;
}

export function customerKeyPrefix(organizationId: string, customerId: string): string {
  return `orgs/${organizationId}/customers/${customerId}/`;
}

function hmac(secret: string, purpose: string, value: string) {
  return createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('base64url');
}

/** Binds an uploaded object to the uploading customer so it can only be attached by them. */
export function signUploadReceipt(secret: string, r: { key: string; mimeType: string; size: number; customerId: string }) {
  return hmac(secret, 'upload', `${r.key}|${r.mimeType}|${r.size}|${r.customerId}`);
}

export function verifyUploadReceipt(
  secret: string,
  r: { key: string; mimeType: string; size: number; customerId: string; sig: string },
): boolean {
  return safeEqual(r.sig, signUploadReceipt(secret, r));
}

const DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;

/** Short-lived, signed download URL served by /api/files (no public bucket needed). */
export function signedFileUrl(secret: string, key: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + DOWNLOAD_TTL_SECONDS;
  const sig = hmac(secret, 'download', `${key}|${exp}`);
  return `/api/files?k=${encodeURIComponent(key)}&e=${exp}&s=${sig}`;
}

export function verifyFileSignature(secret: string, key: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < now / 1000) return false;
  return safeEqual(sig, hmac(secret, 'download', `${key}|${exp}`));
}

export function typeForMime(mime: string): AllowedType | undefined {
  return Object.values(TYPES).find((t) => t.mime === mime);
}
