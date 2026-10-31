# Model access: cache and router

Two hooks, each available in process or as a gateway.

| | In process | Gateway |
|---|---|---|
| Cache | `CacheStore` + `withResponseCache` | gateway cache (LiteLLM + Valkey/Redis) |
| Router | `ModelRouter` + `routedModel` / `withRouter` | model groups and fallbacks of the gateway |

A gateway is an OpenAI-compatible endpoint: use it as a `providers` entry of type `openai-compatible` with the gateway
URL and key, and the gateway's model group as the model id.

## Response cache

`withResponseCache` memoizes whole model responses keyed by a hash of the request (model, instructions, history, tools,
params). Extension point: `CacheStore { get, set }`, registered with `registry.caches`. Built in: `memory`, `file`.

```json
{ "responseCache": { "type": "file", "dir": ".reinloop/cache", "ttlMs": 86400000 } }
```

An agent opts out with `"responseCache": false`. A hit is reported with `cached: true` and costs nothing.

## Model router

```ts
interface ModelRouter { select(req: ModelRequest, ctx: HookContext): string | Promise<string> }
```

`select` returns a model spec (a `models` alias or `"provider/model"`), possibly served by a different provider than the
agent's own model. Routing is a pair, a provider that dispatches on `req.model` and a `beforeModel` middleware that asks
the router. In code:

```ts
import { withRouter } from 'reinloop';

const routed = withRouter(agent, { router: myRouter }); // or routedModel(base, opts) for the model and middleware separately
```

### Config

`routers.<name>` is `{ type, ...options }`; an agent attaches one with `router: <name>` (also in agent-file
frontmatter). `type` resolves through `registry.routers`, which is empty by default: a plugin registers the types.

```json
{ "routers": { "by-size": { "type": "my-router", "threshold": 6000 } }, "agents": { "main": { "model": "small", "router": "by-size" } } }
```

```ts
registry.routers.set('my-router', (options, ctx) => ({ select(req, hookCtx) { return 'large'; } }));
```

A router object with a `models: string[]` property has those specs resolved when the agent is built, so a typo fails at
startup. The selected spec is the `model` of that turn's `model_request` and `model_response` events, and the response
is priced with the selected model's pricing (`ModelResponse.pricing`; unknown pricing costs zero).

Implementations: `adapter-rule-router` in agent-layers (rules over context size, tools and turn).
