// Catalog of the AI agent's business tools. Client-safe: the dashboard lists these, the
// server registry (server/modules/agent/tools) implements them under the same names.
import { z } from 'zod';

export const AGENT_TOOL_NAMES = [
  'search_knowledge_base',
  'get_product_information',
  'get_business_hours',
  'get_customer_profile',
  'update_customer_profile',
  'create_lead',
  'create_support_ticket',
  'schedule_appointment',
  'get_order_status',
  'request_human_agent',
  'save_conversation_summary',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolInfo {
  name: AgentToolName;
  label: string;
  description: string;
  group: 'Knowledge' | 'Customer' | 'Sales & support' | 'Escalation';
  /** Shown when the tool needs extra setup before the AI can use it. */
  requires?: string;
  /** Read-only tools never change data. */
  readOnly: boolean;
}

export const AGENT_TOOLS: AgentToolInfo[] = [
  { name: 'search_knowledge_base', label: 'Search knowledge base', group: 'Knowledge', readOnly: true, description: 'Look up answers in your documents and FAQs.' },
  { name: 'get_product_information', label: 'Product & price lookup', group: 'Knowledge', readOnly: true, description: 'Read products, plans and prices from your catalog. The AI only quotes prices found here.' },
  { name: 'get_business_hours', label: 'Business hours', group: 'Knowledge', readOnly: true, description: 'Tell customers when your team is available.' },
  { name: 'get_customer_profile', label: 'Read customer profile', group: 'Customer', readOnly: true, description: "Recall the current customer's details, open requests and tickets. Never other customers." },
  { name: 'update_customer_profile', label: 'Update customer profile', group: 'Customer', readOnly: false, description: 'Save name, email, phone, company or language the customer shares.' },
  { name: 'create_lead', label: 'Create leads', group: 'Sales & support', readOnly: false, description: 'Capture sales interest (quote, demo, consultation) once the customer shares contact details.' },
  { name: 'create_support_ticket', label: 'Create support tickets', group: 'Sales & support', readOnly: false, description: 'Open a ticket for problems that need follow-up by the team.' },
  { name: 'schedule_appointment', label: 'Appointment requests', group: 'Sales & support', readOnly: false, description: 'Record an appointment request with preferred times. Your team confirms it; the AI never promises a booking.' },
  { name: 'get_order_status', label: 'Order status', group: 'Sales & support', readOnly: true, requires: 'Order lookup connection', description: 'Look up an order by number and email through your order system.' },
  { name: 'request_human_agent', label: 'Human handoff', group: 'Escalation', readOnly: false, description: 'Hand the conversation to your team. Follows the escalation behavior setting.' },
  { name: 'save_conversation_summary', label: 'Conversation notes', group: 'Escalation', readOnly: false, description: 'Leave a summary for your team, for example before a handoff.' },
];

export const ESCALATION_TRIGGERS = ['angry', 'complaint', 'legal', 'payment', 'technical', 'safety'] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export const ESCALATION_TRIGGER_LABELS: Record<EscalationTrigger, string> = {
  angry: 'Customer is angry or very frustrated',
  complaint: 'Serious complaint',
  legal: 'Legal or privacy request',
  payment: 'Payment or billing problem',
  technical: 'Complex technical issue',
  safety: 'Safety or emergency concern',
};

export const agentBehaviorSchema = z.object({
  disabledTools: z.array(z.enum(AGENT_TOOL_NAMES)).max(AGENT_TOOL_NAMES.length).default([]),
  escalateOn: z.array(z.enum(ESCALATION_TRIGGERS)).max(ESCALATION_TRIGGERS.length).default([...ESCALATION_TRIGGERS]),
});
export type AgentBehavior = z.infer<typeof agentBehaviorSchema>;

/** PATCH input: each part is optional and merged into the stored behavior. */
export const agentBehaviorPatchSchema = z
  .object({
    disabledTools: z.array(z.enum(AGENT_TOOL_NAMES)).max(AGENT_TOOL_NAMES.length),
    escalateOn: z.array(z.enum(ESCALATION_TRIGGERS)).max(ESCALATION_TRIGGERS.length),
  })
  .partial();

/** Reads the stored behavior JSON, falling back to defaults for anything invalid. */
export function parseAgentBehavior(value: unknown): AgentBehavior {
  const parsed = agentBehaviorSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : agentBehaviorSchema.parse({});
}
