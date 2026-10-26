import type { Pricing } from './types.ts';

/** Anthropic hosted-tool prices in USD per request (web search: $10 per 1,000; web fetch is not metered). */
export const ANTHROPIC_SERVER_TOOL_USD: Record<string, number> = { webSearchRequests: 0.01 };

/** Built-in USD prices per million tokens, keyed by model id (without the `provider/` prefix). */
export const PRICING: Record<string, Pricing> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, serverToolUsd: ANTHROPIC_SERVER_TOOL_USD },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, serverToolUsd: ANTHROPIC_SERVER_TOOL_USD },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, serverToolUsd: ANTHROPIC_SERVER_TOOL_USD },
};

/** Price of a model id: `overrides` (e.g. the config's `pricing`) merged over the built-in table. */
export function pricingFor(model: string, overrides: Record<string, Partial<Pricing>> = {}): Pricing | undefined {
  const base = PRICING[model];
  const over = overrides[model];
  const merged: Partial<Pricing> = { ...base, ...over };
  if (base?.serverToolUsd && over?.serverToolUsd) merged.serverToolUsd = { ...base.serverToolUsd, ...over.serverToolUsd };
  return merged.inputPerMTok !== undefined && merged.outputPerMTok !== undefined ? (merged as Pricing) : undefined;
}
