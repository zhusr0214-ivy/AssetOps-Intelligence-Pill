import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';

const env = { SOCLAAS_BASE_URL: 'https://provider.example/v1/', SOCLAAS_API_KEY: 'test-key-not-real', SOCLAAS_MODEL: 'default' };
const proposed = { title: 'Cooling issue', category: 'hvac', location: 'floor 18', asset: 'AHU-18-01', occurredAt: 'today', impact: 'Three tenants affected', observations: '', actionsTaken: '' };
const source = { description: 'AHU-18-01 at floor 18 stopped cooling today. Three tenants affected.', priority: 'low' };
const reply = value => ({ ok: true, json: async () => ({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) });

test('model request uses configured endpoint/model; user fields and priority are protected', async () => {
  const agent = createIntakeAgent({ env, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://provider.example/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key-not-real');
    assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'default');
    assert.equal(payload.messages[1].role, 'user');
    return reply({ ...proposed, priority: 'urgent', description: 'replaced', status: 'ready_for_triage' });
  } });
  const result = await agent({ ...source, location: 'User location', asset: 'Unknown' });
  assert.equal(result.mode, 'llm');
  assert.equal(result.fields.priority, 'low');
  assert.equal(result.fields.location, 'User location');
  assert.equal(result.fields.asset, 'Unknown');
  assert.equal(result.fields.description, source.description);
  assert.equal(result.fields.status, undefined);
  assert.equal(result.readyForTriage, true);
});

test('unsubstantiated facts are discarded and optional priority is never invented', async () => {
  const agent = createIntakeAgent({ env, fetchImpl: async () => reply({ ...proposed, impact: '200 people affected', asset: 'AHU-99', priority: 'urgent' }) });
  const result = await agent({ description: source.description });
  assert.equal(result.fields.priority, '');
  assert.equal(result.fields.impact, '');
  assert.equal(result.fields.asset, '');
  assert.equal(result.readyForTriage, false);
  assert.ok(!result.missingFields.includes('priority'));
  assert.ok(result.missingFields.includes('impact'));
});

test('malformed model responses are rejected', async () => {
  for (const value of ['not json', '[]', '{}', { ...proposed, category: 'invented' }, { ...proposed, impact: 123 }]) {
    const agent = createIntakeAgent({ env, fetchImpl: async () => reply(value) });
    await assert.rejects(agent(source), { status: 502 });
  }
});

test('provider errors and timeouts are sanitized without silent rules fallback', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const agent = createIntakeAgent({ env, fetchImpl: async () => ({ ok: false, status, json: async () => ({ secret: env.SOCLAAS_API_KEY }) }) });
    await assert.rejects(agent(source), error => error.status >= 500 && !error.message.includes(env.SOCLAAS_API_KEY));
  }
  const agent = createIntakeAgent({ env, fetchImpl: async () => { throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); } });
  await assert.rejects(agent(source), { status: 504 });
});

test('rules fallback is only used without configuration; incomplete config is explicit', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error(); };
  assert.equal((await createIntakeAgent({ env: {}, fetchImpl })(source)).mode, 'local-rules');
  await assert.rejects(createIntakeAgent({ env: { SOCLAAS_BASE_URL: env.SOCLAAS_BASE_URL }, fetchImpl })(source), { status: 503 });
  await assert.rejects(createIntakeAgent({ env: { ...env, SOCLAAS_BASE_URL: '[https://example.com](https://example.com)' }, fetchImpl })(source), { status: 503 });
  assert.equal(called, false);
});
