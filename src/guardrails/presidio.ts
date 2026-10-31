import type { Guard, GuardStage } from '../types.ts';
import { assertPlainUrl, GuardCallError, type HttpClientOptions, postGuardJson } from './contract.ts';

export interface PresidioGuardOptions extends HttpClientOptions {
  /** Presidio Analyzer base URL (`POST /analyze`). */
  analyzerUrl: string;
  /** Presidio Anonymizer base URL (`POST /anonymize`); only used when `action` is `redact`. */
  anonymizerUrl: string;
  language?: string;
  /** Entity types to look for (default: all the analyzer supports), e.g. `["EMAIL_ADDRESS", "PHONE_NUMBER"]`. */
  entities?: string[];
  /** Ignore findings scored below this (0..1). */
  scoreThreshold?: number;
  /** `redact`: replace findings via the anonymizer; `block`: refuse any text with findings. */
  action: 'redact' | 'block';
  /** Presidio anonymizer operators per entity type (`DEFAULT` for the rest), e.g. `{ DEFAULT: { type: 'replace', new_value: '[PII]' } }`. */
  operators?: Record<string, unknown>;
  name?: string;
  stages?: GuardStage[];
}

interface Finding { entity_type: string; start: number; end: number; score: number }

/** PII detection and anonymization with Microsoft Presidio (MIT): the analyzer finds entities, the anonymizer rewrites them. */
export function presidioGuard(opts: PresidioGuardOptions): Guard {
  assertPlainUrl(opts.analyzerUrl, 'presidioGuard analyzerUrl');
  assertPlainUrl(opts.anonymizerUrl, 'presidioGuard anonymizerUrl');
  const analyzer = `${opts.analyzerUrl.replace(/\/+$/, '')}/analyze`;
  const anonymizer = `${opts.anonymizerUrl.replace(/\/+$/, '')}/anonymize`;
  return {
    name: opts.name ?? 'presidio',
    ...(opts.stages && { stages: opts.stages }),
    async check({ text }, ctx) {
      const found: Finding[] = await postGuardJson(
        analyzer,
        {
          text,
          language: opts.language ?? 'en',
          ...(opts.entities && { entities: opts.entities }),
          ...(opts.scoreThreshold !== undefined && { score_threshold: opts.scoreThreshold }),
        },
        opts,
        ctx?.signal,
      );
      if (!Array.isArray(found)) throw new GuardCallError('invalid response');
      if (!found.length) return { action: 'allow' };
      if (opts.action === 'block') return { action: 'block', reason: `PII detected: ${[...new Set(found.map((f) => f.entity_type))].join(', ')}` };
      const res = await postGuardJson(
        anonymizer,
        {
          text,
          analyzer_results: found.map(({ entity_type, start, end, score }) => ({ entity_type, start, end, score })),
          ...(opts.operators && { anonymizers: opts.operators }),
        },
        opts,
        ctx?.signal,
      );
      if (typeof res?.text !== 'string') throw new GuardCallError('invalid response');
      return { action: 'redact', text: res.text, reason: `PII redacted: ${[...new Set(found.map((f) => f.entity_type))].join(', ')}` };
    },
  };
}
