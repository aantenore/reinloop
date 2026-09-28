import type { CompactionStrategy, Message } from './types.ts';
import { textOf, userMessage } from './util.ts';

/**
 * Index where the kept tail starts, moved back so the tail never begins with
 * orphan tool results (their tool calls must stay in the same window).
 */
function tailStart(messages: Message[], keepLast: number): number {
  let start = Math.max(0, messages.length - keepLast);
  while (start > 0 && messages[start]!.role === 'tool') start--;
  return start;
}

export interface WindowOptions {
  keepFirst?: number;
  keepLast?: number;
  /** Visible marker inserted where messages were dropped; `{count}` is replaced. Empty string disables it. */
  note?: string;
}

/** Drops the middle of the conversation, keeping the task (first messages) and the recent tail. */
export function windowCompaction(opts: WindowOptions = {}): CompactionStrategy {
  const keepFirst = opts.keepFirst ?? 1;
  const keepLast = opts.keepLast ?? 20;
  const note = opts.note ?? '[{count} earlier messages omitted to fit the context window]';
  return {
    name: 'window',
    async compact(messages) {
      const start = tailStart(messages, keepLast);
      const headEnd = Math.min(keepFirst, start);
      const dropped = start - headEnd;
      if (dropped <= 0) return messages;
      const head = messages.slice(0, headEnd).filter((m) => m.role === 'user');
      const marker = note ? [userMessage(note.replace('{count}', String(dropped)))] : [];
      return [...head, ...marker, ...messages.slice(start)];
    },
  };
}

export const DEFAULT_SUMMARY_PROMPT =
  'Summarize the conversation below for a continuation of the same task. Keep goals, decisions, facts learned, file names, open questions and next steps. Be concise; no preamble.';

export interface SummarizeOptions {
  keepLast?: number;
  prompt?: string;
  maxTokens?: number;
}

/** Replaces older messages with a model-written summary; the recent tail is kept verbatim. */
export function summarizeCompaction(opts: SummarizeOptions = {}): CompactionStrategy {
  const keepLast = opts.keepLast ?? 10;
  return {
    name: 'summarize',
    async compact(messages, ctx) {
      const start = tailStart(messages, keepLast);
      if (start <= 0) return messages;
      const transcript = messages.slice(0, start).map(render).join('\n');
      const res = await ctx.model.provider.generate(
        {
          model: ctx.model.model,
          instructions: opts.prompt ?? DEFAULT_SUMMARY_PROMPT,
          messages: [userMessage(transcript)],
          tools: [],
          params: { ...ctx.model.params, maxTokens: opts.maxTokens ?? 2048 },
        },
        { signal: ctx.signal },
      );
      ctx.track(res.usage);
      return [userMessage(`Summary of the earlier conversation:\n${textOf(res.message)}`), ...messages.slice(start)];
    },
  };
}

function render(m: Message): string {
  return m.parts
    .map((p) => {
      if (p.type === 'text') return `${m.role}: ${p.text}`;
      if (p.type === 'tool_call') return `assistant called ${p.name}(${JSON.stringify(p.args)})`;
      return `tool ${p.name}${p.isError ? ' (error)' : ''}: ${p.content.slice(0, 2000)}`;
    })
    .join('\n');
}
