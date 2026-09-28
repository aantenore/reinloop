import { validate } from './schema.ts';
import { agentTool } from './subagent.ts';
import { safeToolName } from './tools/define.ts';
import { isTeam, type Member, type Team, type TeamContext, type TeamOutcome } from './team.ts';
import type { Agent, JsonSchema, Message, RunResult } from './types.ts';

export interface RoleSpec {
  description: string;
  /** Accepts a list of members. */
  many?: boolean;
  optional?: boolean;
  /** `agent`: must be a single agent (the pattern changes its output schema or tools). Default: any member. */
  kind?: 'agent' | 'member';
}

/**
 * A pattern is a named recipe that wires members into roles. Built-in patterns follow the
 * common agentic workflows; custom ones are registered the same way from plugins.
 */
export interface PatternDefinition {
  description: string;
  roles: Record<string, RoleSpec>;
  options?: JsonSchema;
  build(roles: Record<string, any>, options: Record<string, any>): (input: Message[], ctx: TeamContext) => Promise<TeamOutcome>;
}

export const definePattern = (pattern: PatternDefinition): PatternDefinition => pattern;

/** Harness-authored texts used by the patterns. Every one can be replaced per team via options. */
export const TEMPLATES = {
  chain: '{{task}}\n\n---\nOutput of the previous step:\n{{previous}}',
  aggregate: '{{task}}\n\n---\nResults from the workers:\n\n{{results}}',
  route: 'Choose the route best suited to handle the task.\n\nRoutes:\n{{routes}}\n\nTask:\n{{task}}',
  evaluate:
    'Evaluate the candidate for the task. Set "pass" to true only if it fully satisfies the task; otherwise give specific, actionable feedback.\n\nTask:\n{{task}}\n\nCandidate:\n{{candidate}}',
  revise: 'Revise your answer using this feedback:\n{{feedback}}',
  reviseFresh: 'Task:\n{{task}}\n\nPrevious answer:\n{{candidate}}\n\nRevise it using this feedback:\n{{feedback}}',
};

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

export const memberName = (m: Member): string => m.name;

function labels(members: Member[]): string[] {
  const seen = new Map<string, number>();
  return members.map((m) => {
    const n = (seen.get(m.name) ?? 0) + 1;
    seen.set(m.name, n);
    return n === 1 ? m.name : `${m.name}#${n}`;
  });
}

const failed = (r: RunResult, who: string): TeamOutcome => ({ output: r.output, data: r.data, status: r.status, reason: `${who}: ${r.reason ?? r.status}` });

/** Bounded concurrency; after a failure no new items start, running ones finish, then the error is thrown. */
async function limited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let error: { err: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !error) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        error ??= { err };
      }
    }
  }));
  if (error) throw error.err;
  return out;
}

const templateOpt = { type: 'string' };

export const BUILTIN_PATTERNS: Record<string, PatternDefinition> = {
  chain: {
    description: 'Prompt chaining: each step receives the previous step\'s output; stops at the first failure.',
    roles: { steps: { description: 'Members run in order', many: true } },
    options: { type: 'object', additionalProperties: false, properties: { template: templateOpt } },
    build: ({ steps }, o) => async (input, ctx) => {
      let previous: RunResult | undefined;
      for (const step of steps as Member[]) {
        const r = await ctx.call(step, previous ? fill(o.template ?? TEMPLATES.chain, { task: ctx.task, previous: previous.output }) : input);
        if (r.status !== 'completed') return failed(r, step.name);
        previous = r;
      }
      return { output: previous?.output ?? '', data: previous?.data };
    },
  },

  parallel: {
    description: 'Sectioning or voting: workers run concurrently on the same task; an optional aggregator merges the results.',
    roles: {
      workers: { description: 'Members run concurrently', many: true },
      aggregator: { description: 'Merges worker results', optional: true },
    },
    options: { type: 'object', additionalProperties: false, properties: { template: templateOpt, concurrency: { type: 'integer', minimum: 1 } } },
    build: ({ workers, aggregator }, o) => async (input, ctx) => {
      const names = labels(workers);
      const results = await limited(workers as Member[], o.concurrency ?? workers.length, (w) => ctx.call(w, input));
      const byName = Object.fromEntries(results.map((r, i) => [names[i]!, r.data ?? r.output]));
      if (results.every((r) => r.status !== 'completed')) return { output: '', data: { results: byName }, status: 'failed', reason: 'all workers failed' };
      const sections = results
        .map((r, i) => `## ${names[i]}${r.status === 'completed' ? '' : ` (${r.status}${r.reason ? `: ${r.reason}` : ''})`}\n${r.output}`)
        .join('\n\n');
      if (!aggregator) return { output: sections, data: { results: byName } };
      const merged = await ctx.call(aggregator, fill(o.template ?? TEMPLATES.aggregate, { task: ctx.task, results: sections }));
      return merged.status === 'completed' ? { output: merged.output, data: merged.data ?? { results: byName } } : failed(merged, aggregator.name);
    },
  },

  router: {
    description: 'Routing: a classifier agent picks exactly one route, which then handles the original task.',
    roles: {
      router: { description: 'Agent that chooses the route', kind: 'agent' },
      routes: { description: 'Candidate members (their descriptions guide the choice)', many: true },
    },
    options: { type: 'object', additionalProperties: false, properties: { template: templateOpt, fallback: { type: 'string' } } },
    build: ({ router, routes }, o) => {
      const names = (routes as Member[]).map((r) => r.name);
      const chooser: Agent = {
        ...(router as Agent),
        output: {
          schema: { type: 'object', properties: { route: { enum: names }, reason: { type: 'string' } }, required: ['route'] },
          retries: 1,
        },
      };
      const menu = (routes as Member[]).map((r) => `- ${r.name}: ${r.description ?? ''}`).join('\n');
      return async (input, ctx) => {
        const pick = await ctx.call(chooser, fill(o.template ?? TEMPLATES.route, { task: ctx.task, routes: menu }));
        const chosen = pick.status === 'completed' ? (pick.data as { route: string }).route : o.fallback;
        const target = (routes as Member[]).find((r) => r.name === chosen);
        if (!target) return failed(pick, `router ${router.name}`);
        const r = await ctx.call(target, input);
        return { output: r.output, data: r.data, status: r.status, reason: r.reason };
      };
    },
  },

  evaluator: {
    description: 'Evaluator-optimizer: a generator drafts, an evaluator judges pass/feedback, repeat until pass or maxRounds.',
    roles: {
      generator: { description: 'Produces and revises the answer' },
      evaluator: { description: 'Agent that returns { pass, feedback }', kind: 'agent' },
    },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: { maxRounds: { type: 'integer', minimum: 1 }, template: templateOpt, reviseTemplate: templateOpt },
    },
    build: ({ generator, evaluator }, o) => {
      const judge: Agent = {
        ...(evaluator as Agent),
        output: {
          schema: { type: 'object', properties: { pass: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['pass', 'feedback'] },
          retries: 1,
        },
      };
      const maxRounds = o.maxRounds ?? 3;
      const continuing = !isTeam(generator);
      return async (input, ctx) => {
        let candidate = await ctx.call(generator, input, { session: 'generator' });
        for (let round = 1; ; round++) {
          if (candidate.status !== 'completed') return failed(candidate, generator.name);
          const verdict = await ctx.call(judge, fill(o.template ?? TEMPLATES.evaluate, { task: ctx.task, candidate: candidate.output }));
          if (verdict.status !== 'completed') return failed(verdict, evaluator.name);
          const v = verdict.data as { pass: boolean; feedback: string };
          const data = { rounds: round, passed: v.pass, feedback: v.feedback };
          if (v.pass) return { output: candidate.output, data };
          if (round >= maxRounds) return { output: candidate.output, data, status: 'stopped', reason: 'evaluator:maxRounds' };
          const revise = o.reviseTemplate ?? (continuing ? TEMPLATES.revise : TEMPLATES.reviseFresh);
          candidate = await ctx.call(generator, fill(revise, { task: ctx.task, candidate: candidate.output, feedback: v.feedback }), { session: 'generator' });
        }
      };
    },
  },

  orchestrator: {
    description: 'Orchestrator-workers: a lead agent plans and delegates to workers exposed as tools.',
    roles: {
      orchestrator: { description: 'Lead agent', kind: 'agent' },
      workers: { description: 'Members the lead can delegate to', many: true },
    },
    options: { type: 'object', additionalProperties: false, properties: { context: { enum: ['fresh', 'fork'] } } },
    build: ({ orchestrator, workers }, o) => {
      const lead = orchestrator as Agent;
      const delegates = (workers as Member[]).map((w) =>
        agentTool(w, { name: safeToolName(w.name), description: w.description ?? `Delegate a task to ${w.name}`, context: o.context }),
      );
      const taken = new Set(lead.tools.map((t) => t.name));
      for (const d of delegates) {
        if (taken.has(d.name)) throw new Error(`orchestrator: worker tool name "${d.name}" collides with a tool of ${lead.name}`);
        taken.add(d.name);
      }
      const withWorkers: Agent = { ...lead, tools: [...lead.tools, ...delegates] };
      return async (input, ctx) => {
        const r = await ctx.call(withWorkers, input);
        return { output: r.output, data: r.data, status: r.status, reason: r.reason };
      };
    },
  },
};

/** Validates roles and options against the pattern and returns a runnable team. */
export function createTeam(
  name: string,
  pattern: PatternDefinition,
  patternName: string,
  roles: Record<string, Member | Member[] | undefined>,
  options: Record<string, unknown> = {},
  description?: string,
): Team {
  const errors: string[] = [];
  const bound: Record<string, Member | Member[]> = {};
  for (const role of Object.keys(roles)) if (!pattern.roles[role]) errors.push(`unknown role "${role}" (roles: ${Object.keys(pattern.roles).join(', ')})`);
  for (const [role, spec] of Object.entries(pattern.roles)) {
    const value = roles[role];
    if (value === undefined || (Array.isArray(value) && !value.length)) {
      if (!spec.optional) errors.push(`role "${role}" is required (${spec.description})`);
      continue;
    }
    if (spec.many) bound[role] = Array.isArray(value) ? value : [value];
    else if (Array.isArray(value)) errors.push(`role "${role}" takes a single member`);
    else bound[role] = value;
    const list = Array.isArray(bound[role]) ? (bound[role] as Member[]) : [bound[role] as Member];
    if (spec.kind === 'agent' && list.some(isTeam)) errors.push(`role "${role}" must be an agent, not a team`);
  }
  if (pattern.options) errors.push(...validate(pattern.options, options, 'options'));
  if (errors.length) throw new Error(`team "${name}" (${patternName}): ${errors.join('; ')}`);
  const members = Object.values(bound).flat();
  return { kind: 'team', name, description, pattern: patternName, members, execute: pattern.build(bound, options) };
}
