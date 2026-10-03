import 'server-only';
import { encodeSseEvent, SSE_COMMENT_PING } from '@/lib/sse';
import type { WidgetEvent } from '@/lib/widget-protocol';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export interface SseWriter {
  send(event: WidgetEvent): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Creates a streaming SSE response. `run` receives a writer whose sends become no-ops
 * once the client disconnects, so producers (e.g. an AI reply that must still be
 * stored) can keep going safely.
 */
export function sseResponse(
  signal: AbortSignal,
  /** May return a cleanup function, called once when the stream closes (any reason). */
  run: (writer: SseWriter) => Promise<void | (() => void)> | void | (() => void),
  options: { heartbeatMs?: number; maxDurationMs?: number } = {},
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];
  let cleanup: (() => void) | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    timers.forEach(clearInterval);
    try {
      cleanup?.();
    } catch {
      // ignore cleanup errors
    }
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };

  const writer: SseWriter = {
    send(event) {
      if (closed || !controllerRef) return;
      try {
        controllerRef.enqueue(encoder.encode(encodeSseEvent(event.type, event)));
      } catch {
        close();
      }
    },
    close,
    get closed() {
      return closed;
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      signal.addEventListener('abort', close);
      if (options.heartbeatMs) {
        timers.push(
          setInterval(() => {
            if (!closed) {
              try {
                controller.enqueue(encoder.encode(SSE_COMMENT_PING));
              } catch {
                close();
              }
            }
          }, options.heartbeatMs),
        );
      }
      if (options.maxDurationMs) timers.push(setInterval(close, options.maxDurationMs));
      Promise.resolve(run(writer))
        .then((fn) => {
          if (typeof fn !== 'function') return;
          if (closed) fn();
          else cleanup = fn;
        })
        .catch(() => close());
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
