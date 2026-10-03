// Server-Sent Events encoding (server) and incremental parsing (browser, over fetch streams).

export function encodeSseEvent(event: string, data: unknown, id?: string): string {
  const payload = JSON.stringify(data)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `${id ? `id: ${id}\n` : ''}event: ${event}\n${payload}\n\n`;
}

export const SSE_COMMENT_PING = ': ping\n\n';

export interface ParsedSseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental SSE parser: feed it decoded text chunks, it emits complete events.
 * Handles events split across chunks and CRLF line endings.
 */
export function createSseParser(onEvent: (e: ParsedSseEvent) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
      if (data.length) onEvent({ event, data: data.join('\n'), id });
    }
  };
}
