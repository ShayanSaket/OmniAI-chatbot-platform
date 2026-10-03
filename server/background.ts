import 'server-only';
import { logger } from './logger';

// Fire-and-forget work that should not delay a response (summaries, memory updates).
// The app runs as a long-lived Node server, so promises outlive the request. Failures
// are logged, never thrown. Tests call flushBackgroundTasks() to wait for completion.

const pending = new Set<Promise<unknown>>();

export function runInBackground(name: string, task: () => Promise<unknown>, fields: Record<string, unknown> = {}) {
  const promise = Promise.resolve()
    .then(task)
    .catch((err) => logger.error('background task failed', { task: name, ...fields, err: (err as Error).message }))
    .finally(() => pending.delete(promise));
  pending.add(promise);
}

export async function flushBackgroundTasks() {
  while (pending.size) await Promise.all(Array.from(pending));
}
