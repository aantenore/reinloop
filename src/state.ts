import type { EventType, Message, RunEvent, RunState, ToolCallPart } from './types.ts';
import { addUsage, emptyUsage, toolCallsOf } from './util.ts';

/** Events that are streamed to sinks but never persisted. */
export const EPHEMERAL: ReadonlySet<EventType> = new Set(['text_delta', 'tool_start', 'turn_start', 'model_request']);

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
      state.messages.push(ev.data.message);
      state.usage = addUsage(state.usage, ev.data.usage);
      state.costUsd += ev.data.costUsd;
      state.turns = Math.max(state.turns, ev.data.turn);
      state.lastUsage = ev.data.usage;
      state.lastUsageAt = state.messages.length;
      break;
    case 'tool_result':
      state.toolCalls += 1;
      state.messages.push({
        role: 'tool',
        parts: [{ type: 'tool_result', callId: ev.data.callId, name: ev.data.name, content: ev.data.content, isError: ev.data.isError }],
      });
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
      break;
  }
  return state;
}

export function replay(runId: string, agent: string, events: RunEvent[]): RunState {
  return events.reduce(reduce, initialState(runId, agent));
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

/** Unbounded async queue used to expose the run as an async iterable. */
export class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.queue.push(value);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
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
