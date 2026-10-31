# Identity and access

Who a run acts as, what it may call, and which credentials it carries downstream. reinloop defines the contracts and
wires them into the loop, `serve` and the MCP client. Implementations (OIDC verifier, token exchange, OPA, AuthZEN) are
agent-layers adapters: `adapter-oidc`, `adapter-opa`, `adapter-authzen`.

| Concern | Contract | Registry | Config |
|---|---|---|---|
| Inbound authentication | `IdentityVerifier { verify(token) }` -> `Identity` | `registry.verifiers` | `identity.verifier` |
| Outbound credentials | `CredentialProvider { token(audience, opts) }`, `CredentialFactory = (identity?) => CredentialProvider` | `registry.credentials` | `identity.credentials` |
| Authorization | `Authorizer { evaluate(AccessQuestion) }` -> `AccessDecision` | `registry.authorizers` | `policy.pdp` |

All three registries are empty by default. An unknown `type` fails with an error that says none is registered and points
to agent-layers.

## Identity in a run

`RunOptions.identity` and `RunOptions.credentials` set who the run acts as. They reach tools as `ToolContext.identity` /
`credentials` and middleware as `HookContext.identity`. `Identity.token` is never written to events, stores, sinks or
`tool_decision` reasons. A `CredentialFactory` is called with the run identity, or without it for the agent's own
credentials (for example MCP connection setup outside any run).

## Policy

Local rules take an optional `when`:

```json
{ "policy": { "rules": [
  { "risk": "write", "when": { "roles": ["analyst", "admin"] }, "action": "allow" },
  { "match": "shell", "when": { "kind": "agent" }, "action": "deny" },
  { "risk": "write", "action": "deny" }
] } }
```

Every set field must match: `roles` and `scopes` are any-of, `kind` is exact. A rule with `when` never matches a run
without identity.

### External PDP

`policy.pdp` is `{ type, onError, includeArgs, maxReasonChars, ...factory options }`. `type` resolves through
`registry.authorizers`; in code, `pdp: { authorizer }` sets the authorizer directly.

```json
{ "policy": { "pdp": { "type": "opa", "url": "${env:OPA_URL}", "onError": "deny" } } }
```

`type: "opa"` here is whatever a plugin registered, for example a wrapper of `adapter-opa`:
`registry.authorizers.set('opa', (options) => myAuthorizer(options))`.

Order in `authorizeCall`:

1. Local rules. `deny` is final; the PDP is not asked.
2. For `allow` or `ask`, the PDP evaluates an `AccessQuestion`. `decision: false` denies with reason `pdp: <reason>`;
   `true` keeps the local decision, so `ask` still goes to the approver.
3. PDP failure (error, timeout, malformed answer) follows `onError`: `deny` (default), `ask` or `allow`.

`accessQuestion` builds the question for a call: `caller` (`id`, `kind` of `user`, `agent` or `anonymous`, `roles`,
`scopes`), `action: "call"`, `target` (`kind`, `id`, `layer`, `risk`, `agent`) and `args`. `args` is included only with
`includeArgs: true` (default false), reasons are cut to `maxReasonChars` (default 200), and the token never leaves the
process. A run without identity is the explicit `anonymous` caller, never the agent. `publicQuestion` normalizes a
question to what may leave the process. The shape follows the agent-layers `AccessQuestion`.

## Configuration

```json
{
  "identity": { "verifier": { "type": "oidc", "issuer": "${env:OIDC_ISSUER}" }, "credentials": { "type": "oidc", "mode": "on-behalf-of" }, "required": true },
  "mcpServers": { "tools": { "url": "https://tools.example.com/mcp", "auth": { "audience": "tools-api", "scopes": ["tools.read"] } } }
}
```

`type` is required in `verifier` and `credentials` (`"oidc"` above is whatever a plugin registered, for example a wrapper of `adapter-oidc`); the other fields go to the registered factory. `runtime.identity`
exposes the built verifier and factory.

## HTTP (`reinloop serve`)

`serve(runtime, { identity: { verifier, required } | false, token })`; the verifier defaults to the one from config.

- `/v1/*` needs `Authorization: Bearer <token>`. Missing (when `required`, the default) or invalid -> `401` with an
  RFC 6750 `WWW-Authenticate: Bearer ...`. A present but malformed header is never treated as anonymous.
- A verifier error with an `IdentityError` `code` starting with `identity_` (provider unavailable or misconfigured) -> `503`.
- The static `token` is an operator credential: it runs without identity and may read every run log.
- Verified callers read and continue only runs started under their own subject (others: `404`); listing runs needs the
  operator token (`403`).
- `required: false`: requests without a header run anonymously and see only runs without identity.

## MCP (streamable HTTP)

`auth: { audience, scopes? }` on an MCP server sends `Authorization: Bearer <token>` for that audience, taken from the
run's `CredentialProvider`, on every `tools/call`; without credentials the call fails as a tool error. Connection setup
(`initialize`, `tools/list`, session close) happens outside any run and uses the agent's own credentials, from the
`CredentialFactory` called without identity. The credential header replaces a static `headers.authorization`, and tokens
are masked in results and errors. Servers that bind the MCP session to the principal that opened it may reject per-user
calls on a shared session.

## Implementations

`adapter-oidc` (JWT/JWKS verifier, RFC 8693 token exchange and client credentials), `adapter-opa`, `adapter-authzen` in
agent-layers, with `@agent-layers/conformance` for the verifier, credential and authorizer contracts.
