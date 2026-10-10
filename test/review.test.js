import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createTriageService } from '../triage.js';
import { createReviewService, governancePackage } from '../review.js';
import { createHandler } from '../server.js';
import { reviewMarkup } from '../public/review.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'incidents.json'); const store = createIncidentStore(file);
  const incident = await store.create({ title: 'Warm office', description: 'AHU cooling issue', category: 'hvac_cooling', location: 'Floor 1', asset: 'AHU-01', occurredAt: 'Today', impact: 'Warm office', affectedScope: 'Office', observations: 'Room temperature 29 C', priority: 'high', status: 'ready_for_triage', revision: 0 });
  const triage = createTriageService(store, async () => ({ summary: 'Verify reported conditions.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check readings.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: ['Cause unconfirmed.'] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null }));
  const report = await triage.run(incident.id, 0); const service = createReviewService(store);
  const payload = { revision: 1, reportId: report.id, reviewer: 'Test reviewer', decision: 'approve', assessment: 'accepted', factsVerified: true, notes: 'Readings verified; cause still unconfirmed.', owner: 'Operations', actions: [{ id: 'check-readings', choice: 'accept' }] };
  return { store, file, id: incident.id, report, triage, service, payload };
}
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost' } });
  let status, result;
  await handler(req, { writeHead(s) { status = s; }, end(body) { result = JSON.parse(body); } });
  return { status, ...result };
}

test('review API persists advisory approval, governance snapshot and learning candidate', async t => {
  const { store, file, id, payload } = await setup(t); const handler = createHandler(store);
  assert.equal((await request(handler, 'GET', '/api/review')).cases.length, 1);
  const response = await request(handler, 'POST', `/api/review/${id}`, payload);
  assert.equal(response.status, 201); assert.equal(response.review.executionAllowed, false);
  assert.equal(response.review.identityVerified, false);
  const saved = await createReviewService(createIncidentStore(file)).get(id);
  assert.equal(saved.state, 'approve'); assert.equal(saved.incident.priority, 'high');
  assert.equal(saved.incident.reviews.length, 1);
  assert.equal((await request(handler, 'GET', '/api/learning')).candidates[0].status, 'pending_validation');
});
test('concurrent and duplicate reviews cannot overwrite decisions', async t => {
  const { id, service, payload } = await setup(t);
  const results = await Promise.allSettled([service.submit(id, payload), service.submit(id, payload)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const current = await service.get(id);
  await assert.rejects(service.submit(id, { ...payload, revision: current.incident.revision }), { status: 409 });
});
test('changed facts and newer report invalidate pending approval', async t => {
  const { id, store, service, payload, triage } = await setup(t);
  const changed = await store.update(id, { observations: 'Room temperature 30 C' }, 1);
  await assert.rejects(service.submit(id, { ...payload, revision: changed.revision }), { status: 409 });
  await store.update(id, { observations: 'Room temperature 29 C' });
  const current = await service.get(id); await triage.run(id, current.incident.revision);
  await assert.rejects(service.submit(id, { ...payload, revision: (await service.get(id)).incident.revision }), { status: 409 });
});
test('request information returns case to intake; new analysis allows another review', async t => {
  const { id, store, service, payload, triage } = await setup(t);
  await service.submit(id, { ...payload, decision: 'request_information', questions: 'Confirm supply-air reading.' });
  const current = await service.get(id);
  assert.equal(current.incident.status, 'needs_info'); assert.equal(current.state, 'request_information');
  const revised = await store.update(id, { status: 'ready_for_triage', affectedScope: 'Office east' }, current.incident.revision);
  await triage.run(id, revised.revision);
  assert.equal((await service.get(id)).state, 'pending');
});
test('boundary, evidence, scope and Pill changes block approval', async t => {
  const { service, id } = await setup(t); const { incident, report } = await service.get(id);
  for (const edit of [r => { r.pill.version = 'old'; }, r => { r.actions[0].instruction = 'Reset equipment'; }, r => { r.hypotheses[0].evidence[0].quote = 'Invented'; }, r => { r.pill = null; }, r => { r.missingFields = ['asset']; }]) {
    const copy = structuredClone(report); edit(copy); assert.equal(governancePackage(incident, copy).canApprove, false);
  }
});
test('unsupported analysis, unverified facts, malformed actions and missing rationale are rejected', async t => {
  const { id, service, payload } = await setup(t);
  for (const patch of [{ assessment: 'unsupported' }, { factsVerified: false }, { factsVerified: 'true' }, { actions: [] }, { actions: [null] }, { notes: '' }, { owner: '' }, { actions: [{ id: 'reset', choice: 'accept' }] }, { decision: 'request_information', questions: '' }, { proposals: 'Reset equipment' }]) await assert.rejects(service.submit(id, { ...payload, ...patch }), { status: 422 });
});
test('new action proposals stay pending validation and are not approved actions', async t => {
  const { id, service, payload } = await setup(t);
  const saved = await service.submit(id, { ...payload, decision: 'approve_with_changes', proposals: 'Investigate another possible cause.' });
  assert.equal(saved.proposalStatus, 'pending_expert_validation'); assert.equal(saved.actions.length, 1);
});
test('review markup escapes case, governance and historical feedback', async t => {
  const { id, service, payload } = await setup(t);
  await service.submit(id, { ...payload, notes: '<script>bad()</script>' });
  const markup = reviewMarkup(await service.get(id));
  assert.ok(!markup.includes('<script>')); assert.ok(markup.includes('&lt;script&gt;'));
});

test('approved review becomes historical when intake reopens without field changes', async t => {
  const { id, service, store, payload } = await setup(t);
  await service.submit(id, payload);
  await store.update(id, { status: 'draft' });
  assert.equal((await service.get(id)).state, 'outdated');
});
