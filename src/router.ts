import { resolveModel } from './presets.ts';
import type { Agent, HookContext, Middleware, ModelRef, ModelRequest, ModelRouter, Provider } from './types.ts';
import { estimateTokens } from './util.ts';

/** All set conditions must hold. */
export interface RouteCondition {
  /** Context size estimate of the request (the `estTokens` of its `model_request` event). */
  minEstTokens?: number;
  maxEstTokens?: number;
  /** Whether the request offers any tool. */
  hasTools?: boolean;
  /** The request is for this turn (1-based) or a later one. */
  turnAtLeast?: number;
}

/** `model` is a model spec: a `models` alias or `"provider/model"` (anything the resolver understands). */
export interface RouteRule { when: RouteCondition; model: string }

export interface RuleRouterOptions { rules: RouteRule[]; default: string }

/** Same estimate as the `model_request` event: the last real usage plus an estimate for what was added since. */
function estimateRequest(req: ModelRequest, ctx: HookContext): number {
  const { lastUsage, lastUsageAt, messages } = ctx.state;
  if (lastUsage && lastUsageAt !== undefined) return lastUsage.inputTokens + lastUsage.outputTokens + estimateTokens(messages.slice(lastUsageAt));
  return estimateTokens(req.instructions ?? '') + estimateTokens(req.tools) + estimateTokens(req.messages);
}

const matches = (when: RouteCondition, req: ModelRequest, ctx: HookContext): boolean => {
  if (when.hasTools !== undefined && (req.tools.length > 0) !== when.hasTools) return false;
  if (when.turnAtLeast !== undefined && ctx.state.turns + 1 < when.turnAtLeast) return false;
  if (when.minEstTokens !== undefined || when.maxEstTokens !== undefined) {
    const est = estimateRequest(req, ctx);
    if (when.minEstTokens !== undefined && est < when.minEstTokens) return false;
    if (when.maxEstTokens !== undefined && est > when.maxEstTokens) return false;
  }
  return true;
};

/** Zero-cost router: the first rule whose conditions all hold picks the model, else `default`. */
export function ruleRouter(opts: RuleRouterOptions): ModelRouter & { readonly models: string[] } {
  if (!opts.default || typeof opts.default !== 'string') throw new Error('ruleRouter requires a default model');
  const rules = opts.rules ?? [];
  for (const [i, r] of rules.entries()) {
    if (!r || typeof r.model !== 'string' || !r.model) throw new Error(`ruleRouter rule ${i} needs a model`);
    if (typeof r.when !== 'object' || r.when === null) throw new Error(`ruleRouter rule ${i} needs a "when" object`);
  }
  return {
    models: [...new Set([...rules.map((r) => r.model), opts.default])],
    select: (req, ctx) => rules.find((r) => matches(r.when, req, ctx))?.model ?? opts.default,
  };
}

export interface RoutedModelOptions {
  router: ModelRouter;
  /** Turns a selected model spec into a provider and model id (default: `resolveModel`, i.e. built-in presets). */
  resolve?: (spec: string) => ModelRef | Promise<ModelRef>;
}

/**
 * Routes each request to the model the router selects, across providers. Returns the model reference to put on the
 * agent and the middleware that asks the router; both are needed. The selected spec shows up as `model` in the
 * `model_request` and `model_response` events. Costs are computed from the agent's own model pricing.
 */
export function routedModel(base: ModelRef, opts: RoutedModelOptions): { model: ModelRef; middleware: Middleware } {
  const resolve = opts.resolve ?? ((spec: string) => resolveModel(spec));
  const resolved = new Map<string, Promise<ModelRef>>();
  const target = (spec: string): Promise<ModelRef> => {
    if (!resolved.has(spec)) {
      const p = Promise.resolve(resolve(spec));
      resolved.set(spec, p);
      p.catch(() => resolved.delete(spec));
    }
    return resolved.get(spec)!;
  };

  const provider: Provider = {
    name: `routed(${base.provider.name})`,
    async generate(req, ctx) {
      if (req.model === base.model) return base.provider.generate(req, ctx);
      const ref = await target(req.model);
      const res = await ref.provider.generate({ ...req, model: ref.model, params: ref.params ?? req.params }, ctx);
      return { ...res, model: req.model };
    },
  };
  const middleware: Middleware = {
    name: 'router',
    async beforeModel(req, ctx) {
      const spec = await opts.router.select(req, ctx);
      if (typeof spec !== 'string' || !spec) throw new Error('router returned no model');
      return spec === req.model ? undefined : { ...req, model: spec };
    },
  };
  return { model: { ...base, provider }, middleware };
}

/** Returns the agent with its model routed by `router` (see `routedModel`). */
export function withRouter(agent: Agent, opts: RoutedModelOptions): Agent {
  const { model, middleware } = routedModel(agent.model, opts);
  return { ...agent, model, middleware: [middleware, ...(agent.middleware ?? [])] };
}
