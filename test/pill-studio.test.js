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
import { previewMarkup } from '../public/pill-preview.js';

const adminRoles = ['admin'];
const adminActor = { id: 'admin1', name: 'Admin' };

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pill-studio-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pills.json'); const studio = createPillStudio(file);
  const store = createIncidentStore(join(dir, 'incidents.json'));
  const record = await studio.get(ahuPill.id);
  const content = structuredClone(record.content);
  content.pill.scope = content.pill.scope || 'All cooling systems';
  return { file, studio, store, record, content };
}
async function publish(studio, record, content) {
  let r = await studio.change(record.id, 'save', { revision: record.revision, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  r = await studio.change(r.id, 'validate', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  r = await studio.change(r.id, 'submit', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  return studio.change(r.id, 'publish', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
}
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost' }, authenticatedActor: adminActor, authenticatedRoles: adminRoles }); let status, body;
  await handler(req, { writeHead(s) { status = s; }, end(text) { body = JSON.parse(text); } });
  return { status, ...body };
}

test('admin with name and scope can publish directly', async t => {
  const { studio, file, record, content } = await setup(t);
  const published = await publish(studio, record, content);
  assert.equal(published.state, 'published');
  assert.equal((await createPillStudio(file).active()).version, '1.0.0');
  assert.equal((await studio.library())[0].status, 'approved');
  await assert.rejects(studio.change(record.id, 'save', { revision: published.revision, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles }), { status: 409 });
  const fork = await studio.change(record.id, 'fork', { revision: published.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  content.pill.name = 'Revised AHU';
  await studio.change(record.id, 'save', { revision: fork.revision, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  assert.equal((await studio.active()).name, ahuPill.name);
});
test('validation requires name, scope and actions', async t => {
  const { record, content } = await setup(t);
  assert.equal(validateDraft({ pill: { name: '', scope: '', actions: [] } }).passed, false);
  assert.equal(validateDraft({ pill: { name: 'Test', scope: '', actions: [] } }).passed, false);
  assert.equal(validateDraft({ pill: { name: 'Test', scope: 'Scope text', actions: [] } }).passed, false);
  assert.equal(validateDraft({ pill: { name: 'Test', scope: 'Scope text', actions: [{ id: 'a1', title: 'Act', instruction: 'Do it', owner: 'Op', requiresApproval: false, ruleIds: [] }] } }).passed, true);
  assert.equal(validateDraft(record.content).passed, true);
  assert.equal(validateDraft(content).passed, true);
});
test('non-admin cannot submit or publish', async t => {
  const { studio, record, content } = await setup(t);
  let r = await studio.change(record.id, 'save', { revision: 0, content, authenticatedActor: { id: 'e1', name: 'Expert' }, authenticatedRoles: ['expert'] });
  await assert.rejects(studio.change(r.id, 'submit', { revision: r.revision, authenticatedActor: { id: 'e1', name: 'Expert' }, authenticatedRoles: ['expert'] }), { status: 403 });
  await assert.rejects(studio.change(r.id, 'publish', { revision: r.revision, authenticatedActor: { id: 'e1', name: 'Expert' }, authenticatedRoles: ['expert'] }), { status: 403 });
});
test('admin without scope cannot publish', async t => {
  const { studio, record, content } = await setup(t);
  content.pill.scope = '';
  let r = await studio.change(record.id, 'save', { revision: 0, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  await assert.rejects(studio.change(r.id, 'publish', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles }), { status: 422 });
});
test('concurrent publish creates only one release', async t => {
  const { studio, record, content } = await setup(t);
  let r = await studio.change(record.id, 'save', { revision: 0, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  r = await studio.change(r.id, 'validate', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  r = await studio.change(r.id, 'submit', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  const body = { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles };
  const results = await Promise.allSettled([studio.change(r.id, 'publish', body), studio.change(r.id, 'publish', body)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});
test('create only requires name; owner comes from authenticated actor', async t => {
  const { store, studio } = await setup(t); const handler = createHandler(store, undefined, undefined, studio);
  const created = await request(handler, 'POST', '/api/studio', { name: 'New Pill' });
  assert.equal(created.status, 201);
  assert.equal(created.record.content.pill.name, 'New Pill');
  assert.equal(created.record.content.pill.owner, 'Admin');
});
test('Studio API rejects malformed content', async t => {
  const { store, studio } = await setup(t); const handler = createHandler(store, undefined, undefined, studio);
  const created = await request(handler, 'POST', '/api/studio', { name: 'New' });
  const id = created.record.id;
  assert.equal((await request(handler, 'POST', `/api/studio/${id}/save`, { revision: 0, content: null })).status, 422);
});
test('new Triage uses published Pill', async t => {
  const { studio, store, record, content } = await setup(t);
  const incident = await store.create({ title: 'Warm', description: 'AHU issue', category: 'hvac_cooling', asset: 'AHU-01', location: 'Floor 1', occurredAt: 'Today', impact: 'Warm office', observations: 'Temperature 29 C', priority: 'high', status: 'ready_for_triage', revision: 0 });
  const agent = async () => ({ summary: 'Check readings.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check.', evidence: [{ field: 'observations', quote: 'Temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
  const handler = createHandler(store, undefined, agent, studio);
  const old = await request(handler, 'POST', `/api/triage/${incident.id}/runs`, { revision: 0 });
  await publish(studio, record, content);
  const current = await request(handler, 'POST', `/api/triage/${incident.id}/runs`, { revision: 1 });
  assert.equal(current.report.pill.version, '1.0.0');
});
test('editor renders captured knowledge safely', async t => {
  const { record, content } = await setup(t);
  content.pill.scope = '<script>alert(1)</script>';
  record.content = content;
  const html = previewMarkup(record);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
});
