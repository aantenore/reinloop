import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelResponse, Provider } from './types.ts';
import { textOf } from './util.ts';

export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
}

export function memoryCache(maxEntries = 1000): CacheStore {
  const items = new Map<string, { value: string; expires: number }>();
  return {
    async get(key) {
      const hit = items.get(key);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) {
        items.delete(key);
        return undefined;
      }
      return hit.value;
    },
    async set(key, value, ttlMs = Number.POSITIVE_INFINITY) {
      if (items.size >= maxEntries) items.delete(items.keys().next().value!);
      items.set(key, { value, expires: Date.now() + ttlMs });
    },
  };
}

export function fileCache(dir: string): CacheStore {
  let ready: Promise<unknown> | undefined;
  const file = (key: string) => join(dir, `${key}.json`);
  return {
    async get(key) {
      try {
        const { value, expires } = JSON.parse(await readFile(file(key), 'utf8'));
        if (expires !== null && expires < Date.now()) {
          await rm(file(key), { force: true });
          return undefined;
        }
        return value;
      } catch {
        return undefined;
      }
    },
    async set(key, value, ttlMs) {
      await (ready ??= mkdir(dir, { recursive: true }));
      await writeFile(file(key), JSON.stringify({ value, expires: ttlMs === undefined ? null : Date.now() + ttlMs }));
    },
  };
}

export interface ResponseCacheOptions {
  ttlMs?: number;
  /** Separates caches that share a store (e.g. per project or prompt version). */
  namespace?: string;
}

/**
 * Memoizes model responses by a hash of the full request. Identical requests (same model,
 * instructions, history, tools and params) are replayed at zero cost: ideal for development,
 * tests, evals and deterministic pipelines.
 */
export function withResponseCache(provider: Provider, cache: CacheStore, opts: ResponseCacheOptions = {}): Provider {
  return {
    name: provider.name,
    async generate(req, ctx) {
      const key = createHash('sha256')
        .update(JSON.stringify([opts.namespace ?? '', provider.name, req.model, req.instructions ?? '', req.messages, req.tools, req.params ?? {}]))
        .digest('hex');
      const hit = await cache.get(key);
      if (hit !== undefined) {
        const res = JSON.parse(hit) as ModelResponse;
        const text = textOf(res.message);
        if (text) ctx.onText?.(text);
        return { ...res, cached: true };
      }
      const res = await provider.generate(req, ctx);
      await cache.set(key, JSON.stringify(res), opts.ttlMs);
      return res;
    },
  };
}
