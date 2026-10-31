import type { KnowledgeSource } from '../types.ts';

export interface KnowledgeConformanceOptions {
  /** A query the source can answer. */
  query: string;
  /** Passage id that must appear in the results of `query`. */
  expectId?: string;
  /** Number of passages requested (default 3). */
  k?: number;
  /** A query with no good match: the source must answer with an array, not throw (default: a nonsense token). */
  noMatchQuery?: string;
}

/**
 * Checks that a `KnowledgeSource` honours the contract: non-empty name, passages with a string `id` and non-empty `text`,
 * at most `k` of them, optional fields of the right type, no stray fields (`passage.json`); and
 * (with `expectId`) that the expected passage is retrieved. Returns the list of failures; empty means conformant.
 */
export async function checkKnowledgeSource(source: KnowledgeSource, opts: KnowledgeConformanceOptions): Promise<string[]> {
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  const k = opts.k ?? 3;
  const allowed = new Set(['id', 'text', 'source', 'score', 'metadata']);

  if (typeof source.name !== 'string' || !source.name) fail('name must be a non-empty string');
  if (typeof source.search !== 'function') return [...failures, 'search must be a function'];

  let passages: unknown;
  try {
    passages = await source.search({ query: opts.query, k });
  } catch (err) {
    return [...failures, `search("${opts.query}") threw: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!Array.isArray(passages)) return [...failures, `search must resolve to an array, got ${typeof passages}`];
  if (!passages.length) fail(`search("${opts.query}") returned no passages`);
  if (passages.length > k) fail(`search returned ${passages.length} passages for k=${k}`);

  passages.forEach((p, i) => {
    const at = `passage[${i}]`;
    if (typeof p !== 'object' || p === null) return fail(`${at} is not an object`);
    if (typeof p.id !== 'string' || !p.id) fail(`${at}.id must be a non-empty string`);
    if (typeof p.text !== 'string' || !p.text.trim()) fail(`${at}.text must be a non-empty string`);
    if (p.source !== undefined && typeof p.source !== 'string') fail(`${at}.source must be a string`);
    if (p.score !== undefined && typeof p.score !== 'number') fail(`${at}.score must be a number`);
    if (p.metadata !== undefined && (typeof p.metadata !== 'object' || p.metadata === null || Array.isArray(p.metadata))) fail(`${at}.metadata must be an object`);
    for (const key of Object.keys(p)) if (!allowed.has(key)) fail(`${at} has unknown field "${key}"`);
  });

  const ids = passages.map((p) => p?.id);
  if (new Set(ids).size !== ids.length) fail('passage ids must be unique within a result');
  if (opts.expectId !== undefined && !ids.includes(opts.expectId)) {
    fail(`expected passage "${opts.expectId}" not in results (got: ${ids.join(', ') || 'none'})`);
  }

  try {
    const none = await source.search({ query: opts.noMatchQuery ?? 'zq9x-no-such-topic-7f3k', k });
    if (!Array.isArray(none)) fail('search must resolve to an array also when nothing matches');
  } catch (err) {
    fail(`search must resolve to [] (not throw) when nothing matches: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures;
}
