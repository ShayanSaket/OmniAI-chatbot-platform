import 'server-only';
import { runExclusive } from '../locks';
import { logger } from '../logger';
import { scanInactiveConversations } from '../modules/automations/engine';
import { backfillEmbeddings, recoverPendingDocuments } from '../modules/knowledge/ingest';
import { retryDueWebhookDeliveries } from '../modules/webhooks/delivery';
import { emitInactiveConversationWebhooks } from './automation-jobs';
import { purgeOldWebhookEvents, retryDueWebhookEvents, retryFailedWhatsAppDeliveries } from './whatsapp-jobs';

// In-process job scheduler, started once per server process (instrumentation.ts).
// Each job holds a short Redis lock, so with several instances only one runs a job at a
// time; without Redis every instance runs them (safe: events are claimed with leases and
// deliveries are idempotent on the stored wamid).

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

const JOBS: Job[] = [
  { name: 'whatsapp-webhook-retry', everyMs: 15_000, run: () => retryDueWebhookEvents() },
  { name: 'whatsapp-delivery-retry', everyMs: 30_000, run: () => retryFailedWhatsAppDeliveries() },
  { name: 'webhook-event-purge', everyMs: 6 * 60 * 60 * 1000, run: () => purgeOldWebhookEvents() },
  { name: 'knowledge-recover', everyMs: 30_000, run: () => recoverPendingDocuments() },
  { name: 'knowledge-embedding-backfill', everyMs: 60_000, run: () => backfillEmbeddings() },
  { name: 'webhook-delivery-retry', everyMs: 15_000, run: () => retryDueWebhookDeliveries() },
  { name: 'automation-inactivity', everyMs: 60_000, run: () => scanInactiveConversations() },
  { name: 'webhook-inactivity', everyMs: 60_000, run: () => emitInactiveConversationWebhooks() },
];

const state = globalThis as unknown as { __omniaiScheduler?: { timers: NodeJS.Timeout[] } };

export function startScheduler() {
  if (state.__omniaiScheduler) return;
  const running = new Set<string>();
  const timers = JOBS.map((job) =>
    setInterval(() => {
      if (running.has(job.name)) return;
      running.add(job.name);
      runExclusive(`job:${job.name}`, Math.max(job.everyMs, 60_000), job.run)
        .catch((err) => logger.error('scheduled job failed', { job: job.name, err: (err as Error).message }))
        .finally(() => running.delete(job.name));
    }, job.everyMs),
  );
  timers.forEach((t) => t.unref?.());
  state.__omniaiScheduler = { timers };
  logger.info('job scheduler started', { jobs: JOBS.map((j) => j.name) });
}

export function stopScheduler() {
  state.__omniaiScheduler?.timers.forEach(clearInterval);
  delete state.__omniaiScheduler;
}
