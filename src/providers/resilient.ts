import type { ModelRef, Provider } from '../types.ts';
import { ProviderError, sleep } from '../util.ts';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** HTTP statuses worth retrying; 0 means network failure. */
  retryOn?: number[];
}

export const DEFAULT_RETRY_ON = [0, 408, 409, 429, 500, 502, 503, 504, 529];

/**
 * Exponential backoff with jitter, honouring Retry-After. A response that already
 * streamed text is never retried, so consumers never see duplicated output.
 */
export function withRetry(provider: Provider, opts: RetryOptions = {}): Provider {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 30_000;
  const retryOn = new Set(opts.retryOn ?? DEFAULT_RETRY_ON);
  return {
    name: provider.name,
    async generate(req, ctx) {
      for (let attempt = 1; ; attempt++) {
        let streamed = false;
        try {
          return await provider.generate(req, {
            ...ctx,
            onText: ctx.onText && ((d) => ((streamed = true), ctx.onText!(d))),
          });
        } catch (err) {
          const retryable = err instanceof ProviderError && retryOn.has(err.status);
          if (!retryable || streamed || attempt >= maxAttempts || ctx.signal.aborted) throw err;
          const backoff = Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
          await sleep(Math.min(cap, (err as ProviderError).retryAfterMs ?? backoff), ctx.signal);
        }
      }
    },
  };
}

/** Tries each model in order; later entries replace the request's model and params. */
export function withFallback(refs: ModelRef[]): Provider {
  if (!refs.length) throw new Error('withFallback requires at least one model');
  return {
    name: refs.map((r) => r.provider.name).join('>'),
    async generate(req, ctx) {
      let lastError: unknown;
      let streamed = false;
      const onText = ctx.onText && ((d: string) => ((streamed = true), ctx.onText!(d)));
      for (const [i, ref] of refs.entries()) {
        try {
          const request = i === 0 ? req : { ...req, model: ref.model, params: ref.params ?? req.params };
          return await ref.provider.generate(request, { ...ctx, onText });
        } catch (err) {
          if (ctx.signal.aborted || streamed) throw err;
          lastError = err;
        }
      }
      throw lastError;
    },
  };
}
