import { authorizeCall } from '../identity/authorize.ts';
import { validate } from '../schema.ts';
import type { Agent, Approver, Budget, CredentialProvider, HookContext, Identity, RunEvent, RunOptions, RunResult, RunState, Tool, ToolCallPart, ToolOutput, ToolResultPart } from '../types.ts';
import { finiteTimeout, limitDefault } from '../limits.ts';
import { addUsage, emptyUsage, errorMessage, timeoutSignal, truncate } from '../util.ts';
import { normalizeOutput } from './define.ts';

export interface ExecEnv {
  agent: Agent;
  tools: Map<string, Tool>;
  runId: string;
  state: RunState;
  signal: AbortSignal;
  emit: (type: RunEvent['type'], data: any) => void;
  forward: (ev: RunEvent) => void;
  approve?: Approver;
  inherit: Pick<RunOptions, 'store' | 'approve' | 'sinks' | 'identity' | 'credentials'>;
  identity?: Identity;
  credentials?: CredentialProvider;
  /** Calls of this batch that may still run (the `maxToolCalls` budget); the rest get an error result. */
  maxCalls?: number;
  /** What the run has left of its cost, token and time limits, read when a call starts (handed to delegated runs). */
  remaining?: () => Budget | undefined;
}

/** Delegated calls of one batch that have not started, and the shares the running ones hold. */
interface Shares { waiting: number; held: Budget[] }

/** Limits split between the delegated calls of a batch; time is not split, since they run side by side. */
const SPLIT_LIMITS = ['maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostUsd'] as const;

/** How long a failed call waits for the nested runs it started to end, before it is charged its whole share. */
export const DELEGATE_SETTLE_MS = 5_000;

export const DEFAULT_CONCURRENCY = limitDefault('tools.concurrency');
export const DEFAULT_MAX_RESULT_CHARS = limitDefault('tools.maxResultChars');

/**
 * Executes tool calls: consecutive non-exclusive calls run in parallel (bounded),
 * exclusive tools run alone. Every failure becomes an error result for the model.
 */
export async function executeToolCalls(calls: ToolCallPart[], env: ExecEnv): Promise<void> {
  const limit = Math.max(1, env.agent.toolSettings?.concurrency ?? DEFAULT_CONCURRENCY);
  let batch: ToolCallPart[] = [];
  const flush = async () => {
    await pool(batch, limit, (c) => executeOne(c, env, shares));
    batch = [];
  };
  // Over the budget, the tail of the batch is answered without running, after the allowed calls (call order is kept).
  const allowed = env.maxCalls === undefined ? calls : calls.slice(0, env.maxCalls);
  const shares: Shares = { waiting: allowed.filter((c) => env.tools.get(c.name)?.delegates).length, held: [] };
  for (const call of allowed) {
    if (env.tools.get(call.name)?.exclusive) {
      await flush();
      await executeOne(call, env, shares);
    } else batch.push(call);
  }
  await flush();
  for (const call of calls.slice(allowed.length)) await skipCall(call, env);
}

/** A call over the `maxToolCalls` budget: not run, answered with an error result so the history stays well-formed. */
async function skipCall(call: ToolCallPart, env: ExecEnv): Promise<void> {
  env.emit('tool_result', {
    callId: call.id,
    name: call.name,
    content: 'Tool call skipped: the maxToolCalls budget is exhausted.',
    isError: true,
    durationMs: 0,
  });
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * What a call may hand to nested runs: the run's remaining budget minus the shares running delegated calls hold. A
 * delegated call reserves an equal part of that for itself and leaves the rest to the delegated calls still to start,
 * so the calls of a batch never get more than the run has left between them.
 */
function handOut(tool: Tool, env: ExecEnv, shares: Shares): Budget | undefined {
  const free = env.remaining?.();
  if (!free) return undefined;
  const parts = tool.delegates ? Math.max(1, shares.waiting--) : 1;
  for (const key of SPLIT_LIMITS) {
    if (free[key] === undefined) continue;
    const held = shares.held.reduce((sum, share) => sum + (share[key] ?? 0), 0);
    free[key] = Math.max(0, free[key] - held) / parts;
  }
  if (tool.delegates) shares.held.push(free);
  return free;
}

/**
 * Spend of the nested runs a failed call started. They share the call's signal, so they end soon after a timeout and
 * report their totals; when they do not, the call is charged the whole share it was handed.
 */
async function nestedSpend(nested: Array<Promise<Pick<RunResult, 'usage' | 'costUsd'>>>, share: Budget | undefined): Promise<Pick<ToolOutput, 'usage' | 'costUsd'> | undefined> {
  if (!nested.length) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), DELEGATE_SETTLE_MS);
  });
  const ended = await Promise.race([Promise.all(nested), grace]).catch(() => undefined);
  clearTimeout(timer);
  if (ended) return ended.reduce((sum, r) => ({ usage: addUsage(sum.usage, r.usage), costUsd: sum.costUsd + r.costUsd }), { usage: emptyUsage(), costUsd: 0 });
  return share && { usage: { inputTokens: share.maxInputTokens ?? share.maxTotalTokens ?? 0, outputTokens: share.maxOutputTokens ?? 0 }, costUsd: share.maxCostUsd ?? 0 };
}

async function executeOne(original: ToolCallPart, env: ExecEnv, shares: Shares): Promise<void> {
  const started = performance.now();
  const hookCtx: HookContext = { runId: env.runId, agent: env.agent.name, state: env.state, identity: env.identity, emit: env.emit };
  let call = original;
  const finish = async (content: string, isError: boolean, artifact?: string, stop?: Pick<ToolOutput, 'data'>, spent?: Pick<ToolOutput, 'usage' | 'costUsd'>) => {
    let result: ToolResultPart = { type: 'tool_result', callId: original.id, name: original.name, content, isError };
    for (const mw of env.agent.middleware ?? []) result = (await mw.afterTool?.(result, hookCtx)) ?? result;
    const stops = stop && !result.isError;
    const layer = env.tools.get(original.name)?.layer;
    env.emit('tool_result', {
      callId: original.id,
      name: original.name,
      content: result.content,
      isError: result.isError ?? false,
      durationMs: Math.round(performance.now() - started),
      artifact,
      ...(layer && { layer }),
      ...(stops && { stop: true, ...('data' in stop && { data: stop.data }) }),
      ...(spent?.usage && { usage: spent.usage }),
      ...(spent?.costUsd && { costUsd: spent.costUsd }),
    });
  };

  for (const mw of env.agent.middleware ?? []) {
    const out = await mw.beforeTool?.(call, hookCtx);
    if (out && 'deny' in out) {
      env.emit('tool_decision', { callId: call.id, name: call.name, allowed: false, reason: out.deny });
      return finish(`Tool call denied: ${out.deny}`, true);
    }
    if (out) call = out;
  }

  const tool = env.tools.get(call.name);
  if (!tool) return finish(`Unknown tool "${call.name}". Available: ${[...env.tools.keys()].join(', ') || 'none'}`, true);

  if (call.argsIssue) {
    env.emit('tool_args_invalid', { callId: call.id, name: call.name, error: call.argsIssue.error, repaired: call.argsIssue.repaired });
    if (!call.argsIssue.repaired) {
      return finish(`Invalid JSON arguments for tool ${call.name}: ${truncate(call.argsIssue.error, 200)}. Please retry the call with valid JSON arguments.`, true);
    }
  }

  const verdict = await authorizeCall(env.agent.policy, call, tool, { agent: env.agent.name, identity: env.identity, signal: env.signal });
  let allowed = verdict.decision === 'allow';
  let reason = verdict.reason;
  if (verdict.decision === 'ask') {
    allowed = env.approve ? await env.approve({ runId: env.runId, agent: env.agent.name, call, tool, reason }) : false;
    reason = `${reason}: ${allowed ? 'approved' : env.approve ? 'rejected by approver' : 'no approver configured'}`;
  }
  env.emit('tool_decision', { callId: call.id, name: call.name, allowed, reason });
  if (!allowed) return finish(`Tool call denied (${reason}).`, true);

  const errors = validate(tool.schema, call.args, 'args');
  if (errors.length) return finish(`Invalid arguments: ${errors.join('; ')}`, true);

  env.emit('tool_start', { callId: call.id, name: call.name, args: call.args, ...(tool.layer && { layer: tool.layer }) });
  // A tool's own timeout wins; Infinity (unbounded) and 0 mean no timer.
  const timeoutMs = finiteTimeout(tool.timeoutMs ?? env.agent.toolSettings?.timeoutMs);
  const limit = timeoutMs ? timeoutSignal(timeoutMs, env.signal) : undefined;
  const signal = limit?.signal ?? env.signal;
  const budget = handOut(tool, env, shares);
  const nested: Array<Promise<Pick<RunResult, 'usage' | 'costUsd'>>> = [];
  try {
    const out = normalizeOutput(
      await raceAbort(
        Promise.resolve(tool.run(call.args, {
          runId: env.runId, agent: env.agent.name, signal, state: env.state, emit: env.forward, inherit: { ...env.inherit, budget }, identity: env.identity,
          credentials: env.credentials, track: (run) => nested.push(run),
        })),
        signal,
      ),
    );
    const { content, artifact } = await limitSize(out.content, env);
    return await finish(content, out.isError ?? false, artifact, out.stop ? ('data' in out ? { data: out.data } : {}) : undefined, out);
  } catch (err) {
    if (env.signal.aborted) throw err;
    const msg = signal.aborted ? `timed out after ${timeoutMs}ms` : errorMessage(err);
    // The call failed, yet the runs it started may have spent: that still counts against this run.
    return await finish(`Tool error: ${msg}`, true, undefined, undefined, await nestedSpend(nested, budget));
  } finally {
    limit?.stop();
    // The share is held until the result (and with it the real spend) is recorded.
    if (shares.held.includes(budget!)) shares.held.splice(shares.held.indexOf(budget!), 1);
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (signal.removeEventListener('abort', onAbort), reject(e)),
    );
  });
}

async function limitSize(content: string, env: ExecEnv): Promise<{ content: string; artifact?: string }> {
  const max = env.agent.toolSettings?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  if (content.length <= max) return { content };
  const head = content.slice(0, Math.floor(max * 0.8));
  const store = env.agent.toolSettings?.artifacts;
  if (!store) return { content: `${head}\n[output truncated: ${content.length} chars total]` };
  const artifact = await store.put(content);
  return {
    content: `${head}\n[output truncated: ${content.length} chars total, stored as artifact "${artifact}"; use read_artifact to page through it]`,
    artifact,
  };
}
