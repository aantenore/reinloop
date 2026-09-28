import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Tool } from '../types.ts';
import { defineTool } from './define.ts';

export interface WorkspaceOptions {
  /** Root directory the tools are confined to. */
  root: string;
  shellTimeoutMs?: number;
  maxOutputChars?: number;
}

/** Resolves `path` inside `root`, following symlinks of the existing prefix to block escapes. */
export async function resolveInside(root: string, path: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, path);
  let probe = target;
  let rest = '';
  // Walk up to the deepest existing ancestor, resolve it, then re-append the missing tail.
  for (;;) {
    try {
      const real = await realpath(probe);
      const full = rest ? resolve(real, rest) : real;
      const rel = relative(realRoot, full);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path "${path}" is outside the workspace`);
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(probe);
      if (parent === probe) throw err;
      rest = rest ? `${probe.slice(parent.length + 1)}/${rest}` : probe.slice(parent.length + 1);
      probe = parent;
    }
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.reinloop']);

/** Path glob: `**` crosses directories, `*` and `?` stay within one segment. */
export function pathGlob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, full, out, limit);
    } else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

export function workspaceTools(opts: WorkspaceOptions): Record<string, Tool> {
  const root = opts.root;
  const maxOut = opts.maxOutputChars ?? 100_000;
  return {
    read_file: defineTool<{ path: string }>({
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace.',
      risk: 'read',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run({ path }) {
        return readFile(await resolveInside(root, path), 'utf8');
      },
    }),
    list_dir: defineTool<{ path?: string }>({
      name: 'list_dir',
      description: 'List entries of a workspace directory (directories end with /, symlinks with @).',
      risk: 'read',
      schema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      async run({ path = '.' }) {
        const entries = await readdir(await resolveInside(root, path), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name)).sort().join('\n');
      },
    }),
    write_file: defineTool<{ path: string; content: string }>({
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file in the workspace.',
      risk: 'write',
      exclusive: true,
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async run({ path, content }) {
        const file = await resolveInside(root, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
        return `wrote ${content.length} chars to ${path}`;
      },
    }),
    edit_file: defineTool<{ path: string; old: string; new: string; all?: boolean }>({
      name: 'edit_file',
      description: 'Replace an exact text snippet in a workspace file. The snippet must be unique unless all=true.',
      risk: 'write',
      exclusive: true,
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, old: { type: 'string', minLength: 1 }, new: { type: 'string' }, all: { type: 'boolean' } },
        required: ['path', 'old', 'new'],
        additionalProperties: false,
      },
      async run({ path, old, new: replacement, all }) {
        const file = await resolveInside(root, path);
        const text = await readFile(file, 'utf8');
        const count = text.split(old).length - 1;
        if (!count) return { content: `snippet not found in ${path}`, isError: true };
        if (count > 1 && !all) return { content: `snippet occurs ${count} times in ${path}; add context or set all=true`, isError: true };
        await writeFile(file, all ? text.split(old).join(replacement) : text.replace(old, () => replacement));
        return `replaced ${all ? count : 1} occurrence(s) in ${path}`;
      },
    }),
    find_files: defineTool<{ pattern: string; path?: string }>({
      name: 'find_files',
      description: 'Find workspace files by glob (e.g. "src/**/*.ts"). Skips dependency and build folders.',
      risk: 'read',
      schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
      async run({ pattern, path = '.' }) {
        const base = await resolveInside(root, path);
        const files: string[] = [];
        await walk(base, base, files, 20_000);
        const re = pathGlob(pattern);
        const hits = files.filter((f) => re.test(f)).slice(0, 500);
        return hits.length ? hits.join('\n') : 'no files match';
      },
    }),
    search_files: defineTool<{ pattern: string; glob?: string; path?: string; maxResults?: number }>({
      name: 'search_files',
      description: 'Search file contents with a regular expression. Returns "path:line: text" matches.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1 } },
        required: ['pattern'],
        additionalProperties: false,
      },
      async run({ pattern, glob = '**', path = '.', maxResults = 200 }) {
        const base = await resolveInside(root, path);
        const files: string[] = [];
        await walk(base, base, files, 20_000);
        const re = new RegExp(pattern);
        const include = pathGlob(glob);
        const out: string[] = [];
        for (const f of files) {
          if (out.length >= maxResults) break;
          if (!include.test(f)) continue;
          const full = join(base, f);
          if ((await stat(full)).size > 1_000_000) continue;
          const text = await readFile(full, 'utf8');
          if (text.includes('\u0000')) continue; // binary
          text.split('\n').forEach((line, i) => {
            if (out.length < maxResults && re.test(line)) out.push(`${f}:${i + 1}: ${line.slice(0, 300)}`);
          });
        }
        return out.length ? out.join('\n') : 'no matches';
      },
    }),
    shell: defineTool<{ command: string }>({
      name: 'shell',
      description: 'Run a shell command in the workspace root. Returns exit code, stdout and stderr.',
      risk: 'exec',
      exclusive: true,
      timeoutMs: opts.shellTimeoutMs ?? 120_000,
      schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
      run({ command }, ctx) {
        return new Promise((resolvePromise, reject) => {
          // Own process group, so abort/timeout also stops anything the command spawned.
          const child = spawn('/bin/sh', ['-c', command], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          const killGroup = () => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              // already gone
            }
          };
          if (ctx.signal.aborted) killGroup();
          ctx.signal.addEventListener('abort', killGroup, { once: true });
          let out = '';
          let settled = false;
          const collect = (chunk: Buffer) => {
            if (out.length < maxOut) out += chunk.toString('utf8');
          };
          const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            ctx.signal.removeEventListener('abort', killGroup);
            child.stdout.destroy();
            child.stderr.destroy();
            const body = out.length > maxOut ? `${out.slice(0, maxOut)}\n[output truncated]` : out;
            resolvePromise({ content: `exit ${code}\n${body}`, isError: code !== 0 });
          };
          child.stdout.on('data', collect);
          child.stderr.on('data', collect);
          child.on('error', (err) => {
            settled = true;
            ctx.signal.removeEventListener('abort', killGroup);
            reject(err);
          });
          child.on('close', finish);
          // Background processes may keep the pipes open after the shell exits: do not wait for them.
          child.on('exit', (code) => setTimeout(() => finish(code), 200).unref());
        });
      },
    }),
  };
}
