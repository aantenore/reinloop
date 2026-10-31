import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accessQuestion, publicQuestion, type AccessQuestion, type Identity, type Tool, type ToolCallPart } from '../src/index.ts';
import { SchemaSet } from './schema-validate.ts';

// reinloop keeps its own AccessQuestion type; this checks its output against the agent-layers schema copy.
const dir = new URL('./fixtures/agent-layers/', import.meta.url);
const schemas = new SchemaSet(['access-question.json', 'common.json'].map((f) => fileURLToPath(new URL(f, dir))));
const validate = (q: unknown) => schemas.validate('access-question.json', q);
const assertValid = (q: unknown) => assert.deepEqual(validate(q), [], JSON.stringify(q));

const TOKEN = 'secret-bearer-token-123';
const call: ToolCallPart = { type: 'tool_call', id: 'c1', name: 'crm__lookup', args: { customer: 'C-77' } };
const tool = { name: 'crm__lookup', description: 'Look up', schema: { type: 'object' }, risk: 'read', run: async () => 'ok' } as Tool;
const user: Identity = { subject: 'u-1042', kind: 'user', roles: ['support'], scopes: ['orders:read'], token: TOKEN, claims: { name: 'Mara Rossi' } };

describe('AccessQuestion against the agent-layers schema', () => {
  it('user caller with roles and scopes', () => {
    const q = accessQuestion(call, tool, 'support', user);
    assertValid(q);
    assert.deepEqual(q.caller, { id: 'u-1042', kind: 'user', roles: ['support'], scopes: ['orders:read'] });
  });

  it('caller name through publicQuestion', () => {
    const q = publicQuestion({ ...accessQuestion(call, tool, 'support', user), caller: { id: 'u-1042', kind: 'user', roles: ['support'], scopes: [], name: 'Mara Rossi' } });
    assertValid(q);
    assert.equal(q.caller.name, 'Mara Rossi');
  });

  it('agent caller without roles and scopes', () => {
    const q = accessQuestion(call, tool, 'support', { subject: 'svc-agent', kind: 'agent', token: TOKEN });
    assertValid(q);
    assert.deepEqual(q.caller, { id: 'svc-agent', kind: 'agent', roles: [], scopes: [] });
  });

  it('no identity is the anonymous caller', () => {
    const q = accessQuestion(call, tool, 'support', undefined);
    assertValid(q);
    assert.deepEqual(q.caller, { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] });
  });

  it('an unknown caller kind becomes anonymous', () => {
    const q = publicQuestion({ ...accessQuestion(call, tool, 'support', user), caller: { id: 'x', kind: 'robot' as 'user', roles: ['admin'], scopes: [] } });
    assertValid(q);
    assert.equal(q.caller.kind, 'anonymous');
  });

  it('args only with includeArgs', () => {
    const without = accessQuestion(call, tool, 'support', user, false);
    const withArgs = accessQuestion(call, tool, 'support', user, true);
    assertValid(without);
    assertValid(withArgs);
    assert.equal('args' in without, false);
    assert.deepEqual(withArgs.args, { customer: 'C-77' });
  });

  it('layer defaults: tool, hosted tool, explicit layer', () => {
    assert.equal(accessQuestion(call, tool, 'a', user).target.layer, 'tool');
    const hosted = { ...tool, hosted: { type: 'web_search' } } as unknown as Tool;
    const q = accessQuestion(call, hosted, 'a', user);
    assertValid(q);
    assert.equal(q.target.layer, 'llm');
    assertValid(accessQuestion(call, { ...tool, layer: 'knowledge' }, 'a', user));
  });

  it('every risk class', () => {
    for (const risk of ['read', 'write', 'exec'] as const) assertValid(accessQuestion(call, { ...tool, risk }, 'a', user));
  });

  it('target attrs pass through publicQuestion', () => {
    const base = accessQuestion(call, tool, 'support', user);
    assertValid(publicQuestion({ ...base, target: { ...base.target, attrs: { owner: 'sales', tags: ['a', 'b'], tier: 2, beta: true } } }));
  });

  it('a credential never appears', () => {
    for (const q of [accessQuestion(call, tool, 'a', user), accessQuestion(call, tool, 'a', user, true), accessQuestion(call, tool, 'a', undefined)]) {
      assert.equal(JSON.stringify(q).includes(TOKEN), false);
      assert.equal('token' in q.caller, false);
      assert.equal('claims' in q.caller, false);
    }
    const leaky = publicQuestion({ ...accessQuestion(call, tool, 'a', user), caller: { ...user, id: 'u-1', roles: [], scopes: [], token: TOKEN } as unknown as AccessQuestion['caller'] });
    assert.equal(JSON.stringify(leaky).includes(TOKEN), false);
    assertValid(leaky);
  });

  it('tool without a risk label asks as exec, like the SDK', () => {
    const q = accessQuestion(call, { ...tool, risk: undefined }, 'a', user);
    assertValid(q);
    assert.equal(q.target.risk, 'exec');
  });
});

describe('schema validator', () => {
  const good = accessQuestion(call, tool, 'support', user);

  it('accepts the SDK example', () => {
    const example = {
      caller: { id: 'u-1042', kind: 'user', roles: ['support'], scopes: ['orders:read'], name: 'Mara Rossi' },
      action: 'call',
      target: { kind: 'tool', id: 'crm__lookup', layer: 'tool', risk: 'read', agent: 'support', attrs: { owner: 'sales' } },
      args: { customer: 'C-77' },
    };
    assert.deepEqual(validate(example), []);
  });

  it('rejects an extra top-level field', () => {
    assert.notDeepEqual(validate({ ...good, extra: 1 }), []);
  });

  it('rejects a missing target', () => {
    const { target: _target, ...rest } = good;
    assert.match(validate(rest).join('\n'), /missing required "target"/);
  });

  it('rejects wrong values through $ref and pattern', () => {
    assert.notDeepEqual(validate({ ...good, target: { ...good.target, layer: 'nope' } }), []);
    assert.notDeepEqual(validate({ ...good, target: { ...good.target, risk: null } }), []);
    assert.notDeepEqual(validate({ ...good, action: 'Call' }), []);
    assert.notDeepEqual(validate({ ...good, caller: { kind: 'anonymous', id: 'anonymous', roles: ['x'], scopes: [] } }), []);
    assert.notDeepEqual(validate({ ...good, caller: { ...good.caller, token: TOKEN } }), []);
  });

  it('rejects an invalid ext key', () => {
    assert.notDeepEqual(validate({ ...good, ext: { bad: 1 } }), []);
    assert.deepEqual(validate({ ...good, ext: { 'acme.trace': 1 } }), []);
  });

  it('fails loudly on an unsupported keyword', () => {
    const set = new SchemaSet([fileURLToPath(new URL('access-question.json', dir))]);
    assert.throws(() => (set as unknown as { check: (...a: unknown[]) => void }).check({ if: {} }, {}, 1, '$', []), /unsupported keyword "if"/);
  });
});
