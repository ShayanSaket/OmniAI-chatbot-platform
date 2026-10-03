import 'server-only';
import { logger } from '../../logger';
import type { GraphMessagePayload } from './format';

// Minimal Meta Graph API client for the WhatsApp Cloud API. Provider specifics stay in
// this file; the rest of the app sees GraphConfig in and typed results/errors out.

export interface GraphConfig {
  token: string;
  phoneNumberId: string;
  businessAccountId: string;
  /** e.g. https://graph.facebook.com */
  baseUrl: string;
  version: string;
}

export type WhatsAppErrorKind = 'window_closed' | 'auth' | 'rate_limited' | 'invalid_request' | 'undeliverable' | 'unavailable' | 'other';

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly kind: WhatsAppErrorKind,
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/** Maps Graph error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
export function classifyGraphError(status: number | undefined, code: number | undefined, message: string): WhatsAppApiError {
  if (code === 131047) return new WhatsAppApiError('The 24-hour customer service window has closed; use a template.', 'window_closed', false, status, code);
  if (code === 190 || code === 0 || code === 10 || code === 200 || status === 401) return new WhatsAppApiError(`WhatsApp access token rejected: ${message}`, 'auth', false, status, code);
  if (code === 130429 || code === 131056 || code === 4 || code === 80007 || status === 429) return new WhatsAppApiError(`WhatsApp rate limit: ${message}`, 'rate_limited', true, status, code);
  if (code === 131026 || code === 131021 || code === 131051) return new WhatsAppApiError(`Message undeliverable: ${message}`, 'undeliverable', false, status, code);
  if (code === 131000 || code === 1 || code === 2 || code === 131016 || (status !== undefined && status >= 500)) {
    return new WhatsAppApiError(`WhatsApp temporarily unavailable: ${message}`, 'unavailable', true, status, code);
  }
  if (status !== undefined && status >= 400 && status < 500) return new WhatsAppApiError(`WhatsApp rejected the request: ${message}`, 'invalid_request', false, status, code);
  return new WhatsAppApiError(message, 'other', false, status, code);
}

const TIMEOUT_MS = 15_000;
const SEND_ATTEMPTS = 3;
const backoffMs = (attempt: number) => 250 * 3 ** (attempt - 1); // 250ms, 750ms

export function createGraphClient(cfg: GraphConfig) {
  const root = `${cfg.baseUrl.replace(/\/$/, '')}/${cfg.version}`;

  async function request<T>(method: 'GET' | 'POST', path: string, body?: { json?: unknown; form?: FormData }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.token}`, ...(body?.json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body?.json !== undefined ? JSON.stringify(body.json) : body?.form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new WhatsAppApiError(`WhatsApp request failed: ${(err as Error).message}`, 'unavailable', true);
    }
    const data = (await res.json().catch(() => null)) as { error?: { message?: string; code?: number } } | null;
    if (!res.ok) throw classifyGraphError(res.status, data?.error?.code, data?.error?.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  return {
    /** Sends one message, retrying transient failures. Returns the wamid. */
    async sendMessage(payload: GraphMessagePayload): Promise<string> {
      let lastError: WhatsAppApiError | null = null;
      for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
        try {
          const res = await request<{ messages?: { id: string }[] }>('POST', `/${cfg.phoneNumberId}/messages`, { json: payload });
          const id = res.messages?.[0]?.id;
          if (!id) throw new WhatsAppApiError('WhatsApp returned no message id', 'other', false);
          return id;
        } catch (err) {
          lastError = err instanceof WhatsAppApiError ? err : new WhatsAppApiError((err as Error).message, 'other', false);
          if (!lastError.retryable || attempt === SEND_ATTEMPTS) break;
          logger.warn('whatsapp send failed; retrying', { attempt, kind: lastError.kind, code: lastError.code });
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
      throw lastError!;
    },

    /** Marks an inbound message read (blue ticks) and shows the typing indicator. */
    async markRead(wamid: string, typing = true): Promise<void> {
      await request('POST', `/${cfg.phoneNumberId}/messages`, {
        json: { messaging_product: 'whatsapp', status: 'read', message_id: wamid, ...(typing ? { typing_indicator: { type: 'text' } } : {}) },
      });
    },

    async getMediaInfo(mediaId: string) {
      return request<{ url: string; mime_type?: string; file_size?: number }>('GET', `/${encodeURIComponent(mediaId)}`);
    },

    /** Downloads media bytes (the URL requires the same bearer token). */
    async downloadMedia(url: string, maxBytes: number): Promise<Uint8Array> {
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      } catch (err) {
        throw new WhatsAppApiError(`Media download failed: ${(err as Error).message}`, 'unavailable', true);
      }
      if (!res.ok || !res.body) throw classifyGraphError(res.status, undefined, `Media download HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        await res.body.cancel();
        throw new WhatsAppApiError('Media file too large', 'invalid_request', false);
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new WhatsAppApiError('Media file too large', 'invalid_request', false);
        }
        parts.push(value);
      }
      return new Uint8Array(Buffer.concat(parts));
    },

    async uploadMedia(bytes: Uint8Array, mimeType: string, fileName: string): Promise<string> {
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', mimeType);
      form.set('file', new Blob([bytes], { type: mimeType }), fileName);
      const res = await request<{ id: string }>('POST', `/${cfg.phoneNumberId}/media`, { form });
      return res.id;
    },

    async getPhoneNumber() {
      return request<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>(
        'GET',
        `/${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      );
    },

    async listTemplates() {
      const templates: { id?: string; name: string; language: string; status: string; category: string; components?: unknown[] }[] = [];
      let path: string | null = `/${cfg.businessAccountId}/message_templates?fields=id,name,language,status,category,components&limit=100`;
      for (let page = 0; path && page < 20; page++) {
        const res: { data: typeof templates; paging?: { cursors?: { after?: string }; next?: string } } = await request('GET', path);
        templates.push(...res.data);
        const after = res.paging?.next ? res.paging.cursors?.after : undefined;
        path = after
          ? `/${cfg.businessAccountId}/message_templates?fields=id,name,language,status,category,components&limit=100&after=${encodeURIComponent(after)}`
          : null;
      }
      return templates;
    },
  };
}

export type GraphClient = ReturnType<typeof createGraphClient>;
