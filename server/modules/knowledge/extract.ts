import 'server-only';
import type { PageText } from './clean';
import { htmlFragmentToText } from './html';

// Text extraction per source format. Returns pages for paginated formats (PDF) so chunks
// keep their page numbers.

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface Extracted {
  title: string | null;
  /** Paginated text (PDF); otherwise a single page 0. */
  pages: PageText[];
  paginated: boolean;
}

const MAX_PDF_PAGES = 1000;

export async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const message = (err as Error).message ?? '';
    throw new ExtractionError(/password/i.test(message) ? 'The PDF is password-protected.' : 'The PDF could not be read.');
  }
  if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractionError(`The PDF has more than ${MAX_PDF_PAGES} pages.`);
  const { text } = await extractText(pdf, { mergePages: false });
  let title: string | null = null;
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info as { Title?: string } | undefined;
    title = info?.Title?.trim() || null;
  } catch {
    /* metadata is optional */
  }
  const pages = (Array.isArray(text) ? text : [text]).map((t, i) => ({ page: i + 1, text: t }));
  if (!pages.some((p) => p.text.trim())) {
    throw new ExtractionError('The PDF contains no extractable text (it may be a scanned image).');
  }
  return { title, pages, paginated: true };
}

export async function extractDocx(bytes: Uint8Array): Promise<Extracted> {
  const mammoth = await import('mammoth');
  let html: string;
  try {
    // Via HTML so headings, lists and tables keep their structure.
    html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })).value;
  } catch {
    throw new ExtractionError('The Word document could not be read.');
  }
  const text = htmlFragmentToText(html);
  if (!text.trim()) throw new ExtractionError('The Word document contains no text.');
  const firstHeading = /^#{1,2} (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  return { title: firstHeading, pages: [{ page: 0, text }], paginated: false };
}

export function extractPlainText(bytes: Uint8Array): Extracted {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    // Legacy encodings (Windows-1252) are common for .txt exports.
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  if (!text.trim()) throw new ExtractionError('The file is empty.');
  const firstHeading = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  return { title: firstHeading, pages: [{ page: 0, text }], paginated: false };
}

export async function extractFile(bytes: Uint8Array, mimeType: string): Promise<Extracted> {
  switch (mimeType) {
    case 'application/pdf':
      return extractPdf(bytes);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(bytes);
    case 'text/plain':
    case 'text/markdown':
      return extractPlainText(bytes);
    default:
      throw new ExtractionError(`Unsupported file type: ${mimeType}`);
  }
}
