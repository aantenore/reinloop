import type { Pricing } from './types.ts';

/** Built-in USD prices per million tokens, keyed by model id (without the `provider/` prefix). */
export const PRICING: Record<string, Pricing> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 },
};

/** Price of a model id: `overrides` (e.g. the config's `pricing`) merged over the built-in table. */
export function pricingFor(model: string, overrides: Record<string, Partial<Pricing>> = {}): Pricing | undefined {
  const merged = { ...PRICING[model], ...overrides[model] };
  return merged.inputPerMTok !== undefined && merged.outputPerMTok !== undefined ? (merged as Pricing) : undefined;
}
