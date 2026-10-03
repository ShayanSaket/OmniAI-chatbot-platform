import 'server-only';
import type { BotConfiguration, ChannelType, ConversationStatus, LeadTemperature } from '@prisma/client';
import type { z } from 'zod';
import type { AgentBehavior, AgentToolName } from '@/lib/agent-tools';
import type { BusinessHoursRule } from '@/lib/business-hours';
import type { OrderLookupConfig } from '../../../integrations/order-lookup';
import type { TenantDb } from '../../../tenancy/tenant-db';
import type { RetrievedChunk } from '../../knowledge/retrieval';

/** Numbered knowledge snippets shown to the model in one reply ("[n]" citations). */
export class KnowledgeRefs {
  private readonly items: RetrievedChunk[] = [];

  add(chunk: RetrievedChunk): number {
    const existing = this.items.findIndex((c) => c.chunkId === chunk.chunkId);
    if (existing >= 0) return existing + 1;
    this.items.push(chunk);
    return this.items.length;
  }

  get(ref: number): RetrievedChunk | undefined {
    return this.items[ref - 1];
  }

  get size() {
    return this.items.length;
  }
}

export type HandoffReasonCode =
  | 'customer_request'
  | 'angry'
  | 'complaint'
  | 'legal'
  | 'payment'
  | 'technical'
  | 'safety'
  | 'low_confidence'
  | 'other';

/** Everything a tool may use. Tools act only on this conversation's customer. */
export interface ToolContext {
  db: TenantDb;
  organizationId: string;
  bot: BotConfiguration;
  behavior: AgentBehavior;
  conversation: { id: string; channel: ChannelType; status: ConversationStatus; leadTemperature: LeadTemperature | null };
  customerId: string;
  timeZone: string;
  businessHours: BusinessHoursRule[];
  /** Customer language for localized notes. */
  language: string;
  knowledge: KnowledgeRefs;
  orderLookup: OrderLookupConfig | null;
  /** Text the customer wrote in this conversation (to verify contact details). */
  customerTranscript: () => Promise<string>;
  /** Set by request_human_agent; the pipeline performs the handoff after the reply. */
  handoff: { reason: HandoffReasonCode; note: string } | null;
  /** Set when a human should be offered (escalation behavior SUGGEST). */
  suggestHandoff: boolean;
}

/** What decides whether a tool is offered to the model. */
export type ToolAvailabilityContext = Pick<ToolContext, 'bot' | 'behavior' | 'orderLookup'>;

/** A failure the model should see and recover from (e.g. "ask for the email first"). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface AgentTool<S extends z.AnyZodObject = z.AnyZodObject> {
  name: AgentToolName;
  /** Instructions for the model: when to use the tool and what it returns. */
  description: string;
  parameters: S;
  /** What the widget shows while the tool runs. */
  status: 'searching' | 'working';
  isAvailable?: (ctx: ToolAvailabilityContext) => boolean;
  execute: (ctx: ToolContext, input: z.infer<S>) => Promise<Record<string, unknown>>;
}

export function defineTool<S extends z.AnyZodObject>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}
