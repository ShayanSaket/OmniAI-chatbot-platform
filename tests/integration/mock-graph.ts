import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock Meta Graph API (WhatsApp Cloud API) for integration tests.

export interface GraphRequest {
  method: string;
  path: string;
  auth: string | undefined;
  json: Record<string, unknown> | null;
  raw: string;
}

export interface MockGraph {
  url: string;
  requests: GraphRequest[];
  /** Outbound message sends (excluding read receipts). */
  sends(): Record<string, unknown>[];
  readReceipts(): Record<string, unknown>[];
  addMedia(id: string, bytes: Uint8Array, mimeType: string): void;
  /** The next n message sends fail with this HTTP status / Graph error code. */
  failSends(n: number, status: number, code: number): void;
  setTemplates(templates: unknown[]): void;
  acceptTokens(tokens: string[]): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startMockGraph(version = 'v21.0'): Promise<MockGraph> {
  const requests: GraphRequest[] = [];
  const media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  let failures: { remaining: number; status: number; code: number } = { remaining: 0, status: 500, code: 1 };
  let templates: unknown[] = [];
  let tokens = new Set(['wa-env-token']);
  let counter = 0;
  let base = '';

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url!, 'http://x');
      let json: Record<string, unknown> | null = null;
      if ((req.headers['content-type'] ?? '').includes('application/json')) json = JSON.parse(raw || '{}');
      requests.push({ method: req.method!, path: url.pathname + url.search, auth: req.headers.authorization, json, raw });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!tokens.has(token)) return send(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });

      // Media download (lookaside URL).
      const file = /^\/media-file\/(.+)$/.exec(url.pathname);
      if (file) {
        const m = media.get(decodeURIComponent(file[1]!));
        if (!m) return send(404, { error: { message: 'not found' } });
        res.writeHead(200, { 'Content-Type': m.mimeType, 'Content-Length': String(m.bytes.byteLength) });
        return res.end(Buffer.from(m.bytes));
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== version) return send(404, { error: { message: 'bad version' } });
      const [, id, edge] = parts;

      if (req.method === 'POST' && edge === 'messages') {
        if (json?.status === 'read') return send(200, { success: true });
        if (failures.remaining > 0) {
          failures.remaining--;
          return send(failures.status, { error: { message: 'mock failure', code: failures.code } });
        }
        return send(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.out.${++counter}` }] });
      }
      if (req.method === 'POST' && edge === 'media') return send(200, { id: `media-up-${++counter}` });
      if (req.method === 'GET' && edge === 'message_templates') return send(200, { data: templates, paging: {} });
      if (req.method === 'GET' && !edge && id && media.has(id)) {
        const m = media.get(id)!;
        return send(200, { url: `${base}/media-file/${encodeURIComponent(id)}`, mime_type: m.mimeType, file_size: m.bytes.byteLength });
      }
      if (req.method === 'GET' && !edge) {
        return send(200, { id, display_phone_number: '+49 30 1234 5672', verified_name: 'NovaTech GmbH', quality_rating: 'GREEN' });
      }
      return send(404, { error: { message: 'unknown route' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const sends = () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages') && r.json && r.json.status !== 'read').map((r) => r.json!);
  return {
    url: base,
    requests,
    sends,
    readReceipts: () => requests.filter((r) => r.json?.status === 'read').map((r) => r.json!),
    addMedia: (id, bytes, mimeType) => media.set(id, { bytes, mimeType }),
    failSends: (n, status, code) => {
      failures = { remaining: n, status, code };
    },
    setTemplates: (t) => {
      templates = t;
    },
    acceptTokens: (t) => {
      tokens = new Set(t);
    },
    reset() {
      requests.length = 0;
      media.clear();
      failures = { remaining: 0, status: 500, code: 1 };
      templates = [];
      tokens = new Set(['wa-env-token']);
      counter = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
