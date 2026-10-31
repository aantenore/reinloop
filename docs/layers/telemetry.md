# Telemetry and observability

Standard: OpenTelemetry (OTLP/HTTP, GenAI semantic conventions). Extension point: `Sink`. Built in sinks: `console`,
`jsonl`, `otlp` (`otlpSink`, which needs no SDK and talks to any collector) and `otelSink` for an existing tracer.

## Spans

| Span | `agent.layer` |
|---|---|
| `invoke_agent <name>` | `harness` |
| `chat <model>` | `llm` |
| `execute_tool <name>` | `Tool.layer`, else `tool` |
| `compaction <strategy>` | `harness` |

The run span also carries `gen_ai.conversation.id` and, when the run has an identity, `enduser.id` (the subject; never the token). Tool spans get their layer from `layer` on the `tool_start` / `tool_result` events, which the executor sets from `Tool.layer`.

Message content, tool arguments and results are recorded only with `captureContent: true`.

## Events of other layers

Event types without a span of their own are recorded as span events on the run span, carrying `agent.layer` and the scalar fields `EVENT_ATTR_KEYS` (`name`, `callId`, `allowed`, `action`, `stage`, `guard`, `source`, `passages`, `durationMs`). Free text (`reason`, `query`, `error`: `EVENT_CONTENT_KEYS`) is added only with `captureContent`. The type-to-layer table is `EVENT_LAYERS`:

| Event type | Layer | Fields |
|---|---|---|
| `tool_decision` | `identity` | `callId`, `name`, `allowed`, `reason` (incl. `pdp: ...`) |
| `guardrail` | `guardrail` | `guard`, `stage`, `action`, `reason` |
| `knowledge_retrieval` | `knowledge` | `source`, `query`, `passages` (count), `ids`, `durationMs`, `error` |

Plugins that emit their own event types add entries with the `eventLayers` option (`otelSink`, `otlpSink`, or the config entry). Event types in neither table are ignored.

## Metrics

`otlpMetricsSink({ endpoint, headers, serviceName, intervalMs })`, or `"metrics": true` on the `otlp` sink, posts OTLP/HTTP JSON to `/v1/metrics`.

| Metric | Type | Attributes |
|---|---|---|
| `gen_ai.client.token.usage` | histogram, `{token}` | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.token.type` (`input`/`output`) |
| `gen_ai.client.operation.duration` | histogram, `s` | `gen_ai.operation.name`, `gen_ai.request.model` |
| `agent.tool.calls` | counter | `tool`, `error`, `layer` |
| `agent.cost.usd` | counter | `gen_ai.operation.name`, `gen_ai.request.model` |
| `agent.policy.decisions` | counter | `allowed` |
| `agent.guardrail.actions` | counter | `action`, `stage`, `guard` (from `guardrail` events) |
| `agent.runs` | counter | `status` |

Temporality is cumulative: Prometheus exporters and most backends take it as is, totals only grow, and a lost export is healed by the next one. Metrics are sent every `intervalMs` (default 10 s, only when something changed), on every `run_end`, and on close.

## Configuration

```json
"sinks": [{ "type": "otlp", "endpoint": "http://localhost:4318", "metrics": true, "serviceName": "my-agent" }]
```
