import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockMode = 'ok' | 'error' | 'empty' | 'slow';

export interface MockRequest {
  model: string;
  messages: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  stream: boolean;
  tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  response_format?: { type: string };
}

/** What the mock answers to one chat request. */
export type MockReply = { text: string } | { toolCalls: { name: string; args: unknown }[]; text?: string };

export interface MockOpenAI {
  url: string;
  /** Chat (non-JSON) requests: the conversational replies. */
  requests: MockRequest[];
  /** JSON-mode requests (classification, summaries). */
  jsonRequests: MockRequest[];
  /** Exceptions thrown by scripted responders (failed expectations); tests assert it is empty. */
  errors: unknown[];
  /** Sizes of audio transcription request bodies. */
  transcriptions: number[];
  /** Calls to /embeddings (one entry per request). */
  embeddingRequests: { model: string; inputs: number; dimensions: number | null }[];
  setEmbeddingMode(mode: 'ok' | 'error' | 'wrong-dims'): void;
  setTranscript(text: string): void;
  setMode(mode: MockMode, text?: string): void;
  /** Scripted chat replies; return undefined to fall back to the default text reply. */
  respond(fn: ((req: MockRequest, index: number) => MockReply | undefined) | null): void;
  /** JSON-mode replies; return undefined for the defaults (neutral classification / short summary). */
  respondJson(fn: ((req: MockRequest) => unknown) | null): void;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_CLASSIFICATION = {
  intent: 'FAQ',
  sentiment: 'neutral',
  leadTemperature: null,
  escalation: 'none',
  wantsHuman: false,
  language: 'en',
  confidence: 0.9,
};

/**
 * Deterministic stand-in for a semantic embedding model: words that mean the same thing
 * in different languages share a "concept" dimension, other words hash into the rest.
 * Enough to exercise cross-language retrieval and similarity thresholds.
 */
const CONCEPTS: RegExp[] = [
  /^(host|hosted|hosting|gehostet|server|rechenzentrum|frankfurt|datacenter|alojad)/,
  /^(data|daten|datos|données|donnees)$/,
  /^(price|prices|pricing|cost|costs|preis|preise|kosten|kostet|precio|prix|euro|€)/,
  /^(trial|test|testen|probe|prueba|essai|gratis|free|kostenlos)/,
  /^(cancel|kündig|cancelar|annuler|termin)/,
  /^(support|help|hilfe|ayuda|aide)/,
  /^(widget|chat|chatbot|bot)/,
  /^(holiday|holidays|urlaub|vacation|ferien)/,
];

export function fakeEmbedding(text: string, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}€]+/gu) ?? []) {
    const concept = CONCEPTS.findIndex((c) => c.test(word));
    if (concept >= 0) v[concept] += 3;
    else if (word.length > 3) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[16 + (h % (dims - 16))] += 0.5;
    }
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

/** Minimal OpenAI-compatible /chat/completions server that streams like the real API. */
export async function startMockOpenAI(): Promise<MockOpenAI> {
  let mode: MockMode = 'ok';
  let reply = 'Our **Growth** plan costs €399 per month.';
  let responder: ((req: MockRequest, index: number) => MockReply | undefined) | null = null;
  let jsonResponder: ((req: MockRequest) => unknown) | null = null;
  const requests: MockRequest[] = [];
  const jsonRequests: MockRequest[] = [];
  const errors: unknown[] = [];
  const transcriptions: number[] = [];
  const embeddingRequests: MockOpenAI['embeddingRequests'] = [];
  let embeddingMode: 'ok' | 'error' | 'wrong-dims' = 'ok';
  let transcript = "Do you offer a free trial?";

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url === '/v1/embeddings' && req.headers.authorization === 'Bearer test-key') {
        const parsed = JSON.parse(body) as { model: string; input: string[]; dimensions?: number };
        embeddingRequests.push({ model: parsed.model, inputs: parsed.input.length, dimensions: parsed.dimensions ?? null });
        if (embeddingMode === 'error') {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":{"message":"embedding boom"}}');
          return;
        }
        const data = parsed.input.map((text, index) => ({ index, embedding: fakeEmbedding(text, embeddingMode === 'wrong-dims' ? 512 : 1536) }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data, usage: { prompt_tokens: parsed.input.join(' ').length / 4 } }));
        return;
      }
      if (req.url === '/v1/audio/transcriptions' && req.headers.authorization === 'Bearer test-key') {
        transcriptions.push(body.length);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: transcript }));
        return;
      }
      if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401).end();
        return;
      }
      const parsed = JSON.parse(body) as MockRequest;
      const isJson = parsed.response_format?.type === 'json_object';
      (isJson ? jsonRequests : requests).push(parsed);
      if (mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":{"message":"boom"}}');
        return;
      }
      let custom: unknown;
      let scripted: MockReply | undefined;
      try {
        if (isJson) custom = jsonResponder?.(parsed);
        else scripted = responder?.(parsed, requests.length - 1);
      } catch (err) {
        errors.push(err);
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (isJson) {
        const system = parsed.messages[0]?.content ?? '';
        const value =
          custom !== undefined ? custom : system.startsWith('TASK: classify') ? DEFAULT_CLASSIFICATION : { summary: 'Customer asked about pricing.', customerFacts: {} };
        res.write(chunk({ content: typeof value === 'string' ? value : JSON.stringify(value) }));
        res.write(chunk({}, 'stop'));
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      if (scripted && 'toolCalls' in scripted) {
        if (scripted.text) res.write(chunk({ content: scripted.text }));
        scripted.toolCalls.forEach((call, index) => {
          const args = JSON.stringify(call.args);
          const id = `call_${requests.length}_${index}`;
          // Like the real API: id + name first, then the arguments in fragments.
          res.write(chunk({ tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }] }));
          for (let i = 0; i < args.length; i += 12) {
            res.write(chunk({ tool_calls: [{ index, function: { arguments: args.slice(i, i + 12) } }] }));
          }
        });
        res.write(chunk({}, 'tool_calls'));
      } else {
        const text = scripted?.text ?? reply;
        const words = mode === 'empty' ? [] : text.split(/(?<= )/);
        for (const w of words) {
          res.write(chunk({ content: w }));
          if (mode === 'slow') await new Promise((r) => setTimeout(r, 30));
        }
        res.write(chunk({}, 'stop'));
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 12 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    jsonRequests,
    errors,
    transcriptions,
    embeddingRequests,
    setEmbeddingMode(mode) {
      embeddingMode = mode;
    },
    setTranscript(text) {
      transcript = text;
    },
    setMode(next, text) {
      mode = next;
      if (text) reply = text;
    },
    respond(fn) {
      responder = fn;
    },
    respondJson(fn) {
      jsonResponder = fn;
    },
    reset() {
      mode = 'ok';
      reply = 'Our **Growth** plan costs €399 per month.';
      responder = null;
      jsonResponder = null;
      requests.length = 0;
      jsonRequests.length = 0;
      errors.length = 0;
      transcriptions.length = 0;
      embeddingRequests.length = 0;
      embeddingMode = 'ok';
      transcript = "Do you offer a free trial?";
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
