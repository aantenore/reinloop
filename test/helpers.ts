import { defineTool, mockProvider, type MockStep } from '../src/index.ts';
import type { Agent, Tool } from '../src/index.ts';

export function makeAgent(script: MockStep[], overrides: Partial<Agent> = {}): Agent & { provider: ReturnType<typeof mockProvider> } {
  const provider = mockProvider(script);
  return { name: 'test', model: { provider, model: 'mock-1' }, tools: [], ...overrides, provider };
}

export function echoTool(name = 'echo', extra: Partial<Tool> = {}): Tool<{ text: string }> & { calls: number } {
  const tool = defineTool<{ text: string }>({
    name,
    description: 'Echo text',
    risk: 'read',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    async run({ text }) {
      tool.calls++;
      return `echoed:${text}`;
    },
    ...extra,
  }) as Tool<{ text: string }> & { calls: number };
  tool.calls = 0;
  return tool;
}

export function sleepTool(ms: number): Tool {
  return defineTool({
    name: 'sleep',
    description: 'Sleep',
    risk: 'read',
    schema: { type: 'object', properties: {} },
    run: () => new Promise((r) => setTimeout(() => r('slept'), ms)),
  });
}

/** Fake fetch returning queued responses and recording requests. */
export function fakeFetch(responses: Array<() => Response>) {
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const impl = async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next();
  };
  return { impl, requests };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const sse = (events: Array<{ event?: string; data: unknown }>) => () =>
  new Response(
    events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
