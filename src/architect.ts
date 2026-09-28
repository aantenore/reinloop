import { normalize, sep } from 'node:path';
import { agent, type EasyAgent } from './easy.ts';
import { missingCredentials, PRESETS } from './presets.ts';
import { loadProject } from './project.ts';
import type { Registry } from './registry.ts';
import { createRegistry } from './registry.ts';
import { defineTool } from './tools/define.ts';
import { workspaceTools } from './tools/node.ts';
import type { RunHandle } from './loop.ts';
import type { Approver, ModelRef, RunResult, Sink } from './types.ts';
import { errorMessage } from './util.ts';

/** Instructions of the built-in agent that designs agents and teams from a plain-language request. */
export function architectInstructions(registry: Registry): string {
  const tools = [...registry.tools.keys()].join(', ');
  const patterns = [...registry.patterns.entries()]
    .map(([name, p]) => `- ${name}: ${p.description} Roles: ${Object.entries(p.roles).map(([r, s]) => `${r}${s.many ? '[]' : ''}${s.optional ? '?' : ''}`).join(', ')}`)
    .join('\n');
  return `You design agents for the reinloop harness. Turn the user's request into Markdown files under agents/.

Agent file (agents/<name>.md):
---
description: one line saying what the agent does (used for delegation and routing)
model: provider/model   # OMIT unless the user names a model: the project default is used. Providers: ${Object.keys(PRESETS).join(', ')}
tools: [tool, other-agent]   # built-in tools: ${tools}; any agent or team name delegates to it
budget: { maxTurns: 20 }     # optional: maxTurns, maxToolCalls, maxTotalTokens, maxCostUsd, maxDurationMs
output: { schema: { type: object, properties: { ... }, required: [...] } }   # optional structured answer
skills: [skill-name]         # optional Agent Skills (folders with SKILL.md in skills/)
---
Instructions in plain Markdown: role, goal, method, output format, constraints.

Team file (agents/<name>.md) composes agents with a pattern:
---
pattern: <pattern>
description: what the team delivers
roles: { role: agent-name, listRole: [a, b] }
options: { ... }   # optional
---

Patterns:
${patterns}

Contracts the harness enforces (do not contradict them in instructions):
- evaluator pattern: the evaluator must answer { "pass": boolean, "feedback": string }; the harness adds this schema. Tell it what to judge, not the format. The generator answers in plain text.
- router pattern: the router must answer { "route": <name>, "reason": string }; routes are chosen from their description fields.
- Add "output" to an agent only when its caller needs JSON. Schema properties are objects: { "field": { "type": "string" } }.

Method:
1. Choose the simplest design that satisfies the request: one agent beats a team; add a team only for a clear reason (quality loop, parallel work, routing).
2. Do not set "model" unless the user asked for a specific one. Give each agent only the tools it needs. Prefer read-only tools; add write_file, edit_file or shell only when required.
3. Write concrete, specific instructions; no filler.
4. Write the files with write_file, then call validate_project and fix every reported error.
5. Finish with a short summary: files created, how to run them (reinloop run -a <name> "task").`;
}

/** Loads and builds every member as the CLI would; returns the problems (empty when valid). */
export async function validateProject(cwd: string): Promise<string[]> {
  try {
    const rt = await loadProject({ cwd });
    try {
      for (const name of rt.names()) await rt.agent(name);
      return missingCredentials(rt.config);
    } finally {
      await rt.close();
    }
  } catch (err) {
    return [errorMessage(err)];
  }
}

/** Validates the project on disk exactly as the CLI would load it. */
function validateTool(cwd: string) {
  return defineTool({
    name: 'validate_project',
    description: 'Load and build every agent and team in the project; returns "ok" or the errors to fix.',
    risk: 'read',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const problems = await validateProject(cwd);
      return problems.length ? { content: problems.join('\n'), isError: true } : 'ok';
    },
  });
}

export interface ArchitectOptions {
  cwd: string;
  model?: string | ModelRef;
  approve?: Approver;
  sinks?: Sink[];
}

/** An agent that writes agent/team files; its writes are limited to agents/ by a guard. */
export function architect(opts: ArchitectOptions): EasyAgent {
  const registry = createRegistry();
  const ws = workspaceTools({ root: opts.cwd });
  return agent({
    name: 'architect',
    model: opts.model,
    instructions: architectInstructions(registry),
    tools: [ws.list_dir!, ws.read_file!, ws.write_file!, ws.edit_file!, validateTool(opts.cwd)],
    budget: { maxTurns: 25 },
    policy: { rules: [{ match: 'write_file', action: 'allow' }, { match: 'edit_file', action: 'allow' }] },
    middleware: [
      {
        beforeTool(call) {
          if (call.name !== 'write_file' && call.name !== 'edit_file') return;
          const path = String((call.args as { path?: string }).path ?? '');
          const target = normalize(path);
          const inAgents = target.startsWith(`agents${sep}`) && !target.split(sep).includes('..') && target.endsWith('.md');
          return inAgents ? undefined : { deny: 'the architect may only write agents/*.md files' };
        },
      },
    ],
    approve: opts.approve,
    sinks: opts.sinks,
  });
}

/**
 * Runs the architect and enforces the result: when the files on disk do not validate, the same session is sent
 * the errors to fix (up to `rounds` times). `onHandle` can render each streamed attempt.
 */
export async function design(
  request: string,
  opts: ArchitectOptions & { rounds?: number; onHandle?: (handle: RunHandle) => Promise<unknown> },
): Promise<{ result: RunResult; problems: string[] }> {
  const designer = architect(opts);
  let input = request;
  let runId: string | undefined;
  for (let round = 0; ; round++) {
    const handle = designer.stream(input, { runId });
    await opts.onHandle?.(handle);
    const result = await handle.result;
    runId = result.runId;
    const problems = await validateProject(opts.cwd);
    if (!problems.length || round >= (opts.rounds ?? 2) || result.status === 'interrupted') return { result, problems };
    input = `The project does not validate yet. Fix these problems, then call validate_project:\n${problems.map((p) => `- ${p}`).join('\n')}`;
  }
}
