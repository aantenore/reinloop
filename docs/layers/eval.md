# Evaluation

Measure the agent and attribute failures to a layer. There is no open standard for agent evaluation. reinloop keeps
only the contract and the data evaluators read; datasets, assertion engines, judges, replay and layer attribution are
agent-layers adapters.

## Contract

```ts
interface EvalCase { id: string; input: string; expected?: unknown; tags?: string[]; layer?: Layer }
interface EvalScore { metric: string; value: number; layer?: Layer; reason?: string }
interface Evaluator {
  name: string;
  score(c: EvalCase, run: { runId: string; output?: string; status: RunStatus; events: RunEvent[] }): Promise<EvalScore[]>;
}
```

`expected` is free-form and defined by each evaluator. `layer` names the layer a case is meant to exercise, so scores
can be attributed to it.

## Data an evaluator reads

Every run is an append-only event log persisted by the `RunStore` (`memoryStore`, `fileStore`, or a plugin store):
`store.load(runId)` returns the `RunEvent[]` passed to `score`. The events carry what each layer emitted
(`model_request` / `model_response`, `tool_decision`, `guardrail`, `knowledge_retrieval`, `tool_start` / `tool_result`),
so an evaluator can score a layer from the log without touching the loop.

## Using an evaluator

reinloop has no evaluation command or config section. An evaluator is a plain object: run the agent, load the events,
call `score`.

```ts
const result = await run(agent, c.input, { runId: c.id, store });
const scores = await evaluator.score(c, { runId: result.runId, output: result.output, status: result.status, events: await store.load(result.runId) });
```

Implementations: `adapter-expected-eval` (expected-value checks), `adapter-judge-eval` (LLM as judge) and
`adapter-layer-signals` (per-layer scores from events) in agent-layers, with the dataset format, replay and the
conformance kit.
