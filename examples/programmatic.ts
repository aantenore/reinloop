// Code-only usage. Runs offline with scripted models; set REINLOOP_MODEL (e.g. openai/gpt-5-mini) to use a real one.
// Run: node examples/programmatic.ts
import { agent, mockProvider, team, tool } from '../src/index.ts';

const live = process.env.REINLOOP_MODEL;
const scripted = (...texts: string[]) => (live ? live : { provider: mockProvider(texts.map((text) => ({ text }))), model: 'mock' });

const wordCount = tool('word_count', 'Count words in a text', { text: 'string' }, ({ text }) => String(text.split(/\s+/).filter(Boolean).length));

const writer = agent({
  name: 'writer',
  description: 'Writes short product copy',
  model: scripted('Meet reinloop: agents as files.', 'reinloop: agents as Markdown files, with a production harness included.'),
  instructions: 'Write one sentence of product copy. Be concrete.',
  tools: [wordCount],
});

const editor = agent({
  name: 'editor',
  model: scripted('{"pass": false, "feedback": "Mention the harness."}', '{"pass": true, "feedback": "Clear and concrete."}'),
  instructions: 'Judge copy for clarity and concreteness.',
});

// Evaluator-optimizer in one line: the writer revises until the editor approves (max 3 rounds).
const copyDesk = team('copy-desk', 'evaluator', { generator: writer, evaluator: editor }, { maxRounds: 3 });

const result = await copyDesk.run('Tagline for an open-source agent harness');
console.log(result.output);
console.log(result.status, result.data, `${result.turns} model turns`);
