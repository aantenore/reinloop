# Evaluation and improvement

Measure the agent, attribute failures to a layer, verify fixes. There is no open standard for agent evaluation, so this
layer is an adapter contract with a small reference implementation. reinloop provides the runtime hooks (events, run
store, layer attribution); assertion engines and optimisers stay upstream (promptfoo, DeepEval, RAGAS, DSPy, Opik, Inspect AI).

## Contract

Dataset: JSONL, one `EvalCase` per line.

```json
{"id": "weather", "input": "Weather in Rome?", "expected": {"contains": "Rome"}, "tags": ["tools"], "layer": "tool"}
```

`expected` is free-form; the built-in `expectedEvaluator` understands a string (contains), `{ contains: string | string[] }`,
`{ equals }` and `{ regex, flags? }`. `layer` is the layer the case is meant to exercise; scores of that case inherit it.

Results: JSONL, one row per case.

```json
{"id": "weather", "runId": "…", "output": "…", "status": "completed",
 "scores": [{"metric": "expected", "value": 1, "layer": "tool"}, {"metric": "tool_health", "value": 1, "layer": "tool", "reason": "1 calls ok"}]}
```

`value` is always 0..1, higher is better. `layer` is one of `infra llm harness knowledge tool identity guardrail cache telemetry eval interface` (`LAYERS`).

```ts
interface Evaluator {
  name: string;
  score(c: EvalCase, run: { runId: string; output?: string; status: RunStatus; events: RunEvent[] }): Promise<EvalScore[]>;
}
```

## Running

```ts
import { evaluate, expectedEvaluator, fileStore, layerSignals, parseDataset } from 'reinloop';

const rows = await evaluate({
  agent: myAgent,
  cases: parseDataset(await readFile('datasets/smoke.jsonl', 'utf8')),
  evaluators: [expectedEvaluator(), layerSignals()],
  store: fileStore('.reinloop/runs'), // keep the runs so they can be replayed
  concurrency: 4,
});
```

An evaluator that throws does not abort the run: its row gets a `0` score on layer `eval` with the error as reason.

CLI:

```
reinloop eval datasets/smoke.jsonl --agent support --out results.jsonl [--judge judge-agent]
reinloop replay <runId...|--all> --agent support-v2 --model anthropic/claude-haiku-5-5 --out compare.jsonl
```

`eval` falls back to `$EVAL_DATASET` when no path is given, writes rows to stdout without `--out` and a summary
(mean per metric) to stderr. Runs go to the project's run store.

## Built-in evaluators

| Evaluator | What it does |
|---|---|
| `expectedEvaluator()` | contains / equals / regex against `expected` |
| `judgeEvaluator({ agent })` | LLM as judge; the judge answers `{ score, reason }` (use `output: JUDGE_SCHEMA`; plain JSON text is parsed too). An unusable judge scores 0 on layer `eval`. |
| `layerSignals()` | one `<layer>_health` score per layer that has a signal, derived from events |

### layerSignals

| Layer | Signal | Value |
|---|---|---|
| `tool` | `tool_result` errors (denials excluded), `tool_args_invalid` (also when repaired); results of tools with another `layer` (e.g. `knowledge`) are scored there | 1 - failed calls / calls |
| `identity` | `tool_decision` with `allowed: false`, except guardrail denials; PDP denials (`pdp: ...`, `pdp error ...`) are counted in the reason | 1 - denied / decisions |
| `guardrail` | `guardrail {guard, stage, action, reason}` events (recorded only for interventions and guard errors), denials with reason `guardrail:...`, run reason `guardrail:<guard>:<stage>` | 0 on a block or guard error; 0.5 when guards only redacted |
| `harness` | failed, interrupted or budget-stopped run (0); completed after `compaction` (0.5); completed (1) | |
| `llm` | `max_tokens` / `refusal` answers, structured-output retries, run failed with `max_tokens`, `refusal`, invalid structured output or a provider error (HTTP / network) | 1 - bad responses / responses; 0 on a model-side failure |
| `knowledge` | `knowledge_retrieval {source, passages, error}` with an `error` or `passages: 0`; errors of `knowledge`-layer tools (`search_knowledge`) | 1 - bad / (retrievals + knowledge tool calls) |
| `cache` | provider prompt-cache token counts on `model_response.usage` | responses reading the cache / responses |

The scoring reads a minimal event shape, `{ type, data, runId?, parentRunId? }` (`SignalEvent`), and the evaluators depend only on
the contract types and Node built-ins. `scoreLayers(events, { status })` is the pure form, so events mapped from another
runtime's traces can be scored the same way. `judgeEvaluator` takes anything with `run(prompt) → { status, output, data? }`
(a reinloop `agent()` fits as is).

A layer without any signal gets no score. Event types it does not know are ignored. The mapping from stop reasons to
layers is a heuristic on `run_end.reason`; a failed run whose reason matches no model-side pattern is attributed to the harness.

## Replay

`replayRuns({ store, runIds | all, agent, overrides?: { model?, instructions? } })` (the CLI is `reinloop replay`) takes the
stored inputs (`message` events with `source: "input"`) and runs them against another agent or model. A continued session
is replayed turn by turn. Rows:

```json
{"runId": "…", "input": "…", "originalOutput": "…", "originalStatus": "completed", "originalCostUsd": 0, "originalTurns": 1,
 "replayRunId": "…", "output": "…", "status": "completed", "costUsd": 0, "turns": 1, "changed": true}
```

Notes: replayed runs go to an in-memory store by default (`into` overrides); with `--all`, member runs of teams are skipped;
the CLI `--model` takes `provider/model` or an alias (built-in presets), and model params of the agent are dropped on override;
teams cannot be overridden (replay a member agent instead).

## Writing an evaluator

An evaluator is any object with `name` and `score`. Check it against the contract:

```ts
import { checkEvaluator } from 'reinloop';
const failures = await checkEvaluator(myEvaluator); // [] = conformant
```

It checks that `score` returns an array, every score has a non-empty `metric`, a `value` in 0..1, a valid `layer`, and that
failed runs, runs without output and runs without events do not throw. Pass `{ fixtures }` to add your own cases.

## Where things live

| | |
|---|---|
| `src/eval/evaluate.ts` | `evaluate`, `summarize` |
| `src/eval/evaluators.ts` | built-in evaluators |
| `src/eval/replay.ts` | `replayRuns` |
| `src/eval/contract.ts` | dataset parsing, score validation, `LAYERS` |
| `src/eval/cli.ts` | `eval` and `replay` commands |
| `src/conformance/eval.ts` | `checkEvaluator` |
