// Stdio MCP server that exits right after answering tools/list: later requests must fail at once.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'exiting', version: '1' } } });
    case 'tools/list':
      process.stderr.write('shutting down\n');
      return process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })}\n`, () => process.exit(0));
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
