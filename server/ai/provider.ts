import 'server-only';
import { createSseParser } from '@/lib/sse';
import type { JsonSchema } from '@/lib/zod-json-schema';
import { env } from '../env';

// Provider-neutral chat interface. Business logic depends on ChatProvider only; the
// OpenAI-compatible implementation below is the default (OPENAI_BASE_URL allows Azure
// OpenAI, gateways or a local mock).

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model (validated by the tool registry). */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  tools?: ToolSpec[];
  /** Ask for a JSON object response (classification, summaries). */
  json?: boolean;
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: TokenUsage; finishReason: string | null; toolCalls: ToolCall[] };

export interface ChatProvider {
  readonly name: string;
  stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor() {
    super('No AI provider is configured (OPENAI_API_KEY is missing).');
    this.name = 'ProviderNotConfiguredError';
  }
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 2;

class OpenAICompatibleProvider implements ChatProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  private async open(request: ChatRequest): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(toOpenAIBody(request)),
        });
        if (res.ok && res.body) return res;
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new ProviderError(`AI provider responded with ${res.status}`, res.status, retryable);
        await res.body?.cancel().catch(() => undefined);
        if (!retryable) break;
      } catch (err) {
        if (request.signal?.aborted) throw err;
        lastError = new ProviderError(`AI provider request failed: ${(err as Error).message}`, undefined, true);
      }
      // Retry only before any token was produced; brief backoff.
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    throw lastError;
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const res = await this.open(request);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const queue: ChatStreamEvent[] = [];
    let usage = { promptTokens: 0, completionTokens: 0 };
    let finishReason: string | null = null;
    // Tool calls arrive as fragments keyed by index: the id/name first, then argument pieces.
    const calls = new Map<number, ToolCall>();
    const parse = createSseParser(({ data }) => {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) queue.push({ type: 'delta', text: choice.delta.content });
      for (const fragment of choice?.delta?.tool_calls ?? []) {
        const call = calls.get(fragment.index) ?? { id: '', name: '', arguments: '' };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
        calls.set(fragment.index, call);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = { promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 };
      }
    });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(value);
        while (queue.length) yield queue.shift()!;
      }
    } finally {
      reader.releaseLock();
    }
    const toolCalls = Array.from(calls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
      .filter((call) => call.name);
    yield { type: 'done', usage, finishReason, toolCalls };
  }
}

function toOpenAIMessage(message: ChatMessage) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

export function toOpenAIBody(request: ChatRequest) {
  return {
    model: request.model,
    messages: request.messages.map(toOpenAIMessage),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: 'auto',
          parallel_tool_calls: true,
        }
      : {}),
    ...(request.json ? { response_format: { type: 'json_object' } } : {}),
  };
}

/** Runs a request to completion and returns the whole text (for non-streamed tasks). */
export async function complete(request: ChatRequest): Promise<{ text: string; usage: TokenUsage; toolCalls: ToolCall[] }> {
  let text = '';
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  let toolCalls: ToolCall[] = [];
  for await (const event of getChatProvider().stream(request)) {
    if (event.type === 'delta') text += event.text;
    else {
      usage = event.usage;
      toolCalls = event.toolCalls;
    }
  }
  return { text, usage, toolCalls };
}

let override: ChatProvider | null = null;

/** Test hook: replace the provider (pass null to restore the default). */
export function setChatProviderOverride(provider: ChatProvider | null) {
  override = provider;
}

export function getChatProvider(): ChatProvider {
  if (override) return override;
  const e = env();
  if (!e.OPENAI_API_KEY) throw new ProviderNotConfiguredError();
  return new OpenAICompatibleProvider(e.OPENAI_API_KEY, e.OPENAI_BASE_URL);
}

/** Rough token estimate when the provider does not report usage (≈4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
