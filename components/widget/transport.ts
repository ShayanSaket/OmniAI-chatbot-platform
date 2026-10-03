import { createSseParser } from '@/lib/sse';
import type {
  UploadReceipt,
  WidgetConfig,
  WidgetConversation,
  WidgetEvent,
  WidgetMessage,
  WidgetSession,
} from '@/lib/widget-protocol';

export class WidgetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<WidgetApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new WidgetApiError(res.status, body?.error?.code ?? 'INTERNAL', body?.error?.message ?? 'Request failed');
}

/** Reads an SSE response body and dispatches parsed widget events. */
async function consumeSse(res: Response, onEvent: (e: WidgetEvent) => void, signal?: AbortSignal) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const parse = createSseParser(({ data }) => {
    try {
      onEvent(JSON.parse(data) as WidgetEvent);
    } catch {
      // ignore malformed events
    }
  });
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      parse(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Same-origin client for the public widget API (the widget runs on our origin, inside an iframe). */
export class WidgetTransport {
  private token: string | null = null;

  constructor(private readonly botKey: string) {}

  private url(path: string) {
    return `/api/widget/${encodeURIComponent(this.botKey)}${path}`;
  }

  private headers(json = true): HeadersInit {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  setToken(token: string | null) {
    this.token = token;
  }

  async startSession(input: { token: string | null; hostOrigin: string | null; pageUrl: string | null; locale: string }) {
    const res = await fetch(this.url('/session'), { method: 'POST', headers: this.headers(), body: JSON.stringify(input) });
    if (!res.ok) throw await readError(res);
    const { data } = (await res.json()) as { data: WidgetSession & { config: WidgetConfig } };
    this.token = data.token;
    return data;
  }

  /** Sends a message; the response streams the stored message and the AI reply. */
  async sendMessage(
    body: { clientMessageId: string; content: string; attachments: UploadReceipt[]; pageUrl?: string },
    onEvent: (e: WidgetEvent) => void,
  ) {
    const res = await fetch(this.url('/messages'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw await readError(res);
    await consumeSse(res, onEvent);
  }

  async messagesSince(afterId: string | null) {
    const res = await fetch(this.url(`/messages${afterId ? `?after=${encodeURIComponent(afterId)}` : ''}`), {
      headers: this.headers(false),
      cache: 'no-store',
    });
    if (!res.ok) throw await readError(res);
    const { data } = (await res.json()) as { data: { conversation: WidgetConversation | null; messages: WidgetMessage[] } };
    return data;
  }

  /** Long-lived events stream; resolves when the server closes it. */
  async events(onEvent: (e: WidgetEvent) => void, signal: AbortSignal) {
    const res = await fetch(this.url('/events'), { headers: this.headers(false), signal, cache: 'no-store' });
    if (!res.ok) throw await readError(res);
    await consumeSse(res, onEvent, signal);
  }

  async restart() {
    const res = await fetch(this.url('/conversation/restart'), { method: 'POST', headers: this.headers() });
    if (!res.ok) throw await readError(res);
  }

  async handoff() {
    const res = await fetch(this.url('/handoff'), { method: 'POST', headers: this.headers() });
    if (!res.ok) throw await readError(res);
    const { data } = (await res.json()) as { data: { conversation: WidgetConversation; message: WidgetMessage | null } };
    return data;
  }

  async upload(file: File): Promise<UploadReceipt> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(this.url('/uploads'), { method: 'POST', headers: this.headers(false), body: form });
    if (!res.ok) throw await readError(res);
    const { data } = (await res.json()) as { data: UploadReceipt };
    return data;
  }
}
