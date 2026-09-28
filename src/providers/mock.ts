import type { ModelRequest, Part, Provider, Usage } from '../types.ts';
import { estimateTokens, ProviderError, sleep, textOf } from '../util.ts';

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ name: string; args?: unknown; id?: string }>;
  usage?: Partial<Usage>;
  delayMs?: number;
  error?: { status: number; message?: string };
}

export type MockStep = MockTurn | ((req: ModelRequest, index: number) => MockTurn);

export interface MockProvider extends Provider {
  readonly requests: ModelRequest[];
}

/**
 * Deterministic provider for tests, demos and CI. With an empty script it echoes the
 * last user message; otherwise it plays the script and fails when it runs out.
 */
export function mockProvider(script: MockStep[] = [], opts: { name?: string; loop?: boolean } = {}): MockProvider {
  const requests: ModelRequest[] = [];
  return {
    name: opts.name ?? 'mock',
    requests,
    async generate(req, ctx) {
      const index = requests.length;
      requests.push(req);
      let step: MockStep | undefined;
      if (!script.length) {
        const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
        step = { text: `echo: ${textOf(lastUser)}` };
      } else {
        step = opts.loop ? script[index % script.length] : script[index];
      }
      if (!step) throw new ProviderError(500, `mock script exhausted after ${script.length} responses`);
      const turn = typeof step === 'function' ? step(req, index) : step;
      if (turn.delayMs) await sleep(turn.delayMs, ctx.signal);
      if (turn.error) throw new ProviderError(turn.error.status, turn.error.message ?? `mock error ${turn.error.status}`);
      const parts: Part[] = [];
      if (turn.text) {
        for (const chunk of turn.text.match(/\S+\s*/g) ?? [turn.text]) ctx.onText?.(chunk);
        parts.push({ type: 'text', text: turn.text });
      }
      turn.toolCalls?.forEach((c, i) => parts.push({ type: 'tool_call', id: c.id ?? `call_${index}_${i}`, name: c.name, args: c.args ?? {} }));
      return {
        message: { role: 'assistant', parts },
        stopReason: turn.toolCalls?.length ? 'tool_calls' : 'end',
        model: req.model,
        usage: {
          inputTokens: turn.usage?.inputTokens ?? estimateTokens(req.messages) + estimateTokens(req.instructions ?? ''),
          outputTokens: turn.usage?.outputTokens ?? estimateTokens(parts),
          ...(turn.usage?.cacheReadTokens && { cacheReadTokens: turn.usage.cacheReadTokens }),
        },
      };
    },
  };
}
