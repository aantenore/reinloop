// Minimal stdio MCP server used by tests.
import { createInterface } from 'node:readline';

const tools = [
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
    case 'tools/list':
      return msg.params?.cursor
        ? send({ id: msg.id, result: { tools: [tools[1]] } })
        : send({ id: msg.id, result: { tools: [tools[0]], nextCursor: 'p2' } });
    case 'tools/call':
      if (msg.params.name === 'add') {
        const { a, b } = msg.params.arguments;
        return send({ id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }] } });
      }
      return send({ id: msg.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } });
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
