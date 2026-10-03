import 'server-only';
import type { Conversation } from '@prisma/client';
import { isWithinBusinessHours, nextOpening, type BusinessHoursRule } from '@/lib/business-hours';
import { emitDomainEvent } from '../../events/domain-events';
import { channels, publish } from '../../realtime/bus';
import type { TenantDb } from '../../tenancy/tenant-db';
import { appendMessage, CONVERSATION_INCLUDE } from './conversation-service';
import { formatOpening, systemText } from './system-messages';

export type HandoffReason = 'customer_request' | 'ai_failure' | 'ai_escalation' | 'rule';


/**
 * Requests a human for a conversation.
 *  - Team online: status → WAITING_FOR_AGENT and the AI stops replying.
 *  - Team offline: the AI stays active (the customer still gets help), the request is
 *    recorded for follow-up, and the customer is told when the team is back.
 */
export async function requestHumanHandoff(params: {
  db: TenantDb;
  conversation: Conversation;
  businessHours: BusinessHoursRule[];
  timeZone: string;
  reason: HandoffReason;
  /** Extra context for the team, e.g. the escalation trigger or the AI's note. */
  detail?: Record<string, unknown>;
  /** Customer language for the notice (ISO 639-1). */
  language?: string | null;
  /** Automations that caused this handoff (event loop protection). */
  causedBy?: string[];
  now?: Date;
}) {
  const { db, conversation, businessHours, timeZone, reason } = params;
  const now = params.now ?? new Date();
  if (conversation.status === 'WAITING_FOR_AGENT' || conversation.status === 'HUMAN_ACTIVE') {
    return { conversation, message: null, teamOnline: true, alreadyRequested: true };
  }

  const teamOnline = isWithinBusinessHours(businessHours, timeZone, now);
  const opening = teamOnline ? null : nextOpening(businessHours, timeZone, now);

  const updated = await db.conversation.update({
    where: { id: conversation.id },
    data: {
      handoffRequestedAt: now,
      ...(teamOnline ? { status: 'WAITING_FOR_AGENT' as const } : {}),
      metadata: { ...((conversation.metadata as object) ?? {}), handoff: { reason, ...params.detail, requestedAt: now.toISOString(), teamOnline } },
    },
    include: CONVERSATION_INCLUDE,
  });

  const text = systemText(params.language);
  // Only ask for contact details when we have none (WhatsApp always has the number).
  const contact = await db.customer.findUnique({ where: { id: conversation.customerId }, select: { email: true, phone: true } });
  const reachable = conversation.channel === 'WHATSAPP' || Boolean(contact?.email || contact?.phone);
  const when = opening ? formatOpening(opening, timeZone, params.language) : null;
  const content = teamOnline ? text.handoffOnline : reachable ? text.handoffOfflineKnownContact(when) : text.handoffOffline(when);

  const message = await appendMessage(db, updated, {
    senderType: 'SYSTEM',
    messageType: 'SYSTEM',
    content,
    status: 'SENT',
    metadata: { event: 'handoff_requested', reason, teamOnline },
  });

  await publish(channels.inbox(conversation.organizationId), {
    type: 'handoff.requested',
    conversationId: conversation.id,
    teamOnline,
    reason,
    ...(params.detail?.trigger ? { trigger: params.detail.trigger } : {}),
  });

  emitDomainEvent({
    type: 'human_handoff.requested',
    organizationId: conversation.organizationId,
    refs: { conversationId: conversation.id, customerId: conversation.customerId },
    data: { channel: conversation.channel, reason, teamOnline, ...(params.detail?.trigger ? { trigger: params.detail.trigger } : {}) },
    causedBy: params.causedBy,
  });
  return { conversation: updated, message, teamOnline, alreadyRequested: false };
}
