import { interpolate } from './config/load.ts';
import type { Runtime } from './config/runtime.ts';

export interface MemberInfo {
  name: string;
  kind: 'agent' | 'team';
  description?: string;
  model?: string;
  tools?: string[];
  pattern?: string;
  roles?: Record<string, unknown>;
}

const shown = (spec: string | undefined) => {
  try {
    return spec && interpolate(spec, process.env);
  } catch {
    return spec;
  }
};

/** Static description of every member, read from config (no model or MCP connection needed). */
export function describeMembers(runtime: Runtime): MemberInfo[] {
  const { agents = {}, teams = {}, defaultModel } = runtime.config;
  return [
    ...Object.entries(agents).map(([name, a]): MemberInfo => ({
      name,
      kind: 'agent',
      description: a.description ?? a.asTool?.description,
      model: shown(a.model ?? defaultModel) ?? 'auto',
      tools: a.tools ?? [],
    })),
    ...Object.entries(teams).map(([name, t]): MemberInfo => ({ name, kind: 'team', description: t.description, pattern: t.pattern, roles: t.roles })),
  ];
}
