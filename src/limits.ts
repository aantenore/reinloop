// Every configurable limit in one place: defaults, config paths, accepted and safe ranges. Components read their
// defaults from here; config validation, the JSON Schema, load-time warnings and the docs tables are derived from it.
// Self-contained modules (metrics, provider timeouts, redaction) declare their own limits and are merged in below, so
// they keep depending on contract types and Node built-ins only.
import { TELEMETRY_LIMITS } from './observe/metrics.ts';
import { PROVIDER_TIMEOUT_LIMITS } from './providers/limits.ts';
import { REDACT_LIMITS } from './tools/redact.ts';
import type { JsonSchema, LimitSpec } from './types.ts';

export type { LimitSpec } from './types.ts';

/** The string that turns a limit off where that is allowed (`Infinity` in code). */
export const UNBOUNDED = 'unbounded';

const TOOL_LIMITS = {
  'tools.concurrency': {
    component: 'Tools', path: 'tools.concurrency', option: 'Agent.toolSettings.concurrency', default: 8, min: 1, safe: [1, 64],
    why: 'Tool calls of one turn that run in parallel',
  },
  'tools.timeoutMs': {
    component: 'Tools', path: 'tools.timeoutMs', option: 'Agent.toolSettings.timeoutMs', default: 'unbounded', min: 1, unbounded: true, safe: [1000, 3_600_000],
    why: 'Time limit of one tool call (tools may set their own)',
  },
  'tools.maxResultChars': {
    component: 'Tools', path: 'tools.maxResultChars', option: 'Agent.toolSettings.maxResultChars', default: 32_000, min: 100, unbounded: true, warnUnbounded: true,
    safe: [1000, 1_000_000], why: 'Tool output kept in the conversation; the rest goes to an artifact or is cut',
  },
  'tools.shellTimeoutMs': {
    component: 'Tools', path: 'tools.shellTimeoutMs', option: 'workspaceTools({ shellTimeoutMs })', default: 120_000, min: 1, unbounded: true, warnUnbounded: true,
    safe: [1000, 3_600_000], why: 'Time limit of one shell command; the whole process group is killed',
  },
  'tools.shellMaxOutputChars': {
    component: 'Tools', path: 'tools.shellMaxOutputChars', option: 'workspaceTools({ maxOutputChars })', default: 100_000, min: 100, unbounded: true, warnUnbounded: true,
    safe: [1000, 10_000_000], why: 'Shell output collected in memory',
  },
  'tools.shellExitGraceMs': {
    component: 'Tools', path: 'tools.shellExitGraceMs', option: 'workspaceTools({ shellExitGraceMs })', default: 200, min: 0, safe: [0, 10_000],
    why: 'Wait for output after the shell exits while background processes keep the pipes open',
  },
  'tools.maxWalkFiles': {
    component: 'Tools', path: 'tools.maxWalkFiles', option: 'workspaceTools({ maxWalkFiles })', default: 20_000, min: 1, safe: [1, 1_000_000],
    why: 'Files visited by find_files and search_files',
  },
  'tools.maxFindResults': {
    component: 'Tools', path: 'tools.maxFindResults', option: 'workspaceTools({ maxFindResults })', default: 500, min: 1, safe: [1, 100_000],
    why: 'Paths returned by find_files',
  },
  'tools.searchMaxResults': {
    component: 'Tools', path: 'tools.searchMaxResults', option: 'workspaceTools({ searchMaxResults })', default: 200, min: 1, safe: [1, 10_000],
    why: 'Matches returned by search_files when the model does not ask for a number',
  },
  'tools.searchMaxFileBytes': {
    component: 'Tools', path: 'tools.searchMaxFileBytes', option: 'workspaceTools({ searchMaxFileBytes })', default: 1_000_000, min: 1, safe: [1, 100_000_000],
    why: 'Larger files are skipped by search_files',
  },
  'tools.searchLineChars': {
    component: 'Tools', path: 'tools.searchLineChars', option: 'workspaceTools({ searchLineChars })', default: 300, min: 20,
    why: 'Characters kept of each matching line',
  },
  'tools.artifactReadChars': {
    component: 'Tools', path: 'tools.artifactReadChars', option: 'readArtifactTool(store, { defaultLimit })', default: 8000, min: 100,
    why: 'Characters read_artifact returns when the model gives no limit',
  },
  'tools.skillMaxFileBytes': {
    component: 'Tools', path: 'tools.skillMaxFileBytes', option: 'skillTool(skills, { maxFileBytes })', default: 1_000_000, min: 1, safe: [1, 100_000_000],
    why: 'Largest skill resource file the skill tool loads',
  },
  'tools.skillDescriptionChars': {
    component: 'Tools', path: 'tools.skillDescriptionChars', option: 'skillTool(skills, { descriptionChars })', default: 300, min: 20,
    why: 'Characters of each skill description listed in the tool description',
  },
  'memory.recallLimit': {
    component: 'Memory', path: 'memory.recallLimit', option: 'memoryTools({ recallLimit })', default: 8, min: 1, safe: [1, 100],
    why: 'Notes recall returns when the model gives no limit',
  },
} as const satisfies Record<string, LimitSpec>;

const WEB_LIMITS = {
  'web.maxResults': { component: 'Web', path: 'web.maxResults', option: 'webTools({ maxResults })', default: 5, min: 1, why: 'Results per search when the model does not ask (capped by maxResultsCap)' },
  'web.maxResultsCap': { component: 'Web', path: 'web.maxResultsCap', option: 'webTools({ maxResultsCap })', default: 10, min: 1, safe: [1, 50], why: 'Most results the model may ask for' },
  'web.maxChars': { component: 'Web', path: 'web.maxChars', option: 'webTools({ maxChars })', default: 1000, min: 50, why: 'Characters kept per search snippet' },
  'web.maxFetchChars': { component: 'Web', path: 'web.maxFetchChars', option: 'webTools({ maxFetchChars })', default: 8000, min: 100, safe: [100, 200_000], why: 'Characters kept of a fetched page' },
  'web.cacheTtlMs': { component: 'Web', path: 'web.cacheTtlMs', option: 'webTools({ cacheTtlMs })', default: 0, min: 0, safe: [0, 86_400_000], why: 'In-memory result cache lifetime (0: off)' },
  'web.cacheMaxEntries': { component: 'Web', path: 'web.cacheMaxEntries', option: 'webTools({ cacheMaxEntries })', default: 200, min: 1, safe: [1, 100_000], why: 'Results kept in the cache' },
  'web.maxUrlLength': { component: 'Web', path: 'web.maxUrlLength', option: 'webTools({ maxUrlLength })', default: 512, min: 16, safe: [16, 2048], why: 'Longest URL web_fetch accepts; long URLs can carry exfiltrated data' },
  'web.maxUses': { component: 'Web', path: 'web.maxUses', option: 'anthropicWebProvider({ maxUses })', default: 1, min: 1, safe: [1, 10], why: 'Hosted searches per query (anthropic-native)' },
  'web.maxTrackedRuns': { component: 'Web', path: 'web.maxTrackedRuns', option: 'webTools({ maxTrackedRuns })', default: 200, min: 1, safe: [1, 100_000], why: 'Runs whose search results web_fetch remembers (oldest are forgotten)' },
} as const satisfies Record<string, LimitSpec>;

const SIGNAL_LIMITS = {
  'signals.maxResults': { component: 'Signals', path: 'signals.maxResults', option: 'signalTools({ maxResults })', default: 5, min: 1, why: 'Results per search when the model does not ask (capped by maxResultsCap)' },
  'signals.maxResultsCap': { component: 'Signals', path: 'signals.maxResultsCap', option: 'signalTools({ maxResultsCap })', default: 10, min: 1, safe: [1, 100], why: 'Most results the model may ask for' },
  'signals.maxChars': { component: 'Signals', path: 'signals.maxChars', option: 'signalTools({ maxChars })', default: 300, min: 20, why: 'Characters kept per title or description' },
  'signals.cacheTtlMs': { component: 'Signals', path: 'signals.cacheTtlMs', option: 'signalTools({ cacheTtlMs })', default: 0, min: 0, safe: [0, 86_400_000], why: 'In-memory result cache lifetime (0: off)' },
  'signals.cacheMaxEntries': { component: 'Signals', path: 'signals.cacheMaxEntries', option: 'signalTools({ cacheMaxEntries })', default: 200, min: 1, safe: [1, 100_000], why: 'Results kept in the cache' },
  'signals.timeoutMs': { component: 'Signals', path: 'signals.timeoutMs', option: 'signalTools({ timeoutMs })', default: 10_000, min: 100, safe: [1000, 60_000], why: 'Time limit of one request to a public API' },
  'signals.errorBodyChars': { component: 'Signals', path: 'signals.errorBodyChars', option: 'signalTools({ errorBodyChars })', default: 300, min: 0, why: 'Response text kept in an HTTP error' },
  'signals.rateLimitBodyChars': { component: 'Signals', path: 'signals.rateLimitBodyChars', option: 'signalTools({ rateLimitBodyChars })', default: 200, min: 0, why: 'Response text kept in a throttling error' },
} as const satisfies Record<string, LimitSpec>;

const MCP_LIMITS = {
  'mcp.timeoutMs': {
    component: 'MCP servers', path: 'mcpServers.<name>.timeoutMs', option: 'McpServerConfig.timeoutMs', default: 60_000, min: 1, unbounded: true, warnUnbounded: true,
    safe: [1000, 600_000], why: 'Time limit of one MCP request (connect, list, call)',
  },
  'mcp.errorBodyChars': {
    component: 'MCP servers', path: 'mcpServers.<name>.errorBodyChars', option: 'McpServerConfig.errorBodyChars', default: 300, min: 0,
    why: 'Response text kept in an HTTP error (secrets are masked first)',
  },
  'mcp.stderrChars': {
    component: 'MCP servers', path: 'mcpServers.<name>.stderrChars', option: 'McpServerConfig.stderrChars', default: 2000, min: 0,
    why: 'Tail of a stdio server stderr kept for error messages',
  },
} as const satisfies Record<string, LimitSpec>;

const BUILTIN_PROVIDERS = ['openai-compatible', 'anthropic'] as const;

const PROVIDER_LIMITS = {
  'provider.retry.maxAttempts': {
    component: 'Providers', path: 'providers.<name>.retry.maxAttempts', option: 'withRetry(provider, { maxAttempts })', default: 3, min: 1, safe: [1, 10],
    types: BUILTIN_PROVIDERS, why: 'Tries of one model request, the first included',
  },
  'provider.retry.baseDelayMs': {
    component: 'Providers', path: 'providers.<name>.retry.baseDelayMs', option: 'withRetry(provider, { baseDelayMs })', default: 500, min: 0, safe: [100, 10_000],
    types: BUILTIN_PROVIDERS, why: 'First backoff delay, doubled on each retry (with jitter)',
  },
  'provider.retry.maxDelayMs': {
    component: 'Providers', path: 'providers.<name>.retry.maxDelayMs', option: 'withRetry(provider, { maxDelayMs })', default: 30_000, min: 0, safe: [1000, 300_000],
    types: BUILTIN_PROVIDERS, why: 'Longest wait between tries, Retry-After included',
  },
  'provider.errorBodyChars': {
    component: 'Providers', path: 'providers.<name>.errorBodyChars', option: 'openaiCompatible / anthropic({ errorBodyChars })', default: 500, min: 0,
    types: BUILTIN_PROVIDERS, why: 'Response text kept in an HTTP error',
  },
  'provider.responseExcerptChars': {
    component: 'Providers', path: 'providers.<name>.responseExcerptChars', option: 'openaiCompatible / anthropic({ responseExcerptChars })', default: 300, min: 0,
    types: BUILTIN_PROVIDERS, why: 'Response JSON kept when a response has an unexpected shape',
  },
  'provider.cacheMinTokens': {
    component: 'Providers', path: 'providers.<name>.cacheMinTokens', option: 'anthropic({ cacheMinTokens })', default: 1024, min: 0,
    types: ['anthropic'], why: 'Shorter prompt prefixes get no cache breakpoint',
  },
  'provider.defaultMaxTokens': {
    component: 'Providers', path: 'providers.<name>.defaultMaxTokens', option: 'anthropic({ defaultMaxTokens })', default: 4096, min: 1,
    types: ['anthropic'], why: 'Output tokens per request when the agent sets no params.maxTokens',
  },
} as const satisfies Record<string, LimitSpec>;

const AGENT_LIMITS = {
  'responseCache.ttlMs': {
    component: 'Response cache', path: 'responseCache.ttlMs', option: 'withResponseCache(provider, cache, { ttlMs })', default: 'unbounded', min: 1, unbounded: true,
    why: 'How long a cached response is replayed',
  },
  'responseCache.maxEntries': {
    component: 'Response cache', path: 'responseCache.maxEntries', option: 'memoryCache(maxEntries)', default: 1000, min: 1, safe: [1, 1_000_000],
    types: ['memory'], why: 'Responses kept by the memory cache (oldest are dropped)',
  },
  'agent.output.retries': {
    component: 'Agents', path: 'agents.<name>.output.retries', option: 'Agent.output.retries', default: 1, min: 0, safe: [0, 5],
    why: 'Extra model calls when the final answer does not match output.schema',
  },
  'compaction.window.keepFirst': {
    component: 'Agents', path: 'agents.<name>.compaction.keepFirst', option: 'windowCompaction({ keepFirst })', default: 1, min: 0,
    types: ['window'], why: 'Leading messages (the task) kept by window compaction',
  },
  'compaction.window.keepLast': {
    component: 'Agents', path: 'agents.<name>.compaction.keepLast', option: 'windowCompaction({ keepLast })', default: 20, min: 1,
    types: ['window'], why: 'Recent messages kept by window compaction',
  },
  'compaction.summarize.keepLast': {
    component: 'Agents', path: 'agents.<name>.compaction.keepLast', option: 'summarizeCompaction({ keepLast })', default: 10, min: 1,
    types: ['summarize'], why: 'Recent messages kept verbatim by summarize compaction',
  },
  'compaction.summarize.maxTokens': {
    component: 'Agents', path: 'agents.<name>.compaction.maxTokens', option: 'summarizeCompaction({ maxTokens })', default: 2048, min: 1,
    types: ['summarize'], why: 'Output tokens of the summary request',
  },
  'compaction.summarize.toolResultChars': {
    component: 'Agents', path: 'agents.<name>.compaction.toolResultChars', option: 'summarizeCompaction({ toolResultChars })', default: 2000, min: 0,
    types: ['summarize'], why: 'Characters of each tool result in the transcript sent for summary',
  },
  'team.maxRounds': {
    component: 'Agents', path: 'teams.<name>.options.maxRounds', option: 'evaluator pattern options.maxRounds', default: 3, min: 1, safe: [1, 10],
    why: 'Generate-and-judge rounds of an evaluator team',
  },
  'team.judgeRetries': {
    component: 'Agents', path: 'teams.<name>.options.judgeRetries', option: 'evaluator pattern options.judgeRetries', default: 1, min: 0, safe: [0, 5],
    why: 'Extra judge calls when the verdict is not valid { pass, feedback } JSON',
  },
} as const satisfies Record<string, LimitSpec>;

const SERVE_LIMITS = {
  'serve.maxBodyBytes': {
    component: 'Serve', path: 'serve.maxBodyBytes', option: 'serve(runtime, { maxBodyBytes })', default: 1_000_000, min: 1, unbounded: true, warnUnbounded: true,
    safe: [1024, 10_485_760], why: 'Largest request body; bigger ones get 413 and the connection is closed',
  },
  'serve.requestTimeoutMs': {
    component: 'Serve', path: 'serve.requestTimeoutMs', option: 'serve(runtime, { requestTimeoutMs })', default: 300_000, min: 1, unbounded: true, warnUnbounded: true,
    safe: [1000, 3_600_000], why: 'Time to receive a whole request (Node default); slow clients cannot hold sockets',
  },
  'serve.headersTimeoutMs': {
    component: 'Serve', path: 'serve.headersTimeoutMs', option: 'serve(runtime, { headersTimeoutMs })', default: 60_000, min: 1, unbounded: true, warnUnbounded: true,
    safe: [1000, 300_000], why: 'Time to receive the request headers (Node default; never above requestTimeoutMs)',
  },
  'serve.errorDescriptionChars': {
    component: 'Serve', path: 'serve.errorDescriptionChars', option: 'serve(runtime, { errorDescriptionChars })', default: 120, min: 0,
    why: 'Verifier reason kept in the WWW-Authenticate error_description',
  },
} as const satisfies Record<string, LimitSpec>;

const POLICY_LIMITS = {
  'pdp.maxReasonChars': {
    component: 'Policy', path: 'policy.pdp.maxReasonChars', also: ['agents.<name>.policy.pdp.maxReasonChars'], option: 'PolicyConfig.pdp.maxReasonChars', default: 200, min: 20,
    why: 'Characters of a PDP reason or error kept in the decision',
  },
} as const satisfies Record<string, LimitSpec>;

const LOOP_LIMITS = {
  'limits.maxTurns': {
    component: 'Run loop and redaction', path: 'limits.maxTurns', option: 'DEFAULT_BUDGET.maxTurns (Agent.budget)', default: 50, min: 1, unbounded: true, warnUnbounded: true,
    safe: [1, 1000], why: 'Turns of an agent that sets no budget; with "unbounded" a looping agent never stops',
  },
  'limits.maxEmptyResponses': {
    component: 'Run loop and redaction', path: 'limits.maxEmptyResponses', option: 'Agent.maxEmptyResponses', default: 2, min: 0, safe: [0, 10],
    why: 'Empty model responses in a row before the run fails',
  },
} as const satisfies Record<string, LimitSpec>;

/** Every limit by name. */
export const LIMITS = {
  ...TOOL_LIMITS,
  ...WEB_LIMITS,
  ...SIGNAL_LIMITS,
  ...MCP_LIMITS,
  ...PROVIDER_LIMITS,
  ...PROVIDER_TIMEOUT_LIMITS,
  ...AGENT_LIMITS,
  ...POLICY_LIMITS,
  ...TELEMETRY_LIMITS,
  ...SERVE_LIMITS,
  ...LOOP_LIMITS,
  ...REDACT_LIMITS,
} as const satisfies Record<string, LimitSpec>;

export type LimitName = keyof typeof LIMITS;

/** Default of a limit as a number (`Infinity` when it is unbounded by default). */
export function limitDefault(name: LimitName): number {
  const d: number | 'unbounded' = LIMITS[name].default;
  return d === UNBOUNDED ? Number.POSITIVE_INFINITY : d;
}

/** A timeout that can be armed: finite and positive. `Infinity` (unbounded) and 0 mean no timer. */
export const finiteTimeout = (ms: number | undefined): number | undefined => (ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined);

const pathPattern = (path: string) => path.replace(/[.$]/g, '\\$&').replace(/\[\]/g, '\\[\\d+\\]').replace(/<name>/g, '[^.\\[\\]]+');
const compiled = Object.entries(LIMITS as Record<string, LimitSpec>).map(([name, spec]) => ({
  name,
  spec,
  re: new RegExp(`^\\$\\.(?:${[spec.path, ...(spec.also ?? [])].map(pathPattern).join('|')})$`),
}));

/** The limit declared at a concrete config path (`$.tools.timeoutMs`), for a component of type `owner`. */
export function limitAt(path: string, owner?: string): { name: string; spec: LimitSpec } | undefined {
  for (const c of compiled) {
    if (c.re.test(path) && (!c.spec.types || owner === undefined || c.spec.types.includes(owner))) return c;
  }
  return undefined;
}

/** Accepted values in words, e.g. `1–∞ or "unbounded"`. */
export const limitRange = (s: LimitSpec) => `${s.min}–${s.max ?? '∞'}${s.unbounded ? ' or "unbounded"' : ''}`;

/**
 * Checks a resolved value (number, `"unbounded"` or a numeric string from an environment variable) and returns it as a
 * number (`Infinity` for unbounded), or the reason it is rejected.
 */
export function checkLimit(spec: LimitSpec, value: unknown): { value: number } | { error: string } {
  if (value === UNBOUNDED || value === Number.POSITIVE_INFINITY) {
    return spec.unbounded ? { value: Number.POSITIVE_INFINITY } : { error: `must not be "unbounded" (accepted: ${limitRange(spec)})` };
  }
  const n = typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { error: `must be a number (accepted: ${limitRange(spec)})` };
  if (!Number.isInteger(n)) return { error: `must be an integer (accepted: ${limitRange(spec)})` };
  if (n < spec.min || (spec.max !== undefined && n > spec.max)) return { error: `must be within ${limitRange(spec)}` };
  return { value: n };
}

/** Load-time warning for an accepted value, if it is unsafe. */
export function limitWarning(spec: LimitSpec, value: number, path: string): string | undefined {
  if (value === Number.POSITIVE_INFINITY) return spec.warnUnbounded ? `${path} is "unbounded", so this limit is off. ${spec.why}.` : undefined;
  if (spec.safe && (value < spec.safe[0] || value > spec.safe[1])) return `${path}: ${value} is outside the safe range ${spec.safe[0]}–${spec.safe[1]}. ${spec.why}.`;
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Calls `visit` for every value of `config` that sits at a declared limit path. Profiles are skipped (applied before). */
export function forEachLimit(config: unknown, visit: (path: string, value: unknown, spec: LimitSpec, owner?: string) => void): void {
  const walk = (value: unknown, path: string, owner: string | undefined) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`, owner));
    if (isObject(value)) {
      const type = typeof value.type === 'string' ? value.type : owner;
      for (const [k, v] of Object.entries(value)) if (v !== undefined && !(path === '$' && k === 'profiles')) walk(v, `${path}.${k}`, type);
      return;
    }
    const hit = limitAt(path, owner);
    if (hit) visit(path, value, hit.spec, owner);
  };
  walk(config, '$', undefined);
}

/** Schema of a limit field: an integer in range, `"unbounded"` where allowed, or a `${env:NAME}` placeholder. */
export function limitSchema(name: LimitName): JsonSchema {
  const s: LimitSpec = LIMITS[name];
  return {
    description: `${s.why}. Default ${s.default}.`,
    default: s.default,
    anyOf: [
      { type: 'integer', minimum: s.min, ...(s.max !== undefined && { maximum: s.max }) },
      ...(s.unbounded ? [{ const: UNBOUNDED }] : []),
      { type: 'string', pattern: '\\$\\{env:[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\\}' },
    ],
  };
}
