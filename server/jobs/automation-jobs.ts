import 'server-only';
import { prisma } from '../db';
import { buildEvent } from '../events/domain-events';
import { enqueueWebhooksForEvent } from '../modules/webhooks/delivery';

/** Webhook subscribers get conversation.inactive once a conversation is quiet for this long. */
export const WEBHOOK_INACTIVE_MINUTES = 60;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Emits conversation.inactive to webhook endpoints that subscribed to it. The event id
 * contains the last message time, so each quiet period is delivered once.
 * (Automations use their own thresholds: modules/automations/engine.ts.)
 */
export async function emitInactiveConversationWebhooks(): Promise<number> {
  const subscribed = await prisma.webhookEndpoint.findMany({
    where: { isActive: true, OR: [{ events: { has: 'conversation.inactive' } }, { events: { has: '*' } }] },
    select: { organizationId: true },
    distinct: ['organizationId'],
  });
  if (!subscribed.length) return 0;
  const cutoff = new Date(Date.now() - WEBHOOK_INACTIVE_MINUTES * 60_000);
  let sent = 0;
  for (const { organizationId } of subscribed) {
    const conversations = await prisma.conversation.findMany({
      where: { organizationId, status: { not: 'CLOSED' }, lastMessageAt: { lte: cutoff, gte: new Date(cutoff.getTime() - WINDOW_MS) } },
      select: { id: true, customerId: true, channel: true, lastMessageAt: true },
      take: 200,
    });
    for (const c of conversations) {
      const event = buildEvent({
        id: `inactive_${c.id}_${c.lastMessageAt.getTime()}`,
        type: 'conversation.inactive',
        organizationId,
        refs: { conversationId: c.id, customerId: c.customerId },
        data: { channel: c.channel, inactiveMinutes: WEBHOOK_INACTIVE_MINUTES },
      });
      sent += await enqueueWebhooksForEvent(event);
    }
  }
  return sent;
}
