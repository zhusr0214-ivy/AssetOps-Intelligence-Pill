import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { analyzeIntake } from '../intake.js';
import { createIncidentStore } from '../incident-store.js';
import { createHandler } from '../server.js';

test('extract explicit facts without inventing asset, impact or priority', () => {
  const result = analyzeIntake({ description: '今天下午2点左右18层东区空调不制冷，室温29℃。' });
  assert.equal(result.fields.location, '18层东区');
  assert.equal(result.fields.category, 'hvac');
  assert.equal(result.fields.observations, '29℃');
  assert.equal(result.fields.priority, '');
  assert.equal(result.fields.asset, '');
  assert.equal(result.fields.impact, '');
  assert.ok(result.missingFields.includes('priority'));
  assert.ok(result.followUpQuestions.length <= 3);
});

test('manual values and explicit unknown answers are preserved', () => {
  const result = analyzeIntake({ description: 'Urgent HVAC issue at floor 18, AHU-18-01', location: 'Tower B', asset: 'Unknown', category: 'other', priority: 'low', occurredAt: 'Unknown', impact: '不清楚' });
  assert.equal(result.fields.priority, 'low');
  assert.equal(result.fields.asset, 'Unknown');
  assert.equal(result.fields.category, 'other');
  assert.equal(result.fields.location, 'Tower B');
  assert.equal(result.readyForTriage, true);
});

test('invalid types and enum values are rejected', () => {
  for (const input of [null, [], { priority: 'critical' }, { description: {} }, { category: 'invented' }]) assert.throws(() => analyzeIntake(input), { status: 400 });
});

// Exercise HTTP handlers without binding a port or starting a preview.
async function request(handler, method, url, data, raw = false) {
  const req = Readable.from(data === undefined ? [] : [raw ? data : JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost' } });
  let status;
  let payload;
  const res = { writeHead(code) { status = code; }, end(body) { payload = JSON.parse(body); } };
  await handler(req, res);
  return { status, ...payload };
}

test('API lifecycle, persistence and errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'incidents.json');
  const handler = createHandler(createIncidentStore(file), analyzeIntake);
  assert.deepEqual((await request(handler, 'GET', '/api/incidents')).incidents, []);
  const draft = await request(handler, 'POST', '/api/incidents', { description: 'HVAC overheating', priority: 'high', status: 'ready_for_triage' });
  assert.equal(draft.status, 201);
  assert.equal(draft.incident.status, 'draft');
  const id = draft.incident.id;
  const incomplete = await request(handler, 'POST', `/api/incidents/${id}/finalize`, {});
  assert.equal(incomplete.status, 422);
  assert.ok(incomplete.missingFields.includes('location'));
  const updated = await request(handler, 'PATCH', `/api/incidents/${id}`, { location: 'Tower A', priority: 'urgent' });
  assert.equal(updated.incident.status, 'needs_info');
  assert.equal(updated.incident.priority, 'urgent');
  const analysis = await request(handler, 'POST', '/api/intake/analyze', { ...updated.incident, occurredAt: 'Unknown', impact: 'Unknown' });
  assert.equal(analysis.readyForTriage, true);
  const submitted = await request(handler, 'POST', `/api/incidents/${id}/finalize`, analysis.fields);
  assert.equal(submitted.incident.status, 'ready_for_triage');
  assert.equal(submitted.incident.priority, 'urgent');
  const restarted = createHandler(createIncidentStore(file), analyzeIntake);
  assert.equal((await request(restarted, 'GET', `/api/incidents/${id}`)).incident.priority, 'urgent');
  assert.equal((await request(restarted, 'GET', '/api/incidents')).incidents.length, 1);
  assert.equal((await request(handler, 'POST', '/api/intake/analyze', '{', true)).status, 400);
  assert.equal((await request(handler, 'POST', '/api/incidents', {})).status, 422);
  assert.equal((await request(handler, 'POST', '/api/intake/analyze', 'x'.repeat(100001), true)).status, 413);
  assert.equal((await request(handler, 'GET', '/api/incidents/missing')).status, 404);
  assert.equal((await request(handler, 'DELETE', `/api/incidents/${id}`)).status, 405);
  assert.equal((await request(handler, 'GET', '/api/unknown')).status, 404);
});

test('parallel creates are serialized and persisted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createIncidentStore(join(dir, 'incidents.json'));
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.create({ title: `Incident ${index}` })));
  const incidents = await store.list();
  assert.equal(incidents.length, 10);
  assert.equal(new Set(incidents.map(item => item.id)).size, 10);
});
