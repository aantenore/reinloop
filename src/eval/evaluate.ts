import { memoryStore } from '../store/memory.ts';
import { type Member, streamMember } from '../team.ts';
import type { EvalCase, EvalScore, Evaluator, RunEvent, RunOptions, RunStatus, RunStore } from '../types.ts';
import { errorMessage } from '../util.ts';
import type { EvalResult } from './contract.ts';

export interface EvaluateOptions {
  agent: Member;
  cases: EvalCase[];
  evaluators?: Evaluator[];
  /** Where the runs are stored (default: in memory). Use the project store to `replay` the runs later. */
  store?: RunStore;
  /** Cases run at once (default 1). */
  concurrency?: number;
  /** Extra run options (sinks, approve, identity...); `runId`, `store` and `signal` are set here. */
  runOptions?: Omit<RunOptions, 'runId' | 'store' | 'signal'>;
  signal?: AbortSignal;
  onResult?: (row: EvalResult, index: number) => void;
}

/** A case whose evaluator throws gets a zero score on the `eval` layer: a broken evaluator must not hide as a pass. */
async function applyEvaluators(
  evaluators: Evaluator[],
  c: EvalCase,
  run: { runId: string; output?: string; status: RunStatus; events: RunEvent[] },
): Promise<EvalScore[]> {
  const settled = await Promise.all(
    evaluators.map(async (ev): Promise<EvalScore[]> => {
      try {
        return await ev.score(c, run);
      } catch (err) {
        return [{ metric: ev.name, value: 0, layer: 'eval', reason: `evaluator error: ${errorMessage(err)}` }];
      }
    }),
  );
  return settled.flat();
}

/** Runs every case against the agent, collects the events and applies the evaluators. Rows keep the dataset order. */
export async function evaluate(opts: EvaluateOptions): Promise<EvalResult[]> {
  const { agent, cases, evaluators = [] } = opts;
  const store = opts.store ?? memoryStore();
  const rows = new Array<EvalResult>(cases.length);
  let next = 0;

  const runCase = async (c: EvalCase): Promise<EvalResult> => {
    const events: RunEvent[] = [];
    const handle = streamMember(agent, c.input, { ...opts.runOptions, store, signal: opts.signal });
    let output = '';
    let status: RunStatus = 'failed';
    let failure: string | undefined;
    try {
      for await (const ev of handle) events.push(ev);
      const res = await handle.result;
      output = res.output;
      status = res.status;
    } catch (err) {
      failure = errorMessage(err);
    }
    const scores = await applyEvaluators(evaluators, c, { runId: handle.runId, output, status, events });
    if (failure) scores.push({ metric: 'run_error', value: 0, layer: 'harness', reason: failure });
    return { id: c.id, runId: handle.runId, output, status, scores };
  };

  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      rows[i] = await runCase(cases[i]!);
      opts.onResult?.(rows[i]!, i);
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? 1, cases.length));
  await Promise.all(Array.from({ length: width }, worker));
  return rows;
}

/** Mean value per metric over all rows (for a one-line summary). */
export function summarize(rows: EvalResult[]): Record<string, { mean: number; count: number }> {
  const acc: Record<string, { sum: number; count: number }> = {};
  for (const row of rows) {
    for (const s of row.scores) {
      const a = (acc[s.metric] ??= { sum: 0, count: 0 });
      a.sum += s.value;
      a.count++;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { mean: v.sum / v.count, count: v.count }]));
}
