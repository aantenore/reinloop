import { readFile, writeFile } from 'node:fs/promises';
import type { Runtime } from '../config/runtime.ts';
import { runMember } from '../team.ts';
import { parseDataset, toJsonl } from './contract.ts';
import { evaluate, summarize } from './evaluate.ts';
import { expectedEvaluator, judgeEvaluator, layerSignals } from './evaluators.ts';
import { replayRuns } from './replay.ts';

/** The subset of parsed CLI options these commands read. */
export interface EvalCliValues { agent?: string; model?: string; out?: string; judge?: string; all?: boolean; yes?: boolean }

/** Dataset path: the argument, else `$EVAL_DATASET`. */
export function datasetPath(rest: string[], env: NodeJS.ProcessEnv = process.env): string {
  const path = rest[0] ?? env.EVAL_DATASET;
  if (!path) throw new Error('usage: reinloop eval <dataset.jsonl> --agent X [--out results.jsonl] [--judge J]   (or set EVAL_DATASET)');
  return path;
}

/** Run ids to replay: the arguments, or every run with `--all` (not both). */
export function replayTargets(rest: string[], values: Pick<EvalCliValues, 'all'>): { runIds?: string[]; all: boolean } {
  if (values.all && rest.length) throw new Error('replay: pass run ids or --all, not both');
  if (!values.all && !rest.length) throw new Error('usage: reinloop replay <runId...|--all> [--agent X] [--model Y] [--out results.jsonl]');
  return values.all ? { all: true } : { runIds: rest, all: false };
}

async function emitRows(rows: unknown[], out: string | undefined): Promise<void> {
  if (out) await writeFile(out, toJsonl(rows));
  else process.stdout.write(toJsonl(rows));
}

/** `reinloop eval <dataset.jsonl>`: runs the agent on every case, scores with `expected` + per-layer signals (+ judge). */
export async function evalCommand(rt: Runtime, rest: string[], values: EvalCliValues): Promise<number> {
  const path = datasetPath(rest);
  const cases = parseDataset(await readFile(path, 'utf8'));
  const agent = await rt.agent(values.agent);
  const evaluators = [expectedEvaluator(), layerSignals(), ...(values.judge ? [judgeEvaluator({ agent: { run: async (input) => runMember(await rt.agent(values.judge), input) } })] : [])];
  const rows = await evaluate({
    agent,
    cases,
    evaluators,
    store: rt.store,
    runOptions: { sinks: rt.sinks, approve: values.yes ? () => true : undefined },
  });
  await emitRows(rows, values.out);
  const summary = Object.entries(summarize(rows)).map(([metric, s]) => `${metric}=${s.mean.toFixed(2)}(${s.count})`).join(' ');
  process.stderr.write(`${rows.length} cases${values.out ? ` -> ${values.out}` : ''} · ${summary}\n`);
  return 0;
}

/** `reinloop replay <runId...|--all>`: re-runs stored inputs against another agent or model. */
export async function replayCommand(rt: Runtime, rest: string[], values: EvalCliValues): Promise<number> {
  const targets = replayTargets(rest, values);
  const rows = await replayRuns({
    store: rt.store,
    ...targets,
    agent: await rt.agent(values.agent),
    overrides: { model: values.model },
    runOptions: { sinks: rt.sinks, approve: values.yes ? () => true : undefined },
  });
  await emitRows(rows, values.out);
  const changed = rows.filter((r) => r.changed).length;
  process.stderr.write(`${rows.length} runs replayed${values.out ? ` -> ${values.out}` : ''} · ${changed} with a different output\n`);
  return 0;
}
