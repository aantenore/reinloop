# Identity and access

Who a run acts as, what it may call, and which credentials it carries downstream.

| Concern | Standard | Extension point | Built in |
|---|---|---|---|
| Inbound authentication | OIDC Discovery 1.0, JWKS (RFC 7517), JWT access tokens (RFC 7519 / 9068) | `IdentityVerifier` | `oidcVerifier` |
| Outbound credentials | RFC 8693 token exchange (on behalf of), OAuth 2 `client_credentials` (self) | `CredentialProvider` (per run), `CredentialFactory` | `oidcCredentials` |
| Authorization | Local rules + OpenID AuthZEN evaluation API | `Authorizer` | `authzenAuthorizer`, `opaAuthorizer` |

The verifier, credential factory and authorizers (`src/identity/verifier.ts`, `credentials.ts`, `authorizers.ts`,
`jwt.ts`, `http.ts`) depend only on contract types and `node:*`, so they can run outside the agent loop (e.g. in a
gateway). The loop wiring is `src/identity/authorize.ts`, `policy.ts`, `serve.ts` and `mcp/client.ts`.

## Verifying tokens

```ts
import { oidcVerifier } from 'reinloop';

const verifier = oidcVerifier({ issuer: 'https://idp.example.com/realms/agents', audience: 'agent-api' });
const identity = await verifier.verify(bearerToken); // throws IdentityError (code invalid_token) when invalid
```

- Keys come from `{issuer}/.well-known/openid-configuration` → `jwks_uri` (or `jwksUri`). The discovered `issuer`
  must equal the configured one.
- The JWKS is cached (`jwksMaxAgeMs`, default 10 min). An unknown `kid` triggers a refetch, at most once per
  `jwksMinRefreshMs` (default 30 s); during an IdP outage the last key set keeps working.
- Accepted algorithms: `algorithms` (default `RS256`, `ES256`; also `RS384/512`, `PS256/384/512`, `ES384/512`,
  `EdDSA`). `none` and `HS*` are always refused. The key type and curve must match the algorithm; RSA keys need
  2048 bits or more.
- Claims: `iss` must match; `aud` must contain one of `audience` (when set); `exp` is required; `nbf` and `iat` are
  checked with `clockSkewSec` (default 60); `maxTokenAgeSec` optionally bounds `iat`. Tokens with `crit` headers are
  refused.
- Plain `http` issuer/JWKS URLs are accepted only on loopback hosts unless `allowHttp: true`.

Identity mapping:

| Identity | From |
|---|---|
| `subject` | `sub`; an allow-listed agent token without `sub`: its client. Any other token without `sub` is refused |
| `kind` | `agent` only when the token's `azp` (or `client_id`) is in `agentClients` and it has no `sub`, or `sub` equals that client's `agentSubjects` entry (when none is set: the client id, RFC 9068); otherwise `user`. Without `agentClients` no token is `agent`; usernames never count. Override with `kind: (claims) => ...` |
| `roles` | `realm_access.roles` + `roles` + `resource_access[client].roles` of `roleClients` only (default: the `audience` values), as `<client>:<role>` unless `namespaceClientRoles: false` |
| `scopes` | `scope` (space separated) + `scp` |
| `claims`, `token` | the verified payload and the raw token |

Set `audience`: without it, any token of the issuer (an ID token for another client included) is accepted, and no
client roles are read.

For Keycloak, client-credentials tokens carry the service-account user id as `sub`: set
`"agentClients": ["agent-runtime"]` and `"agentSubjects": { "agent-runtime": "<service-account user id>" }` (admin API:
`GET /admin/realms/<realm>/clients/<id>/service-account-user`).

Migration: client roles are namespaced. A `when.roles` rule or a PDP policy that matched a client role `writer` now
matches `tools-api:writer` (or set `namespaceClientRoles: false` and list the client in `roleClients`). Rules on
`kind: agent` need `agentClients`.

## Credentials for downstream calls

`oidcCredentials(opts)` returns a `CredentialFactory`: `(identity?) => CredentialProvider`. The runtime binds it to
the run identity at run start, so `RunOptions.credentials` stays a plain `CredentialProvider`:

```ts
const creds = oidcCredentials({ issuer, clientId: 'agent-runtime', clientSecret, mode: 'on-behalf-of' });
await run(agent, input, { identity, credentials: creds(identity) });
// in a tool: await ctx.credentials.token('tools-api', { scopes: ['tools.write'] })
```

| `mode` | Request |
|---|---|
| `on-behalf-of` | `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<caller token>`, `subject_token_type` and `requested_token_type` `…:access_token`, `audience`, `scope` |
| `self` | `grant_type=client_credentials`, `audience`, `scope` |

- Client authentication: `client_secret_basic` (default) or `client_secret_post` (`authMethod`).
- `audienceParam`: `audience` (default), `resource` (RFC 8707) or `none`.
- Cache key: audience, sorted scopes and, on behalf of a user, the subject plus a SHA-256 of the caller token. Entries
  live until `expires_in − refreshSkewSec` (default 30 s) and never past the caller token's `exp`. Concurrent requests
  for the same key share one round trip.
- On behalf of without a caller token fails (`identity_missing`); it never falls back to the agent's own identity.

## Policy

Local rules take an optional `when`:

```json
{ "policy": { "rules": [
  { "risk": "write", "when": { "roles": ["analyst", "admin"] }, "action": "allow" },
  { "match": "shell", "when": { "kind": "agent" }, "action": "deny" },
  { "risk": "write", "action": "deny" }
] } }
```

Every set field must match: `roles` and `scopes` are any-of (one listed value is enough), `kind` is exact. A rule
with `when` never matches a run without identity. `decide(policy, call, tool, identity?)` is the local step.

### External PDP

```json
{ "policy": { "pdp": { "type": "opa", "url": "${env:OPA_URL}", "path": "agents/allow", "onError": "deny" } } }
```

Order (`authorizeCall`):

1. Local rules. `deny` is final; the PDP is not asked.
2. For `allow` or `ask`, the PDP evaluates an AccessRequest. `false` → denied, reason `pdp: <reason>`. `true` keeps the
   local decision, so `ask` still goes to the approver.
3. PDP failure (network, timeout, malformed answer) → `onError`: `deny` (default), `ask` or `allow`.

The same path applies to hosted tools before they are offered. The reason is on `tool_decision`; tokens never are.

AccessRequest (AuthZEN shape):

```json
{
  "subject":  { "type": "user", "id": "<sub>", "properties": { "roles": [], "scopes": [], "authenticated": true } },
  "action":   { "name": "call" },
  "resource": { "type": "tool", "id": "<tool>", "properties": { "risk": "write", "agent": "<agent>", "layer": "tool" } },
  "context":  { "args": {} }
}
```

`context.args` is sent only with `includeArgs: true` (arguments may hold personal data). A run without identity is
sent as `{ "type": "agent", "id": "agent:<name>", "properties": { "authenticated": false } }`.

| Adapter | Request | Answer |
|---|---|---|
| `authzen` | `POST {url}/access/v1/evaluation` | `{ decision, context?: { reason \| reason_admin \| reason_user } }` |
| `opa` | `POST {url}/v1/data/{path}` with `{ input }` | `{ result: boolean }` or `{ result: { allow, reason? } }`; an undefined result is an error |

Both take `headers` (e.g. a PDP API key) and `timeoutMs` (default 5 s). More adapters (Cedar, OpenFGA, Cerbos...)
register from a plugin: `registry.authorizers.set('cedar', (options) => myAuthorizer(options))`. Programmatic agents
set `policy.pdp.authorizer` directly.

## Configuration

```json
{
  "identity": {
    "verifier":    { "issuer": "${env:OIDC_ISSUER}", "audience": "agent-api" },
    "credentials": { "issuer": "${env:OIDC_ISSUER}", "clientId": "${env:OIDC_CLIENT_ID}", "clientSecret": "${env:OIDC_CLIENT_SECRET}", "mode": "on-behalf-of" },
    "required": true
  },
  "mcpServers": { "tools": { "url": "https://tools.example.com/mcp", "auth": { "audience": "tools-api", "scopes": ["tools.read"] } } }
}
```

`verifier` and `credentials` take `type` (default `oidc`) from `registry.verifiers` / `registry.credentials`; the other
fields go to the factory. `runtime.identity` exposes the built verifier and factory.

## HTTP (`reinloop serve`)

With a verifier (from config or `serve(rt, { identity: { verifier, required } })`):

- `/v1/*` needs `Authorization: Bearer <JWT>`. Missing (when `required`, the default) or invalid → `401` with
  `WWW-Authenticate: Bearer ...`. A present but malformed header is never treated as anonymous. IdP unreachable → `503`.
- The run is started with the verified identity; credentials are bound to it.
- The static `--token` keeps working as an operator credential: it runs without identity and may read every run log.
- Run logs: identity callers read and continue (`runId`) only runs started under their own subject (others: `404`);
  `GET /v1/runs` (listing) needs the operator token (`403`).
- `required: false`: requests without a header run anonymously (they see only runs without identity).

## MCP (streamable HTTP)

`auth: { audience, scopes? }` on an MCP server sends `Authorization: Bearer <token>` for that audience from the
run's credentials on every `tools/call`; without credentials the call fails as a tool error. Connection setup
(`initialize`, `tools/list`, session close) happens outside any run and uses the agent's own identity (the configured
credentials in `self` mode). The credential header replaces a static `headers.authorization`. Servers that bind the
MCP session to the principal that opened it may reject per-user calls on a shared session.

## Conformance

`src/conformance/identity.ts`, no test framework needed; each returns a list of failures:

- `checkIdentityVerifier(verifier, { validToken, expiredToken?, invalidTokens?, expect? })`: accepts the valid token
  with a well-formed Identity; rejects garbage, a tampered signature, `alg: none` and the invalid tokens; errors do not
  echo the token.
- `checkAuthorizer(authz, { allowCase, denyCase })`: boolean decisions as expected, string reasons, stable answers.
- `checkCredentialProvider(provider, { audience, scopes?, inspect? })`: non-empty token, repeatable, empty audience
  refused, optional custom inspection of the issued token.

## Threat notes

- Tokens: `Identity.token` and issued credentials are never written to events, stores, sinks or `tool_decision`
  reasons. Verifier errors name the failed check only.
- Algorithm confusion: no symmetric or `none` algorithms; the key type is bound to the algorithm.
- Key rotation DoS: unknown `kid` refetches are rate limited; a known `kid` with a bad signature never refetches.
- Mix-up: the discovery `issuer` must match; `iss` must match exactly.
- Identity confusion: `agent` is never inferred from names; it needs an allow-listed client and a client-credentials
  subject. A token exchanged by the agent client on behalf of a user keeps the user's `sub` and stays `user`.
- Privilege confusion: only the realm, the `roles` claim and the `roleClients` are read; client roles are namespaced
  so a client role cannot pose as a realm role.
- PDP outages deny by default. `onError: "allow"` is an explicit availability-over-safety choice.
