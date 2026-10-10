import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPillStudio, validateDraft } from '../pill-studio.js';
import { createIncidentStore } from '../incident-store.js';
import { ahuPill } from '../triage.js';
import { createHandler } from '../server.js';
import { editorMarkup } from '../public/studio.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pill-studio-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pills.json'); const studio = createPillStudio(file);
  const store = createIncidentStore(join(dir, 'incidents.json'));
  const record = await studio.get(ahuPill.id);
  const content = structuredClone(record.content);
  content.sources = [{ expert: 'Test engineer', reference: 'Synthetic interview fixture', knowledge: 'Verify readings and avoid inferring actual valve position from a command.' }];
  content.examples = [{ scenario: 'Room is warm; temperature 29 C.', rationale: 'Verify readings first.', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  return { file, studio, store, record, content };
}
async function publish(studio, record, content) {
  let r = await studio.change(record.id, 'save', { revision: record.revision, content });
  r = await studio.change(r.id, 'validate', { revision: r.revision });
  assert.equal(r.validation.passed, true);
  r = await studio.change(r.id, 'submit', { revision: r.revision });
  return studio.change(r.id, 'publish', { revision: r.revision, reviewer: 'Reviewer', notes: 'Reviewed synthetic examples.', expertConfirmed: true });
}
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost' } }); let status, body;
  await handler(req, { writeHead(s) { status = s; }, end(text) { body = JSON.parse(text); } });
  return { status, ...body };
}

test('expert capture, validation, review, publish and persistence keep a frozen release', async t => {
  const { studio, file, record, content } = await setup(t);
  const published = await publish(studio, record, content);
  assert.equal(published.state, 'published');
  assert.equal((await createPillStudio(file).active()).version, '1.0.0');
  assert.equal((await studio.library())[0].status, 'approved');
  assert.equal(published.releases[0].sources[0].expert, 'Test engineer');
  await assert.rejects(studio.change(record.id, 'save', { revision: published.revision, content }), { status: 409 });
  const fork = await studio.change(record.id, 'fork', { revision: published.revision });
  content.pill.name = 'Revised AHU';
  await studio.change(record.id, 'save', { revision: fork.revision, content });
  assert.equal((await studio.active()).name, ahuPill.name);
});
test('structural validation detects missing sources, invalid references and inconsistent examples', async t => {
  const { record, content } = await setup(t);
  assert.equal(validateDraft(record.content).passed, false);
  for (const edit of [c => c.sources = [], c => c.pill.rules[0].actionIds = ['missing'], c => c.pill.actions[0].ruleIds = ['HVAC-02'], c => c.examples[0].actionIds = ['missing'], c => c.pill.actions[0].requiresApproval = 'false', c => c.pill.domain = 'lift', c => c.pill.rules.push(c.pill.rules[0])]) {
    const c = structuredClone(content); edit(c); assert.equal(validateDraft(c).passed, false);
  }
});
test('editing invalidates validation; review and publication cannot be bypassed', async t => {
  const { studio, record, content } = await setup(t);
  let r = await studio.change(record.id, 'save', { revision: 0, content });
  await assert.rejects(studio.change(r.id, 'publish', { revision: r.revision, expertConfirmed: true, reviewer: 'A', notes: 'B' }), { status: 422 });
  r = await studio.change(r.id, 'validate', { revision: r.revision });
  r = await studio.change(r.id, 'save', { revision: r.revision, content });
  assert.equal(r.validation, null);
  await assert.rejects(studio.change(r.id, 'submit', { revision: r.revision }), { status: 422 });
  r = await studio.change(r.id, 'validate', { revision: r.revision });
  r = await studio.change(r.id, 'submit', { revision: r.revision });
  await assert.rejects(studio.change(r.id, 'publish', { revision: r.revision, expertConfirmed: 'true', reviewer: 'A', notes: 'B' }), { status: 422 });
  r = await studio.change(r.id, 'return', { revision: r.revision, reviewer: 'A', notes: 'Clarify applicability.' });
  assert.equal(r.state, 'draft'); assert.equal(r.events.at(-1).notes, 'Clarify applicability.');
});
test('concurrent publish creates only one release; next publication switches active version', async t => {
  const { studio, record, content } = await setup(t);
  let r = await studio.change(record.id, 'save', { revision: 0, content });
  r = await studio.change(r.id, 'validate', { revision: r.revision });
  r = await studio.change(r.id, 'submit', { revision: r.revision });
  const body = { revision: r.revision, reviewer: 'A', notes: 'Reviewed.', expertConfirmed: true };
  const results = await Promise.allSettled([studio.change(r.id, 'publish', body), studio.change(r.id, 'publish', body)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  r = await studio.get(r.id); r = await studio.change(r.id, 'fork', { revision: r.revision });
  await publish(studio, r, content);
  const releases = await studio.library(); assert.equal(releases.length, 2);
  assert.deepEqual(releases.filter(r => r.active).map(r => r.version), ['2.0.0']);
});
test('Studio API rejects malformed content and client-supplied publication metadata', async t => {
  const { studio, store, content } = await setup(t); const handler = createHandler(store, undefined, undefined, studio);
  const created = await request(handler, 'POST', '/api/studio', { name: 'New AHU', owner: 'Author' });
  assert.equal(created.status, 201);
  const id = created.record.id;
  assert.equal((await request(handler, 'POST', `/api/studio/${id}/save`, { revision: 0, content: { pill: {} } })).status, 422);
  const forged = structuredClone(content); Object.assign(forged.pill, { status: 'approved', version: '99.0.0', id: 'forged' });
  const saved = await request(handler, 'POST', `/api/studio/${id}/save`, { revision: 0, content: forged });
  assert.equal(saved.status, 200); assert.equal(saved.record.content.pill.id, id);
  assert.equal(saved.record.content.pill.status, undefined); assert.equal(saved.record.content.pill.version, undefined);
  assert.equal((await request(handler, 'GET', '/api/library')).pills.length, 0);
});
test('new Triage uses published Pill; old report retains its snapshot and cannot approve against a new version', async t => {
  const { studio, store, record, content } = await setup(t);
  const incident = await store.create({ title: 'Warm', description: 'AHU issue', category: 'hvac_cooling', asset: 'AHU-01', location: 'Floor 1', occurredAt: 'Today', impact: 'Warm office', observations: 'Temperature 29 C', priority: 'high', status: 'ready_for_triage', revision: 0 });
  const agent = async () => ({ summary: 'Check readings.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check.', evidence: [{ field: 'observations', quote: 'Temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
  const handler = createHandler(store, undefined, agent, studio);
  const old = await request(handler, 'POST', `/api/triage/${incident.id}/runs`, { revision: 0 });
  await publish(studio, record, content);
  const review = await request(handler, 'GET', `/api/review/${incident.id}`);
  assert.equal(review.package.canApprove, false);
  assert.ok(review.package.findings.some(f => f.code === 'pill_version'));
  const current = await request(handler, 'POST', `/api/triage/${incident.id}/runs`, { revision: 1 });
  assert.equal(current.report.pill.version, '1.0.0'); assert.equal(current.report.governance.demoOnly, false);
  assert.equal((await store.list())[0].triageReports[0].pill.version, old.report.pill.version);
  assert.equal((await request(handler, 'GET', `/api/review/${incident.id}`)).package.canApprove, true);
});
test('editor renders captured knowledge safely and preserves review/version controls', async t => {
  const { record, content } = await setup(t);
  content.sources[0].knowledge = '<script>alert(1)</script>'; record.content = content;
  const html = editorMarkup(record);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Validate saved draft')); assert.ok(!html.includes('Approve and publish'));
});
