import 'server-only';
import { getChatProvider, type ChatMessage, type TokenUsage, type ToolCall } from '../../ai/provider';
import { addUsage } from '../../ai/usage';
import { createCitationFilter, extractCitations, stripCitations } from './citations';
import { executeToolCall, toolSpec, type ToolCallResult } from './tools/registry';
import type { AgentTool, ToolContext } from './tools/types';

// The agent loop (tool calling):
//   model answers or proposes tool calls → backend validates + executes them →
//   results go back to the model → repeat → final answer.
// Text streams to the customer as it is generated (citation markers filtered out).

export const MAX_ROUNDS = 4;
export const MAX_TOOL_CALLS = 6;

export interface AgentRunParams {
  model: string;
  temperature: number;
  maxTokens: number;
  messages: ChatMessage[];
  tools: AgentTool[];
  toolCtx: ToolContext;
  onDelta?: (text: string) => void;
  onStatus?: (status: 'searching' | 'working') => void;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  /** Final text with citation markers removed. */
  text: string;
  /** Citation numbers the model used. */
  citations: number[];
  usage: TokenUsage;
  rounds: number;
  toolResults: ToolCallResult[];
  /** Tool outputs the model saw (allowed context for the output guard). */
  toolOutputs: string[];
}

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const provider = getChatProvider();
  const messages = [...params.messages];
  const filter = createCitationFilter();
  const toolResults: ToolCallResult[] = [];
  const toolOutputs: string[] = [];
  let rawText = '';
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  let rounds = 0;

  const emit = (text: string) => {
    const visible = filter.push(text);
    if (visible) params.onDelta?.(visible);
  };

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const lastRound = rounds === MAX_ROUNDS || toolResults.length >= MAX_TOOL_CALLS;
    const tools = lastRound ? [] : params.tools;
    let roundText = '';
    let toolCalls: ToolCall[] = [];

    for await (const event of provider.stream({
      model: params.model,
      messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      tools: tools.map(toolSpec),
      signal: params.signal,
    })) {
      if (event.type === 'delta') {
        // Separate text from different rounds ("Let me check…" + the answer).
        if (!roundText && rawText.trim()) {
          rawText += '\n\n';
          emit('\n\n');
        }
        roundText += event.text;
        rawText += event.text;
        emit(event.text);
      } else {
        usage = addUsage(usage, event.usage);
        toolCalls = event.toolCalls;
      }
    }

    if (!toolCalls.length || lastRound) break;

    messages.push({ role: 'assistant', content: roundText, toolCalls });
    for (const call of toolCalls) {
      if (toolResults.length >= MAX_TOOL_CALLS) {
        messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ error: 'limit', message: 'Too many tool calls; answer now.' }) });
        continue;
      }
      const tool = params.tools.find((t) => t.name === call.name);
      params.onStatus?.(tool?.status ?? 'working');
      const result = await executeToolCall(params.toolCtx, call, params.tools);
      toolResults.push(result);
      toolOutputs.push(result.content);
      messages.push({ role: 'tool', toolCallId: call.id, content: result.content });
    }
  }

  const tail = filter.flush();
  if (tail) params.onDelta?.(tail);
  return {
    text: stripCitations(rawText).trim(),
    citations: extractCitations(rawText),
    usage,
    rounds,
    toolResults,
    toolOutputs,
  };
}
