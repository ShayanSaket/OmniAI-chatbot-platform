import 'server-only';

// Structured JSON logger. Keeps the surface tiny so it can be swapped for pino or an
// OpenTelemetry log exporter without touching call sites.

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|signature/i;
const MAX_DEPTH = 5;

export type LogFields = Record<string, unknown>;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function threshold(): number {
  const configured = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
  return LEVELS[configured] ?? LEVELS.info;
}

function write(level: Level, msg: string, fields: LogFields) {
  if (LEVELS[level] < threshold()) return;
  const entry = { level, time: new Date().toISOString(), msg, ...(redact(fields) as LogFields) };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function create(base: LogFields): Logger {
  return {
    debug: (msg, f = {}) => write('debug', msg, { ...base, ...f }),
    info: (msg, f = {}) => write('info', msg, { ...base, ...f }),
    warn: (msg, f = {}) => write('warn', msg, { ...base, ...f }),
    error: (msg, f = {}) => write('error', msg, { ...base, ...f }),
    child: (f) => create({ ...base, ...f }),
  };
}

export const logger = create({ service: 'omniai' });
