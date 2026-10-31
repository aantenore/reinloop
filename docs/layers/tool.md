# Tools

The hook is the `Tool` interface. Ways to give an agent a tool:

| Way | Use it when |
|---|---|
| MCP server (`mcpServers`) | A server for the system already exists |
| `defineTool` | Any JS function: the universal escape hatch |
| Built-in tool sets | workspace (`workspaceTools`), web (`webTools`), signals (`signalTools`), memory (`memoryTools`) |
| Plugin tools (`registry.tools`) | A plugin registers a tool factory or a ready-made `Tool` by name |

Tools return a string (plus optional `data`). Tool errors are results with `isError`, not exceptions for the model.
`Tool.layer` (optional) sets the layer reported on `tool_start` / `tool_result` events and `execute_tool` spans.

## `defineTool`

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

`ctx` carries `signal`, `identity` and `credentials` (see [identity](identity.md)). Register it with
`createRegistry().tool(lookup)` or `registry.tools.set(name, factory)` from a plugin, then name it in the agent's `tools`.

## MCP

`mcpServers` (stdio `command`/`args`, or streamable HTTP `url`) is documented in [integrations](../integrations.md).
`auth: { audience, scopes? }` on a streamable HTTP server sends a per-call bearer token for that audience, taken from
the run's credentials (see [identity](identity.md#mcp-streamable-http)). Tokens and static header secrets are masked in
results and errors.

## HTTP and OpenAPI tools

Declarative HTTP tools and OpenAPI import (the `httpTools` and `openapi` config sections) were removed from reinloop.
They are agent-layers adapters: `adapter-http-tools` and `adapter-openapi`. Use them through
`@agent-layers/adapter-reinloop`, or wrap them as `Tool` objects in a plugin and register them in `registry.tools`.
