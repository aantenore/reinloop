import { GUARD_STAGES } from '../guardrails/contract.ts';
import type { Guard, GuardInput, GuardStage, GuardVerdict } from '../types.ts';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface GuardCheckOptions {
  /** Harmless text every supported stage must allow. */
  benign: string;
  /** Texts the guard must not allow (block, or redact into something different). */
  harmful?: string | string[];
  /** Text with personal data: must be blocked or redacted; with `contains`, the redacted text must no longer include that value. */
  pii?: string | { text: string; contains?: string };
  /** Stage used for `harmful` and `pii` (default: the first one the guard supports). */
  stage?: GuardStage;
}

const ACTIONS = ['allow', 'block', 'redact'];

/**
 * Conformance check for a `Guard` implementation: returns the failures, empty when it conforms.
 * Verifies the verdict shape on every supported stage, that benign text is allowed, and (when given) that harmful text
 * and PII are not.
 */
export async function checkGuard(guard: Guard, opts: GuardCheckOptions): Promise<string[]> {
  const failures: string[] = [];
  if (typeof guard?.name !== 'string' || !guard.name) failures.push('name must be a non-empty string');
  if (typeof guard?.check !== 'function') return [...failures, 'check must be a function'];
  const stages = guard.stages ?? GUARD_STAGES;
  if (!stages.length || stages.some((s) => !GUARD_STAGES.includes(s))) failures.push(`stages must be a non-empty subset of ${GUARD_STAGES.join(', ')}`);

  const input = (stage: GuardStage, text: string): GuardInput => ({
    stage, text, agent: 'conformance', runId: 'conformance-run', ...((stage === 'tool_args' || stage === 'tool_result') && { tool: 'conformance_tool' }),
  });
  const verdict = async (label: string, stage: GuardStage, text: string): Promise<GuardVerdict | undefined> => {
    let v: GuardVerdict;
    try {
      v = await guard.check(input(stage, text));
    } catch (err) {
      failures.push(`${label}: check threw: ${errorMessage(err)}`);
      return undefined;
    }
    if (!v || !ACTIONS.includes(v.action)) failures.push(`${label}: action must be one of ${ACTIONS.join(', ')}`);
    else if (v.action === 'redact' && typeof v.text !== 'string') failures.push(`${label}: redact must carry the redacted text`);
    else if (v.reason !== undefined && typeof v.reason !== 'string') failures.push(`${label}: reason must be a string`);
    else return v;
    return undefined;
  };

  for (const stage of stages) {
    const v = await verdict(`benign@${stage}`, stage, opts.benign);
    if (v && v.action !== 'allow') failures.push(`benign@${stage}: expected allow, got ${v.action}${v.reason ? ` (${v.reason})` : ''}`);
  }

  const stage = opts.stage ?? stages[0]!;
  if (!stages.includes(stage)) {
    failures.push(`stage ${stage} is not supported by the guard`);
    return failures;
  }
  for (const text of [opts.harmful ?? []].flat()) {
    const v = await verdict('harmful', stage, text);
    if (v && (v.action === 'allow' || (v.action === 'redact' && v.text === text))) failures.push(`harmful: expected block or a changed redaction, got ${v.action}`);
  }
  if (opts.pii !== undefined) {
    const { text, contains } = typeof opts.pii === 'string' ? { text: opts.pii, contains: undefined } : opts.pii;
    const v = await verdict('pii', stage, text);
    if (v?.action === 'allow') failures.push('pii: expected block or redact, got allow');
    else if (v?.action === 'redact') {
      if (v.text === text) failures.push('pii: redaction left the text unchanged');
      else if (contains && v.text!.includes(contains)) failures.push('pii: redacted text still contains the personal data');
    }
  }
  return failures;
}
