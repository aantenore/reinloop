import { resolveModel } from '../presets.ts';
import { replay as foldEvents } from '../state.ts';
import { memoryStore } from '../store/memory.ts';
import { isTeam, type Member, streamMember } from '../team.ts';
import type { Message, ModelRef, RunEvent, RunOptions, RunResult, RunStatus, RunStore } from '../types.ts';
import { errorMessage, textOf } from '../util.ts';

export interface ReplayOverrides {
  /** `"provider/model"`, an alias, or a ModelRef. Model params of the agent are dropped (they are provider specific). */
  model?: string | ModelRef;
  instructions?: string;
}

export interface ReplayOptions {
  /** Where the original runs are stored. */
  store: RunStore;
  /** Runs to replay; with `all`, every top-level run of the store (member runs of teams are skipped). */
  runIds?: string[];
  all?: boolean;
  /** Agent that answers the stored inputs. */
  agent: Member;
  overrides?: ReplayOverrides;
  /** Where the replayed runs go (default: in memory, so the original store is left untouched). */
  into?: RunStore;
  concurrency?: number;
  runOptions?: Omit<RunOptions, 'runId' | 'store' | 'signal'>;
  signal?: AbortSignal;
}

/** One comparison row: the original run next to its replay. */
export interface ReplayRow {
  runId: string;
  input: string;
  originalOutput: string;
  originalStatus: RunStatus;
  originalCostUsd: number;
  originalTurns: number;
  replayRunId: string;
  output: string;
  status: RunStatus;
  costUsd: number;
  turns: number;
  reason?: string;
  /** The replay produced a different output. */
  changed: boolean;
}

/** The agent with another model and/or instructions. Teams cannot be overridden: their roles are fixed at build time. */
export function withOverrides(agent: Member, overrides: ReplayOverrides = {}): Member {
  if (overrides.model === undefined && overrides.instructions === undefined) return agent;
  if (isTeam(agent)) throw new Error(`cannot override the model or instructions of team "${agent.name}"; replay one of its member agents instead`);
  return {
    ...agent,
    ...(overrides.model !== undefined && { model: resolveModel(overrides.model) }),
    ...(overrides.instructions !== undefined && { instructions: overrides.instructions }),
  };
}

/** Input messages of a stored run, one group per run segment (a continued session has several). */
export function inputSegments(events: RunEvent[]): Message[][] {
  const segments: Message[][] = [];
  for (const ev of events) {
    if (ev.type === 'run_start') segments.push([]);
    else if (ev.type === 'message' && ev.data.source === 'input') (segments.at(-1) ?? segments[segments.push([]) - 1]!).push(ev.data.message);
  }
  return segments.filter((s) => s.length);
}

async function replayOne(runId: string, events: RunEvent[], agent: Member, opts: ReplayOptions, into: RunStore): Promise<ReplayRow> {
  const segments = inputSegments(events);
  const original = foldEvents(runId, '', events);
  const originalOutput = [...events].reverse().find((e): e is RunEvent<'run_end'> => e.type === 'run_end')?.data.output ?? '';
  const base = {
    runId,
    input: segments.map((s) => s.map((m) => textOf(m)).join('\n')).join('\n---\n'),
    originalOutput,
    originalStatus: original.status,
    originalCostUsd: original.costUsd,
    originalTurns: original.turns,
  };
  // A continued session is replayed turn by turn in one new session.
  let last: RunResult | undefined;
  let replayRunId = '';
  try {
    for (const segment of segments) {
      const handle = streamMember(agent, segment, { ...opts.runOptions, store: into, signal: opts.signal, ...(last && { runId: last.runId }) });
      replayRunId = handle.runId;
      last = await handle.result;
      if (last.status !== 'completed') break;
    }
  } catch (err) {
    return { ...base, replayRunId, output: '', status: 'failed', costUsd: 0, turns: 0, reason: errorMessage(err), changed: originalOutput !== '' };
  }
  if (!last) return { ...base, replayRunId, output: '', status: 'failed', costUsd: 0, turns: 0, reason: 'no stored input to replay', changed: false };
  return {
    ...base, replayRunId, output: last.output, status: last.status, costUsd: last.costUsd, turns: last.turns,
    ...(last.reason && { reason: last.reason }), changed: last.output !== originalOutput,
  };
}

/** Re-runs the stored inputs of past runs against another agent or model and returns original-vs-replay rows. */
export async function replayRuns(opts: ReplayOptions): Promise<ReplayRow[]> {
  const { store } = opts;
  if (!opts.all && !opts.runIds?.length) throw new Error('replay needs runIds or all: true');
  const ids = opts.runIds?.length ? opts.runIds : ((await store.list?.()) ?? []);
  if (opts.all && !store.list) throw new Error('this run store cannot list runs; pass runIds');
  const agent = withOverrides(opts.agent, opts.overrides);
  const into = opts.into ?? memoryStore();

  const loaded: Array<{ runId: string; events: RunEvent[] }> = [];
  for (const runId of ids) {
    const events = await store.load(runId);
    if (!events.length) throw new Error(`run "${runId}" not found in the store`);
    const start = events.find((e): e is RunEvent<'run_start'> => e.type === 'run_start');
    if (opts.all && start?.data.parentRunId) continue;
    loaded.push({ runId, events });
  }

  const rows = new Array<ReplayRow>(loaded.length);
  let next = 0;
  const worker = async () => {
    while (next < loaded.length) {
      const i = next++;
      rows[i] = await replayOne(loaded[i]!.runId, loaded[i]!.events, agent, opts, into);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, loaded.length)) }, worker));
  return rows;
}
