import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore, RunEvent, RunStore } from '../types.ts';
import { newId } from '../util.ts';

const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

function fileFor(dir: string, id: string, ext: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid id "${id}"`);
  return join(dir, `${id}${ext}`);
}

/** Append-only JSONL event log, one file per run. Survives crashes; replay rebuilds state. */
export function fileStore(dir: string): RunStore {
  let ready: Promise<unknown> | undefined;
  const ensure = () => (ready ??= mkdir(dir, { recursive: true }));
  return {
    async append(event) {
      await ensure();
      await appendFile(fileFor(dir, event.runId, '.jsonl'), `${JSON.stringify(event)}\n`);
    },
    async load(runId) {
      let text: string;
      try {
        text = await readFile(fileFor(dir, runId, '.jsonl'), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const lines = text.split('\n').filter((l) => l.trim());
      return lines.flatMap((line, i) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch (err) {
          if (i === lines.length - 1) return []; // torn final write after a crash
          throw new Error(`corrupt run log ${runId} at line ${i + 1}`, { cause: err });
        }
      });
    },
    async list() {
      try {
        return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
      } catch {
        return [];
      }
    },
  };
}

export function fileArtifacts(dir: string): ArtifactStore {
  let ready: Promise<unknown> | undefined;
  return {
    async put(content) {
      await (ready ??= mkdir(dir, { recursive: true }));
      const handle = `art_${newId().slice(0, 8)}`;
      await writeFile(fileFor(dir, handle, '.txt'), content);
      return handle;
    },
    async get(handle) {
      try {
        return await readFile(fileFor(dir, handle, '.txt'), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}
