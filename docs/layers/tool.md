# Tools

Four ways to give an agent a tool, from most standard to most flexible.

| Way | Standard | Use it when |
|---|---|---|
| MCP server (`mcpServers`) | Model Context Protocol, stdio and streamable HTTP | A server for the system already exists |
| OpenAPI import (`openapi`, `openapiTools`) | OpenAPI 3 (JSON) | The API has a spec |
| Declarative HTTP tool (`httpTools`, `httpTool`) | HTTP | One or two endpoints, no spec |
| `defineTool` | none (any JS function) | Anything else: it is the universal escape hatch |

Tools return a string (plus optional `data`). Tool errors are results with `isError`, not exceptions for the model.

## `defineTool`: any JS function

```ts
import { defineTool } from 'reinloop';

const lookup = defineTool({
  name: 'lookup_order',
  description: 'Find an order by id',
  risk: 'read',
  schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  run: async ({ id }, ctx) => JSON.stringify(await db.find(id)),
});
```

`ctx` carries `signal`, `identity` and `credentials` (see the identity layer). Register it with
`createRegistry().tool(lookup)` or from a plugin, then name it in the agent's `tools`.

## Declarative HTTP tools

```json
{
  "httpTools": {
    "get_user": {
      "description": "Get a user by id",
      "method": "GET",
      "url": "${env:API_URL}/users/{id}",
      "query": ["expand"],
      "headers": { "x-api-key": "${env:API_KEY}" },
      "schema": { "type": "object", "properties": { "id": { "type": "string" }, "expand": { "type": "string" } }, "required": ["id"], "additionalProperties": false },
      "auth": { "audience": "tools-api", "scopes": ["users:read"] }
    }
  },
  "agents": { "support": { "tools": ["get_user"] } }
}
```

In code: `httpTool({ name, ...same fields })`.

- `{param}` in `url` is filled from the arguments and URL-encoded. A missing one is a tool error.
- `query`: arguments sent as query parameters (arrays repeat the key; `null` and absent are skipped).
- `headerArgs`: arguments sent as headers of the same name. `headers`: static; `${env:X}` is resolved when the tool is built.
- `body: "json"` sends the arguments not used above as a JSON object, or only `bodyArg` when set. Not allowed for GET/HEAD.
- `risk` defaults to `read` for GET/HEAD and `write` otherwise. `timeoutMs`, `maxResultChars` (default 16000).
- `auth`: asks the run's `CredentialProvider` for a token for `audience` and sends `Authorization: Bearer ...`
  (it replaces a static `authorization` header). Without credentials, or if the token request fails, the tool returns an
  error and **nothing is sent**. The token is never logged or emitted, and is redacted if the server echoes it.
- Result: JSON is pretty-printed, text is returned as is, both truncated; binary responses are summarized by size.
  Non-2xx is an error with the status and the first 500 chars of the body. Redirects are followed.

## OpenAPI 3 import

```json
{
  "openapi": {
    "petstore": { "spec": "./petstore.json", "baseUrl": "https://petstore.example/v1", "include": ["get*", "list*"], "auth": { "audience": "petstore" } }
  },
  "agents": { "shop": { "tools": ["petstore__getPetById", "petstore__list*"] } }
}
```

- `spec`: a file path (relative to the config file) or an http(s) URL. **JSON only**: reinloop has no YAML dependency;
  convert YAML first (`yq -o=json spec.yaml > spec.json`). Swagger 2 is not supported.
- Tools are named `<source>__<operationId>` (like MCP `server__tool`). Without an `operationId`, `<method>_<path>`.
  In `tools:` use exact names, globs (`petstore__get*`) or `openapi:petstore` for all of them. Specs are loaded the first
  time an agent that references them is built.
- `baseUrl` defaults to the first absolute `servers` entry (server variables take their default); a relative one is
  resolved against the spec URL. Otherwise set `baseUrl`.
- `include`: globs over `operationId` (without the prefix). Filter large specs: every tool costs prompt tokens.
- Path, query and header parameters and a JSON request body become the tool schema. Local `$ref`s are inlined (a
  reference that loops back into itself is cut to `{}`); `nullable` becomes a type union. An object body is flattened
  into the arguments (when no name clashes with a parameter); any other body goes in a `body` argument.
- Skipped: operations whose request body has no JSON media type. Errors: non-local `$ref`s, and a parameter name used
  in two locations of one operation (exclude it with `include`). Cookie parameters are ignored.
- Risk: `read` for GET/HEAD, `write` otherwise; policy rules and approvals apply as for any tool.
- In code: `openapiTools(spec, { baseUrl, include, prefix, risk, auth, headers })`, `readOpenApiSpec(pathOrUrl)`.

## MCP

`mcpServers` (stdio `command`/`args`, or streamable HTTP `url`) is documented in [integrations](../integrations.md).
An OpenAPI API can also be exposed through an MCP bridge (for example FastMCP `from_openapi`) when a shared MCP gateway
is preferred over importing the spec in each runtime; the agent sees the same tool shape either way.

Delegated credentials work for MCP servers too: `auth: { audience, scopes? }` on a streamable HTTP server sends a
token for that audience from the run's credentials on every call (implemented in `src/mcp/client.ts`, documented in
[identity](identity.md#mcp-streamable-http)). It is the same `auth` shape as for `httpTools` and `openapi`.

## Choosing

Prefer an MCP server or an OpenAPI import over hand-written tools when the system already has one. Use `httpTools` for
a handful of endpoints. Use `defineTool` for logic, not plumbing.
