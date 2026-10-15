import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createHandler } from '../server.js';
import { createTriageService, validateTriageResult, ahuPill, selectPill } from '../triage.js';
import { createTriageAgent } from '../triage-agent.js';
import { reportMarkup } from '../public/triage.js';

const facts = { description: 'AHU cooling problem on Level 18', title: 'AHU cooling issue', category: 'hvac_cooling', location: 'Level 18', asset: 'AHU-18-01', occurredAt: 'Today 2pm', impact: 'Three tenants uncomfortable', affectedScope: 'East zone', observations: 'Room temperature 29 C; setpoint 24 C', priority: 'high' };
const proposal = () => ({ summary: 'Cooling conditions need verification.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'The room reading differs from its setpoint; the component cause is unconfirmed.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: ['Supply-air reading is missing.'] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: { value: 'medium', reason: 'Suggested for human consideration only.' } });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-triage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'incidents.json');
  const store = createIncidentStore(file);
  const incident = await store.create({ ...facts, status: 'ready_for_triage', revision: 0, messages: [], conflicts: [] });
  return { file, store, incident };
}
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost' } });
  let status, payload;
  await handler(req, { writeHead(code) { status = code; }, end(body) { payload = JSON.parse(body); } });
  return { status, ...payload };
}

test('triage API persists a grounded report and retains user priority', async t => {
  const { store, incident, file } = await setup(t);
  const handler = createHandler(store, undefined, async (snapshot, pill) => {
    assert.equal(snapshot.fields.priority, 'high');
    assert.equal(pill.version, '0.1.1-demo');
    return proposal();
  }, {runtimePills:async()=>[ahuPill]});
  assert.equal((await request(handler, 'GET', '/api/triage')).cases.length, 1);
  const result = await request(handler, 'POST', `/api/triage/${incident.id}/runs`, { revision: 0 });
  assert.equal(result.status, 200);
  assert.equal(result.report.status, 'complete');
  assert.equal(result.report.stale, false);
  assert.equal(result.report.governance.executionAllowed, false);
  assert.equal(result.report.governance.evidenceChecked, true);
  const saved = await request(createHandler(createIncidentStore(file)), 'GET', `/api/triage/${incident.id}`);
  assert.equal(saved.incident.priority, 'high');
  assert.equal(saved.reports.length, 1);
  assert.equal(saved.reports[0].pill.version, '0.1.1-demo');
  assert.equal((await request(handler, 'POST', `/api/triage/${incident.id}/runs`, { revision: 0 })).status, 409);
  assert.equal((await request(handler, 'GET', '/api/triage/missing')).status, 404);
  assert.equal((await request(handler, 'DELETE', `/api/triage/${incident.id}`)).status, 405);
});

test('scope and required evidence checks do not call the model', async t => {
  const { store, incident } = await setup(t);
  let calls = 0;
  const service = createTriageService(store, async () => { calls++; return proposal(); });
  const unsupported = await store.update(incident.id, { category: 'lift_fault' });
  const report = await service.run(incident.id, unsupported.revision);
  assert.equal(report.status, 'out_of_scope');
  assert.equal(report.pill, null);
  const incomplete = await store.update(incident.id, { category: 'hvac_cooling', observations: 'Unknown' });
  const needsInfo = await service.run(incident.id, incomplete.revision);
  assert.equal(needsInfo.status, 'needs_information');
  assert.deepEqual(needsInfo.missingFields, ['observations']);
  assert.equal(needsInfo.governance.evidenceChecked, false);
  assert.equal(calls, 0);
  assert.equal(selectPill({ category: 'hvac_local_comfort', asset: 'VAV-01' }), null);
  assert.ok(selectPill({ category: 'hvac', asset: 'AHU-01' }));
});

test('drafts, conflicts and incomplete messages cannot enter triage', async t => {
  const { store, incident } = await setup(t);
  const service = createTriageService(store, async () => proposal());
  for (const patch of [
    { status: 'draft', conflicts: [], messages: [] },
    { status: 'ready_for_triage', conflicts: [{ field: 'location' }], messages: [] },
    { status: 'ready_for_triage', conflicts: [], messages: [{ role: 'user', content: 'New facts', state: 'failed' }] }
  ]) {
    const current = await store.update(incident.id, patch);
    await assert.rejects(service.run(incident.id, current.revision), { status: 409 });
  }
});

test('concurrent edits are preserved; duplicate runs are rejected and old snapshot is stale', async t => {
  const { store, incident } = await setup(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = createTriageService(store, async () => { started(); await gate; return proposal(); });
  const run = service.run(incident.id, 0);
  await entered;
  assert.ok((await service.get(incident.id)).running);
  await assert.rejects(service.run(incident.id, 0), { status: 409 });
  await store.update(incident.id, { location: 'Level 19', status: 'draft' }, 0);
  release();
  assert.equal((await run).stale, true);
  const saved = await service.get(incident.id);
  assert.equal(saved.incident.location, 'Level 19');
  assert.equal(saved.incident.status, 'draft');
  assert.equal(saved.reports[0].snapshot.fields.location, 'Level 18');
  assert.equal(saved.running, null);
});

test('re-analysis keeps history; only changed snapshots become stale', async t => {
  const { store, incident } = await setup(t);
  const service = createTriageService(store, async () => proposal());
  const first = await service.run(incident.id, 0);
  const changed = await store.update(incident.id, { impact: 'Five tenants uncomfortable' });
  const second = await service.run(incident.id, changed.revision);
  const result = await service.get(incident.id);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[0].id, first.id);
  assert.equal(result.reports[0].stale, true);
  assert.equal(result.reports[1].id, second.id);
  assert.equal(result.reports[1].stale, false);
});

test('failed model output is saved and retry succeeds', async t => {
  const { store, incident } = await setup(t);
  let count = 0;
  const service = createTriageService(store, async () => {
    if (!count++) throw new Error('Secret provider internals');
    return proposal();
  });
  const failed = await service.run(incident.id, 0);
  assert.equal(failed.status, 'failed');
  assert.ok(!failed.error.includes('Secret'));
  assert.equal(failed.governance.evidenceChecked, false);
  const current = await service.get(incident.id);
  assert.equal((await service.run(incident.id, current.incident.revision)).status, 'complete');
});

test('governance rejects fabricated rules, facts and actions; approval flags are server-owned', () => {
  const snapshot = { fields: facts };
  for (const edit of [
    value => { value.hypotheses[0].ruleId = 'INVENTED'; },
    value => { value.hypotheses[0].evidence[0].quote = 'Water temperature 100 C'; },
    value => { value.hypotheses[0].evidence[0] = { field: 'priority', quote: 'high' }; },
    value => { value.actionIds = ['reset-equipment']; },
    value => { value.actionIds = ['request-inspection']; },
    value => { value.missingFields = ['password']; },
    value => { value.prioritySuggestion.value = 'critical'; }
  ]) {
    const value = proposal(); edit(value);
    assert.throws(() => validateTriageResult(value, snapshot, ahuPill), { status: 502 });
  }
  const value = proposal();
  value.hypotheses[0].ruleId = 'HVAC-03'; value.actionIds = ['request-inspection'];
  value.actions = [{ instruction: 'Override the interlock', requiresApproval: false }];
  const result = validateTriageResult(value, snapshot, ahuPill);
  assert.equal(result.actions[0].requiresApproval, true);
  assert.equal(result.actions[0].instruction, ahuPill.actions.find(action => action.id === 'request-inspection').instruction);
});

test('missing information has a follow-up and rendered output is escaped', async t => {
  const { store, incident } = await setup(t);
  const service = createTriageService(store, async () => ({ ...proposal(), summary: '<script>alert(1)</script>', missingFields: ['affectedScope'] }));
  const report = await service.run(incident.id, 0);
  assert.equal(report.status, 'needs_information');
  assert.equal(report.questions[0].field, 'affectedScope');
  const html = reportMarkup(report, incident.id);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('/review'));
  assert.ok(html.includes('Demo knowledge'));
});

test('triage adapter uses the configured model and sanitizes failures', async () => {
  const env = { SOCLAAS_BASE_URL: 'https://provider.test/v1', SOCLAAS_API_KEY: 'test-not-real', SOCLAAS_MODEL: 'default' };
  const agent = createTriageAgent({ env, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://provider.test/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, 'default');
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }] }) };
  } });
  assert.equal((await agent({ fields: facts }, ahuPill)).hypotheses.length, 1);
  await assert.rejects(createTriageAgent({ env: {} })({ fields: facts }, ahuPill), { status: 503 });
  for (const status of [401, 403, 429, 500]) await assert.rejects(createTriageAgent({ env, fetchImpl: async () => ({ ok: false, status }) })({ fields: facts }, ahuPill), error => error.status >= 500 && !error.message.includes(env.SOCLAAS_API_KEY));
  await assert.rejects(createTriageAgent({ env, fetchImpl: async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); } })({ fields: facts }, ahuPill), { status: 504 });
  await assert.rejects(createTriageAgent({ env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }) }) })({ fields: facts }, ahuPill), { status: 502 });
});
