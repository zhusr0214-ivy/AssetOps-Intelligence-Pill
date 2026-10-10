import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createPillStudio } from '../pill-studio.js';
import { createLearningService, learningSnapshot } from '../learning.js';
import { createLearningAgent, validateLearning } from '../learning-agent.js';
import { ahuPill, caseFingerprint, createTriageService } from '../triage.js';
import { createHandler } from '../server.js';

const action = { kind: 'action', author: 'Expert', occurredAt: '2026-01-01T10:00:00Z', notes: 'Measured independent sensor.', rationale: 'Compare field evidence.', deviation: 'No approved plan.' };
const outcome = { kind: 'outcome', author: 'Expert', occurredAt: '2026-01-01T11:00:00Z', notes: 'Mismatch persisted.', status: 'unresolved', verified: true, verification: 'Independent readings compared.', remaining: 'Specialist investigation required.' };
const review = { decision: 'accepted', reviewer: 'Reviewer', confirmed: true, notes: 'Checked limits and evidence.', reviewedAfter: 'Add an evidence comparison condition; specialist verification required.' };
const proposal = snapshot => ({ summary: 'Candidate experience; not a validated diagnosis.', questions: [], proposals: [{ title: 'Comparison evidence', cause: 'pill_gap', disposition: snapshot.pill ? 'update_pill' : 'new_pill', reason: 'Case identified a gap.', before: 'No applicable comparison condition.', after: 'Add a condition pending expert validation.', applicability: 'Only independently verified sensor mismatch.', limitations: 'One case; no general diagnosis.', validationCases: ['Matching independent readings: do not select mismatch rule.', 'Conflicting verified readings: refer for investigation.'], evidence: [{ blockId: snapshot.currentActionId, quote: 'Measured independent sensor.' }, { blockId: snapshot.currentOutcomeId, quote: 'Mismatch persisted.' }] }] });
async function setup(t, agent = async s => proposal(s)) {
  const dir = await mkdtemp(join(tmpdir(), 'learning-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'cases.json'), pillFile = join(dir, 'pills.json');
  const store = createIncidentStore(file), studio = createPillStudio(pillFile), service = createLearningService(store, studio, agent);
  let incident = await store.create({ title: 'AHU mismatch', description: 'Room temperature discrepancy', category: 'hvac_cooling', asset: 'AHU-01', location: 'L1', occurredAt: 'today', observations: 'Room temperature 29 C', impact: 'Office warm', priority: 'high', status: 'ready_for_triage', revision: 0 });
  incident = await store.update(incident.id, { triageReports: [{ id: 'TRI-1', status: 'complete', pill: structuredClone(ahuPill), caseFingerprint: caseFingerprint(incident), actions: [] }] }, 0);
  const recorded = async () => { let i = (await service.get(incident.id)).incident; i = await service.record(i.id, { ...action, revision: i.revision }); return service.record(i.id, { ...outcome, revision: i.revision }); };
  const analyzed = async () => { const i = await recorded(); return service.analyze(i.id, { revision: i.revision }); };
  const accepted = async () => { const run = await analyzed(); const i = (await service.get(incident.id)).incident; await service.decide(i.id, run.id, run.proposals[0].id, { ...review, revision: i.revision }); return run; };
  return { store, studio, service, incident, recorded, analyzed, accepted, file, pillFile };
}
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]); Object.assign(req, { method, url, headers: { host: 'localhost' } }); let status, body;
  await handler(req, { writeHead(s) { status = s; }, end(text) { body = JSON.parse(text); } }); return { status, ...body };
}

test('operational records append, preserve case priority and report fingerprint, persist corrections', async t => {
  const { service, incident, recorded, file } = await setup(t); const before = caseFingerprint(incident);
  let i = await recorded(); assert.equal(i.priority, 'high'); assert.equal(i.status, 'ready_for_triage'); assert.equal(caseFingerprint(i), before);
  const old = structuredClone(i.handlingRecords[0]);
  i = await service.record(i.id, { ...action, notes: 'Corrected sensor identifier.', corrects: old.id, revision: i.revision });
  assert.deepEqual(i.handlingRecords[0], old); assert.equal(i.handlingStatus, 'in_progress'); assert.equal(learningSnapshot(i).verifiedOutcome, false);
  assert.equal((await createIncidentStore(file).list())[0].handlingRecords.length, 3);
});
test('records reject stale revisions, invalid corrections, future dates and unverified resolution', async t => {
  const { service, incident } = await setup(t);
  for (const extra of [{ revision: 0 }, { corrects: 'unknown' }, { occurredAt: '2999-01-01' }, { kind: 'outcome', status: 'resolved', verified: false, verification: 'None', remaining: 'Unknown' }]) {
    await assert.rejects(service.record(incident.id, { ...action, revision: incident.revision, ...extra }));
  }
  const i = await service.record(incident.id, { ...action, revision: incident.revision });
  await assert.rejects(service.record(i.id, { ...outcome, occurredAt: '2026-01-01T09:00:00Z', revision: i.revision }), { status: 422 });
  await assert.rejects(service.record(i.id, { ...outcome, status: 'pending_verification', revision: i.revision }), { status: 422 });
});
test('learning saves immutable input/model metadata and validates quotes and outcomes', async t => {
  const { service, incident, analyzed } = await setup(t); const run = await analyzed();
  assert.equal(run.snapshot.verifiedOutcome, true); assert.equal(run.snapshot.pill.version, ahuPill.version); assert.ok(run.promptVersion);
  assert.equal(run.proposals[0].decision, null);
  for (const edit of [s => s.verifiedOutcome = false, s => s.blocks.find(b => b.id === s.currentActionId).superseded = true]) {
    const snapshot = structuredClone(run.snapshot); edit(snapshot); assert.throws(() => validateLearning(proposal(snapshot), snapshot));
  }
  const bad = proposal(run.snapshot); bad.proposals[0].evidence[0].quote = 'Fabricated fact'; assert.throws(() => validateLearning(bad, run.snapshot));
  const wrong = proposal(run.snapshot); wrong.proposals[0].cause = 'agent_error'; assert.throws(() => validateLearning(wrong, run.snapshot));
  let i = (await service.get(incident.id)).incident; i = await service.record(i.id, { ...action, revision: i.revision });
  assert.deepEqual(i.learningRuns[0].snapshot, run.snapshot);
});
test('insufficient evidence allows questions but cannot create knowledge proposals', async t => {
  const { service, incident } = await setup(t, async () => ({ summary: 'Need actual outcome.', questions: ['What was verified?'], proposals: [] }));
  const i = await service.record(incident.id, { ...action, revision: incident.revision });
  const run = await service.analyze(i.id, { revision: i.revision }); assert.equal(run.proposals.length, 0); assert.equal(run.snapshot.verifiedOutcome, false);
});
test('concurrent analysis and case edits cannot overwrite operational evidence', async t => {
  let finish, entered;
  const started = new Promise(resolve => entered = resolve);
  const { service, incident, recorded } = await setup(t, snapshot => new Promise(resolve => { finish = () => resolve(proposal(snapshot)); entered(); }));
  const i = await recorded(); const pending = service.analyze(i.id, { revision: i.revision }); await started;
  await assert.rejects(service.analyze(i.id, { revision: i.revision }), { status: 409 });
  await service.record(i.id, { ...action, revision: i.revision }); finish(); await assert.rejects(pending, { status: 409 });
  const data = await service.get(incident.id); assert.equal(data.running, false); assert.equal(data.incident.handlingRecords.length, 3); assert.equal(data.incident.learningRuns, undefined);
});
test('proposal review requires confirmation, is immutable, and rejected proposals cannot import', async t => {
  const { service, incident, analyzed } = await setup(t); const run = await analyzed(), id = run.proposals[0].id;
  const i = (await service.get(incident.id)).incident;
  await assert.rejects(service.decide(i.id, run.id, id, { ...review, confirmed: false, revision: i.revision }), { status: 422 });
  await service.decide(i.id, run.id, id, { ...review, decision: 'rejected', revision: i.revision });
  await assert.rejects(service.decide(i.id, run.id, id, { ...review, revision: i.revision + 1 }), { status: 409 });
  await assert.rejects(service.apply(i.id, run.id, id, { revision: 0 }), { status: 422 });
});
test('accepted proposal imports idempotently without changing operational rules or publishing', async t => {
  const { service, studio, incident, accepted, pillFile } = await setup(t); const run = await accepted(), id = run.proposals[0].id;
  const before = await studio.get(ahuPill.id);
  let r = await service.apply(incident.id, run.id, id, { revision: before.revision });
  assert.deepEqual(r.content.pill.rules, before.content.pill.rules); assert.equal(r.releases.length, 0); assert.equal(r.learningImports[0].status, 'pending_incorporation');
  assert.equal(r.content.sources[0].expert, 'Reviewer');
  r = await service.apply(incident.id, run.id, id, { revision: 0 }); assert.equal(r.content.sources.length, 1);
  assert.equal((await createPillStudio(pillFile).get(r.id)).learningImports[0].proposalId, id);
  const runs = await service.list(); assert.equal(runs[0].proposals[0].imported.pillId, r.id);
});
test('imported knowledge cannot publish until incorporated, validated and explicitly approved', async t => {
  const { service, studio, incident, accepted } = await setup(t); const run = await accepted();
  let r = await service.apply(incident.id, run.id, run.proposals[0].id, { revision: 0 });
  const content = structuredClone(r.content); content.examples = [{ scenario: 'Independent readings mismatch.', rationale: 'Compare before diagnosis.', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  r = await studio.change(r.id, 'save', { revision: r.revision, content });
  r = await studio.change(r.id, 'validate', { revision: r.revision }); assert.equal(r.validation.passed, true);
  r = await studio.change(r.id, 'submit', { revision: r.revision });
  await assert.rejects(studio.change(r.id, 'publish', { revision: r.revision, reviewer: 'Expert', notes: 'Reviewed', expertConfirmed: true }), { status: 422 });
  r = await studio.change(r.id, 'incorporate-learning', { revision: r.revision, proposalId: run.proposals[0].id, reviewer: 'Expert', notes: 'HVAC-01 comparison and example reviewed.', expertConfirmed: true });
  r = await studio.change(r.id, 'save', { revision: r.revision, content: r.content });
  assert.equal(r.learningImports[0].status, 'pending_incorporation');
  r = await studio.change(r.id, 'incorporate-learning', { revision: r.revision, proposalId: run.proposals[0].id, reviewer: 'Expert', notes: 'Rechecked saved content and example.', expertConfirmed: true });
  r = await studio.change(r.id, 'validate', { revision: r.revision }); r = await studio.change(r.id, 'submit', { revision: r.revision });
  r = await studio.change(r.id, 'publish', { revision: r.revision, reviewer: 'Expert', notes: 'Reviewed', expertConfirmed: true });
  assert.equal(r.releases[0].learningImports[0].releasedVersion, '1.0.0'); assert.equal((await studio.active()).version, '1.0.0');
});
test('outdated original Pill version cannot be imported into a newer release', async t => {
  const { service, studio, incident, accepted } = await setup(t); const run = await accepted();
  let r = await studio.get(ahuPill.id); const content = structuredClone(r.content);
  content.sources = [{ expert: 'A', reference: 'Fixture', knowledge: 'Verify readings.' }]; content.examples = [{ scenario: 'Room warm', rationale: 'Verify readings.', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  r = await studio.change(r.id, 'save', { revision: r.revision, content }); r = await studio.change(r.id, 'validate', { revision: r.revision }); r = await studio.change(r.id, 'submit', { revision: r.revision }); r = await studio.change(r.id, 'publish', { revision: r.revision, reviewer: 'Expert', notes: 'Reviewed', expertConfirmed: true });
  r = await studio.change(r.id, 'fork', { revision: r.revision });
  await assert.rejects(service.apply(incident.id, run.id, run.proposals[0].id, { revision: r.revision }), { status: 409 });
});
test('manual cases without a Pill can learn; non-AHU knowledge stays a proposal', async t => {
  const { store, service, incident, accepted } = await setup(t);
  await store.update(incident.id, { category: 'lift', asset: 'Lift A', triageReports: [] }, incident.revision);
  const run = await accepted(); assert.equal(run.proposals[0].disposition, 'new_pill');
  await assert.rejects(service.apply(incident.id, run.id, run.proposals[0].id, { name: 'Lift', owner: 'Expert' }), { status: 422 });
});
test('new AHU knowledge creates a separate draft with no active release', async t => {
  const { store, service, studio, incident, accepted } = await setup(t);
  await store.update(incident.id, { triageReports: [] }, incident.revision); const run = await accepted();
  const r = await service.apply(incident.id, run.id, run.proposals[0].id, { name: 'New knowledge', owner: 'Expert' });
  assert.notEqual(r.id, ahuPill.id); assert.equal(r.state, 'draft'); assert.equal(r.content.pill.rules.length, 0); assert.equal((await studio.library()).length, 0);
});
test('learning adapter uses configured endpoint, refuses invalid transport and sanitizes failures', async t => {
  const { recorded } = await setup(t); const snapshot = learningSnapshot(await recorded()); let requestBody;
  const env = { SOCLAAS_BASE_URL: 'https://provider.example/v1', SOCLAAS_API_KEY: 'test-only', SOCLAAS_MODEL: 'test-model' };
  const agent = createLearningAgent({ env, fetchImpl: async (url, options) => { assert.equal(url.href, 'https://provider.example/v1/chat/completions'); requestBody = JSON.parse(options.body); assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(proposal(snapshot)) } }] }) }; } });
  assert.equal((await agent(snapshot)).proposals.length, 1); assert.equal(requestBody.model, 'test-model');
  await assert.rejects(createLearningAgent({ env: {} })(snapshot), { status: 503 });
  await assert.rejects(createLearningAgent({ env: { ...env, SOCLAAS_BASE_URL: 'http://unsafe.example' } })(snapshot), { status: 502 });
  await assert.rejects(createLearningAgent({ env, fetchImpl: async () => { throw new Error('secret-provider-body'); } })(snapshot), error => !error.message.includes('secret-provider-body'));
});
test('API supports records, learning, review and import with revision checks', async t => {
  const { store, studio, incident } = await setup(t); const handler = createHandler(store, undefined, undefined, studio, async s => proposal(s));
  let res = await request(handler, 'GET', `/api/cases/${incident.id}/handling`); assert.equal(res.status, 200);
  res = await request(handler, 'POST', `/api/cases/${incident.id}/handling`, { ...action, revision: res.incident.revision }); assert.equal(res.status, 201);
  res = await request(handler, 'POST', `/api/cases/${incident.id}/handling`, { ...outcome, revision: res.incident.revision }); assert.equal(res.status, 201);
  res = await request(handler, 'POST', `/api/cases/${incident.id}/learning`, { revision: res.incident.revision }); assert.equal(res.status, 201);
  const run = res.run, i = (await store.list())[0];
  const endpoint = `/api/learning/${i.id}/${run.id}/${run.proposals[0].id}`;
  assert.equal((await request(handler, 'POST', `${endpoint}/review`, { ...review, revision: i.revision })).status, 200);
  assert.equal((await request(handler, 'POST', `${endpoint}/apply`, { revision: 0 })).status, 200);
  assert.equal((await request(handler, 'GET', '/api/learning')).runs.length, 1);
  assert.equal((await request(handler, 'POST', `/api/cases/${i.id}/handling`, { ...action, revision: 0 })).status, 409);
});
test('adequate case with no matched rule is a knowledge gap, not a fabricated missing field', async t => {
  const { store, incident } = await setup(t);
  const triage = createTriageService(store, async () => ({ summary: 'No applicable rule.', hypotheses: [], actionIds: [], missingFields: [], prioritySuggestion: null }));
  const report = await triage.run(incident.id, incident.revision);
  assert.equal(report.status, 'knowledge_gap'); assert.equal(report.coverage.status, 'no_matching_rule'); assert.deepEqual(report.questions, []); assert.equal(report.coverage.expertHandlingRequired, true);
});
