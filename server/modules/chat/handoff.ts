import 'server-only';
import type { Conversation } from '@prisma/client';
import { isWithinBusinessHours, nextOpening, type BusinessHoursRule } from '@/lib/business-hours';
import { emitDomainEvent } from '../../events/domain-events';
import { customerDisplayName } from '@/lib/inbox';
import { channels, publish } from '../../realtime/bus';
import { notifyMembers } from '../notifications/notification-service';
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
  const contact = await db.customer.findUnique({ where: { id: conversation.customerId }, select: { id: true, name: true, email: true, phone: true } });
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

  const REASON_TEXT: Record<HandoffReason, string> = {
    customer_request: 'asked to talk to a person',
    ai_failure: 'could not be answered by the AI',
    ai_escalation: 'was escalated by the AI',
    rule: 'matched an escalation rule',
  };
  const who = contact ? customerDisplayName(contact) : 'A customer';
  await notifyMembers(conversation.organizationId, {
    ...(updated.assignedToId ? { userIds: [updated.assignedToId] } : { roles: ['OWNER', 'ADMIN', 'AGENT'] }),
    title: teamOnline ? `${who} is waiting for a team member` : `${who} needs a follow-up`,
    body: `The conversation ${REASON_TEXT[reason]} (${conversation.channel === 'WHATSAPP' ? 'WhatsApp' : 'website'}).${teamOnline ? '' : ' The team was offline, so the AI keeps helping until someone follows up.'}`,
    link: `/inbox?conversation=${conversation.id}`,
  }).catch(() => undefined);

  emitDomainEvent({
    type: 'human_handoff.requested',
    organizationId: conversation.organizationId,
    refs: { conversationId: conversation.id, customerId: conversation.customerId },
    data: { channel: conversation.channel, reason, teamOnline, ...(params.detail?.trigger ? { trigger: params.detail.trigger } : {}) },
    causedBy: params.causedBy,
  });
  return { conversation: updated, message, teamOnline, alreadyRequested: false };
}
