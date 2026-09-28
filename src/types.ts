export type JsonSchema = { [key: string]: unknown };

export interface TextPart { type: 'text'; text: string }
export interface ToolCallPart { type: 'tool_call'; id: string; name: string; args: unknown }
export interface ToolResultPart { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean }
export type Part = TextPart | ToolCallPart | ToolResultPart;

export type Role = 'user' | 'assistant' | 'tool';
export interface Message { role: Role; parts: Part[] }

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ---- Model -----------------------------------------------------------------

export interface ToolSpec { name: string; description: string; schema: JsonSchema }

export interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
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

export type StopReason = 'end' | 'tool_calls' | 'max_tokens' | 'other';

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
}

export interface Provider {
  readonly name: string;
  generate(req: ModelRequest, ctx: GenerateContext): Promise<ModelResponse>;
}

export interface Pricing { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number }

export interface ModelRef {
  provider: Provider;
  model: string;
  params?: ModelParams;
  pricing?: Pricing;
}

// ---- Tools -----------------------------------------------------------------

export type Risk = 'read' | 'write' | 'exec';

export interface ToolOutput { content: string; isError?: boolean }

export interface ToolContext {
  runId: string;
  agent: string;
  signal: AbortSignal;
  state: Readonly<RunState>;
  emit: (ev: RunEvent) => void;
  /** Options a tool may forward when it starts nested runs (subagents). */
  inherit: Pick<RunOptions, 'store' | 'approve' | 'sinks'>;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  schema: JsonSchema;
  risk?: Risk;
  timeoutMs?: number;
  /** Run alone instead of in a parallel batch. */
  exclusive?: boolean;
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

export interface HookContext { runId: string; agent: string; state: Readonly<RunState> }

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
  run_start: { agent: string; resumed: boolean; parentRunId?: string };
  message: { message: Message; source: 'input' | 'harness' };
  turn_start: { turn: number };
  model_request: { turn: number; model: string; messages: number; estTokens: number };
  text_delta: { text: string };
  model_response: { turn: number; model: string; message: Message; usage: Usage; stopReason: StopReason; latencyMs: number; costUsd: number };
  tool_start: { callId: string; name: string; args: unknown };
  tool_decision: { callId: string; name: string; allowed: boolean; reason: string };
  tool_result: { callId: string; name: string; content: string; isError: boolean; durationMs: number; artifact?: string };
  compaction: { strategy: string; beforeTokens: number; afterTokens: number; messages: Message[]; usage?: Usage; costUsd?: number };
  run_end: { status: RunStatus; reason?: string; output?: string; usage: Usage; turns: number; costUsd: number };
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
}
