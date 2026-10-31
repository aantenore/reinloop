# L7 Cache and router

Two concerns, each available in process or as a gateway.

| | In process | Gateway |
|---|---|---|
| Cache | `CacheStore` + `responseCache` | gateway cache (LiteLLM + Valkey/Redis) |
| Router | `ModelRouter` + `routers` | model groups and fallbacks of the gateway |

The standard for the gateway is an OpenAI-compatible endpoint: use it as a `providers` entry of type
`openai-compatible` with the gateway URL and key, and the gateway's model group as the model id.

## Response cache

`responseCache` memoizes whole model responses keyed by a hash of the request (model, instructions, history, tools,
params). Extension point: `CacheStore { get, set }`, registered with `registry.caches`. Built in: `memory`, `file`.

```json
{ "responseCache": { "type": "file", "dir": ".reinloop/cache", "ttlMs": 86400000 } }
```

An agent opts out with `"responseCache": false`. A hit is reported with `cached: true` and costs nothing.

## Model router

```ts
interface ModelRouter { select(req: ModelRequest, ctx: HookContext): string | Promise<string> }
```

`select` returns a model spec (a `models` alias or `"provider/model"`). The model may be served by a different
provider than the agent's own model: specs resolve through the same path as an agent's `model`.

Routing is a pair, a provider that dispatches on `req.model` and a `beforeModel` middleware that asks the router:

```ts
import { ruleRouter, withRouter } from 'reinloop';

const router = ruleRouter({
  rules: [{ when: { minEstTokens: 6000 }, model: 'anthropic/claude-sonnet-5-5' }],
  default: 'ollama/qwen3:4b',
});
const routed = withRouter(agent, { router }); // or routedModel(base, opts) for the model and middleware separately
```

`ruleRouter` is free (no model call) and lives in `src/rule-router.ts`, which imports only contract types. Rules are tried in order and the first whose conditions all hold wins:

| Condition | Holds when |
|---|---|
| `minEstTokens` / `maxEstTokens` | the request's context estimate (the `estTokens` of `model_request`) is at least / at most this |
| `hasTools` | the request offers (`true`) or does not offer (`false`) any tool |
| `turnAtLeast` | the request is for this turn (1-based) or a later one |

### Config

Declare routers by name under `routers` (component entries: `type` selects a registered factory, the rest are
options) and attach one to an agent with `router`. The agent's `model` stays the model used when the router selects
it by its bare id; any other spec the router returns is resolved like a normal model.

```json
{
  "models": { "small": { "provider": "local", "model": "qwen3:4b" }, "large": { "provider": "cloud", "model": "big-1" } },
  "routers": {
    "by-size": { "type": "rule", "rules": [{ "when": { "minEstTokens": 6000 }, "model": "large" }], "default": "small" }
  },
  "agents": { "main": { "model": "small", "router": "by-size" } }
}
```

Custom routers: `registry.routers.set('my-router', (options, ctx) => ({ select(req, ctx) { ... } }))`. A router object
with a `models: string[]` property has those specs resolved when the agent is built, so a typo fails at startup. An
agent file accepts `router:` in its frontmatter.

### Observability

The selected spec is the `model` of the `model_request` and `model_response` events of that turn.

### Limits

- Cost is computed from the pricing of the agent's own model, whichever model the router picked.
- Params set on the agent apply to every routed model unless the selected model's `models` entry defines its own.
- The `models.<name>.fallback` chains of a selected model apply as usual.
