import { scoreProblems } from '../eval/contract.ts';
import type { EvalCase, Evaluator, Message, RunEvent, RunStatus } from '../types.ts';
import { errorMessage } from '../util.ts';

export interface EvalFixture { name: string; case: EvalCase; run: { runId: string; output?: string; status: RunStatus; events: RunEvent[] } }

export interface EvaluatorCheckOptions {
  /** Replaces the built-in fixtures (a completed run, a tool failure, a failed run with no output, a run without events). */
  fixtures?: EvalFixture[];
}

let seq = 0;
const ev = <T extends RunEvent['type']>(runId: string, type: T, data: Extract<RunEvent, { type: T }>['data']): RunEvent =>
  ({ runId, seq: ++seq, ts: 0, type, data }) as RunEvent;

function defaultFixtures(): EvalFixture[] {
  const usage = { inputTokens: 10, outputTokens: 5 };
  const message: Message = { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] };
  const end = (runId: string, status: RunStatus, reason?: string, output = 'ok') => ev(runId, 'run_end', { status, reason, output, usage, turns: 1, costUsd: 0 });
  const response = (runId: string) => ev(runId, 'model_response', { turn: 1, model: 'm', message, usage, stopReason: 'end', latencyMs: 1, costUsd: 0 });
  return [
    {
      name: 'completed run',
      case: { id: 'c1', input: 'say ok', expected: 'ok', tags: ['smoke'] },
      run: { runId: 'r1', output: 'ok', status: 'completed', events: [ev('r1', 'run_start', { agent: 'a', resumed: false }), response('r1'), end('r1', 'completed')] },
    },
    {
      name: 'tool failure',
      case: { id: 'c2', input: 'use the tool', layer: 'tool' },
      run: {
        runId: 'r2', output: 'sorry', status: 'completed',
        events: [
          ev('r2', 'run_start', { agent: 'a', resumed: false }),
          ev('r2', 'tool_decision', { callId: 'k1', name: 't', allowed: true, reason: 'allowed' }),
          ev('r2', 'tool_result', { callId: 'k1', name: 't', content: 'Tool error: boom', isError: true, durationMs: 1 }),
          response('r2'), end('r2', 'completed', undefined, 'sorry'),
        ],
      },
    },
    {
      name: 'failed run without output',
      case: { id: 'c3', input: 'anything', expected: { regex: 'x' } },
      run: { runId: 'r3', status: 'failed', events: [ev('r3', 'run_start', { agent: 'a', resumed: false }), end('r3', 'failed', 'budget:turns', '')] },
    },
    { name: 'run without events', case: { id: 'c4', input: 'anything' }, run: { runId: 'r4', output: '', status: 'interrupted', events: [] } },
  ];
}

/** Checks an Evaluator against the evaluation contract: named, never throws on failed runs, scores are valid EvalScores (value 0..1). Empty = conformant. */
export async function checkEvaluator(evaluator: Evaluator, opts: EvaluatorCheckOptions = {}): Promise<string[]> {
  const failures: string[] = [];
  if (typeof evaluator?.name !== 'string' || !evaluator.name) failures.push('evaluator.name must be a non-empty string');
  if (typeof evaluator?.score !== 'function') return [...failures, 'evaluator.score must be a function'];

  for (const f of opts.fixtures ?? defaultFixtures()) {
    let scores: unknown;
    try {
      scores = await evaluator.score(structuredClone(f.case), structuredClone(f.run));
    } catch (err) {
      failures.push(`${f.name}: score() threw instead of returning scores (${errorMessage(err)})`);
      continue;
    }
    if (!Array.isArray(scores)) {
      failures.push(`${f.name}: score() must return an array`);
      continue;
    }
    scores.forEach((s, i) => {
      for (const p of scoreProblems(s)) failures.push(`${f.name}: scores[${i}] ${p}`);
    });
  }
  return failures;
}
