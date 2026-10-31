# Guardrails

There is no open standard for agent guardrails. reinloop defines the `Guard` contract and the middleware that applies
guards at the checkpoints of a run; guard implementations (Presidio, LLM Guard, HTTP, regex) are agent-layers adapters.

```ts
interface Guard {
  name: string;
  stages?: GuardStage[]; // default: all four (GUARD_STAGES)
  check(input: GuardInput, opts?: { signal?: AbortSignal }): Promise<GuardVerdict>;
}
type GuardStage = 'input' | 'output' | 'tool_args' | 'tool_result';
interface GuardInput { stage; text; agent; runId; tool?; subject? }          // subject = identity.subject
interface GuardVerdict { action: 'allow' | 'block' | 'redact'; text?: string; reason?: string } // redact needs text
```

## `guardMiddleware`

```ts
guardMiddleware(guards, { onError: 'block', name: 'guard', maxReasonChars: 200 })
```

| Stage | Hook | Effect |
|---|---|---|
| `input` | `beforeInput` | new user text; a redaction is what is persisted and what the model sees |
| `output` | `afterModel` | assistant text; a redaction is what is persisted and returned |
| `tool_args` | `beforeTool` | the JSON of a call's arguments; block denies the call |
| `tool_result` | `afterTool` | a tool's result; block replaces it with an error for the model |

- Guards run in order, the first block wins and redactions chain. Guards that set `stages` run only there.
- A block on `input` or `output` ends the run with status `stopped` and reason `guardrail:<guard>:<stage>`, through
  `RunStop`. The blocked response is accounted as a discarded `model_response` without its content, so usage and cost count.
- With an `output` guard the middleware sets `holdsText`: `text_delta` carries the checked text once, after the answer is
  complete, so no unchecked text is streamed (streaming latency is lost).
- `onError`: what a guard that throws or returns an invalid verdict means; `block` (default, fail closed) or `allow`.
- Each non-allow verdict is a `guardrail` audit event (`guard`, `stage`, `action`, `reason`); it never carries the text.
  `parseVerdict` validates a raw answer into a `GuardVerdict`.

## Plugging in

There is no `guardrails` config section and no `guard` registry. A plugin registers the middleware and agents list it:

```ts
registry.middleware.set('guard', () => guardMiddleware([myGuard], { onError: 'block' }));
```

```json
{ "plugins": ["./plugins/guard.mjs"], "agents": { "support": { "middleware": ["guard"] } } }
```

Implementations: `adapter-presidio`, `adapter-llm-guard`, `adapter-http-guard`, `adapter-regex-guard` in agent-layers,
which also provides the conformance kit.
