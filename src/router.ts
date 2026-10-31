import { resolveModel } from './presets.ts';
import type { Agent, Middleware, ModelRef, ModelRouter, Provider } from './types.ts';

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
