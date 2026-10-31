import type { LimitSpec } from '../types.ts';

const BUILTIN = ['openai-compatible', 'anthropic'] as const;

/**
 * Time limit of the model HTTP adapters. Self-contained (contract types only), merged into `LIMITS`.
 * For a non-streamed request it covers the whole exchange, response body included. For a stream it is the time to the
 * first chunk and then the longest silence between two chunks, so a long answer that keeps flowing is not cut.
 */
export const PROVIDER_TIMEOUT_LIMITS = {
  'provider.timeoutMs': {
    component: 'Providers', path: 'providers.<name>.timeoutMs', option: 'openaiCompatible / anthropic({ timeoutMs })', default: 600_000, min: 1, unbounded: true,
    warnUnbounded: true, safe: [1000, 3_600_000], types: BUILTIN,
    why: 'Time limit of one model request, response body included; for a stream, time to the first chunk and then the longest silence between chunks',
  },
} as const satisfies Record<string, LimitSpec>;
