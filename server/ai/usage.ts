import 'server-only';
import type { UsageKind } from '@prisma/client';
import type { TenantDb } from '../tenancy/tenant-db';
import { estimateCostUsd } from './pricing';
import { estimateTokens, type TokenUsage } from './provider';

/**
 * Records one AI call for cost analytics. When the provider did not report usage,
 * tokens are estimated from the text sent and received.
 */
export async function recordUsage(
  db: TenantDb,
  params: {
    organizationId: string;
    conversationId?: string | null;
    kind: UsageKind;
    model: string;
    usage: TokenUsage;
    latencyMs: number;
    estimate?: { input: string; output: string };
  },
) {
  const promptTokens = params.usage.promptTokens || (params.estimate ? estimateTokens(params.estimate.input) : 0);
  const completionTokens = params.usage.completionTokens || (params.estimate ? estimateTokens(params.estimate.output) : 0);
  await db.usageRecord.create({
    data: {
      organizationId: params.organizationId,
      conversationId: params.conversationId ?? null,
      kind: params.kind,
      model: params.model,
      promptTokens,
      completionTokens,
      costUsd: estimateCostUsd(params.model, promptTokens, completionTokens) ?? 0,
      latencyMs: params.latencyMs,
    },
  });
  return { promptTokens, completionTokens };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens };
}
