import type { LimitSpec } from '../types.ts';

export const REDACT_LIMITS = {
  'limits.minSecretChars': {
    component: 'Run loop and redaction', path: 'limits.minSecretChars', option: 'secretForms(values, minChars); minSecretChars of httpTool, httpKnowledge, McpClient.connect',
    default: 4, min: 1, safe: [1, 8], why: 'Shorter secrets are not masked in echoed error text (they would mangle ordinary text)',
  },
} as const satisfies Record<string, LimitSpec>;

/** Secrets shorter than this are not worth masking and would mangle ordinary text. */
const MIN_SECRET_CHARS: number = REDACT_LIMITS['limits.minSecretChars'].default;
const REDACTED = '[redacted]';

/** Every form a secret may take when a server echoes it: raw, JSON-escaped, URL-encoded; longest first. */
export function secretForms(values: Iterable<string>, minChars: number = MIN_SECRET_CHARS): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < minChars) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  return [...forms].filter((f) => f.length >= minChars).sort((a, b) => b.length - a.length);
}

export const redact = (text: string, forms: readonly string[]): string => forms.reduce((t, f) => t.split(f).join(REDACTED), text);

/** Values of every static header, plus the credential part of an Authorization value ("Bearer abc" also yields "abc"). */
export function staticSecrets(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {}).flatMap(([k, v]) => (k.toLowerCase() === 'authorization' ? [v, v.replace(/^\s*\w+\s+/, '').trim()] : [v]));
}

/** Masks secrets in an error's message and stack, keeping its class and properties. */
export function scrubError(err: unknown, forms: readonly string[]): unknown {
  if (!(err instanceof Error) || !forms.length) return err;
  err.message = redact(err.message, forms);
  if (err.stack) err.stack = redact(err.stack, forms);
  return err;
}
