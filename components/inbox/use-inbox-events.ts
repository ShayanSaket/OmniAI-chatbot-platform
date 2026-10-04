'use client';

import { useEffect, useRef, useState } from 'react';
import { createSseParser } from '@/lib/sse';

export interface InboxEvent {
  type: string;
  conversationId?: string;
  customerId?: string;
  messageId?: string;
  [key: string]: unknown;
}

/**
 * Subscribes to the organization's live inbox feed (/api/v1/inbox/events). Reconnects
 * with backoff; `onReconnect` lets the caller catch up on anything missed meanwhile.
 */
export function useInboxEvents(onEvent: (e: InboxEvent) => void, onReconnect: () => void) {
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let everConnected = false;

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch('/api/v1/inbox/events', { signal: controller.signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
          if (res.status === 401 || res.status === 403) {
            setConnected(false);
            return; // signed out or no access: don't hammer the server
          }
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          setConnected(true);
          if (everConnected) handlers.current.onReconnect();
          everConnected = true;
          attempt = 0;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          const feed = createSseParser((e) => {
            try {
              handlers.current.onEvent({ ...(JSON.parse(e.data) as InboxEvent), type: e.event || 'message' });
            } catch {
              /* ignore malformed events */
            }
          });
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            feed(value);
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        setConnected(false);
        attempt += 1;
        // The server closes streams every 5 minutes: reconnect at once the first time.
        const delay = attempt === 1 ? 250 : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        await new Promise((r) => setTimeout(r, delay));
      }
    };
    void run();
    return () => controller.abort();
  }, []);

  return connected;
}
