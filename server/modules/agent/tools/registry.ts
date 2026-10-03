import 'server-only';
import type { Prisma } from '@prisma/client';
import { zodToJsonSchema } from '@/lib/zod-json-schema';
import type { ToolCall, ToolSpec } from '../../../ai/provider';
import { logger } from '../../../logger';
import { getCustomerProfile, updateCustomerProfile } from './customer-tools';
import { getOrderStatus, requestHumanAgent, saveConversationSummary } from './escalation-tools';
import { getBusinessHours, getProductInformation, searchKnowledgeBase } from './knowledge-tools';
import { createLead, createSupportTicket, scheduleAppointment } from './sales-tools';
import { ToolError, type AgentTool, type ToolAvailabilityContext, type ToolContext } from './types';

// Tool registry. To add a tool: implement it with defineTool(), add it here and to the
// catalog in lib/agent-tools.ts. The model proposes calls; this module validates the
// input, checks the tool is enabled for the organization, executes it, records a
// ToolExecution and hands the (confirmed) result back to the model.

export const TOOLS: AgentTool[] = [
  searchKnowledgeBase,
  getProductInformation,
  getBusinessHours,
  getCustomerProfile,
  updateCustomerProfile,
  createLead,
  createSupportTicket,
  scheduleAppointment,
  getOrderStatus,
  requestHumanAgent,
  saveConversationSummary,
] as AgentTool[];

const TOOL_TIMEOUT_MS = 15_000;

export function availableTools(ctx: ToolAvailabilityContext): AgentTool[] {
  return TOOLS.filter((t) => !ctx.behavior.disabledTools.includes(t.name) && (t.isAvailable?.(ctx) ?? true));
}

const specCache = new Map<string, ToolSpec>();

export function toolSpec(tool: AgentTool): ToolSpec {
  let spec = specCache.get(tool.name);
  if (!spec) {
    spec = { name: tool.name, description: tool.description, parameters: zodToJsonSchema(tool.parameters) };
    specCache.set(tool.name, spec);
  }
  return spec;
}

export interface ToolCallResult {
  /** JSON string returned to the model. */
  content: string;
  executionId: string;
  status: 'SUCCESS' | 'FAILED' | 'DENIED';
  toolName: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolError('timeout', 'The tool took too long. Apologize and offer the team.')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function executeToolCall(ctx: ToolContext, call: ToolCall, allowed: AgentTool[]): Promise<ToolCallResult> {
  const started = Date.now();
  const tool = allowed.find((t) => t.name === call.name);
  let input: unknown = null;
  let output: Record<string, unknown>;
  let status: ToolCallResult['status'];
  let error: string | null = null;

  if (!tool) {
    status = 'DENIED';
    error = `Tool "${call.name}" is not available`;
    output = { error: 'not_available', message: `The tool "${call.name}" is not available. Continue without it.` };
  } else {
    try {
      input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      input = call.arguments.slice(0, 2000);
    }
    const parsed = tool.parameters.safeParse(input ?? {});
    if (!parsed.success) {
      status = 'FAILED';
      error = 'invalid_arguments';
      output = {
        error: 'invalid_arguments',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      };
    } else {
      try {
        output = await withTimeout(tool.execute(ctx, parsed.data), TOOL_TIMEOUT_MS);
        status = 'SUCCESS';
      } catch (err) {
        status = 'FAILED';
        if (err instanceof ToolError) {
          error = err.code;
          output = { error: err.code, message: err.message };
        } else {
          error = 'internal_error';
          output = { error: 'internal_error', message: 'The action failed. Do not claim it succeeded; offer the team instead.' };
          logger.error('tool execution crashed', {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversation.id,
            tool: call.name,
            err: (err as Error).message,
          });
        }
      }
    }
  }

  const durationMs = Date.now() - started;
  const execution = await ctx.db.toolExecution.create({
    data: {
      organizationId: ctx.organizationId,
      conversationId: ctx.conversation.id,
      toolName: call.name.slice(0, 100),
      input: (input ?? {}) as Prisma.InputJsonValue,
      output: output as Prisma.InputJsonValue,
      status,
      error,
      durationMs,
    },
    select: { id: true },
  });
  logger.info('tool executed', {
    organizationId: ctx.organizationId,
    conversationId: ctx.conversation.id,
    tool: call.name,
    status,
    error,
    durationMs,
  });
  return { content: JSON.stringify(output), executionId: execution.id, status, toolName: call.name };
}
