/** Secrets shorter than this are not worth masking and would mangle ordinary text. */
const MIN_SECRET_CHARS = 4;
const REDACTED = '[redacted]';

/** Every form a secret may take when a server echoes it: raw, JSON-escaped, URL-encoded; longest first. */
export function secretForms(values: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < MIN_SECRET_CHARS) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS).sort((a, b) => b.length - a.length);
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
