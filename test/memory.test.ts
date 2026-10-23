import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryNotes, memoryTools, type MemoryStore, type Note } from '../src/index.ts';
import type { ToolContext } from '../src/types.ts';

const ctx = { agent: 'a' } as ToolContext;
const note = (text: string): Note => ({ text, agent: 'a', ts: 0 });

describe('memory recall', () => {
  it('uses the store search hook when present and keeps its order', async () => {
    const calls: unknown[][] = [];
    const store: MemoryStore = {
      async add() {},
      async all() {
        throw new Error('all() must not be called when search() exists');
      },
      async search(ns, query, limit) {
        calls.push([ns, query, limit]);
        return [note('zeta unrelated'), note('alpha match'), note('beta extra')];
      },
    };
    const { recall } = memoryTools({ store, namespace: 'kb' });
    const out = await recall.run({ query: 'alpha', limit: 2 }, ctx);
    assert.deepEqual(calls, [['kb', 'alpha', 2]]);
    assert.equal(out, '- zeta unrelated\n- alpha match');
  });

  it('falls back to keyword ranking of all() without a search hook', async () => {
    const store = memoryNotes();
    const { remember, recall } = memoryTools({ store });
    await remember.run({ text: 'the deploy uses blue green' }, ctx);
    await remember.run({ text: 'coffee preference is espresso' }, ctx);
    assert.equal(await recall.run({ query: 'espresso coffee' }, ctx), '- coffee preference is espresso');
    assert.equal(await recall.run({ query: 'nothing here' }, ctx), 'no matching notes');
  });
});
