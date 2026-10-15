import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createHandler } from '../server.js';
import { createIntakeAgent } from '../intake-agent.js';
import { assessIntake } from '../intake.js';
import { createCaseConversationAgent } from '../case-conversation-agent.js';

const env = { SOCLAAS_BASE_URL: 'https://example.test/v1', SOCLAAS_API_KEY: 'test' };
const proposal = { title: '', category: 'hvac', location: '', asset: '', occurredAt: '', impact: '', observations: '', actionsTaken: '', corrections: [] };
const mockAgent = response => createIntakeAgent({ env, fetchImpl: async (url, options) => {
  const data = JSON.parse(JSON.parse(options.body).messages[1].content);
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(response(data)) } }] }) };
} });
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost' } });
  let status, payload;
  await handler(req, { writeHead(code) { status = code; }, end(body) { payload = JSON.parse(body); } });
  return { status, ...payload };
}
async function setup(t, agent) {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-chat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createIncidentStore(join(dir, 'data.json'));
  const handler = createHandler(store, agent);
  const { incident } = await request(handler, 'POST', '/api/incidents', { description: '18层空调不冷', priority: 'low' });
  return { handler, store, path: `/api/incidents/${incident.id}` };
}

test('multi-turn extraction, explicit correction, persistence and user confirmation', async t => {
  const agent = mockAgent(data => {
    const last = data.conversation.at(-1).content;
    assert.ok(data.conversation.some(message => message.role === 'user'));
    return { ...proposal, location: last.includes('19层') ? '19层' : '18层', occurredAt: last.includes('下午两点') ? '下午两点' : '', impact: last.includes('三位租户') ? '三位租户' : '', corrections: last.includes('19层') ? ['location'] : [] };
  });
  const { handler, store, path } = await setup(t, agent);
  const first = await request(handler, 'POST', `${path}/messages`, { requestId: 'message-0001', content: '18层空调不冷' });
  assert.equal(first.incident.location, '18层');
  assert.equal(first.incident.messages.length, 2);
  assert.equal(first.incident.priority, 'low');
  const second = await request(handler, 'POST', `${path}/messages`, { requestId: 'message-0002', content: '其实是19层，下午两点开始，三位租户受影响' });
  assert.equal(second.incident.location, '19层');
  assert.equal(second.incident.occurredAt, '下午两点');
  assert.equal(second.incident.impact, '三位租户');
  assert.equal(second.incident.messages.length, 4);
  assert.equal(second.incident.status, 'draft');
  const reload = await request(createHandler(store, agent), 'GET', path);
  assert.equal(reload.incident.messages.length, 4);
  const finalized = await request(handler, 'POST', `${path}/finalize`, { revision: reload.incident.revision });
  assert.equal(finalized.incident.status, 'ready_for_triage');
});

test('unified HTTP conversation extracts metadata and persists automatically retrieved Pill references', async t => {
  const pill = { id: 'P1', name: 'Cooling guidance', version: '2', status: 'approved', domain: 'ahu_cooling', rules: [{ id: 'R1', guidance: 'Check existing readings.' }] };
  const agent = createCaseConversationAgent({
    extract: mockAgent(() => ({ ...proposal, title: 'AHU cooling issue', category: 'hvac_cooling', asset: 'AHU-1', location: 'Level 2', occurredAt: 'today' })),
    loadPills: async () => [pill],
    answer: async value => {
      assert.equal(value.facts.asset, 'AHU-1');
      assert.equal(value.matchedPills[0].version, '2');
      return { answer: 'Existing readings can help clarify this issue.', citations: [{ sourceId: value.sources[0].sourceId, quote: 'Check existing readings.' }], expertRequest: { required: false, reason: '' }, resultFeedback: { summary: 'Cooling issue reported.', actions: '', outcome: 'not_reported', remaining: '', feedback: '', evidence: [] } };
    }
  });
  const { handler, path } = await setup(t, agent);
  const result = await request(handler, 'POST', `${path}/messages`, { requestId: 'unified-001', content: 'AHU-1 on Level 2 is not cooling today.' });
  assert.equal(result.status, 200);
  assert.equal(result.incident.asset, 'AHU-1');
  assert.equal(result.incident.occurredAt, 'today');
  assert.equal(result.incident.messages.at(-1).citations[0].pillId, 'P1');
  const saved = await request(handler, 'GET', path);
  assert.equal(saved.incident.messages.at(-1).content, 'Existing readings can help clarify this issue.');
  assert.equal(saved.incident.status, 'needs_info');
  assert.equal(saved.incident.triageReports, undefined);
});

test('short unknown replies map to a rephrased date question via its saved target', async () => {
  const agent = mockAgent(() => ({ ...proposal, occurredAt: 'Unknown' }));
  const result = await agent({ description: 'AHU cooling issue' }, {
    manualFields: [], messages: [
      { role: 'user', content: 'AHU cooling issue' },
      { role: 'assistant', content: 'Do you remember when you first noticed this?', followUpField: 'occurredAt' },
      { role: 'user', content: '不知道' }
    ]
  });
  assert.equal(result.fields.occurredAt, 'Unknown');
});

test('manual values require conflict resolution and stale saves are rejected', async t => {
  const agent = mockAgent(() => ({ ...proposal, location: '19层', corrections: ['location'] }));
  const { handler, path } = await setup(t, agent);
  await request(handler, 'PATCH', path, { location: '18层', occurredAt: 'Unknown', impact: 'Unknown' });
  const result = await request(handler, 'POST', `${path}/messages`, { requestId: 'message-0001', content: '其实是19层' });
  assert.equal(result.incident.location, '18层');
  assert.equal(result.incident.conflicts[0].proposed, '19层');
  assert.equal((await request(handler, 'POST', `${path}/finalize`, {})).status, 422);
  assert.equal((await request(handler, 'PATCH', path, { revision: 0, location: '20层' })).status, 409);
  const resolved = await request(handler, 'PATCH', path, { revision: result.incident.revision, location: '19层' });
  assert.equal(resolved.incident.conflicts.length, 0);
  assert.equal((await request(handler, 'POST', `${path}/finalize`, {})).status, 200);
});

test('failed analysis persists message; retry and duplicate request do not duplicate turns', async t => {
  let attempts = 0;
  const agent = async input => {
    if (++attempts === 1) throw Object.assign(new Error('Model timed out.'), { status: 504 });
    return assessIntake(input);
  };
  const { handler, path } = await setup(t, agent);
  const body = { requestId: 'message-0001', content: '18层空调不冷' };
  assert.equal((await request(handler, 'POST', `${path}/messages`, body)).status, 504);
  assert.equal((await request(handler, 'GET', path)).incident.messages[0].state, 'failed');
  assert.equal((await request(handler, 'POST', `${path}/messages`, { requestId: 'message-0002', content: 'Another message' })).status, 409);
  const retry = await request(handler, 'POST', `${path}/messages`, { requestId: body.requestId, retry: true });
  assert.equal(retry.incident.messages.length, 2);
  const duplicate = await request(handler, 'POST', `${path}/messages`, body);
  assert.equal(duplicate.incident.messages.length, 2);
  assert.equal(attempts, 2);
});

test('ambiguous changed values require confirmation; assistant text is not factual evidence', async () => {
  const agent = mockAgent(() => ({ ...proposal, location: '19层', asset: 'AHU-FAKE' }));
  const result = await agent({ description: '18层空调不冷', location: '18层', priority: 'medium' }, {
    manualFields: [], messages: [{ role: 'assistant', content: 'AHU-FAKE' }, { role: 'user', content: '19层也热' }]
  });
  assert.equal(result.fields.location, '18层');
  assert.equal(result.fields.asset, '');
  assert.equal(result.conflicts[0].proposed, '19层');
});
