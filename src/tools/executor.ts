import { decide } from '../policy.ts';
import { validate } from '../schema.ts';
import type { Agent, Approver, HookContext, RunEvent, RunOptions, RunState, Tool, ToolCallPart, ToolResultPart } from '../types.ts';
import { errorMessage } from '../util.ts';
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
  inherit: Pick<RunOptions, 'store' | 'approve' | 'sinks'>;
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_MAX_RESULT_CHARS = 32_000;

/**
 * Executes tool calls: consecutive non-exclusive calls run in parallel (bounded),
 * exclusive tools run alone. Every failure becomes an error result for the model.
 */
export async function executeToolCalls(calls: ToolCallPart[], env: ExecEnv): Promise<void> {
  const limit = Math.max(1, env.agent.toolSettings?.concurrency ?? DEFAULT_CONCURRENCY);
  let batch: ToolCallPart[] = [];
  const flush = async () => {
    await pool(batch, limit, (c) => executeOne(c, env));
    batch = [];
  };
  for (const call of calls) {
    if (env.tools.get(call.name)?.exclusive) {
      await flush();
      await executeOne(call, env);
    } else batch.push(call);
  }
  await flush();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

async function executeOne(original: ToolCallPart, env: ExecEnv): Promise<void> {
  const started = performance.now();
  const hookCtx: HookContext = { runId: env.runId, agent: env.agent.name, state: env.state };
  let call = original;
  const finish = async (content: string, isError: boolean, artifact?: string) => {
    let result: ToolResultPart = { type: 'tool_result', callId: original.id, name: original.name, content, isError };
    for (const mw of env.agent.middleware ?? []) result = (await mw.afterTool?.(result, hookCtx)) ?? result;
    env.emit('tool_result', {
      callId: original.id,
      name: original.name,
      content: result.content,
      isError: result.isError ?? false,
      durationMs: Math.round(performance.now() - started),
      artifact,
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

  const verdict = decide(env.agent.policy, call, tool);
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

  env.emit('tool_start', { callId: call.id, name: call.name, args: call.args });
  const timeoutMs = tool.timeoutMs ?? env.agent.toolSettings?.timeoutMs;
  const signal = timeoutMs ? AbortSignal.any([env.signal, AbortSignal.timeout(timeoutMs)]) : env.signal;
  try {
    const out = normalizeOutput(
      await raceAbort(
        Promise.resolve(tool.run(call.args, { runId: env.runId, agent: env.agent.name, signal, state: env.state, emit: env.forward, inherit: env.inherit })),
        signal,
      ),
    );
    const { content, artifact } = await limitSize(out.content, env);
    return finish(content, out.isError ?? false, artifact);
  } catch (err) {
    if (env.signal.aborted) throw err;
    const msg = signal.aborted ? `timed out after ${timeoutMs}ms` : errorMessage(err);
    return finish(`Tool error: ${msg}`, true);
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
