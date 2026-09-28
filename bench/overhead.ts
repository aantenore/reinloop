// Measures framework overhead with a zero-latency provider: cold import time and per-turn loop cost.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, fileStore, memoryStore, mockProvider, run, type RunStore } from '../src/index.ts';

const TURNS = Number(process.env.TURNS ?? 2000);

// Prefers the built package (what users load); falls back to sources, which adds type-stripping time.
const dist = new URL('../dist/index.js', import.meta.url);
const entry = existsSync(dist) ? dist.href : new URL('../src/index.ts', import.meta.url).href;

function coldImportMs(): number {
  const script = `const t=performance.now();await import(${JSON.stringify(entry)});console.log(performance.now()-t)`;
  const samples = Array.from({ length: 5 }, () => Number(execFileSync(process.execPath, ['--input-type=module', '-e', script]).toString()));
  return samples.sort((a, b) => a - b)[2]!;
}

async function perTurnUs(store: RunStore): Promise<number> {
  const tool = defineTool({ name: 'noop', description: 'noop', risk: 'read', schema: { type: 'object' }, run: () => 'ok' });
  // Fixed usage keeps the mock itself O(1) so the numbers reflect the kernel only.
  const provider = mockProvider([{ toolCalls: [{ name: 'noop' }], usage: { inputTokens: 1, outputTokens: 1 } }], { loop: true });
  const agent = { name: 'bench', model: { provider, model: 'mock' }, tools: [tool], budget: { maxTurns: TURNS } };
  const t0 = performance.now();
  const res = await run(agent, 'go', { store });
  const elapsed = performance.now() - t0;
  if (res.turns !== TURNS) throw new Error(`expected ${TURNS} turns, got ${res.turns}`);
  return (elapsed * 1000) / TURNS;
}

const dir = mkdtempSync(join(tmpdir(), 'reinloop-bench-'));
const mem = await perTurnUs(memoryStore());
const file = await perTurnUs(fileStore(dir));
console.log(`node ${process.version}, ${TURNS} turns (model call + tool call + persistence each)`);
console.log(`cold import ${entry.endsWith('.js') ? 'dist' : 'src '} (median of 5): ${coldImportMs().toFixed(1)} ms`);
console.log(`per turn, memory store:      ${mem.toFixed(0)} µs`);
console.log(`per turn, file store (JSONL): ${file.toFixed(0)} µs`);
