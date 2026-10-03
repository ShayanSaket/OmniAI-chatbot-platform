// USD per 1M tokens. Used for cost *estimates* in analytics; update when prices change.
const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
};

function priceFor(model: string) {
  if (PRICES[model]) return PRICES[model];
  // Dated snapshots, e.g. "gpt-4o-mini-2024-07-18".
  const base = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((m) => model.startsWith(`${m}-`));
  return base ? PRICES[base] : undefined;
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}
