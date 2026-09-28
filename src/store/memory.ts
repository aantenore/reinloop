import type { RunEvent, RunStore } from '../types.ts';

export function memoryStore(): RunStore {
  const runs = new Map<string, RunEvent[]>();
  return {
    async append(event) {
      const list = runs.get(event.runId) ?? [];
      list.push(structuredClone(event));
      runs.set(event.runId, list);
    },
    async load(runId) {
      return structuredClone(runs.get(runId) ?? []);
    },
    async list() {
      return [...runs.keys()];
    },
  };
}
