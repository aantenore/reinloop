import type { EvalScore, Evaluator, JsonSchema, Layer } from '../types.ts';

// Evaluators depend only on the contract types and Node built-ins, so they can run outside reinloop (e.g. on mapped traces).
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ---- expected ----------------------------------------------------------------

export interface ExpectedOptions {
  /** Case-insensitive `contains` / `equals` (default true). Regexes use their own flags. */
  ignoreCase?: boolean;
}

/**
 * Checks the run output against `expected`: a string (contains), `{ contains: string | string[] }`, `{ equals }`
 * or `{ regex, flags? }`. The score carries the case's `layer`, so a failure is attributed to the layer it was meant to exercise.
 */
export function expectedEvaluator(opts: ExpectedOptions = {}): Evaluator {
  const fold = opts.ignoreCase === false ? (s: string) => s : (s: string) => s.toLowerCase();
  return {
    name: 'expected',
    async score(c, run) {
      if (c.expected === undefined || c.expected === null) return [];
      const output = run.output ?? '';
      const layer = c.layer;
      const spec = typeof c.expected === 'string' ? { contains: c.expected } : (c.expected as Record<string, unknown>);
      const done = (value: number, reason?: string): EvalScore[] => [{ metric: 'expected', value, ...(layer && { layer }), ...(reason && { reason }) }];

      if (typeof spec.regex === 'string') {
        let re: RegExp;
        try {
          re = new RegExp(spec.regex, typeof spec.flags === 'string' ? spec.flags : undefined);
        } catch (err) {
          return [{ metric: 'expected', value: 0, layer: 'eval', reason: `invalid regex: ${errorMessage(err)}` }];
        }
        return done(re.test(output) ? 1 : 0, re.test(output) ? undefined : `output does not match /${spec.regex}/`);
      }
      if (typeof spec.equals === 'string') {
        const ok = fold(output.trim()) === fold(spec.equals.trim());
        return done(ok ? 1 : 0, ok ? undefined : `output is not equal to "${truncate(spec.equals, 80)}"`);
      }
      const needles = typeof spec.contains === 'string' ? [spec.contains] : Array.isArray(spec.contains) ? spec.contains.filter((x): x is string => typeof x === 'string') : [];
      if (!needles.length) return [{ metric: 'expected', value: 0, layer: 'eval', reason: 'unsupported "expected" (use a string, { contains }, { equals } or { regex })' }];
      const missing = needles.filter((n) => !fold(output).includes(fold(n)));
      return done((needles.length - missing.length) / needles.length, missing.length ? `missing: ${missing.map((m) => `"${truncate(m, 60)}"`).join(', ')}` : undefined);
    },
  };
}

// ---- LLM as judge ------------------------------------------------------------

/** Output schema for a judge agent: `{ score: 0..1, reason }`. */
export const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { score: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } },
  required: ['score', 'reason'],
  additionalProperties: false,
};

/** Anything that answers a prompt: a reinloop `agent()` fits as is; wrap a `Member` with `{ run: (i) => runMember(member, i) }`. */
export interface JudgeRunner { run(input: string): Promise<{ status: string; output: string; data?: unknown; reason?: string }> }

export interface JudgeOptions {
  /** The judge. Give it `output: JUDGE_SCHEMA` for structured answers; plain JSON text is parsed as a fallback. */
  agent: JudgeRunner;
  /** What a good answer is; default: the answer is correct, relevant and consistent with the reference when given. */
  criteria?: string;
  name?: string;
}

const DEFAULT_CRITERIA = 'The answer is correct, relevant to the task and consistent with the reference answer when one is given.';

function parseVerdict(text: string, data: unknown): { score: number; reason: string } | undefined {
  let v: unknown = data;
  if (!v || typeof v !== 'object') {
    const m = /\{[\s\S]*\}/.exec(text);
    try {
      v = m ? JSON.parse(m[0]) : undefined;
    } catch {
      v = undefined;
    }
  }
  const o = v as { score?: unknown; reason?: unknown } | undefined;
  if (!o || typeof o.score !== 'number' || !Number.isFinite(o.score)) return undefined;
  return { score: Math.min(1, Math.max(0, o.score)), reason: typeof o.reason === 'string' ? o.reason : '' };
}

/** LLM-as-judge: asks `agent` for `{ score, reason }`. A judge that fails or answers unparseably scores 0 on the `eval` layer. */
export function judgeEvaluator(opts: JudgeOptions): Evaluator {
  const name = opts.name ?? 'judge';
  return {
    name,
    async score(c, run) {
      const prompt = [
        `Criteria: ${opts.criteria ?? DEFAULT_CRITERIA}`,
        `Task:\n${c.input}`,
        ...(c.expected !== undefined ? [`Reference answer:\n${typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected)}`] : []),
        `Answer to grade (run status: ${run.status}):\n${run.output ?? ''}`,
        'Reply with only JSON: {"score": <number from 0 (wrong) to 1 (fully meets the criteria)>, "reason": "<one sentence>"}.',
      ].join('\n\n');
      try {
        const res = await opts.agent.run(prompt);
        const verdict = res.status === 'completed' ? parseVerdict(res.output, res.data) : undefined;
        if (!verdict) return [{ metric: name, value: 0, layer: 'eval', reason: `judge gave no usable verdict (${res.status}${res.reason ? `: ${truncate(res.reason, 120)}` : ''})` }];
        return [{ metric: name, value: verdict.score, ...(c.layer && { layer: c.layer }), reason: verdict.reason }];
      } catch (err) {
        return [{ metric: name, value: 0, layer: 'eval', reason: `judge error: ${errorMessage(err)}` }];
      }
    },
  };
}

// ---- per-layer signals ---------------------------------------------------------

/** Value of the harness score when the run completed but its context had to be compacted. */
const COMPACTED_VALUE = 0.5;

const LLM_FAILURE = /^(max_tokens|refusal)$|invalid structured output|empty responses in a row|^HTTP \d{3}|network error|stream (ended|error)|mock script exhausted|rate.?limit/i;
const FEEDBACK_PREFIX = 'Your final answer must be only JSON matching this schema';
const GUARDRAIL_REASON = /^guardrail\b|guardrail:/i;

const layerScore = (layer: Layer, value: number, reason: string): EvalScore => ({
  metric: `${layer}_health`,
  value: Math.min(1, Math.max(0, value)),
  layer,
  reason,
});

/** Count of passages in a `knowledge_retrieval` event, whatever shape the knowledge layer used; undefined when unknown. */
function passageCount(data: Record<string, unknown>): number | undefined {
  for (const key of ['passages', 'results', 'hits']) {
    const v = data[key];
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'number') return v;
  }
  for (const key of ['count', 'passageCount', 'n']) if (typeof data[key] === 'number') return data[key];
  return undefined;
}

/**
 * Derives a health score (1 = healthy) per layer from the event log, so a failing case points at the layer to fix:
 * `tool` (tool errors, malformed arguments), `identity` (denied calls), `guardrail` (blocked/redacted),
 * `harness` (failed run, budget stop, compaction), `llm` (truncation, refusal, invalid structured output, provider errors),
 * `knowledge` (empty retrievals), `cache` (hit rate). A layer without any signal gets no score. Unknown event types are ignored,
 * so layers that add events later (`guardrail`, `knowledge_retrieval`, `cache*`) are picked up when present.
 */
export function layerSignals(): Evaluator {
  return { name: 'layers', score: async (_c, run) => scoreLayers(run.events as unknown as SignalEvent[], run) };
}

/**
 * The minimal event shape the layer scoring reads. reinloop `RunEvent`s fit it; so can events mapped from another
 * runtime's traces. Types read: run_end {status, reason}, model_response {stopReason, usage, discarded}, message {source, message},
 * tool_result {callId, name, content, isError}, tool_args_invalid {callId, name, repaired}, tool_decision {callId, name, allowed, reason},
 * compaction, guardrail {action}, knowledge_retrieval {passages | count}, cache / cache_hit / cache_miss {hit}.
 */
export interface SignalEvent { type: string; data: Record<string, any>; runId?: string; parentRunId?: string }

/** Pure form of `layerSignals`: per-layer scores from events and the final run status. */
export function scoreLayers(events: SignalEvent[], run: { runId?: string; status: string }): EvalScore[] {
  const scores: EvalScore[] = [];
  const of = (type: string) => events.filter((e) => e.type === type);
  const top = [...events].reverse().find((e) => e.type === 'run_end' && (e.runId === run.runId || !e.parentRunId));
  const reason: string = top?.data.reason ?? '';
  const guardrailStop = GUARDRAIL_REASON.test(reason);

  // identity / guardrail: denied calls belong to the guardrail layer when the reason says so.
  const decisions = of('tool_decision');
  const denied = decisions.filter((e) => e.data.allowed === false);
  const guardDenied = denied.filter((e) => GUARDRAIL_REASON.test(String(e.data.reason ?? '')));
  const idDenied = denied.filter((e) => !guardDenied.includes(e));
  const deniedIds = new Set(denied.map((e) => e.data.callId));

  // tool: errors other than denials, plus malformed arguments (even when repaired).
  const results = of('tool_result');
  if (results.length) {
    const bad = new Map<string, string>();
    for (const e of results) if (e.data.isError && !deniedIds.has(e.data.callId)) bad.set(e.data.callId, `${e.data.name}: ${truncate(String(e.data.content), 100)}`);
    for (const e of of('tool_args_invalid')) bad.set(e.data.callId, `${e.data.name}: invalid arguments${e.data.repaired ? ' (repaired)' : ''}`);
    const callIds = new Set([...results.map((e) => e.data.callId), ...bad.keys()]);
    scores.push(layerScore('tool', 1 - bad.size / callIds.size, bad.size ? `${bad.size}/${callIds.size} calls failed: ${[...bad.values()].slice(0, 3).join('; ')}` : `${callIds.size} calls ok`));
  }

  if (decisions.length) {
    scores.push(layerScore('identity', 1 - idDenied.length / (decisions.length - guardDenied.length || 1),
      idDenied.length ? `${idDenied.length} denied: ${idDenied.slice(0, 3).map((e) => `${e.data.name} (${truncate(String(e.data.reason ?? ''), 80)})`).join('; ')}` : 'no denials'));
  }

  const guardEvents = of('guardrail');
  const guardHits = guardEvents.filter((e) => e.data.action !== 'allow').length + guardDenied.length + (guardrailStop && !guardEvents.some((e) => e.data.action === 'block') ? 1 : 0);
  const guardTotal = guardEvents.length + guardDenied.length + (guardrailStop && !guardEvents.some((e) => e.data.action === 'block') ? 1 : 0);
  if (guardTotal) scores.push(layerScore('guardrail', 1 - guardHits / guardTotal, guardHits ? `${guardHits}/${guardTotal} checks intervened${guardrailStop ? ` (${reason})` : ''}` : `${guardTotal} checks passed`));

  // llm: truncated or refused answers, structured-output retries, or a run that failed for a model-side reason.
  const responses = of('model_response').filter((e) => !e.data.discarded);
  const retried = of('message').filter((e) => e.data.source === 'harness' && e.data.message?.role === 'user' && e.data.message.parts?.some((p: any) => String(p.text ?? '').startsWith(FEEDBACK_PREFIX))).length;
  const truncated = responses.filter((e) => e.data.stopReason === 'max_tokens' || e.data.stopReason === 'refusal').length;
  const llmFailed = run.status !== 'completed' && LLM_FAILURE.test(reason);
  if (llmFailed) scores.push(layerScore('llm', 0, `run ${run.status}: ${truncate(reason, 160)}`));
  else if (responses.length) {
    const badCount = Math.min(responses.length, truncated + retried);
    scores.push(layerScore('llm', 1 - badCount / responses.length, badCount ? `${truncated} truncated/refused, ${retried} invalid structured output retries in ${responses.length} responses` : `${responses.length} responses ok`));
  }

  // harness: the run itself (budget, failure, interruption, compaction).
  const compactions = of('compaction').length;
  if (run.status === 'completed') {
    scores.push(layerScore('harness', compactions ? COMPACTED_VALUE : 1, compactions ? `completed after ${compactions} context compaction(s)` : 'completed'));
  } else if (!llmFailed && !guardrailStop) {
    scores.push(layerScore('harness', 0, `run ${run.status}${reason ? `: ${truncate(reason, 160)}` : ''}`));
  }

  const retrievals = of('knowledge_retrieval').flatMap((e) => {
    const n = passageCount(e.data);
    return n === undefined ? [] : [n];
  });
  if (retrievals.length) {
    const empty = retrievals.filter((n) => n === 0).length;
    scores.push(layerScore('knowledge', 1 - empty / retrievals.length, empty ? `${empty}/${retrievals.length} retrievals returned no passages` : `${retrievals.length} retrievals returned passages`));
  }

  // cache: hit rate, from explicit cache events or provider cache token counts.
  const cacheEvents = events.filter((e) => /^cache(_|$)/.test(e.type));
  const tokenSignal = responses.some((e) => (e.data.usage?.cacheReadTokens ?? 0) > 0 || (e.data.usage?.cacheWriteTokens ?? 0) > 0);
  if (cacheEvents.length || tokenSignal) {
    const hits = cacheEvents.length
      ? cacheEvents.filter((e) => e.type === 'cache_hit' || e.data.hit === true).length
      : responses.filter((e) => (e.data.usage?.cacheReadTokens ?? 0) > 0).length;
    const total = cacheEvents.length || responses.length;
    scores.push(layerScore('cache', hits / total, `${hits}/${total} cache hits`));
  }
  return scores;
}
