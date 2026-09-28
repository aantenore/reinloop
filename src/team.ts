import { createEmitter, createHandle, normalizeInput, type RunHandle, stream } from './loop.ts';
import { initialState } from './state.ts';
import { memoryStore } from './store/memory.ts';
import type { Agent, Message, RunOptions, RunResult, RunStatus, Usage } from './types.ts';
import { addUsage, emptyUsage, errorMessage, newId, textOf } from './util.ts';

export interface TeamOutcome { output: string; data?: unknown; status?: RunStatus; reason?: string }

export interface TeamContext {
  runId: string;
  team: string;
  signal: AbortSignal;
  /** The task as plain text (all input messages joined). */
  task: string;
  /**
   * Runs a member as a child run linked by parentRunId. Calls sharing a `session` key continue
   * the same conversation (agents only), which keeps the prompt prefix cache-friendly.
   */
  call(member: Member, input: string | Message[], opts?: { session?: string }): Promise<RunResult>;
}

/** A multi-agent unit built from a pattern; runs, streams and composes exactly like an agent. */
export interface Team {
  kind: 'team';
  name: string;
  description?: string;
  pattern: string;
  members: Member[];
  execute(input: Message[], ctx: TeamContext): Promise<TeamOutcome>;
}

export type Member = Agent | Team;

export const isTeam = (m: unknown): m is Team => typeof m === 'object' && m !== null && (m as Team).kind === 'team';

/** Runs any member (agent or team) with the same handle semantics. */
export function streamMember(member: Member, input?: string | Message[], opts: RunOptions = {}): RunHandle {
  return isTeam(member) ? streamTeam(member, input, opts) : stream(member, input, opts);
}

export function runMember(member: Member, input?: string | Message[], opts: RunOptions = {}): Promise<RunResult> {
  return streamMember(member, input, opts).result;
}

function subtract(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens - b.inputTokens, outputTokens: a.outputTokens - b.outputTokens };
}

/** Teams keep an event log (start, input, output, end) and aggregate usage and cost of their members. */
export function streamTeam(team: Team, input?: string | Message[], opts: RunOptions = {}): RunHandle {
  const runId = opts.runId ?? newId();
  return createHandle(runId, opts.signal, async (signal, channel) => {
    const store = opts.store ?? memoryStore(); // shared by members so sessions can continue
    const state = initialState(runId, team.name);
    const { emit, flush } = createEmitter(state, store, opts, channel);
    const messages = normalizeInput(input);
    let usage = emptyUsage();
    let costUsd = 0;
    let turns = 0;
    const sessions = new Map<string, RunResult>();

    emit('run_start', { agent: team.name, resumed: false, parentRunId: opts.parentRunId });
    for (const message of messages) emit('message', { message, source: 'input' });

    const ctx: TeamContext = {
      runId,
      team: team.name,
      signal,
      task: messages.map(textOf).filter(Boolean).join('\n\n'),
      async call(member, memberInput, o = {}) {
        signal.throwIfAborted();
        const previous = o.session && !isTeam(member) ? sessions.get(o.session) : undefined;
        const handle = streamMember(member, memberInput, {
          store, sinks: opts.sinks, approve: opts.approve, signal, parentRunId: runId, runId: previous?.runId,
        });
        for await (const ev of handle) channel.push(ev);
        const result = await handle.result;
        usage = addUsage(usage, previous ? subtract(result.usage, previous.usage) : result.usage);
        costUsd += result.costUsd - (previous?.costUsd ?? 0);
        turns += result.turns - (previous?.turns ?? 0);
        if (o.session) sessions.set(o.session, result);
        return result;
      },
    };

    let outcome: TeamOutcome;
    try {
      outcome = await team.execute(messages, ctx);
    } catch (err) {
      outcome = signal.aborted
        ? { output: '', status: 'interrupted', reason: errorMessage(signal.reason ?? err) }
        : { output: '', status: 'failed', reason: errorMessage(err) };
    }
    const status = outcome.status ?? 'completed';
    if (outcome.output) emit('message', { message: { role: 'assistant', parts: [{ type: 'text', text: outcome.output }] }, source: 'harness' });
    emit('run_end', { status, reason: outcome.reason, output: outcome.output, usage, turns, costUsd });
    await flush().catch(() => {});
    return { runId, status, reason: outcome.reason, output: outcome.output, data: outcome.data, usage, costUsd, turns, messages: state.messages };
  });
}
