import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolCallPart, Usage } from './types.ts';

export class ReinloopError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReinloopError';
    this.code = code;
  }
}

export class ProviderError extends ReinloopError {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super('provider_error', message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const newId = (): string => randomUUID();

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) || undefined,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
  };
}

export const userMessage = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });

export function textOf(message: Message | undefined): string {
  if (!message) return '';
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function toolCallsOf(message: Message | undefined): ToolCallPart[] {
  return message ? message.parts.filter((p): p is ToolCallPart => p.type === 'tool_call') : [];
}

/** Glob with `*` wildcards only, anchored. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rough, provider-agnostic token estimate (~4 chars/token). */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Expands a leading `~/` to the home directory (for user-level agent and skill folders). */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
