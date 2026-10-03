// Rule-based escalation, applied after every AI reply on top of the model's own judgment
// (the model can also call request_human_agent). Pure.
import type { EscalationBehavior } from '@prisma/client';
import type { EscalationTrigger } from '@/lib/agent-tools';
import type { MessageSignals } from './signals';

export type EscalationDecision =
  | { kind: 'none' }
  /** Offer a "Talk to a human" button with the reply. */
  | { kind: 'suggest'; trigger: EscalationTrigger | 'customer_request' }
  /** Hand the conversation to the team now. */
  | { kind: 'handoff'; trigger: EscalationTrigger | 'customer_request' };

/** The configured trigger a message matches, if any (most serious first). */
export function escalationTrigger(signals: MessageSignals): EscalationTrigger | null {
  if (signals.escalation === 'safety') return 'safety';
  if (signals.escalation === 'legal') return 'legal';
  if (signals.escalation === 'payment') return 'payment';
  if (signals.sentiment === 'angry') return 'angry';
  if (signals.escalation === 'complaint') return 'complaint';
  if (signals.escalation === 'technical') return 'technical';
  return null;
}

export function decideEscalation(params: {
  behavior: EscalationBehavior;
  escalateOn: readonly EscalationTrigger[];
  signals: MessageSignals | null;
}): EscalationDecision {
  const { behavior, escalateOn, signals } = params;
  if (behavior === 'DISABLED' || !signals) return { kind: 'none' };

  // An explicit request for a person is always honored (unless escalation is disabled).
  if (signals.wantsHuman) return { kind: 'handoff', trigger: 'customer_request' };

  const trigger = escalationTrigger(signals);
  if (!trigger || !escalateOn.includes(trigger)) return { kind: 'none' };
  return behavior === 'AUTOMATIC' ? { kind: 'handoff', trigger } : { kind: 'suggest', trigger };
}
