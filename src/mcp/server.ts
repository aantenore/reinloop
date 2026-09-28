import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Runtime } from '../config/runtime.ts';
import { describeMembers } from '../describe.ts';
import { safeToolName } from '../tools/define.ts';
import type { Approver } from '../types.ts';
import { errorMessage } from '../util.ts';
import { MCP_PROTOCOL_VERSION } from './client.ts';

export interface McpServeOptions {
  input?: Readable;
  output?: Writable;
  approve?: Approver;
  version?: string;
}

/**
 * Exposes every agent and team as an MCP tool over stdio, so any MCP client (IDEs, desktop
 * assistants, other agents) can delegate to them. Pass `sessionId` back to continue a conversation.
 */
export function serveMcp(runtime: Runtime, opts: McpServeOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const byTool = new Map(describeMembers(runtime).map((m) => [safeToolName(m.name), m]));
  const write = (msg: unknown) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...(msg as object) })}\n`);
  const inflight = new Map<string | number, AbortController>();

  const handle = async (msg: any): Promise<unknown> => {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'reinloop', version: opts.version ?? '0.1.0' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [...byTool.entries()].map(([tool, m]) => ({
            name: tool,
            description: m.description ?? `Run the ${m.kind} "${m.name}"`,
            inputSchema: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Complete, self-contained task' },
                sessionId: { type: 'string', description: 'Continue a previous conversation (returned as sessionId)' },
              },
              required: ['task'],
            },
          })),
        };
      case 'tools/call': {
        const member = byTool.get(msg.params?.name);
        if (!member) throw Object.assign(new Error(`unknown tool ${msg.params?.name}`), { code: -32602 });
        const { task, sessionId } = msg.params?.arguments ?? {};
        if (typeof task !== 'string') throw Object.assign(new Error('"task" must be a string'), { code: -32602 });
        const controller = new AbortController();
        inflight.set(msg.id, controller);
        try {
          const r = await runtime.run(member.name, task, { runId: typeof sessionId === 'string' ? sessionId : undefined, approve: opts.approve, signal: controller.signal });
          const text = r.status === 'completed' ? r.output : `${r.status}${r.reason ? `: ${r.reason}` : ''}\n${r.output}`.trim();
          return {
            content: [{ type: 'text', text }],
            structuredContent: { status: r.status, sessionId: r.runId, ...(r.data !== undefined && { data: r.data }) },
            isError: r.status !== 'completed',
          };
        } finally {
          inflight.delete(msg.id);
        }
      }
      default:
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input });
    rl.on('line', (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return write({ id: null, error: { code: -32700, message: 'parse error' } });
      }
      if (msg.method === 'notifications/cancelled') inflight.get(msg.params?.requestId)?.abort(new Error('cancelled by client'));
      if (msg.id === undefined || msg.id === null) return;
      handle(msg).then(
        (result) => write({ id: msg.id, result }),
        (err) => write({ id: msg.id, error: { code: (err as { code?: number }).code ?? -32603, message: errorMessage(err) } }),
      );
    });
    rl.on('close', () => {
      for (const c of inflight.values()) c.abort(new Error('client closed'));
      resolve();
    });
  });
}
