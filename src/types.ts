export type JsonSchema = { [key: string]: unknown };

/** `citations`: provider citation objects kept verbatim (e.g. Anthropic `web_search_result_location`) so they can be echoed back. */
export interface TextPart { type: 'text'; text: string; citations?: Array<Record<string, unknown>> }
export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: unknown;
  /**
   * The provider sent arguments that were not valid JSON. `repaired: true`: `args` holds the repaired value and the
   * call runs; `repaired: false`: `args` is `{}` and the call is answered with a tool error asking for valid JSON.
   */
  argsIssue?: { error: string; repaired: boolean };
}
export interface ToolResultPart { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean }
/**
 * Model reasoning kept for replay (e.g. Anthropic `thinking` / `redacted_thinking` blocks with their signature).
 * Never part of the output text; providers that do not know it ignore it.
 */
export interface ThinkingPart { type: 'thinking'; text: string; signature?: string; redacted?: string }
/** A call to a provider-hosted tool (e.g. Anthropic `server_tool_use`): run by the provider, never by the loop. */
export interface HostedCallPart { type: 'hosted_call'; id: string; name: string; input: unknown }
/**
 * The provider's result for a hosted call, kept verbatim (`blockType` + `content`) so multi-turn requests can echo it.
 * `summary`/`sources` are a provider-neutral digest for events and logs.
 */
export interface HostedResultPart {
  type: 'hosted_result';
  callId: string;
  name: string;
  blockType: string;
  content: unknown;
  isError?: boolean;
  summary?: string;
  sources?: Array<{ url: string; title?: string }>;
}
export type Part = TextPart | ToolCallPart | ToolResultPart | ThinkingPart | HostedCallPart | HostedResultPart;

export type Role = 'user' | 'assistant' | 'tool';
export interface Message { role: Role; parts: Part[] }

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Part of `cacheWriteTokens` written with the 1-hour lifetime (priced higher). */
  cacheWrite1hTokens?: number;
  /** Provider-hosted tool requests billed per use, e.g. `{ webSearchRequests: 2 }`. */
  serverToolUse?: Record<string, number>;
  /** Tool calls whose streamed argument JSON was malformed (repaired or answered with a tool error). */
  toolArgsInvalid?: number;
}

// ---- Model -----------------------------------------------------------------

/** A tool executed by the model provider (Anthropic server tools such as web search, web fetch, code execution). */
export interface HostedToolDef {
  /** Provider kind that understands `type` (e.g. `anthropic`); other providers reject the request. */
  provider: string;
  /** Provider tool type, e.g. `web_search_20250305`. */
  type: string;
  /** Provider fields sent verbatim with the tool (e.g. `max_uses`, `allowed_domains`). */
  params?: Record<string, unknown>;
  /** Numeric param capped by the remaining `maxToolCalls` budget (e.g. `max_uses`). */
  limitParam?: string;
  /** Beta flag sent in the `anthropic-beta` header when this tool is offered. */
  beta?: string;
}

export interface ToolSpec { name: string; description: string; schema: JsonSchema; hosted?: HostedToolDef }

export type ThinkingType = 'adaptive' | 'enabled' | 'disabled' | 'between_tools';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Model reasoning settings (Anthropic `thinking`); providers without them ignore these fields. */
export interface ThinkingParams {
  /** `adaptive`: the model decides; `enabled`: fixed `budgetTokens` (older models); `between_tools`: Sonnet 5.5 only. */
  type: ThinkingType;
  budgetTokens?: number;
  /** What thinking blocks contain: `omitted` (empty text, the default on current models), `summarized`, `updates`. */
  display?: 'omitted' | 'summarized' | 'updates';
}

export interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  thinking?: ThinkingParams;
  /** Reasoning depth and token spend (Anthropic `output_config.effort`). */
  effort?: Effort;
  /**
   * Off by default. After a `max_tokens` stop without tool calls, discard that answer and repeat the request once with
   * this `maxTokens` (kept for the rest of the run) instead of ending with `max_tokens`.
   */
  retryMaxTokens?: number;
  /** Prompt caching on providers that support breakpoints (Anthropic: on by default). */
  cache?: boolean;
  /** Prompt-cache lifetime (Anthropic: `5m` default, `1h`). */
  cacheTtl?: '5m' | '1h';
  /** Provider-specific fields merged verbatim into the request body. */
  extra?: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  instructions?: string;
  messages: Message[];
  tools: ToolSpec[];
  params?: ModelParams;
  /** Ask the provider to constrain the answer to this JSON Schema, when it supports native structured output. */
  responseSchema?: JsonSchema;
}

/** `pause_turn`: the provider paused a long hosted-tool turn; the loop sends the history back so it resumes. */
export type StopReason = 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface ModelResponse {
  message: Message;
  usage: Usage;
  stopReason: StopReason;
  model?: string;
  /** Served from a response cache: tokens are reported, cost is zero. */
  cached?: boolean;
}

export interface GenerateContext {
  signal: AbortSignal;
  onText?: (delta: string) => void;
  /** Reasoning text, kept apart from the answer text (often empty: providers may omit it). */
  onThinking?: (delta: string) => void;
}

export interface Provider {
  readonly name: string;
  generate(req: ModelRequest, ctx: GenerateContext): Promise<ModelResponse>;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  /** Cache-write price as a multiple of the input price: 5-minute writes (default 1) and 1-hour writes (default: the 5m one). */
  cacheWriteMultiplier?: number;
  cacheWrite1hMultiplier?: number;
  /** USD per hosted-tool request, keyed like `Usage.serverToolUse` (e.g. `{ webSearchRequests: 0.01 }`). */
  serverToolUsd?: Record<string, number>;
}

export interface ModelRef {
  provider: Provider;
  model: string;
  params?: ModelParams;
  pricing?: Pricing;
}

// ---- Tools -----------------------------------------------------------------

export type Risk = 'read' | 'write' | 'exec';

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /**
   * End the run (status `completed`) once the current batch of tool calls has finished, without another model turn.
   * The run output is `content` and its data is `data` (must be JSON-serializable: it is persisted for resume).
   * Ignored on error results. With several stopping calls in one batch, the first in the model's call order wins.
   */
  stop?: boolean;
  data?: unknown;
}

export interface ToolContext {
  runId: string;
  agent: string;
  signal: AbortSignal;
  state: Readonly<RunState>;
  emit: (ev: RunEvent) => void;
  /** Options a tool may forward when it starts nested runs (subagents). */
  inherit: Pick<RunOptions, 'store' | 'approve' | 'sinks' | 'identity' | 'credentials'>;
  /** Who the run acts as. Never log or persist `identity.token`. */
  identity?: Identity;
  credentials?: CredentialProvider;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  schema: JsonSchema;
  risk?: Risk;
  timeoutMs?: number;
  /** Run alone instead of in a parallel batch. */
  exclusive?: boolean;
  /** Set for provider-hosted tools (see `hostedTool`): offered to the provider, never run by the loop. */
  hosted?: HostedToolDef;
  layer?: Layer;
  run(args: A, ctx: ToolContext): Promise<string | ToolOutput> | string | ToolOutput;
}

// ---- Policy ----------------------------------------------------------------

export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicyRule { match?: string; risk?: Risk; action: Decision; reason?: string }

export interface PolicyConfig {
  default?: Decision;
  risk?: Partial<Record<Risk, Decision>>;
  rules?: PolicyRule[];
}

export interface ApprovalRequest { runId: string; agent: string; call: ToolCallPart; tool: Tool; reason: string }
export type Approver = (req: ApprovalRequest) => boolean | Promise<boolean>;

// ---- Budget / compaction / output ------------------------------------------

export interface Budget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export interface CompactionContext {
  model: ModelRef;
  signal: AbortSignal;
  estimate: (messages: Message[]) => number;
  /** Report tokens spent by the strategy itself (e.g. a summarization call) so budgets and cost include them. */
  track: (usage: Usage) => void;
}

export interface CompactionStrategy {
  name: string;
  compact(messages: Message[], ctx: CompactionContext): Promise<Message[]>;
}

export interface CompactionSettings { strategy: CompactionStrategy; thresholdTokens: number }

export interface OutputSpec { schema: JsonSchema; retries?: number }

// ---- Middleware ------------------------------------------------------------

export interface HookContext { runId: string; agent: string; state: Readonly<RunState>; identity?: Identity }

export interface Middleware {
  name?: string;
  beforeModel?(req: ModelRequest, ctx: HookContext): ModelRequest | void | Promise<ModelRequest | void>;
  afterModel?(res: ModelResponse, ctx: HookContext): ModelResponse | void | Promise<ModelResponse | void>;
  beforeTool?(call: ToolCallPart, ctx: HookContext): ToolCallPart | { deny: string } | void | Promise<ToolCallPart | { deny: string } | void>;
  afterTool?(result: ToolResultPart, ctx: HookContext): ToolResultPart | void | Promise<ToolResultPart | void>;
}

// ---- Agent -----------------------------------------------------------------

export interface ToolSettings {
  concurrency?: number;
  timeoutMs?: number;
  maxResultChars?: number;
  artifacts?: ArtifactStore;
}

export interface Agent {
  name: string;
  /** What the agent is for; used when it is delegated to, routed to, or listed. */
  description?: string;
  model: ModelRef;
  instructions?: string;
  tools: Tool[];
  policy?: PolicyConfig;
  budget?: Budget;
  compaction?: CompactionSettings;
  output?: OutputSpec;
  middleware?: Middleware[];
  toolSettings?: ToolSettings;
}

// ---- Events / state --------------------------------------------------------

export type RunStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';

export interface EventMap {
  run_start: { agent: string; resumed: boolean; parentRunId?: string; subject?: string; identityKind?: 'user' | 'agent' };
  message: { message: Message; source: 'input' | 'harness' };
  turn_start: { turn: number };
  model_request: { turn: number; model: string; messages: number; estTokens: number };
  text_delta: { text: string };
  thinking_delta: { text: string };
  /** `discarded`: accounted for but kept out of the history (the request is repeated, e.g. with `retryMaxTokens`). */
  model_response: { turn: number; model: string; message: Message; usage: Usage; stopReason: StopReason; latencyMs: number; costUsd: number; discarded?: boolean };
  tool_start: { callId: string; name: string; args: unknown; layer?: Layer };
  /** The model's arguments for a call were malformed JSON: repaired and run, or answered with a tool error. */
  tool_args_invalid: { callId: string; name: string; error: string; repaired: boolean };
  tool_decision: { callId: string; name: string; allowed: boolean; reason: string };
  tool_result: { callId: string; name: string; content: string; isError: boolean; durationMs: number; artifact?: string; stop?: boolean; data?: unknown; layer?: Layer };
  /** A provider-hosted tool ran inside the model turn (derived from the response; not persisted). */
  hosted_tool_start: { callId: string; name: string; input: unknown };
  hosted_tool_result: { callId: string; name: string; summary: string; isError: boolean; sources?: Array<{ url: string; title?: string }> };
  compaction: { strategy: string; beforeTokens: number; afterTokens: number; messages: Message[]; usage?: Usage; costUsd?: number };
  run_end: { status: RunStatus; reason?: string; output?: string; usage: Usage; turns: number; costUsd: number; failures?: MemberFailure[] };
}

export type EventType = keyof EventMap;

export type RunEvent<T extends EventType = EventType> = T extends EventType
  ? { runId: string; seq: number; ts: number; type: T; data: EventMap[T]; parentRunId?: string }
  : never;

export interface RunState {
  runId: string;
  agent: string;
  messages: Message[];
  usage: Usage;
  costUsd: number;
  turns: number;
  toolCalls: number;
  status: RunStatus;
  seq: number;
  /** Usage of the latest model response; used for cheap, accurate context estimates. */
  lastUsage?: Usage;
  /** Number of messages covered by lastUsage. */
  lastUsageAt?: number;
  /** Tool results that asked to end the run, by call id; cleared by run_end. */
  stops?: Record<string, { name: string; content: string; data?: unknown }>;
}

/** A team member (or worker) whose run did not complete. */
export interface MemberFailure {
  /** Member name; repeated workers are labelled `name#2`, `name#3`, ... */
  name: string;
  status: RunStatus;
  reason?: string;
  runId?: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  reason?: string;
  output: string;
  data?: unknown;
  usage: Usage;
  costUsd: number;
  turns: number;
  messages: Message[];
  /** Teams: members that did not complete (also when the team itself completed, e.g. a partial parallel run). */
  failures?: MemberFailure[];
}

// ---- Persistence / observability -------------------------------------------

export interface RunStore {
  append(event: RunEvent): Promise<void>;
  load(runId: string): Promise<RunEvent[]>;
  list?(): Promise<string[]>;
}

export interface ArtifactStore {
  put(content: string): Promise<string>;
  get(handle: string): Promise<string | undefined>;
}

export interface Sink {
  name?: string;
  onEvent(event: RunEvent): void;
  close?(): Promise<void> | void;
}

export interface RunOptions {
  /** Continue (or resume) an existing run/session stored in `store`. */
  runId?: string;
  store?: RunStore;
  signal?: AbortSignal;
  approve?: Approver;
  sinks?: Sink[];
  parentRunId?: string;
  identity?: Identity;
  credentials?: CredentialProvider;
}

// ---- Layers and adapter contracts ------------------------------------------

/** Platform layer a span, tool or adapter belongs to. */
export type Layer = 'infra' | 'llm' | 'harness' | 'knowledge' | 'tool' | 'identity' | 'guardrail' | 'cache' | 'telemetry' | 'eval';

/** Who a run acts as: a person (on behalf of) or the agent's own identity. */
export interface Identity {
  subject: string;
  kind: 'user' | 'agent';
  roles?: string[];
  scopes?: string[];
  claims?: Record<string, unknown>;
  /** Raw bearer token. Never written to events, logs or traces. */
  token?: string;
}
export interface IdentityVerifier { verify(token: string, opts?: { signal?: AbortSignal }): Promise<Identity> }
/** Access token for a downstream audience (token exchange on behalf of the user, or client credentials). */
export interface CredentialProvider { token(audience: string, opts?: { scopes?: string[]; signal?: AbortSignal }): Promise<string> }
/** Shaped after the OpenID AuthZEN evaluation request. */
export interface AccessRequest {
  subject: { type: 'user' | 'agent'; id: string; properties?: Record<string, unknown> };
  action: { name: string };
  resource: { type: string; id: string; properties?: Record<string, unknown> };
  context?: Record<string, unknown>;
}
export interface AccessDecision { decision: boolean; reason?: string }
export interface Authorizer { evaluate(req: AccessRequest, opts?: { signal?: AbortSignal }): Promise<AccessDecision> }

export interface Passage { id: string; text: string; source?: string; score?: number; metadata?: Record<string, unknown> }
export interface KnowledgeQuery { query: string; k?: number; filter?: Record<string, unknown>; identity?: Identity; signal?: AbortSignal }
export interface KnowledgeSource { name: string; search(q: KnowledgeQuery): Promise<Passage[]> }

export type GuardStage = 'input' | 'output' | 'tool_args' | 'tool_result';
export interface GuardInput { stage: GuardStage; text: string; agent: string; runId: string; tool?: string; subject?: string }
export interface GuardVerdict { action: 'allow' | 'block' | 'redact'; text?: string; reason?: string }
export interface Guard { name: string; stages?: GuardStage[]; check(input: GuardInput, opts?: { signal?: AbortSignal }): Promise<GuardVerdict> }

/** Picks the model for a request (in-process routing; gateways such as LiteLLM route behind an OpenAI-compatible URL instead). */
export interface ModelRouter { select(req: ModelRequest, ctx: HookContext): string | Promise<string> }

export interface EvalCase { id: string; input: string; expected?: unknown; tags?: string[]; layer?: Layer }
export interface EvalScore { metric: string; value: number; layer?: Layer; reason?: string }
export interface Evaluator { name: string; score(c: EvalCase, run: { runId: string; output?: string; status: RunStatus; events: RunEvent[] }): Promise<EvalScore[]> }
