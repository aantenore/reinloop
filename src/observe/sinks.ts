import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent, Sink } from '../types.ts';
import { truncate } from '../util.ts';

export interface ConsoleSinkOptions {
  /** `info`: tools, decisions, end of run. `debug`: also model calls and compaction. */
  level?: 'info' | 'debug';
  write?: (line: string) => void;
}

/** Human-readable progress on stderr; never prints streamed text (stdout owns that). */
export function consoleSink(opts: ConsoleSinkOptions = {}): Sink {
  const debug = opts.level === 'debug';
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    name: 'console',
    onEvent(ev) {
      const who = ev.parentRunId ? '  ↳' : '•';
      switch (ev.type) {
        case 'tool_start':
          write(`${who} ${ev.data.name} ${truncate(JSON.stringify(ev.data.args), 160)}`);
          break;
        case 'tool_decision':
          if (!ev.data.allowed) write(`${who} denied ${ev.data.name}: ${ev.data.reason}`);
          break;
        case 'tool_result':
          if (ev.data.isError) write(`${who} ${ev.data.name} failed: ${truncate(ev.data.content, 200)}`);
          else if (debug) write(`${who} ${ev.data.name} ok (${ev.data.durationMs}ms, ${ev.data.content.length} chars)`);
          break;
        case 'model_response':
          if (debug) {
            const u = ev.data.usage;
            write(`${who} turn ${ev.data.turn} ${ev.data.model} ${ev.data.latencyMs}ms in=${u.inputTokens} out=${u.outputTokens}${u.cacheReadTokens ? ` cached=${u.cacheReadTokens}` : ''}`);
          }
          break;
        case 'compaction':
          write(`${who} compacted context (${ev.data.strategy}): ~${ev.data.beforeTokens} → ~${ev.data.afterTokens} tokens`);
          break;
        case 'run_end':
          if (!ev.parentRunId || debug) {
            const u = ev.data.usage;
            const cost = ev.data.costUsd ? ` $${ev.data.costUsd.toFixed(4)}` : '';
            write(`${who} ${ev.data.status}${ev.data.reason ? ` (${ev.data.reason})` : ''} · ${ev.data.turns} turns · ${u.inputTokens}/${u.outputTokens} tokens${cost} · run ${ev.runId}`);
          }
          break;
      }
    },
  };
}

/** Writes every event (including ephemeral ones, except text deltas) to `<dir>/<runId>.trace.jsonl`. */
export function jsonlSink(dir: string, opts: { includeDeltas?: boolean } = {}): Sink {
  mkdirSync(dir, { recursive: true });
  return {
    onEvent(ev) {
      if (ev.type === 'text_delta' && !opts.includeDeltas) return;
      appendFileSync(join(dir, `${ev.runId}.trace.jsonl`), `${JSON.stringify(ev)}\n`);
    },
  };
}

/** Collects events in memory; handy for tests and custom UIs. */
export function collectSink(): Sink & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { events, onEvent: (ev) => void events.push(ev) };
}
