import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '../types.ts';
import { defineTool } from './define.ts';

export interface Note { text: string; tags?: string[]; agent: string; ts: number }

export interface MemoryStore {
  add(namespace: string, note: Note): Promise<void>;
  all(namespace: string): Promise<Note[]>;
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

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/** Keyword-overlap ranking: dependency-free and predictable; swap the store for embeddings if needed. */
export function rank(notes: Note[], query: string, limit: number): Note[] {
  const q = words(query);
  return notes
    .map((n, i) => {
      const w = words(`${n.text} ${(n.tags ?? []).join(' ')}`);
      let score = 0;
      for (const t of q) if (w.has(t)) score++;
      return { n, score: score + i / (notes.length * 1000) }; // recency breaks ties
    })
    .filter((x) => x.score >= 1 || !q.size)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.n);
}

export interface MemoryToolsOptions {
  store: MemoryStore;
  /** `shared`: one notebook for all agents; `agent`: one per agent. */
  scope?: 'shared' | 'agent';
  namespace?: string;
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
      async run({ query, limit = 8 }, ctx) {
        const hits = rank(await opts.store.all(ns(ctx.agent)), query, limit);
        return hits.length ? hits.map((n) => `- ${n.text}${n.tags?.length ? ` [${n.tags.join(', ')}]` : ''}`).join('\n') : 'no matching notes';
      },
    }),
  };
}
