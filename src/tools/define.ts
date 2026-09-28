import type { ArtifactStore, JsonSchema, Tool, ToolContext, ToolOutput } from '../types.ts';
import { newId } from '../util.ts';

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function defineTool<A = any>(tool: Tool<A>): Tool<A> {
  if (!NAME.test(tool.name)) throw new Error(`invalid tool name "${tool.name}" (allowed: [a-zA-Z0-9_-], max 64)`);
  return tool;
}

/** Normalizes any external name (e.g. MCP `server/tool.name`) into a provider-safe tool name. */
export function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function objectSchema(properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function normalizeOutput(out: string | ToolOutput | undefined): ToolOutput {
  if (out === undefined) return { content: '' };
  return typeof out === 'string' ? { content: out } : { content: out.content ?? '', isError: out.isError };
}

export function memoryArtifacts(): ArtifactStore {
  const items = new Map<string, string>();
  return {
    async put(content) {
      const handle = `art_${newId().slice(0, 8)}`;
      items.set(handle, content);
      return handle;
    },
    async get(handle) {
      return items.get(handle);
    },
  };
}

/** Pages through large tool outputs offloaded to an artifact store. */
export function readArtifactTool(store: ArtifactStore): Tool<{ handle: string; offset?: number; limit?: number }> {
  return defineTool({
    name: 'read_artifact',
    description: 'Read a slice of a stored large tool output by handle.',
    risk: 'read',
    schema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: 'Start character (default 0)' },
        limit: { type: 'integer', minimum: 1, description: 'Max characters (default 8000)' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    async run({ handle, offset = 0, limit = 8000 }, _ctx: ToolContext) {
      const text = await store.get(handle);
      if (text === undefined) return { content: `unknown artifact ${handle}`, isError: true };
      const slice = text.slice(offset, offset + limit);
      const end = offset + slice.length;
      return end < text.length ? `${slice}\n[chars ${offset}-${end} of ${text.length}; continue with offset=${end}]` : slice;
    },
  });
}
