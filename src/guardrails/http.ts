import type { Guard, GuardInput, GuardStage } from '../types.ts';
import { assertPlainUrl, type HttpClientOptions, parseVerdict, postGuardJson } from './contract.ts';

export interface HttpGuardOptions extends HttpClientOptions {
  url: string;
  name?: string;
  stages?: GuardStage[];
}

/**
 * Generic guard over the HTTP contract: POST `url` with a `GuardInput` body, answer a `GuardVerdict`.
 * Any technology can sit behind a small shim that speaks it.
 */
export function httpGuard(opts: HttpGuardOptions): Guard {
  assertPlainUrl(opts.url, 'httpGuard url');
  return {
    name: opts.name ?? 'http',
    ...(opts.stages && { stages: opts.stages }),
    async check(input: GuardInput, ctx) {
      return parseVerdict(await postGuardJson(opts.url, input, opts, ctx?.signal));
    },
  };
}
