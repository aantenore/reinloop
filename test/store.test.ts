import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileStore, type RunEvent } from '../src/index.ts';

describe('file store', () => {
  it('lists nothing for a directory that does not exist yet and fails for one it cannot read', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-store-'));
    const store = fileStore(join(dir, 'runs'));
    assert.deepEqual(await store.list!(), []);
    await store.append({ runId: 'r1', seq: 1, ts: 0, type: 'run_start', data: { agent: 'a', resumed: false } } as RunEvent);
    assert.deepEqual(await store.list!(), ['r1']);
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('directory permissions are not enforced here');
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await assert.rejects(fileStore(locked).list!(), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
