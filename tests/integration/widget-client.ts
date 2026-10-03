import { NextRequest } from 'next/server';
import { expect } from 'vitest';
import { createSseParser } from '@/lib/sse';
import type { WidgetEvent } from '@/lib/widget-protocol';
import { POST as postMessage } from '@/app/api/widget/[botKey]/messages/route';
import { POST as postSession } from '@/app/api/widget/[botKey]/session/route';
import { POST as postRestart } from '@/app/api/widget/[botKey]/conversation/restart/route';

// Drives the public widget API the way the browser widget does.

export const widgetRequest = (
  path: string,
  init: { method?: string; token?: string; json?: unknown; headers?: Record<string, string> } = {},
) =>
  new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: init.method ?? 'GET',
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

export async function readEvents(res: Response): Promise<WidgetEvent[]> {
  const events: WidgetEvent[] = [];
  const parse = createSseParser((e) => events.push(JSON.parse(e.data)));
  parse(await res.text());
  return events;
}

export function widgetClient(botKey: string) {
  const params = { params: { botKey } };
  return {
    async visitor(locale = 'en-US') {
      const res = await postSession(
        widgetRequest(`/api/widget/${botKey}/session`, { method: 'POST', json: { hostOrigin: 'http://localhost:3000', locale } }),
        params,
      );
      expect(res.status).toBe(200);
      const { data } = await res.json();
      return data as { token: string; customer: { id: string } };
    },
    /** Sends a message and returns every streamed event. */
    async send(token: string, content: string) {
      const res = await postMessage(
        widgetRequest(`/api/widget/${botKey}/messages`, {
          method: 'POST',
          token,
          json: { clientMessageId: `cmid-${Math.random().toString(36).slice(2, 12)}`, content, attachments: [] },
        }),
        params,
      );
      expect(res.status).toBe(200);
      return readEvents(res);
    },
    async restart(token: string) {
      const res = await postRestart(widgetRequest(`/api/widget/${botKey}/conversation/restart`, { method: 'POST', token }), params);
      expect(res.status).toBe(200);
    },
  };
}

/** The final stored AI message of a send. */
export function finalReply(events: WidgetEvent[]) {
  const done = events.find((e): e is Extract<WidgetEvent, { type: 'assistant.done' }> => e.type === 'assistant.done');
  expect(done).toBeDefined();
  return done!.message;
}

export function streamedText(events: WidgetEvent[]) {
  return events
    .filter((e): e is Extract<WidgetEvent, { type: 'assistant.delta' }> => e.type === 'assistant.delta')
    .map((e) => e.text)
    .join('');
}
