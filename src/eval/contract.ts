import type { EvalCase, EvalScore, Layer, RunStatus } from '../types.ts';

/** Every platform layer; the `layer` field of cases and scores must be one of these. */
export const LAYERS: readonly Layer[] = ['infra', 'llm', 'harness', 'knowledge', 'tool', 'identity', 'guardrail', 'cache', 'telemetry', 'eval'];

/** One line of a result JSONL file. */
export interface EvalResult { id: string; runId: string; output: string; status: RunStatus; scores: EvalScore[] }

const CASE_KEYS = new Set(['id', 'input', 'expected', 'tags', 'layer']);

const isLayer = (x: unknown): x is Layer => typeof x === 'string' && (LAYERS as readonly string[]).includes(x);

/** Problems of a parsed dataset line (empty = valid). */
export function caseProblems(x: unknown): string[] {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return ['not an object'];
  const c = x as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof c.id !== 'string' || !c.id) problems.push('"id" must be a non-empty string');
  if (typeof c.input !== 'string') problems.push('"input" must be a string');
  if (c.tags !== undefined && !(Array.isArray(c.tags) && c.tags.every((t) => typeof t === 'string'))) problems.push('"tags" must be an array of strings');
  if (c.layer !== undefined && !isLayer(c.layer)) problems.push(`"layer" must be one of ${LAYERS.join(', ')}`);
  for (const key of Object.keys(c)) if (!CASE_KEYS.has(key)) problems.push(`unknown field "${key}"`);
  return problems;
}

/** Parses dataset JSONL (blank lines skipped); throws with the line number on the first invalid line or duplicate id. */
export function parseDataset(text: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`dataset line ${i + 1}: invalid JSON (${(err as Error).message})`);
    }
    const problems = caseProblems(parsed);
    if (problems.length) throw new Error(`dataset line ${i + 1}: ${problems.join('; ')}`);
    const c = parsed as EvalCase;
    if (seen.has(c.id)) throw new Error(`dataset line ${i + 1}: duplicate id "${c.id}"`);
    seen.add(c.id);
    cases.push(c);
  });
  return cases;
}

export const toJsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** Problems of one score (empty = valid): metric name, value in 0..1, optional layer and reason. */
export function scoreProblems(s: unknown): string[] {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return ['score is not an object'];
  const x = s as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof x.metric !== 'string' || !x.metric) problems.push('"metric" must be a non-empty string');
  if (typeof x.value !== 'number' || !Number.isFinite(x.value) || x.value < 0 || x.value > 1) problems.push(`"value" must be a number in 0..1 (got ${String(x.value)})`);
  if (x.layer !== undefined && !isLayer(x.layer)) problems.push(`"layer" must be one of ${LAYERS.join(', ')}`);
  if (x.reason !== undefined && typeof x.reason !== 'string') problems.push('"reason" must be a string');
  for (const key of Object.keys(x)) if (!['metric', 'value', 'layer', 'reason'].includes(key)) problems.push(`unknown field "${key}"`);
  return problems;
}
