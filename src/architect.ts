import { normalize, sep } from 'node:path';
import { agent, type EasyAgent } from './easy.ts';
import { PRESETS } from './presets.ts';
import { loadProject } from './project.ts';
import type { Registry } from './registry.ts';
import { createRegistry } from './registry.ts';
import { defineTool } from './tools/define.ts';
import { workspaceTools } from './tools/node.ts';
import type { Approver, ModelRef, Sink } from './types.ts';
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
model: provider/model   # optional; omit to use the project default. Providers: ${Object.keys(PRESETS).join(', ')}
tools: [tool, other-agent]   # built-in tools: ${tools}; any agent or team name delegates to it
budget: { maxTurns: 20 }     # optional: maxTurns, maxToolCalls, maxTotalTokens, maxCostUsd, maxDurationMs
output: { schema: { type: object, properties: { ... }, required: [...] } }   # optional structured answer
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

Method:
1. Choose the simplest design that satisfies the request: one agent beats a team; add a team only for a clear reason (quality loop, parallel work, routing).
2. Give each agent only the tools it needs. Prefer read-only tools; add write_file, edit_file or shell only when required.
3. Write concrete, specific instructions; no filler.
4. Write the files with write_file, then call validate_project and fix every reported error.
5. Finish with a short summary: files created, how to run them (reinloop run -a <name> "task").`;
}

/** Validates the project on disk exactly as the CLI would load it. */
function validateTool(cwd: string) {
  return defineTool({
    name: 'validate_project',
    description: 'Load and build every agent and team in the project; returns "ok" or the errors to fix.',
    risk: 'read',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const rt = await loadProject({ cwd });
        try {
          for (const name of rt.names()) await rt.agent(name);
          return `ok: ${rt.names().join(', ')}`;
        } finally {
          await rt.close();
        }
      } catch (err) {
        return { content: errorMessage(err), isError: true };
      }
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
