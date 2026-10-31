# Knowledge layer

Gives an agent facts it was not trained on. reinloop defines the source contract and the middleware that injects
retrieved passages; sources (MCP, HTTP, Markdown) are agent-layers adapters.

```ts
interface KnowledgeSource { name: string; search(q: KnowledgeQuery): Promise<Passage[]> }
interface KnowledgeQuery { query: string; k?: number; filter?: Record<string, unknown>; identity?: Identity; signal?: AbortSignal }
interface Passage { id: string; text: string; source?: string; score?: number; metadata?: Record<string, unknown> }
```

## `knowledgeMiddleware`

```ts
knowledgeMiddleware({ sources, k: 4, maxChars: 6000, mode: 'first-turn', timeoutMs: 10000, maxQueryChars: 1000, maxTrackedRuns: 64 })
```

Before the model call, the latest user message is the query; sources are queried in parallel and merged round-robin
(scores of different backends are not comparable). The passages are appended to that user message as one delimited,
untrusted, cited block. Properties:

- The block never touches instructions or the tool list, and the same text is re-attached on every later turn, so the
  prompt prefix stays cache-friendly. It is added to the request only, not persisted.
- `mode`: `first-turn` retrieves once per run; `every-turn` retrieves for each new user message.
- A slow or failing source is skipped after `timeoutMs`; the run goes on without its passages.
- Each retrieval emits a `knowledge_retrieval` event (`source`, `query`, `passages`, `ids`, `durationMs`, `error`),
  mapped to layer `knowledge` in telemetry.
- Passage text cannot close the block, and the block tells the model to treat it as data.

## Plugging in

There is no `knowledge` config section. A plugin registers the middleware and agents list it:

```ts
// plugin: export default (registry) => ...
registry.middleware.set('knowledge', () => knowledgeMiddleware({ sources: [mySource] }));
```

```json
{ "plugins": ["./plugins/knowledge.mjs"], "agents": { "support": { "middleware": ["knowledge"] } } }
```

Implementations: `adapter-mcp`, `adapter-http-knowledge`, `adapter-markdown-knowledge` in agent-layers, which also
provides the conformance kit. The `search_knowledge` tool was removed; expose a source as a tool with `defineTool` if
the model should query on demand.
