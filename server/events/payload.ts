import 'server-only';
import { env } from '../env';
import { tenantDb } from '../tenancy/tenant-db';
import type { DomainEvent } from './domain-events';

// The public webhook payload (versioned contract):
//
// {
//   "id": "evt_…", "type": "lead.created", "apiVersion": "2026-10-01",
//   "createdAt": "…", "organizationId": "…",
//   "data": { "conversation": {…}, "customer": {…}, "message": {…}, "lead": {…}, … }
// }
//
// Only the entities an event refers to are included, with a fixed set of fields.

export const WEBHOOK_API_VERSION = '2026-10-01';

const ref = (prefix: string, id: string) => `${prefix}-${id.slice(-6).toUpperCase()}`;

export async function buildEventPayload(event: DomainEvent) {
  const db = tenantDb(event.organizationId);
  const { refs } = event;
  const appUrl = env().APP_URL.replace(/\/$/, '');
  const [conversation, customer, message, lead, ticket, appointment] = await Promise.all([
    refs.conversationId
      ? db.conversation.findUnique({
          where: { id: refs.conversationId },
          select: { id: true, channel: true, status: true, intent: true, leadTemperature: true, createdAt: true, lastMessageAt: true, assignedTo: { select: { name: true, email: true } } },
        })
      : null,
    refs.customerId
      ? db.customer.findUnique({ where: { id: refs.customerId }, select: { id: true, name: true, email: true, phone: true, company: true, language: true, createdAt: true } })
      : null,
    refs.messageId
      ? db.message.findUnique({ where: { id: refs.messageId }, select: { id: true, content: true, messageType: true, channel: true, senderType: true, createdAt: true, attachments: true } })
      : null,
    refs.leadId
      ? db.lead.findUnique({
          where: { id: refs.leadId },
          select: { id: true, status: true, temperature: true, name: true, email: true, phone: true, company: true, requestedService: true, message: true, preferredContact: true, source: true, intent: true, createdAt: true },
        })
      : null,
    refs.ticketId ? db.ticket.findUnique({ where: { id: refs.ticketId }, select: { id: true, subject: true, description: true, priority: true, status: true, createdAt: true } }) : null,
    refs.appointmentId
      ? db.appointment.findUnique({ where: { id: refs.appointmentId }, select: { id: true, topic: true, preferredTime: true, status: true, email: true, phone: true, createdAt: true } })
      : null,
  ]);

  return {
    id: event.id,
    type: event.type,
    apiVersion: WEBHOOK_API_VERSION,
    createdAt: event.occurredAt,
    organizationId: event.organizationId,
    data: {
      ...(conversation
        ? {
            conversation: {
              id: conversation.id,
              channel: conversation.channel,
              status: conversation.status,
              intent: conversation.intent,
              leadTemperature: conversation.leadTemperature,
              assignedTo: conversation.assignedTo,
              createdAt: conversation.createdAt.toISOString(),
              lastMessageAt: conversation.lastMessageAt.toISOString(),
              url: `${appUrl}/inbox?conversation=${conversation.id}`,
            },
          }
        : {}),
      ...(customer ? { customer: { ...customer, createdAt: customer.createdAt.toISOString() } } : {}),
      ...(message
        ? {
            message: {
              id: message.id,
              text: message.content,
              type: message.messageType,
              channel: message.channel,
              sender: message.senderType.toLowerCase(),
              attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
              createdAt: message.createdAt.toISOString(),
            },
          }
        : {}),
      ...(lead ? { lead: { ...lead, reference: ref('L', lead.id), createdAt: lead.createdAt.toISOString() } } : {}),
      ...(ticket ? { ticket: { ...ticket, reference: ref('T', ticket.id), createdAt: ticket.createdAt.toISOString() } } : {}),
      ...(appointment ? { appointment: { ...appointment, reference: ref('A', appointment.id), createdAt: appointment.createdAt.toISOString() } } : {}),
      ...event.data,
    },
  };
}
export type EventPayload = Awaited<ReturnType<typeof buildEventPayload>>;
