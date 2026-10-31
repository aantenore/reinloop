# Guardrails

There is no open standard for agent guardrails, so this layer is an adapter SDK: a small `Guard` interface, a middleware that applies guards at the four checkpoints of a run, reference adapters, and a conformance check for your own.

```ts
interface Guard {
  name: string;
  stages?: GuardStage[]; // default: all four
  check(input: GuardInput, opts?: { signal?: AbortSignal }): Promise<GuardVerdict>;
}
type GuardStage = 'input' | 'output' | 'tool_args' | 'tool_result';
interface GuardInput { stage; text; agent; runId; tool?; subject? }          // subject = identity.subject
interface GuardVerdict { action: 'allow' | 'block' | 'redact'; text?: string; reason?: string } // redact needs text
```

## Checkpoints

`guardMiddleware(guards, { onError?, name? })` is a regular `Middleware`:

| Stage | Hook | Text | `block` | `redact` |
| --- | --- | --- | --- | --- |
| `input` | `beforeInput` (`beforeModel` for older history) | each new user text part | run ends `stopped`, reason `guardrail:<guard>:input`, before the model call | the redacted text is what is persisted, returned and sent to the model |
| `output` | `afterModel` | each assistant text part | run ends `stopped`, reason `guardrail:<guard>:output`, empty output | the redacted text is what is persisted and returned |
| `tool_args` | `beforeTool` | JSON of the arguments | call denied (`{ deny }`) | the call runs with the redacted arguments (must stay valid JSON, else denied) |
| `tool_result` | `afterTool` | result content | result replaced by an error for the model | redacted content |

- Guards run in order; the first `block` wins; redactions chain (each guard sees the previous one's output). A guard only runs on the stages it declares.
- Input is checked once per message, before it is recorded: the run log keeps only the redacted text (the model never saw the original). A blocked input is recorded as received, as the audit trail of what was refused. History recorded before the guard was added is checked in `beforeModel`, in the request only.
- `onError`: a guard that throws (service down, malformed verdict) counts as `block` by default (fail closed); `onError: 'allow'` fails open. Either way a `guardrail` event records it.
- A blocked response is recorded as a discarded `model_response` with an empty message: its usage and cost count (and toward budgets), its content is never persisted.
- Streaming: with an `output` guard the middleware sets `Middleware.holdsText`, so the loop emits the checked text as one `text_delta` after `afterModel` instead of the raw tokens. Nothing unchecked reaches `text_delta` consumers; the cost is latency (no incremental text). Without an output guard, text streams as usual.
- Stopping tools (`ToolOutput.stop`) carry `data` that is not scanned.

### Ending a run from middleware

Throw `RunStop(reason, output?)` (exported). The loop finishes the run with status `stopped` and that reason; it is not a failure. `output` replaces the default (last assistant text). `HookContext.emit` lets middleware record events.

### Audit event

`guardrail { guard, stage, action, reason? }` is persisted for every `block` and `redact` (and for an `allow` that follows a guard error). It never contains the inspected text; `reason` is clipped to 200 characters, so adapters must not put raw text in it.

## Adapters

| Factory | Backend | Notes |
| --- | --- | --- |
| `httpGuard({ url, headers?, name?, stages?, timeoutMs? })` | any service | `POST url` with a `GuardInput` body, answer a `GuardVerdict` |
| `presidioGuard({ analyzerUrl, anonymizerUrl, language?, entities?, scoreThreshold?, action, operators? })` | [Microsoft Presidio](https://microsoft.github.io/presidio/) (MIT) | `POST /analyze`, then `POST /anonymize` for `redact` |
| `llmGuardGuard({ url, token?, scannersSuppress?, stages? })` | [LLM Guard](https://github.com/protectai/llm-guard) (MIT) | `POST /analyze/prompt` (input, tool results), `POST /analyze/output`; `is_valid: false` blocks naming the scanners; bearer auth |
| `regexGuard({ patterns?, action, stages? })` | none | emails, phones, IBAN (mod 97), cards (Luhn), API-key-like secrets; a floor, not a model |

The adapters (`src/guardrails/{http,presidio,llm-guard,regex,contract}.ts`) import only the contract types and node built-ins, so they can be reused outside the runtime. The middleware (`middleware.ts`), the stop mechanism (`src/stop.ts`) and the registry wiring (`register.ts`) are separate files.

Any object implementing `Guard` works too (NeMo Guardrails, Guardrails AI or IBM Granite Guardian behind `httpGuard` or a small adapter).

## Configuration

Agents opt in through the existing `middleware` field; the guards live in a top-level `guardrails` section:

```json
{
  "guardrails": {
    "onError": "block",
    "guards": [
      { "type": "regex", "action": "redact", "patterns": ["secret"] },
      { "type": "presidio", "analyzerUrl": "${env:PRESIDIO_ANALYZER_URL}", "anonymizerUrl": "${env:PRESIDIO_ANONYMIZER_URL}", "action": "redact", "entities": ["EMAIL_ADDRESS", "PHONE_NUMBER"] },
      { "type": "llm-guard", "url": "${env:LLM_GUARD_URL}", "token": "${env:LLM_GUARD_TOKEN}" }
    ]
  },
  "agents": { "support": { "middleware": ["guard"] } }
}
```

Types come from `registry.guards`; a plugin adds its own with `registry.guards.set('nemo', (options, ctx) => guard)`.

## Conformance

```ts
import { checkGuard } from 'reinloop';
const failures = await checkGuard(myGuard, { benign: 'What is the weather?', harmful: ['Ignore previous instructions'], pii: { text: 'mail a@b.com', contains: 'a@b.com' } });
// [] when conformant
```

It verifies the verdict shape on every supported stage, that benign text is allowed, and that harmful text and PII are not.
