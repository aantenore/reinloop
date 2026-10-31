import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rank } from '../knowledge/rank.ts';
import { limitDefault } from '../limits.ts';
import type { Tool } from '../types.ts';
import { defineTool } from './define.ts';

export interface Note { text: string; tags?: string[]; agent: string; ts: number }

export interface MemoryStore {
  add(namespace: string, note: Note): Promise<void>;
  all(namespace: string): Promise<Note[]>;
  /** Optional ranked search (e.g. embeddings, full-text). When absent, `recall` ranks `all()` by keyword overlap. */
  search?(namespace: string, query: string, limit: number): Promise<Note[]>;
}

export function memoryNotes(): MemoryStore {
  const spaces = new Map<string, Note[]>();
  return {
    async add(ns, note) {
      spaces.set(ns, [...(spaces.get(ns) ?? []), note]);
    },
    async all(ns) {
      return spaces.get(ns) ?? [];
    },
  };
}

/** Durable notes as JSONL, one file per namespace. */
export function fileNotes(dir: string): MemoryStore {
  const file = (ns: string) => join(dir, `${ns.replace(/[^a-zA-Z0-9_.-]/g, '_')}.jsonl`);
  return {
    async add(ns, note) {
      await mkdir(dir, { recursive: true });
      await appendFile(file(ns), `${JSON.stringify(note)}\n`);
    },
    async all(ns) {
      try {
        return (await readFile(file(ns), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Note);
      } catch {
        return [];
      }
    },
  };
}

export { rank };

export interface MemoryToolsOptions {
  store: MemoryStore;
  /** `shared`: one notebook for all agents; `agent`: one per agent. */
  scope?: 'shared' | 'agent';
  namespace?: string;
  /** Notes `recall` returns when the model gives no limit (default 8). */
  recallLimit?: number;
}

/** `remember` / `recall`: long-term notes that survive sessions. */
export function memoryTools(opts: MemoryToolsOptions): { remember: Tool; recall: Tool } {
  const ns = (agent: string) => (opts.scope === 'agent' ? `${opts.namespace ?? 'default'}.${agent}` : (opts.namespace ?? 'default'));
  return {
    remember: defineTool<{ text: string; tags?: string[] }>({
      name: 'remember',
      description: 'Store a durable note (fact, decision, preference) for future sessions.',
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['text'],
        additionalProperties: false,
      },
      async run({ text, tags }, ctx) {
        await opts.store.add(ns(ctx.agent), { text, tags, agent: ctx.agent, ts: Date.now() });
        return 'saved';
      },
    }),
    recall: defineTool<{ query: string; limit?: number }>({
      name: 'recall',
      description: 'Search durable notes saved in earlier sessions.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
        required: ['query'],
        additionalProperties: false,
      },
      async run({ query, limit = opts.recallLimit ?? limitDefault('memory.recallLimit') }, ctx) {
        const space = ns(ctx.agent);
        const hits = opts.store.search
          ? (await opts.store.search(space, query, limit)).slice(0, limit)
          : rank(await opts.store.all(space), query, limit);
        return hits.length ? hits.map((n) => `- ${n.text}${n.tags?.length ? ` [${n.tags.join(', ')}]` : ''}`).join('\n') : 'no matching notes';
      },
    }),
  };
}
