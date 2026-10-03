import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushBackgroundTasks } from '@/server/background';
import { invalidateBotCache } from '@/server/channels/website/widget-auth';
import { resetEnvCache } from '@/server/env';
import { AppError } from '@/server/errors';
import { resetMemoryRateLimits } from '@/server/rate-limit';
import { getObject } from '@/server/storage/s3';
import { backfillEmbeddings, recoverPendingDocuments } from '@/server/modules/knowledge/ingest';
import {
  addKnowledgeFaq,
  addKnowledgeText,
  addKnowledgeWebsite,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledge,
  reindexKnowledgeDocument,
  testKnowledgeSearch,
  updateKnowledgeContent,
  uploadKnowledgeFile,
} from '@/server/modules/knowledge/knowledge-service';
import { searchKnowledge } from '@/server/modules/knowledge/retrieval';
import type { ServiceContext } from '@/server/context';
import { makeDocx, makePdf } from '../fixtures/documents';
import { addUser, contextFor, createWorkspace, prisma, resetDatabase } from './helpers';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';
import { finalReply, widgetClient } from './widget-client';

let ai: MockOpenAI;
let site: Server;
let siteUrl: string;
let flakyFailures = 0;
let admin: ServiceContext;
let organizationId: string;

const file = (bytes: Uint8Array, name: string, type = 'application/octet-stream') => new File([bytes], name, { type });

const PAGES: Record<string, { status?: number; body: string; type?: string; location?: string }> = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\n' },
  '/': {
    body: `<!doctype html><html lang="en"><head><title>Acme Help Center</title></head><body>
      <nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/old-contact">Contact</a> <a href="/private">Internal</a> <a href="https://elsewhere.example/x">Partner</a> MENU-NAVIGATION</nav>
      <main><article><h1>Welcome to Acme</h1><p>Acme builds chat software for small businesses across Europe. Our support team answers every request within one business day, and our documentation covers installation, configuration and billing questions in detail.</p>
      <h2>Hosting</h2><p>Customer data is hosted in Frankfurt, Germany, in an ISO 27001 certified data center operated by our infrastructure partner.</p></article></main>
      <footer>FOOTER-COPYRIGHT Acme 2026</footer></body></html>`,
  },
  '/pricing': { body: '<html><head><title>Pricing</title></head><body><main><h1>Pricing</h1><p>The Pro plan costs 49 euro per month and includes unlimited conversations and priority support for all team members.</p></main></body></html>' },
  '/old-contact': { status: 301, body: '', location: '/contact' },
  '/contact': { body: '<html><head><title>Contact</title></head><body><main><h1>Contact us</h1><p>Write to hello@acme.example or call our office in Berlin during business hours, Monday to Friday.</p></main></body></html>' },
  '/private': { body: '<html><body><main><p>Secret internal page that must never be imported into the knowledge base.</p></main></body></html>' },
  '/empty': { body: '<html><body><nav>only navigation</nav></body></html>' },
};

beforeAll(async () => {
  ai = await startMockOpenAI();
  site = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    // /flaky fails with 503 until flakyFailures reaches 0.
    if (path === '/flaky' && flakyFailures > 0) {
      flakyFailures--;
      return res.writeHead(503).end('busy');
    }
    const page = path === '/flaky' ? PAGES['/pricing'] : PAGES[path];
    if (!page) return res.writeHead(404).end('not found');
    res.writeHead(page.status ?? 200, { 'Content-Type': page.type ?? 'text/html; charset=utf-8', ...(page.location ? { Location: page.location } : {}) });
    res.end(page.body);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await ai.close();
  await new Promise<void>((r) => site.close(() => r()));
});
afterEach(() => expect(ai.errors).toEqual([]));

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  resetMemoryRateLimits();
  invalidateBotCache();
  ai.reset();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = ai.url;
  resetEnvCache();
  const ws = await createWorkspace('Knowledge Co');
  organizationId = ws.organization.id;
  admin = contextFor(organizationId, (await addUser(organizationId, 'ADMIN')).user.id, 'ADMIN');
});

describe('file sources', () => {
  it('extracts a PDF per page, embeds the chunks and keeps the original file', async () => {
    const pdf = makePdf([['Acme Handbook', 'Installation takes about five minutes.'], ['Hosting', 'Customer data is hosted in Frankfurt, Germany.']], 'Acme Handbook');
    const doc = await uploadKnowledgeFile(admin, file(pdf, 'handbook-v2.pdf'));
    expect(doc).toMatchObject({ status: 'PENDING', sourceType: 'PDF', title: 'handbook v2' });
    await flushBackgroundTasks();

    const detail = await getKnowledgeDocument(admin, doc.id);
    expect(detail).toMatchObject({ status: 'READY', title: 'Acme Handbook', semantic: true, pageCount: 2 });
    expect(detail.chunks.map((c) => [c.pageNumber, c.embedded])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(detail.chunks[1]!.content).toContain('hosted in Frankfurt');
    // Passages carry the real title found in the PDF, not the placeholder from the file name.
    expect(detail.chunks.every((c) => c.location === 'Acme Handbook')).toBe(true);
    expect(detail.downloadUrl).toMatch(/^\/api\/files\?k=/);
    expect(ai.embeddingRequests[0]).toMatchObject({ model: 'text-embedding-3-small', dimensions: 1536, inputs: 2 });
    expect(await prisma.usageRecord.count({ where: { organizationId, kind: 'EMBEDDING' } })).toBe(1);
  });

  it('keeps Word headings as chunk locations', async () => {
    const docx = await makeDocx(['# Setup guide', 'Paste the embed code before the closing body tag.', '## Troubleshooting', 'If the widget does not appear, clear the browser cache.']);
    const doc = await uploadKnowledgeFile(admin, file(docx, 'setup.docx'));
    await flushBackgroundTasks();
    const detail = await getKnowledgeDocument(admin, doc.id);
    expect(detail.status).toBe('READY');
    expect(detail.title).toBe('Setup guide');
    expect(detail.chunks.map((c) => c.location)).toContain('Setup guide › Troubleshooting');
  });

  it('accepts Markdown and text, rejects other types and duplicates', async () => {
    const md = new TextEncoder().encode('# Returns\n\nItems can be returned within 30 days of delivery.');
    const doc = await uploadKnowledgeFile(admin, file(md, 'returns.md'));
    expect(doc.sourceType).toBe('MARKDOWN');
    await flushBackgroundTasks();
    expect((await getKnowledgeDocument(admin, doc.id)).status).toBe('READY');

    await expect(uploadKnowledgeFile(admin, file(md, 'returns-copy.md'))).rejects.toThrow(/already in the knowledge base/);
    await expect(uploadKnowledgeFile(admin, file(new TextEncoder().encode('<html><script>x</script></html>'), 'page.html'))).rejects.toThrow(/Upload a PDF/);
    await expect(uploadKnowledgeFile(admin, file(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'tool.exe'))).rejects.toThrow(/Upload a PDF/);
  });

  it('fails a broken PDF with a helpful message', async () => {
    const broken = new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf');
    const doc = await uploadKnowledgeFile(admin, file(broken, 'broken.pdf'));
    await flushBackgroundTasks();
    const detail = await getKnowledgeDocument(admin, doc.id);
    expect(detail.status).toBe('FAILED');
    expect(detail.error).toMatch(/could not be read|no extractable text/);
  });

  it('deletes chunks and the stored file', async () => {
    const doc = await uploadKnowledgeFile(admin, file(makePdf([['Some content for deletion test.']]), 'delete-me.pdf'));
    await flushBackgroundTasks();
    const stored = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await deleteKnowledgeDocument(admin, doc.id);
    expect(await prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBe(0);
    await expect(getObject(stored.storageKey!)).rejects.toThrow();
  });
});

describe('website sources', () => {
  it('imports the main content and same-site links, honoring robots.txt and redirects', async () => {
    const start = await addKnowledgeWebsite(admin, { url: `${siteUrl}/`, crawl: true, maxPages: 10 });
    await flushBackgroundTasks();
    const { documents } = await listKnowledge(admin);
    const urls = documents.map((d) => d.sourceUrl).sort();
    expect(urls).toEqual([`${siteUrl}/`, `${siteUrl}/contact`, `${siteUrl}/pricing`].sort());
    expect(documents.every((d) => d.status === 'READY')).toBe(true);

    const home = await getKnowledgeDocument(admin, start.id);
    expect(home.title).toBe('Acme Help Center');
    const text = home.chunks.map((c) => c.content).join('\n');
    expect(text).toContain('hosted in Frankfurt');
    expect(text).not.toContain('MENU-NAVIGATION');
    expect(text).not.toContain('FOOTER-COPYRIGHT');
    expect(home.chunks.some((c) => c.location?.includes('Hosting'))).toBe(true);

    await expect(addKnowledgeWebsite(admin, { url: `${siteUrl}/`, crawl: false, maxPages: 1 })).rejects.toThrow(/already in the knowledge base/);
  });

  it('reports pages without readable text', async () => {
    const doc = await addKnowledgeWebsite(admin, { url: `${siteUrl}/empty`, crawl: false, maxPages: 1 });
    await flushBackgroundTasks();
    expect(await getKnowledgeDocument(admin, doc.id)).toMatchObject({ status: 'FAILED', error: 'No readable text was found on the page.' });
  });

  it('retries pages that are temporarily unavailable', async () => {
    flakyFailures = 1;
    const doc = await addKnowledgeWebsite(admin, { url: `${siteUrl}/flaky`, crawl: false, maxPages: 1 });
    await flushBackgroundTasks();
    const pending = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(pending.status).toBe('PENDING'); // queued for another attempt, not failed
    await prisma.$executeRaw`UPDATE "KnowledgeDocument" SET "updatedAt" = now() - interval '1 minute' WHERE "id" = ${doc.id}`;
    expect(await recoverPendingDocuments()).toBe(1);
    expect((await getKnowledgeDocument(admin, doc.id)).status).toBe('READY');
  });

  it('refuses pages blocked by robots.txt', async () => {
    const doc = await addKnowledgeWebsite(admin, { url: `${siteUrl}/private`, crawl: false, maxPages: 1 });
    await flushBackgroundTasks();
    expect((await getKnowledgeDocument(admin, doc.id)).error).toMatch(/robots\.txt/);
  });
});

describe('FAQ and text sources', () => {
  it('stores one chunk per question and re-processes edits', async () => {
    const doc = await addKnowledgeFaq(admin, {
      title: 'Billing FAQ',
      entries: [
        { question: 'Can I cancel anytime?', answer: 'Yes, monthly plans can be cancelled at the end of any billing month.' },
        { question: 'Do you offer a free trial?', answer: 'Yes, 14 days without a credit card.' },
      ],
    });
    await flushBackgroundTasks();
    let detail = await getKnowledgeDocument(admin, doc.id);
    expect(detail.chunks.map((c) => c.content)).toEqual([
      'Q: Can I cancel anytime?\nA: Yes, monthly plans can be cancelled at the end of any billing month.',
      'Q: Do you offer a free trial?\nA: Yes, 14 days without a credit card.',
    ]);
    expect(detail.faq).toHaveLength(2);

    await updateKnowledgeContent(admin, doc.id, { title: 'Billing FAQ', entries: [{ question: 'Is VAT included?', answer: 'Prices are net, excluding 19% VAT.' }] });
    await flushBackgroundTasks();
    detail = await getKnowledgeDocument(admin, doc.id);
    expect(detail.chunks).toHaveLength(1);
    expect(detail.chunks[0]!.content).toContain('VAT');
  });

  it('accepts manual text and refuses edits to file sources', async () => {
    const doc = await addKnowledgeText(admin, { title: 'Shipping policy', content: 'We ship within 2 business days. Express delivery is available in Germany and Austria.' });
    await flushBackgroundTasks();
    expect((await getKnowledgeDocument(admin, doc.id)).status).toBe('READY');
    const pdf = await uploadKnowledgeFile(admin, file(makePdf([['Some handbook page text.']]), 'h.pdf'));
    await expect(updateKnowledgeContent(admin, pdf.id, { title: 'x', content: 'some new content for the pdf' })).rejects.toThrow(/Only FAQ and text/);
  });
});

describe('retrieval', () => {
  async function seedDocs() {
    await addKnowledgeText(admin, { title: 'Data protection', content: 'Customer data is hosted in Frankfurt, Germany, in a certified data center.' });
    await addKnowledgeText(admin, { title: 'Holiday schedule', content: 'The office is closed for holidays between Christmas and New Year.' });
    await flushBackgroundTasks();
  }

  it('finds answers across languages semantically and returns nothing for unrelated questions', async () => {
    await seedDocs();
    const german = await searchKnowledge(organizationId, 'Wo werden meine Daten gehostet?');
    expect(german[0]).toMatchObject({ title: 'Data protection', matchedBy: ['semantic'] });
    expect(german.every((r) => r.title !== 'Holiday schedule')).toBe(true);
    expect(german[0]!.similarity).toBeGreaterThan(0.5);

    // Exact keyword + semantic agree → both signals.
    const english = await searchKnowledge(organizationId, 'Where is customer data hosted?');
    expect(english[0]).toMatchObject({ title: 'Data protection', matchedBy: ['semantic', 'keyword'] });

    expect(await searchKnowledge(organizationId, 'Do you sell bicycles?')).toEqual([]);
  });

  it('never returns another organization’s knowledge', async () => {
    await seedDocs();
    const other = await createWorkspace('Other Co');
    expect(await searchKnowledge(other.organization.id, 'Where is customer data hosted?')).toEqual([]);
  });

  it('reuses cached embeddings instead of paying twice', async () => {
    await seedDocs();
    const doc = (await listKnowledge(admin)).documents.find((d) => d.title === 'Data protection')!;
    const before = ai.embeddingRequests.length;
    await reindexKnowledgeDocument(admin, doc.id);
    await flushBackgroundTasks();
    expect(ai.embeddingRequests.length).toBe(before);
    expect((await getKnowledgeDocument(admin, doc.id)).semantic).toBe(true);
  });

  it('falls back to keyword search without a provider, then backfills embeddings', async () => {
    delete process.env.OPENAI_API_KEY;
    resetEnvCache();
    await seedDocs();
    let docs = (await listKnowledge(admin)).documents;
    expect(docs.every((d) => d.status === 'READY' && !d.semantic)).toBe(true);
    expect(docs[0]!.embeddingError).toBe('No embedding provider configured');
    expect((await searchKnowledge(organizationId, 'customer data hosted'))[0]).toMatchObject({ title: 'Data protection', matchedBy: ['keyword'] });

    process.env.OPENAI_API_KEY = 'test-key';
    resetEnvCache();
    expect(await backfillEmbeddings()).toBe(2);
    docs = (await listKnowledge(admin)).documents;
    expect(docs.every((d) => d.semantic)).toBe(true);
  });

  it('stays keyword-searchable when the embedding provider fails or returns the wrong size', async () => {
    ai.setEmbeddingMode('error');
    await seedDocs();
    const docs = (await listKnowledge(admin)).documents;
    expect(docs.every((d) => d.status === 'READY' && !d.semantic)).toBe(true);
    expect(docs[0]!.embeddingError).toMatch(/500/);

    ai.setEmbeddingMode('wrong-dims');
    const doc = await addKnowledgeText(admin, { title: 'Dims', content: 'Some text that will get the wrong embedding size back.' });
    await flushBackgroundTasks();
    expect((await getKnowledgeDocument(admin, doc.id)).embeddingError).toMatch(/1536 are required/);
  });

  it('feeds cross-language matches with page numbers to the assistant', async () => {
    await uploadKnowledgeFile(admin, file(makePdf([['Introduction to the product.'], ['Hosting', 'Customer data is hosted in Frankfurt, Germany.']]), 'security.pdf'));
    await flushBackgroundTasks();
    ai.respond((req) => {
      const system = req.messages[0]!.content ?? '';
      expect(system).toMatch(/\[1\] .*page 2\)/);
      expect(system).toContain('hosted in Frankfurt');
      return { text: 'Ihre Daten liegen in Frankfurt [1].' };
    });
    const bot = await prisma.botConfiguration.findFirstOrThrow({ where: { organizationId } });
    const client = widgetClient(bot.publicKey);
    const visitor = await client.visitor('de-DE');
    const reply = finalReply(await client.send(visitor.token, 'Wo werden meine Daten gehostet?'));
    expect(reply.content).toBe('Ihre Daten liegen in Frankfurt.');
    expect(reply.sources).toHaveLength(1);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: reply.id } });
    expect(stored.metadata).toMatchObject({ retrieval: { hits: 1 } });
  });

  it('shows admins what would be retrieved', async () => {
    await seedDocs();
    const result = await testKnowledgeSearch(admin, 'data hosting');
    expect(result.semanticEnabled).toBe(true);
    expect(result.results[0]).toMatchObject({ title: 'Data protection' });
  });
});

describe('robustness and permissions', () => {
  it('recovers documents stuck in processing', async () => {
    const doc = await addKnowledgeText(admin, { title: 'Stuck', content: 'This document was being processed when the server restarted.' });
    await flushBackgroundTasks();
    await prisma.$executeRaw`UPDATE "KnowledgeDocument" SET "status" = 'PROCESSING', "updatedAt" = now() - interval '20 minutes' WHERE "id" = ${doc.id}`;
    expect(await recoverPendingDocuments()).toBe(1);
    expect((await getKnowledgeDocument(admin, doc.id)).status).toBe('READY');
  });

  it('is limited to admins and owners, and to the own workspace', async () => {
    const agent = contextFor(organizationId, (await addUser(organizationId, 'AGENT')).user.id, 'AGENT');
    await expect(listKnowledge(agent)).rejects.toBeInstanceOf(AppError);
    await expect(addKnowledgeText(agent, { title: 'x', content: 'agents cannot add knowledge sources' })).rejects.toThrow(/permission/);

    const doc = await addKnowledgeText(admin, { title: 'Private', content: 'Only visible inside this workspace, nowhere else.' });
    const other = await createWorkspace('Other');
    const otherOwner = contextFor(other.organization.id, other.owner.id, 'OWNER');
    await expect(getKnowledgeDocument(otherOwner, doc.id)).rejects.toThrow(/not found/);
    await expect(deleteKnowledgeDocument(otherOwner, doc.id)).rejects.toThrow(/not found/);
  });

  it('rejects private network URLs in production', async () => {
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    resetEnvCache();
    try {
      await expect(addKnowledgeWebsite(admin, { url: 'http://169.254.169.254/latest/meta-data', crawl: false, maxPages: 1 })).rejects.toThrow(/https/);
      await expect(addKnowledgeWebsite(admin, { url: 'https://127.0.0.1/admin', crawl: false, maxPages: 1 })).rejects.toThrow(/public address/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = previous!;
      resetEnvCache();
    }
  });
});
