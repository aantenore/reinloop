import { decide, DEFAULT_BUDGET, exceededBudget } from './policy.ts';
import { validate } from './schema.ts';
import { Channel, EPHEMERAL, pendingToolCalls, reduce, replay } from './state.ts';
import { memoryStore } from './store/memory.ts';
import { executeToolCalls } from './tools/executor.ts';
import type {
  Agent, Approver, Budget, EventMap, EventType, HookContext, Message, ModelRequest, Pricing, RunEvent, RunOptions, RunResult, RunState, RunStatus,
  RunStore, ToolSpec, Usage,
} from './types.ts';
import { addUsage, errorMessage, estimateTokens, hasVisibleParts, newId, textOf, toolCallsOf, userMessage } from './util.ts';

export interface RunHandle extends AsyncIterable<RunEvent> {
  readonly runId: string;
  readonly result: Promise<RunResult>;
  abort(reason?: unknown): void;
}

/** Consecutive empty model answers retried before the run fails. */
export const MAX_EMPTY_RESPONSES = 2;

/** Feedback sent to the model when a structured final answer fails validation. */
export const OUTPUT_FEEDBACK = (schema: unknown, problems: string) =>
  `Your final answer must be only JSON matching this schema: ${JSON.stringify(schema)}. Problems: ${problems}`;

/** Runs an agent and exposes every event as an async iterable. Breaking out of the iteration aborts the run. */
export function stream(agent: Agent, input?: string | Message[], opts: RunOptions = {}): RunHandle {
  const continuing = opts.runId !== undefined;
  const runId = opts.runId ?? newId();
  return createHandle(runId, opts.signal, (signal, channel) => drive(agent, input, { ...opts, runId }, continuing, signal, channel));
}

/** Wraps a driver in a RunHandle: async-iterable events, result promise, abort. Shared by agents and teams. */
export function createHandle(
  runId: string,
  outer: AbortSignal | undefined,
  driver: (signal: AbortSignal, channel: Channel<RunEvent>) => Promise<RunResult>,
): RunHandle {
  const channel = new Channel<RunEvent>();
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  const result = driver(signal, channel).finally(() => channel.close());
  result.catch(() => {});
  return {
    runId,
    result,
    abort: (reason) => controller.abort(reason ?? new Error('aborted')),
    [Symbol.asyncIterator]() {
      const it = channel[Symbol.asyncIterator]();
      return {
        next: () => it.next(),
        async return() {
          controller.abort(new Error('consumer stopped iterating'));
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** Runs an agent to completion. Pass `opts.runId` to continue a stored session or resume a crashed run. */
export function run(agent: Agent, input?: string | Message[], opts: RunOptions = {}): Promise<RunResult> {
  return stream(agent, input, opts).result;
}

async function drive(
  agent: Agent,
  input: string | Message[] | undefined,
  opts: RunOptions & { runId: string },
  continuing: boolean,
  outerSignal: AbortSignal,
  channel: Channel<RunEvent>,
): Promise<RunResult> {
  const { runId } = opts;
  let signal = outerSignal;
  const store = opts.store ?? memoryStore();
  const prior = continuing ? await store.load(runId) : [];
  const state = replay(runId, agent.name, prior);
  const base = { turns: state.turns, toolCalls: state.toolCalls, usage: state.usage, costUsd: state.costUsd };
  const started = Date.now();
  const specs: ToolSpec[] = agent.tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema, ...(t.hosted && { hosted: t.hosted }) }));
  let offered: ToolSpec[] | undefined; // tool specs after the hosted-tool policy check, done once per run
  const tools = new Map(agent.tools.map((t) => [t.name, t]));
  const hookCtx: HookContext = { runId, agent: agent.name, state };

  const storeFailure = new AbortController();
  signal = AbortSignal.any([signal, storeFailure.signal]);
  const { emit, flush } = createEmitter(state, store, opts, channel, (err) => storeFailure.abort(err));

  let end: { status: RunStatus; reason?: string } | undefined;
  let data: unknown;
  let stopOutput: string | undefined;
  let outputRetries = agent.output?.retries ?? 1;
  let lastStop: string | undefined;
  let emptyStreak = 0;
  let raisedMaxTokens: number | undefined;

  emit('run_start', { agent: agent.name, resumed: prior.length > 0, parentRunId: opts.parentRunId });
  for (const message of normalizeInput(input)) emit('message', { message, source: 'input' });

  try {
    while (!end) {
      signal.throwIfAborted();

      const pending = pendingToolCalls(state.messages);
      if (pending.length) {
        await executeToolCalls(pending, {
          agent, tools, runId, state, signal,
          emit: emit as (type: RunEvent['type'], data: any) => void,
          forward: (ev) => channel.push(ev),
          approve: opts.approve,
          inherit: { store: opts.store, approve: opts.approve, sinks: opts.sinks },
        });
        await flush();
        continue;
      }

      // A tool asked to end the run: the whole batch has run (also after a resume), the first stop in call order wins.
      const stop = firstStop(state);
      if (stop) {
        stopOutput = stop.content;
        const checked = agent.output ? checkStopData(agent, stop) : { ok: true as const, data: stop.data };
        if (checked.ok) {
          data = checked.data;
          end = { status: 'completed', reason: `tool:${stop.name}` };
        } else end = { status: 'failed', reason: `invalid structured output from tool ${stop.name}: ${checked.error}` };
        break;
      }

      const last = state.messages.at(-1);
      if (!last) {
        end = { status: 'failed', reason: 'no input' };
        break;
      }
      // A paused hosted-tool turn is sent back as-is so the provider resumes it.
      if (last.role === 'assistant' && lastStop !== 'pause_turn') {
        const checked = checkOutput(agent, textOf(last));
        if (checked.ok) {
          data = checked.data;
          end = { status: 'completed', reason: lastStop === 'max_tokens' ? 'max_tokens' : undefined };
        } else if (lastStop === 'max_tokens') {
          end = { status: 'stopped', reason: 'max_tokens' }; // truncated output: feedback would hit the same limit
        } else if (outputRetries-- > 0) {
          emit('message', { message: userMessage(OUTPUT_FEEDBACK(agent.output!.schema, checked.error)), source: 'harness' });
        } else {
          end = { status: 'failed', reason: `invalid structured output: ${checked.error}` };
        }
        continue;
      }

      const counters = {
        turns: state.turns - base.turns,
        toolCalls: state.toolCalls - base.toolCalls,
        costUsd: state.costUsd - base.costUsd,
        usage: {
          inputTokens: state.usage.inputTokens - base.usage.inputTokens,
          outputTokens: state.usage.outputTokens - base.usage.outputTokens,
        },
      };
      const exceeded = exceededBudget(agent.budget ?? DEFAULT_BUDGET, counters, Date.now() - started);
      if (exceeded) {
        end = { status: 'stopped', reason: `budget:${exceeded}` };
        break;
      }

      if (agent.compaction) {
        const before = contextTokens(state, agent, specs);
        if (before >= agent.compaction.thresholdTokens) {
          let usage: Usage | undefined;
          const messages = await agent.compaction.strategy.compact(state.messages, {
            model: agent.model,
            signal,
            estimate: estimateTokens,
            track: (u) => (usage = usage ? addUsage(usage, u) : u),
          });
          if (messages.length < state.messages.length || usage) {
            const afterTokens = estimateTokens(agent.instructions ?? '') + estimateTokens(specs) + estimateTokens(messages);
            const costUsd = usage ? costOf(agent.model.pricing, usage) : 0;
            emit('compaction', { strategy: agent.compaction.strategy.name, beforeTokens: before, afterTokens, messages, usage, costUsd });
          }
        }
      }

      offered ??= await allowedHostedTools(agent, specs, runId, opts.approve, emit);
      const turn = state.turns + 1;
      emit('turn_start', { turn });
      const params = raisedMaxTokens ? { ...agent.model.params, maxTokens: raisedMaxTokens } : agent.model.params;
      const turnTools = capHostedUses(offered, agent.budget ?? DEFAULT_BUDGET, counters.toolCalls);
      let req: ModelRequest = { model: agent.model.model, instructions: agent.instructions, messages: [...state.messages], tools: turnTools, params };
      // Always offered: providers map it to native structured output that coexists with tool calls, or skip it.
      if (agent.output) req.responseSchema = agent.output.schema;
      for (const mw of agent.middleware ?? []) req = (await mw.beforeModel?.(req, hookCtx)) ?? req;
      emit('model_request', { turn, model: req.model, messages: req.messages.length, estTokens: contextTokens(state, agent, specs) });

      const t0 = performance.now();
      let res = await agent.model.provider.generate(req, {
        signal,
        onText: (text) => emit('text_delta', { text }),
        onThinking: (text) => emit('thinking_delta', { text }),
      });
      for (const mw of agent.middleware ?? []) res = (await mw.afterModel?.(res, hookCtx)) ?? res;
      for (const part of res.message.parts) if (part.type === 'tool_call' && !part.id) part.id = `call_${newId().slice(0, 12)}`;
      lastStop = res.stopReason;
      // Opt-in: one repeat with a higher limit after a max_tokens stop that produced no tool calls.
      const retryMax = agent.model.params?.retryMaxTokens;
      const discarded = res.stopReason === 'max_tokens' && !raisedMaxTokens && !!retryMax && !toolCallsOf(res.message).length;
      if (discarded) raisedMaxTokens = retryMax;
      emit('model_response', {
        turn,
        model: res.model ?? req.model,
        message: res.message,
        usage: res.usage,
        stopReason: res.stopReason,
        latencyMs: Math.round(performance.now() - t0),
        costUsd: res.cached ? 0 : costOf(agent.model.pricing, res.usage),
        ...(discarded && { discarded: true }),
      });
      for (const part of res.message.parts) {
        if (part.type === 'hosted_call') emit('hosted_tool_start', { callId: part.id, name: part.name, input: part.input });
        else if (part.type === 'hosted_result') {
          emit('hosted_tool_result', {
            callId: part.callId, name: part.name, summary: part.summary ?? part.blockType, isError: part.isError ?? false, ...(part.sources && { sources: part.sources }),
          });
        }
      }
      await flush();
      if (discarded) continue;
      // No text and no tool calls: a max_tokens stop (e.g. spent on reasoning) or a refusal ends the run with that
      // reason, since the identical request would end the same way; other empty answers are retried a few times.
      const visible = hasVisibleParts(res.message);
      emptyStreak = visible ? 0 : emptyStreak + 1;
      if (!visible && res.stopReason === 'max_tokens') end = { status: 'stopped', reason: 'max_tokens' };
      else if (!visible && res.stopReason === 'refusal') end = { status: 'failed', reason: 'refusal' };
      else if (emptyStreak > MAX_EMPTY_RESPONSES) end = { status: 'failed', reason: `model returned ${emptyStreak} empty responses in a row` };
    }
  } catch (err) {
    end = storeFailure.signal.aborted
      ? { status: 'failed', reason: `store: ${errorMessage(storeFailure.signal.reason)}` }
      : signal.aborted
        ? { status: 'interrupted', reason: errorMessage(signal.reason ?? err) }
        : { status: 'failed', reason: errorMessage(err) };
  }

  await flush().catch((err) => {
    end = { status: 'failed', reason: `store: ${errorMessage(err)}` };
  });
  const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
  const output = stopOutput ?? textOf(lastAssistant);
  emit('run_end', { status: end!.status, reason: end!.reason, output, usage: state.usage, turns: state.turns, costUsd: state.costUsd });
  await flush().catch(() => {});
  return { runId, status: end!.status, reason: end!.reason, output, data, usage: state.usage, costUsd: state.costUsd, turns: state.turns, messages: state.messages };
}

/** Folds, persists (non-ephemeral), fans out to sinks and to the handle's channel, in that order. */
export function createEmitter(
  state: RunState,
  store: RunStore,
  opts: RunOptions,
  channel: Channel<RunEvent>,
  onPersistError?: (err: unknown) => void,
) {
  // Appends are chained in order; after the first failure nothing more is written, so the log stays a
  // consistent prefix, and `onPersistError` lets the run stop before more side effects happen.
  let persist: Promise<void> = Promise.resolve();
  let failed = false;
  const emit = <T extends EventType>(type: T, data: EventMap[T]): void => {
    const ev = { runId: state.runId, seq: state.seq + 1, ts: Date.now(), type, data, ...(opts.parentRunId && { parentRunId: opts.parentRunId }) } as RunEvent;
    reduce(state, ev);
    if (!EPHEMERAL.has(type)) {
      persist = persist.then(() => store.append(ev));
      persist.catch((err) => {
        if (!failed) (failed = true), onPersistError?.(err);
      });
    }
    for (const sink of opts.sinks ?? []) {
      try {
        sink.onEvent(ev);
      } catch (err) {
        process.emitWarning(`sink error: ${errorMessage(err)}`);
      }
    }
    channel.push(ev);
  };
  return { emit, flush: () => persist };
}

export function normalizeInput(input: string | Message[] | undefined): Message[] {
  if (input === undefined) return [];
  return typeof input === 'string' ? [userMessage(input)] : input;
}

/** Uses the provider's real token count from the last response when available. */
export function contextTokens(state: RunState, agent: Agent, specs: ToolSpec[]): number {
  if (state.lastUsage && state.lastUsageAt !== undefined) {
    return state.lastUsage.inputTokens + state.lastUsage.outputTokens + estimateTokens(state.messages.slice(state.lastUsageAt));
  }
  return estimateTokens(agent.instructions ?? '') + estimateTokens(specs) + estimateTokens(state.messages);
}

export function costOf(pricing: Pricing | undefined, usage: Usage): number {
  if (!pricing) return 0;
  const cached = usage.cacheReadTokens ?? 0;
  let hosted = 0;
  for (const [kind, count] of Object.entries(usage.serverToolUse ?? {})) hosted += count * (pricing.serverToolUsd?.[kind] ?? 0);
  return (
    ((usage.inputTokens - cached) * pricing.inputPerMTok +
      cached * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
      usage.outputTokens * pricing.outputPerMTok) /
      1_000_000 +
    hosted
  );
}

/**
 * Hosted tools run inside the provider, so the policy is applied once per run, before they are offered: `deny` (or
 * `ask` without approval) removes the tool from the request. Each decision is emitted as `tool_decision`.
 */
async function allowedHostedTools(
  agent: Agent,
  specs: ToolSpec[],
  runId: string,
  approve: Approver | undefined,
  emit: <T extends EventType>(type: T, data: EventMap[T]) => void,
): Promise<ToolSpec[]> {
  const denied = new Set<string>();
  for (const tool of agent.tools) {
    if (!tool.hosted) continue;
    const call = { type: 'tool_call' as const, id: `hosted:${tool.name}`, name: tool.name, args: {} };
    const verdict = decide(agent.policy, call, tool);
    let allowed = verdict.decision === 'allow';
    let reason = verdict.reason;
    if (verdict.decision === 'ask') {
      allowed = approve ? await approve({ runId, agent: agent.name, call, tool, reason }) : false;
      reason = `${reason}: ${allowed ? 'approved' : approve ? 'rejected by approver' : 'no approver configured'}`;
    }
    emit('tool_decision', { callId: call.id, name: tool.name, allowed, reason: `hosted tool, ${reason}` });
    if (!allowed) denied.add(tool.name);
  }
  return denied.size ? specs.filter((s) => !denied.has(s.name)) : specs;
}

/** Caps each hosted tool's use limit (e.g. `max_uses`) to what is left of `maxToolCalls`. */
function capHostedUses(specs: ToolSpec[], budget: Budget, used: number): ToolSpec[] {
  if (budget.maxToolCalls === undefined) return specs;
  const left = Math.max(0, budget.maxToolCalls - used);
  return specs.map((s) => {
    const key = s.hosted?.limitParam;
    if (!key) return s;
    const current = s.hosted!.params?.[key];
    const capped = typeof current === 'number' ? Math.min(current, left) : left;
    return { ...s, hosted: { ...s.hosted!, params: { ...s.hosted!.params, [key]: capped } } };
  });
}

type OutputCheck = { ok: true; data?: unknown } | { ok: false; error: string };

type Stop = NonNullable<RunState['stops']>[string];

/** The stop requested by the latest batch of tool calls, in the model's call order. */
function firstStop(state: RunState): Stop | undefined {
  if (!state.stops) return undefined;
  const lastCall = [...state.messages].reverse().find((m) => m.role === 'assistant');
  for (const p of lastCall?.parts ?? []) if (p.type === 'tool_call' && state.stops[p.id]) return state.stops[p.id];
  return undefined;
}

/** Validates a stopping tool's `data` (or its content parsed as JSON) against the output schema; no model retry. */
function checkStopData(agent: Agent, stop: Stop): OutputCheck {
  if (!('data' in stop)) return checkOutput(agent, stop.content);
  const errors = validate(agent.output!.schema, stop.data, '$');
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true, data: stop.data };
}

/** Tolerant JSON extraction: code fences, surrounding prose, and `\'` escapes that small models emit. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  const start = trimmed.search(/[{[]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  const candidates = [trimmed];
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of [...candidates, ...candidates.map((c) => c.replace(/\\'/g, "'"))]) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function checkOutput(agent: Agent, text: string): OutputCheck {
  if (!agent.output) return { ok: true };
  const data = parseJsonLoose(text);
  if (data === undefined) return { ok: false, error: 'not valid JSON' };
  const errors = validate(agent.output.schema, data, '$');
  if (!errors.length) return { ok: true, data };
  // Some models echo the schema shape ({ type, properties: {...values} }): accept the values when they validate.
  const inner = (data as { properties?: unknown })?.properties;
  if (inner && typeof inner === 'object' && !validate(agent.output.schema, inner, '$').length) return { ok: true, data: inner };
  return { ok: false, error: errors.join('; ') };
}
