import type { Guard, GuardStage } from '../types.ts';
import { type HttpClientOptions, postGuardJson } from './contract.ts';

export interface LlmGuardOptions extends HttpClientOptions {
  /** LLM Guard API base URL (`POST /analyze/prompt`, `POST /analyze/output`). */
  url: string;
  /** Bearer token (the API's `AUTH_TOKEN`); omit when auth is disabled. */
  token?: string;
  /** Scanner class names to skip on every call (e.g. `["Toxicity"]`). */
  scannersSuppress?: string[];
  name?: string;
  /** Default `input`, `output` and `tool_result` (prompt scanners also catch injection planted in tool results). */
  stages?: GuardStage[];
}

/**
 * LLM Guard (MIT, Protect AI) over its REST API. Everything except `output` goes through the prompt scanners
 * (`/analyze/prompt`), `output` through the output scanners. An invalid verdict blocks, naming the failing scanners;
 * a valid one whose sanitized text differs from the input redacts.
 */
export function llmGuardGuard(opts: LlmGuardOptions): Guard {
  const base = opts.url.replace(/\/+$/, '');
  const headers = { ...(opts.token && { authorization: `Bearer ${opts.token}` }), ...opts.headers };
  const suppress = opts.scannersSuppress?.length ? { scanners_suppress: opts.scannersSuppress } : {};
  return {
    name: opts.name ?? 'llm-guard',
    stages: opts.stages ?? ['input', 'output', 'tool_result'],
    async check({ stage, text }, ctx) {
      const output = stage === 'output';
      const res = await postGuardJson(
        `${base}/analyze/${output ? 'output' : 'prompt'}`,
        output ? { prompt: '', output: text, ...suppress } : { prompt: text, ...suppress },
        { ...opts, headers },
        ctx?.signal,
      );
      if (typeof res?.is_valid !== 'boolean') throw new Error('llm-guard returned an unexpected body');
      if (!res.is_valid) return { action: 'block', reason: `llm-guard: ${failingScanners(res.scanners)}` };
      const sanitized = output ? res.sanitized_output : res.sanitized_prompt;
      return typeof sanitized === 'string' && sanitized !== text ? { action: 'redact', text: sanitized, reason: 'llm-guard: sanitized' } : { action: 'allow' };
    },
  };
}

/** Scanners with a risk score of 0 or more (a passing scanner reports -1); all names when none qualifies, so the reason is never empty. */
function failingScanners(scanners: unknown): string {
  const entries = Object.entries((scanners ?? {}) as Record<string, number>);
  const failing = entries.filter(([, score]) => score >= 0).map(([name]) => name);
  return (failing.length ? failing : entries.map(([name]) => name)).join(', ') || 'invalid';
}
