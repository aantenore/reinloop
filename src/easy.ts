import { type RunHandle, stream } from './loop.ts';
import { BUILTIN_PATTERNS, createTeam, type PatternDefinition } from './patterns.ts';
import { resolveModel } from './presets.ts';
import { memoryStore } from './store/memory.ts';
import { agentTool } from './subagent.ts';
import { isTeam, type Member, streamMember, type Team } from './team.ts';
import { defineTool } from './tools/define.ts';
import type {
  Agent, Approver, Budget, CompactionSettings, JsonSchema, Message, Middleware, ModelParams, ModelRef, OutputSpec, PolicyConfig,
  Risk, RunOptions, RunResult, RunStore, Sink, Tool, ToolContext, ToolOutput, ToolSettings,
} from './types.ts';

export interface Runnable {
  run(input: string | Message[], opts?: RunOptions): Promise<RunResult>;
  stream(input: string | Message[], opts?: RunOptions): RunHandle;
  /** Multi-turn conversation that keeps its history between `send` calls. */
  session(): Session;
}

export interface Session {
  readonly runId: string | undefined;
  send(input: string | Message[]): Promise<RunResult>;
}

export interface AgentOptions {
  name?: string;
  description?: string;
  /** `"provider/model"` (e.g. `"openai/gpt-5-mini"`), an alias like `"sonnet"`, or a ModelRef. Default: auto-detected. */
  model?: string | ModelRef;
  params?: ModelParams;
  instructions?: string;
  /** Tools, and also other agents or teams: they are delegated to with an isolated context. */
  tools?: Array<Tool | Member>;
  budget?: Budget;
  policy?: PolicyConfig;
  /** JSON Schema of the final answer (or a full OutputSpec); the parsed value is `result.data`. */
  output?: JsonSchema | OutputSpec;
  compaction?: CompactionSettings;
  middleware?: Middleware[];
  toolSettings?: ToolSettings;
  /** Defaults applied to every run of this agent. */
  store?: RunStore;
  sinks?: Sink[];
  /** `true` approves every "ask" decision; a function decides per call. */
  approve?: Approver | boolean;
}

export type EasyAgent = Agent & Runnable;
export type EasyTeam = Team & Runnable;

const isMember = (x: Tool | Member): x is Member => isTeam(x) || 'model' in x;

function runnable<T extends Member>(member: T, defaults: RunOptions): T & Runnable {
  const withDefaults = (o: RunOptions = {}): RunOptions => ({ ...defaults, ...o });
  return Object.assign(member, {
    run: (input: string | Message[], o?: RunOptions) => streamMember(member, input, withDefaults(o)).result,
    stream: (input: string | Message[], o?: RunOptions) => streamMember(member, input, withDefaults(o)),
    session(): Session {
      let runId: string | undefined;
      return {
        get runId() {
          return runId;
        },
        async send(input) {
          const res = await (isTeam(member) ? streamMember(member, input, withDefaults()) : stream(member, input, withDefaults({ runId })))
            .result;
          runId = res.runId;
          return res;
        },
      };
    },
  });
}

/** The shortest path to a working agent: `await agent({ tools: [weather] }).run('Rome?')`. */
export function agent(opts: AgentOptions = {}): EasyAgent {
  const model = resolveModel(opts.model);
  if (opts.params) model.params = { ...model.params, ...opts.params };
  const tools = (opts.tools ?? []).map((t) =>
    isMember(t) ? agentTool(t, { description: t.description ?? `Delegate a task to ${t.name}` }) : t,
  );
  const output = opts.output && ('schema' in opts.output && typeof opts.output.schema === 'object' ? (opts.output as OutputSpec) : { schema: opts.output as JsonSchema });
  const base: Agent = {
    name: opts.name ?? 'agent',
    description: opts.description,
    model,
    instructions: opts.instructions,
    tools,
    budget: opts.budget,
    policy: opts.policy,
    output,
    compaction: opts.compaction,
    middleware: opts.middleware,
    toolSettings: opts.toolSettings,
  };
  const approve = opts.approve === true ? () => true : opts.approve === false ? undefined : opts.approve;
  return runnable(base, { store: opts.store ?? memoryStore(), sinks: opts.sinks, approve });
}

/**
 * Composes members with a pattern: `team('review', 'evaluator', { generator: coder, evaluator: critic })`.
 * Built-in patterns: chain, parallel, router, evaluator, orchestrator; pass a PatternDefinition for your own.
 */
export function team(
  name: string,
  pattern: string | PatternDefinition,
  roles: Record<string, Member | Member[]>,
  options: Record<string, unknown> = {},
  defaults: RunOptions & { description?: string } = {},
): EasyTeam {
  const definition = typeof pattern === 'string' ? BUILTIN_PATTERNS[pattern] : pattern;
  if (!definition) throw new Error(`unknown pattern "${pattern}" (built-in: ${Object.keys(BUILTIN_PATTERNS).join(', ')})`);
  const { description, ...runDefaults } = defaults;
  const t = createTeam(name, definition, typeof pattern === 'string' ? pattern : 'custom', roles, options, description);
  return runnable(t, { store: memoryStore(), ...runDefaults });
}

type Shorthand = string | string[] | JsonSchema;

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** `'string'`, `'number?'`, `'string[]'`, `'integer: page number'`, `['c', 'f']` (enum) or a JSON Schema. */
export function paramsSchema(params: Record<string, Shorthand> | JsonSchema): JsonSchema {
  if (params.type === 'object' && typeof params.properties === 'object') return params;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(params as Record<string, Shorthand>)) {
    if (Array.isArray(spec)) {
      properties[key] = { enum: spec };
      required.push(key);
    } else if (typeof spec === 'string') {
      const m = /^(\w+)(\[\])?(\?)?\s*(?::\s*(.*))?$/.exec(spec.trim());
      if (!m || !TYPES.has(m[1]!)) throw new Error(`invalid parameter "${key}": "${spec}" (e.g. "string", "number?", "string[]: tags")`);
      const base: JsonSchema = { type: m[1] };
      properties[key] = { ...(m[2] ? { type: 'array', items: base } : base), ...(m[4] && { description: m[4] }) };
      if (!m[3]) required.push(key);
    } else {
      properties[key] = spec;
      required.push(key);
    }
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export interface ToolExtras { risk?: Risk; timeoutMs?: number; exclusive?: boolean }

/** `tool('weather', 'Current weather', { city: 'string' }, async ({ city }) => ...)`. */
export function tool<A = any>(
  name: string,
  description: string,
  params: Record<string, Shorthand> | JsonSchema,
  run: (args: A, ctx: ToolContext) => Promise<string | ToolOutput | unknown> | string | ToolOutput | unknown,
  extras: ToolExtras = {},
): Tool<A> {
  return defineTool<A>({
    name,
    description,
    schema: paramsSchema(params),
    ...extras,
    async run(args, ctx) {
      const out = await run(args, ctx);
      if (typeof out === 'string') return out;
      if (out && typeof out === 'object' && 'content' in out && typeof (out as ToolOutput).content === 'string') return out as ToolOutput;
      return out === undefined ? '' : JSON.stringify(out);
    },
  });
}
