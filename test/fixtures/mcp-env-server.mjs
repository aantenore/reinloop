// Minimal stdio MCP server used by tests: the `env` tool returns the value of a variable of its own environment.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'env-fixture', version: '1' } } });
    case 'tools/list':
      return send({ id: msg.id, result: { tools: [{ name: 'env', description: 'Value of an environment variable', inputSchema: { type: 'object', properties: { name: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } });
    case 'tools/call':
      return send({ id: msg.id, result: { content: [{ type: 'text', text: String(process.env[msg.params.arguments.name] ?? '<unset>') }] } });
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
