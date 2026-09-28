// A custom agentic pattern with its own roles: two advocates argue in parallel, a judge decides.
// Register it once; then any team can use `pattern: debate` with roles pro, con and judge.
export default function register(registry) {
  registry.patterns.set('debate', {
    description: 'Two advocates argue opposite positions for N rounds; a judge decides.',
    roles: {
      pro: { description: 'Argues in favour' },
      con: { description: 'Argues against' },
      judge: { description: 'Weighs both sides and decides' },
    },
    options: { type: 'object', properties: { rounds: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    build: ({ pro, con, judge }, { rounds = 1 }) => async (_input, ctx) => {
      let transcript = '';
      for (let round = 1; round <= rounds; round++) {
        const prompt = `Question: ${ctx.task}\n\nDebate so far:\n${transcript || '(none)'}\n\nGive your strongest argument for round ${round}.`;
        const [p, c] = await Promise.all([ctx.call(pro, prompt, { session: 'pro' }), ctx.call(con, prompt, { session: 'con' })]);
        transcript += `\n[round ${round}] PRO: ${p.output}\n[round ${round}] CON: ${c.output}\n`;
      }
      const verdict = await ctx.call(judge, `Question: ${ctx.task}\n\nDebate:${transcript}\nDecide and explain briefly.`);
      if (verdict.status !== 'completed') return { output: verdict.output, status: verdict.status, reason: `judge: ${verdict.reason}` };
      return { output: verdict.output, data: { verdict: verdict.data, transcript } };
    },
  });
}
