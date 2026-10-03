import 'server-only';
import { deliverWhatsAppMessage } from '../channels/whatsapp/outbound';
import { MAX_EVENT_ATTEMPTS, processWebhookEvent, PROVIDER } from '../channels/whatsapp/processor';
import { prisma } from '../db';
import { logger } from '../logger';

// Recovery jobs for WhatsApp. These scan across tenants with the base client (system
// work, no user context); every action they trigger is tenant-scoped again.

/** Webhook events that are new but were never picked up (e.g. a restart) or failed and are due. */
export async function retryDueWebhookEvents(limit = 25): Promise<number> {
  const due = await prisma.inboundWebhookEvent.findMany({
    where: {
      provider: PROVIDER,
      status: { in: ['RECEIVED', 'FAILED'] },
      attempts: { lt: MAX_EVENT_ATTEMPTS },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let processed = 0;
  for (const { id } of due) {
    if ((await processWebhookEvent(id)) !== 'skipped') processed++;
  }
  return processed;
}

/** Outbound WhatsApp messages that failed with a transient error and are due for another try. */
export async function retryFailedWhatsAppDeliveries(limit = 25): Promise<number> {
  const candidates = await prisma.message.findMany({
    where: {
      channel: 'WHATSAPP',
      status: 'FAILED',
      senderType: { in: ['AI', 'AGENT', 'SYSTEM'] },
      createdAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      metadata: { path: ['delivery', 'retryable'], equals: true },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    include: { conversation: true },
  });
  const now = Date.now();
  const due = candidates
    .filter((m) => {
      const next = ((m.metadata ?? {}) as { delivery?: { nextAttemptAt?: number | null } }).delivery?.nextAttemptAt;
      return typeof next === 'number' && next <= now;
    })
    .slice(0, limit);
  for (const message of due) {
    const { conversation, ...rest } = message;
    await deliverWhatsAppMessage(conversation, rest).catch((err) =>
      logger.error('whatsapp delivery retry crashed', { messageId: message.id, err: (err as Error).message }),
    );
  }
  return due.length;
}

/** Handled webhook events are kept 30 days for troubleshooting (payloads are already cleared). */
export async function purgeOldWebhookEvents(days = 30): Promise<number> {
  const { count } = await prisma.inboundWebhookEvent.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }, status: { in: ['PROCESSED', 'IGNORED', 'FAILED'] } },
  });
  return count;
}
