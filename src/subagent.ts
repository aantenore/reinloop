import { defineTool } from './tools/define.ts';
import { type Member, runMember } from './team.ts';
import type { Message, Tool } from './types.ts';
import { userMessage } from './util.ts';

export interface AgentToolOptions {
  name?: string;
  description: string;
  /**
   * `fresh`: the subagent sees only the task (independent verifier, cheapest context).
   * `fork`: it also receives the parent's conversation text (continuing worker).
   */
  context?: 'fresh' | 'fork';
}

/** Exposes an agent or team as a tool: isolated context, own budget, own event log linked by parentRunId. */
export function agentTool(agent: Member, opts: AgentToolOptions): Tool<{ task: string }> {
  const mode = opts.context ?? 'fresh';
  return defineTool({
    name: opts.name ?? agent.name,
    description: opts.description,
    // Delegation has no side effects of its own; the subagent's tools are policed by its own policy.
    risk: 'read',
    schema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Complete, self-contained task for the subagent' } },
      required: ['task'],
      additionalProperties: false,
    },
    async run({ task }, ctx) {
      const input: Message[] = mode === 'fork' ? [...forkContext(ctx.state.messages), userMessage(task)] : [userMessage(task)];
      const handle = await runMember(agent, input, { ...ctx.inherit, signal: ctx.signal, parentRunId: ctx.runId });
      if (handle.status !== 'completed') {
        return { content: `Subagent ${agent.name} ${handle.status}${handle.reason ? `: ${handle.reason}` : ''}. Partial output: ${handle.output}`, isError: true };
      }
      return handle.data !== undefined ? JSON.stringify(handle.data) : handle.output;
    },
  });
}

/** Text-only copy of the parent's conversation (tool traffic dropped to avoid orphaned calls). */
function forkContext(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'tool') continue;
    const parts = m.parts.filter((p) => p.type === 'text');
    if (parts.length) out.push({ role: m.role, parts });
  }
  return out;
}
