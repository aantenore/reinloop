import type { HostedToolDef, Risk, Tool } from '../types.ts';
import { defineTool } from './define.ts';

export interface HostedToolOptions extends HostedToolDef {
  /** Tool name the model sees; default: `type` without its version suffix (`web_search_20250305` -> `web_search`). */
  name?: string;
  description?: string;
  /** Policy risk; default `read` for web search/fetch, `exec` for anything else (e.g. code execution). */
  risk?: Risk;
}

/** Default policy risk of a hosted tool type. */
export function hostedRisk(type: string): Risk {
  return /^web_(search|fetch)/.test(type) ? 'read' : 'exec';
}

/**
 * Declares a tool the provider runs inside the model turn (e.g. Anthropic web search, web fetch, code execution).
 * The loop sends it with the request, never executes it, records its calls and results in the history, counts
 * them against `maxToolCalls` and applies the policy once per run before offering it.
 */
export function hostedTool(opts: HostedToolOptions): Tool {
  const name = opts.name ?? opts.type.replace(/_\d{8}$/, '');
  const limitParam = opts.limitParam ?? (/^web_(search|fetch)/.test(opts.type) ? 'max_uses' : undefined);
  const hosted: HostedToolDef = {
    provider: opts.provider,
    type: opts.type,
    ...(opts.params && { params: opts.params }),
    ...(limitParam && { limitParam }),
    ...(opts.beta && { beta: opts.beta }),
  };
  return defineTool({
    name,
    description: opts.description ?? `Provider-hosted tool (${opts.provider} ${opts.type})`,
    schema: { type: 'object' },
    risk: opts.risk ?? hostedRisk(opts.type),
    hosted,
    run: () => ({ content: `"${name}" is executed by the provider and cannot be called as a regular tool.`, isError: true }),
  });
}
