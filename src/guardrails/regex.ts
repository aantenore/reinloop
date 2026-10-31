import type { Guard, GuardStage } from '../types.ts';

export interface RegexPattern {
  name: string;
  pattern: RegExp | string;
  /** Extra check on the matched text (checksums); a rejected match is ignored. */
  validate?: (match: string) => boolean;
}

export interface RegexGuardOptions {
  /** Built-in pattern names (see `REGEX_PATTERNS`) and/or custom patterns. Default: all built-ins. */
  patterns?: Array<string | RegexPattern>;
  /** `redact`: replace matches with `[REDACTED:<name>]`; `block`: refuse any text with a match. */
  action: 'redact' | 'block';
  name?: string;
  stages?: GuardStage[];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Luhn checksum over the digits of `s` (13 to 19 of them). */
export function luhn(s: string): boolean {
  const d = digitsOf(s);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1 && (n *= 2) > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check of an IBAN (spaces allowed). */
export function ibanValid(s: string): boolean {
  const iban = s.replace(/\s/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  let rem = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

const SECRET_SOURCES = [
  String.raw`sk-[A-Za-z0-9_-]{20,}`, // OpenAI / Anthropic style keys
  String.raw`AKIA[0-9A-Z]{16}`, // AWS access key id
  String.raw`gh[pousr]_[A-Za-z0-9]{36,}`, // GitHub tokens
  String.raw`github_pat_[A-Za-z0-9_]{22,}`,
  String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`, // Slack
  String.raw`AIza[0-9A-Za-z_-]{35}`, // Google API key
  String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, // JWT
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{20,}`,
  String.raw`(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}`,
];

/** Zero-infrastructure detectors, applied in this order (so card numbers are taken before phone numbers). */
export const REGEX_PATTERNS: Record<string, RegexPattern> = {
  email: { name: 'email', pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}` },
  iban: { name: 'iban', pattern: String.raw`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b`, validate: ibanValid },
  credit_card: { name: 'credit_card', pattern: String.raw`\b(?:\d[ -]?){12,18}\d\b`, validate: luhn },
  phone: {
    name: 'phone',
    pattern: String.raw`(?<![\w+])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)`,
    validate: (m) => digitsOf(m).length >= 8 && digitsOf(m).length <= 15,
  },
  secret: { name: 'secret', pattern: `(?:${SECRET_SOURCES.join('|')})` },
};

const compile = (p: RegexPattern): Required<Pick<RegexPattern, 'name' | 'validate'>> & { re: RegExp } => ({
  name: p.name,
  validate: p.validate ?? (() => true),
  re: new RegExp(p.pattern instanceof RegExp ? p.pattern.source : p.pattern, p.pattern instanceof RegExp ? [...new Set([...p.pattern.flags, 'g'])].join('') : 'g'),
});

/**
 * Built-in reference guard: emails, phone numbers, IBANs, credit cards (Luhn) and API-key-like secrets by regular
 * expression, no service needed. Good as a floor behind (or instead of) Presidio; far less accurate than a model.
 */
export function regexGuard(opts: RegexGuardOptions): Guard {
  const patterns = (opts.patterns ?? Object.keys(REGEX_PATTERNS)).map((p) => {
    if (typeof p !== 'string') return compile(p);
    const known = REGEX_PATTERNS[p];
    if (!known) throw new Error(`regexGuard: unknown pattern "${p}" (built-in: ${Object.keys(REGEX_PATTERNS).join(', ')})`);
    return compile(known);
  });
  return {
    name: opts.name ?? 'regex',
    ...(opts.stages && { stages: opts.stages }),
    async check({ text }) {
      const hits: string[] = [];
      let out = text;
      for (const p of patterns) {
        out = out.replace(p.re, (match) => {
          if (!p.validate(match)) return match;
          if (!hits.includes(p.name)) hits.push(p.name);
          return `[REDACTED:${p.name}]`;
        });
      }
      if (!hits.length) return { action: 'allow' };
      return opts.action === 'block'
        ? { action: 'block', reason: `matched: ${hits.join(', ')}` }
        : { action: 'redact', text: out, reason: `redacted: ${hits.join(', ')}` };
    },
  };
}
