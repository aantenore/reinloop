import type { EventType, Message, RunEvent, RunState, ToolCallPart } from './types.ts';
import { addUsage, emptyUsage, hasVisibleParts, hostedCallsOf, toolCallsOf } from './util.ts';

/** Events that are streamed to sinks but never persisted. */
export const EPHEMERAL: ReadonlySet<EventType> = new Set([
  'text_delta', 'thinking_delta', 'tool_start', 'turn_start', 'model_request', 'hosted_tool_start', 'hosted_tool_result',
]);

export function initialState(runId: string, agent: string): RunState {
  return { runId, agent, messages: [], usage: emptyUsage(), costUsd: 0, turns: 0, toolCalls: 0, status: 'running', seq: 0 };
}

/** Pure reducer: the run state is a fold over its event log (event sourcing). */
export function reduce(state: RunState, ev: RunEvent): RunState {
  state.seq = Math.max(state.seq, ev.seq);
  switch (ev.type) {
    case 'message':
      state.messages.push(ev.data.message);
      break;
    case 'model_response':
      // Answers without text or tool calls (also reasoning-only ones) are accounted for but kept out of the history.
      if (hasVisibleParts(ev.data.message) && !ev.data.discarded) state.messages.push(ev.data.message);
      state.usage = addUsage(state.usage, ev.data.usage);
      state.costUsd += ev.data.costUsd;
      // Provider-hosted calls already ran (and were billed), also in a discarded answer: they count as tool calls.
      state.toolCalls += hostedCallsOf(ev.data.message);
      state.turns = Math.max(state.turns, ev.data.turn);
      state.lastUsage = ev.data.usage;
      state.lastUsageAt = state.messages.length;
      break;
    case 'tool_result':
      state.toolCalls += 1;
      // Spend of the runs the call delegated to counts as this run's own.
      if (ev.data.usage) state.usage = addUsage(state.usage, ev.data.usage);
      state.costUsd += ev.data.costUsd ?? 0;
      state.messages.push({
        role: 'tool',
        parts: [{ type: 'tool_result', callId: ev.data.callId, name: ev.data.name, content: ev.data.content, isError: ev.data.isError }],
      });
      if (ev.data.stop) {
        state.stops ??= {};
        state.stops[ev.data.callId] = { name: ev.data.name, content: ev.data.content, ...('data' in ev.data && { data: ev.data.data }) };
      }
      break;
    case 'compaction':
      state.messages = [...ev.data.messages];
      if (ev.data.usage) state.usage = addUsage(state.usage, ev.data.usage);
      state.costUsd += ev.data.costUsd ?? 0;
      state.lastUsage = undefined;
      state.lastUsageAt = undefined;
      break;
    case 'run_start':
      state.status = 'running';
      break;
    case 'run_end':
      state.status = ev.data.status;
      state.stops = undefined;
      break;
  }
  return state;
}

export function replay(runId: string, agent: string, events: RunEvent[]): RunState {
  return events.reduce(reduce, initialState(runId, agent));
}

/**
 * Replays a stored log and returns where its budget window stands: `base` holds the counters at the last `run_end`
 * (budgets count from there) and `activeMs` the time the invocations after it were active (first to last event of
 * each). A log that ends with `run_end` opens a new window; one that ends without it (a crash) continues its window.
 */
export function replayWindow(runId: string, agent: string, events: RunEvent[]) {
  const counters = (s: RunState) => ({ turns: s.turns, toolCalls: s.toolCalls, usage: s.usage, costUsd: s.costUsd });
  const state = initialState(runId, agent);
  let base = counters(state);
  let activeMs = 0;
  let from: number | undefined;
  let last = 0;
  for (const ev of events) {
    reduce(state, ev);
    if (ev.type === 'run_start') {
      if (from !== undefined) activeMs += last - from;
      from = ev.ts;
    }
    last = ev.ts;
    if (ev.type === 'run_end') {
      base = counters(state);
      activeMs = 0;
      from = undefined;
    }
  }
  if (from !== undefined) activeMs += last - from;
  return { state, base, activeMs };
}

/** Tool calls of the latest assistant message that have no result yet (crash-safe resume). */
export function pendingToolCalls(messages: Message[]): ToolCallPart[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'assistant') {
      const done = new Set<string>();
      for (const later of messages.slice(i + 1)) {
        for (const p of later.parts) if (p.type === 'tool_result') done.add(p.callId);
      }
      return toolCallsOf(msg).filter((c) => !done.has(c.id));
    }
    if (msg.role === 'user') return [];
  }
  return [];
}

/** Events a run keeps for a consumer that has not started iterating; older ones are dropped (store and sinks get all). */
export const IDLE_EVENT_BUFFER = 256;

/**
 * Async queue used to expose the run as an async iterable. Until a consumer iterates it keeps only the latest
 * `idleLimit` items, so a run nobody iterates (`run`, a delegated run) does not hold its whole event stream in memory;
 * once a consumer iterates, nothing is dropped.
 */
export class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private attached = false;
  private readonly idleLimit: number;

  constructor(idleLimit = IDLE_EVENT_BUFFER) {
    this.idleLimit = idleLimit;
  }

  push(value: T): void {
    if (this.closed) return;
    if (!this.attached && this.queue.length >= this.idleLimit) this.queue.shift();
    this.queue.push(value);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    this.attached = true;
    return this.drain();
  }

  private async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
