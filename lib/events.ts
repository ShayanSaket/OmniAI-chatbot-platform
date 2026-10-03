// Public event catalog: what outbound webhooks and automations can react to. Client-safe.
// Event names and payload shapes are a public contract; add new ones, don't rename.

export const EVENT_TYPES = [
  'conversation.created',
  'conversation.closed',
  'conversation.inactive',
  'message.received',
  'customer.created',
  'lead.created',
  'ticket.created',
  'appointment.requested',
  'human_handoff.requested',
  'intent.detected',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_INFO: Record<EventType, { label: string; description: string }> = {
  'conversation.created': { label: 'Conversation started', description: 'A customer started a new conversation (website or WhatsApp).' },
  'conversation.closed': { label: 'Conversation closed', description: 'A conversation was closed by the customer or the team.' },
  'conversation.inactive': { label: 'Conversation inactive', description: 'No new message for the configured time.' },
  'message.received': { label: 'Message received', description: 'A customer sent a message on any channel.' },
  'customer.created': { label: 'New customer', description: 'A new customer profile was created.' },
  'lead.created': { label: 'Lead created', description: 'A sales lead was captured by the AI or an automation.' },
  'ticket.created': { label: 'Ticket created', description: 'A support ticket was opened.' },
  'appointment.requested': { label: 'Appointment requested', description: 'A customer asked for an appointment.' },
  'human_handoff.requested': { label: 'Human handoff requested', description: 'The customer, the AI or a rule asked for a team member.' },
  'intent.detected': { label: 'Intent detected', description: 'A customer message was classified (pricing, demo, complaint, …).' },
};

/** Webhook test deliveries use this type; it is not emitted by the app. */
export const PING_EVENT = 'webhook.ping';

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
