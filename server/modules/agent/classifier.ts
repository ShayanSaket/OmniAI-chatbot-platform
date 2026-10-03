import 'server-only';
import { z } from 'zod';
import { complete, ProviderNotConfiguredError } from '../../ai/provider';
import { recordUsage } from '../../ai/usage';
import { logger } from '../../logger';
import type { TenantDb } from '../../tenancy/tenant-db';
import { ESCALATION_CATEGORIES, heuristicSignals, INTENTS, SENTIMENTS, temperatureForIntent, type MessageSignals } from './signals';

const CLASSIFIER_PROMPT = `TASK: classify the latest customer message in a customer-service chat.
Return only a JSON object with these keys:
- "intent": one of ${INTENTS.join(', ')}
- "sentiment": one of ${SENTIMENTS.join(', ')}
- "leadTemperature": "COLD" (just browsing), "WARM" (interested: pricing, features), "HOT" (ready: demo, quote, purchase, contact request) or null when not a sales conversation
- "escalation": one of ${ESCALATION_CATEGORIES.join(', ')} — only when the message itself raises a serious complaint, a legal/privacy matter, a payment problem, a complex technical problem or a safety issue
- "wantsHuman": true only if the customer explicitly asks to talk to a person
- "language": ISO 639-1 code of the latest message
- "confidence": 0..1
Earlier messages are context only. Classify the latest customer message.`;

const resultSchema = z.object({
  intent: z.enum(INTENTS).catch('OTHER'),
  sentiment: z.enum(SENTIMENTS).catch('neutral'),
  leadTemperature: z.enum(['COLD', 'WARM', 'HOT']).nullable().catch(null),
  escalation: z.enum(ESCALATION_CATEGORIES).catch('none'),
  wantsHuman: z.boolean().catch(false),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable()
    .catch(null),
  confidence: z.number().min(0).max(1).catch(0.5),
});

const TIMEOUT_MS = 8000;

/**
 * Classifies a customer message with the LLM (JSON mode, temperature 0), falling back
 * to the keyword heuristic when no provider is configured or the call fails.
 */
export async function classifyMessage(params: {
  db: TenantDb;
  organizationId: string;
  conversationId: string;
  model: string;
  text: string;
  /** A few previous lines ("Customer: …", "Assistant: …") for context. */
  context: string[];
}): Promise<MessageSignals> {
  const fallback = heuristicSignals(params.text);
  if (!params.text.trim()) return fallback;
  const started = Date.now();
  const input = [...params.context.slice(-4), `Customer (latest): ${params.text}`].join('\n').slice(-4000);
  try {
    const { text, usage } = await complete({
      model: params.model,
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: input },
      ],
      temperature: 0,
      maxTokens: 160,
      json: true,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await recordUsage(params.db, {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      kind: 'CLASSIFICATION',
      model: params.model,
      usage,
      latencyMs: Date.now() - started,
      estimate: { input: CLASSIFIER_PROMPT + input, output: text },
    });
    const parsed = resultSchema.parse(JSON.parse(text));
    return {
      ...parsed,
      leadTemperature: parsed.leadTemperature ?? temperatureForIntent(parsed.intent),
      // Keyword evidence of a human request or a safety issue is never dropped.
      wantsHuman: parsed.wantsHuman || fallback.wantsHuman,
      escalation: fallback.escalation === 'safety' ? 'safety' : parsed.escalation,
      language: parsed.language ?? fallback.language,
      source: 'llm',
    };
  } catch (err) {
    if (!(err instanceof ProviderNotConfiguredError)) {
      logger.warn('classification failed; using heuristic', {
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        err: (err as Error).message,
      });
    }
    return fallback;
  }
}
