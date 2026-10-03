import 'server-only';
import { randomUUID } from 'node:crypto';
import type { EventType } from '@/lib/events';
import { runInBackground } from '../background';
import { logger } from '../logger';

// Domain events: the single place where business events are announced. Consumers:
//   - outbound webhooks (modules/webhooks/delivery.ts)
//   - automations (modules/automations/engine.ts)
//   - CRM/integration connectors (integrations/connectors)
// Emitting never blocks or fails the caller: dispatch runs in the background and every
// consumer is isolated from the others' errors.

export interface EventRefs {
  conversationId?: string | null;
  customerId?: string | null;
  messageId?: string | null;
  leadId?: string | null;
  ticketId?: string | null;
  appointmentId?: string | null;
}

export interface DomainEvent {
  id: string;
  type: EventType;
  organizationId: string;
  occurredAt: string;
  refs: EventRefs;
  /** Extra facts (channel, intent, handoff reason, …). */
  data: Record<string, unknown>;
  /** Automations whose actions led to this event (loop protection). */
  causedBy: string[];
}

export type DomainEventInput = Omit<DomainEvent, 'id' | 'occurredAt' | 'data' | 'causedBy'> & {
  id?: string;
  data?: Record<string, unknown>;
  causedBy?: string[];
};

type Consumer = (event: DomainEvent) => Promise<unknown>;
const consumers: { name: string; run: Consumer }[] = [];

/** Consumers register at module load (see server/events/consumers.ts). */
export function registerEventConsumer(name: string, run: Consumer) {
  if (!consumers.some((c) => c.name === name)) consumers.push({ name, run });
}

export function buildEvent(input: DomainEventInput): DomainEvent {
  return {
    id: input.id ?? `evt_${randomUUID().replace(/-/g, '')}`,
    type: input.type,
    organizationId: input.organizationId,
    occurredAt: new Date().toISOString(),
    refs: input.refs,
    data: input.data ?? {},
    causedBy: input.causedBy ?? [],
  };
}

export async function dispatchEvent(event: DomainEvent) {
  // Lazy import wires the consumers without import cycles.
  await import('./consumers');
  const results = await Promise.allSettled(consumers.map((c) => c.run(event)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error('event consumer failed', {
        consumer: consumers[i]!.name,
        eventType: event.type,
        eventId: event.id,
        organizationId: event.organizationId,
        err: (r.reason as Error)?.message,
      });
    }
  });
}

/** Announces an event; returns its id. Processing happens in the background. */
export function emitDomainEvent(input: DomainEventInput): string {
  const event = buildEvent(input);
  runInBackground('domain-event', () => dispatchEvent(event), { eventType: event.type, eventId: event.id });
  return event.id;
}
