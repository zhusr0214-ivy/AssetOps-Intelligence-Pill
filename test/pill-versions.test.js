import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPillStudio } from '../pill-studio.js';
import { ahuPill, createTriageService } from '../triage.js';
import { createIncidentStore } from '../incident-store.js';
import { createReviewService } from '../review.js';
import { compareReleases, releaseHash } from '../pill-versions.js';
import { createHandler } from '../server.js';

const adminRoles = ['admin'], adminActor = { id: 'admin1', name: 'Admin' };
async function publish(studio, id, modify = () => {}) {
  let r = await studio.get(id);
  if (r.state === 'published') r = await studio.change(id, 'fork', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  const content = structuredClone(r.content);
  content.sources = [{ expert: 'Fixture expert', reference: 'Synthetic source', knowledge: 'Verify readings before making a diagnosis.' }];
  content.examples = [{ scenario: 'Room temperature discrepancy.', rationale: 'Check readings first.', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  modify(content);
  r = await studio.change(id, 'save', { revision: r.revision, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  r = await studio.change(id, 'validate', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles }); assert.equal(r.validation.passed, true);
  r = await studio.change(id, 'submit', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  return studio.change(id, 'publish', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'versions-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pills.json'), studio = createPillStudio(file), store = createIncidentStore(join(dir, 'cases.json'));
  await publish(studio, ahuPill.id); await publish(studio, ahuPill.id, c => { c.pill.rules[0].guidance = 'Revised comparison guidance.'; c.pill.boundaries.push('Additional synthetic boundary.'); });
  const body = async () => { const h = await studio.versionHistory(ahuPill.id); return { revision: h.revision, libraryToken: h.libraryToken, reviewer: 'Operator', notes: 'Verified rollback target.', confirmed: true }; };
  return { file, studio, store, body };
}
async function request(handler, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]); Object.assign(req, { method, url, headers: { host: 'localhost' } }); let status, body;
  await handler(req, { writeHead(s) { status = s; }, end(text) { body = JSON.parse(text); } }); return { status, ...body };
}

test('published snapshots, checksums, active state and audit survive restart', async t => {
  const { file, studio, body } = await setup(t);
  const before = await studio.versionHistory(ahuPill.id); assert.equal(before.releases.length, 2);
  assert.equal(before.releases[0].contentHash, releaseHash(before.releases[0]));
  await studio.manageVersion(ahuPill.id, '1.0.0', 'activate', await body());
  const restarted = createPillStudio(file), after = await restarted.versionHistory(ahuPill.id);
  assert.equal((await restarted.active()).version, '1.0.0'); assert.equal(after.releases.length, 2);
  assert.deepEqual(after.releases.map(r => r.contentHash), before.releases.map(r => r.contentHash));
  assert.ok(after.events.some(e => e.action === 'activate' && e.previous.version === '2.0.0' && e.target.version === '1.0.0'));
  assert.equal(after.events.find(e => e.action === 'activate').notes, 'Verified rollback target.');
});
test('rollback leaves a work-in-progress draft, validation state and release content unchanged', async t => {
  const { studio, body } = await setup(t); let r = await studio.get(ahuPill.id);
  r = await studio.change(r.id, 'fork', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles }); const content = structuredClone(r.content); content.pill.name = 'Unsaved release draft';
  r = await studio.change(r.id, 'save', { revision: r.revision, content, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  r = await studio.change(r.id, 'validate', { revision: r.revision, authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  await studio.manageVersion(r.id, '1.0.0', 'activate', await body()); const after = await studio.get(r.id);
  assert.deepEqual(after.content, r.content); assert.deepEqual(after.validation, r.validation); assert.equal(after.state, r.state);
  assert.deepEqual(after.releases.map(v => v.pill), r.releases.map(v => v.pill));
  const published = await publish(studio, r.id); assert.equal(published.releases.at(-1).pill.version, '3.0.0');
});
test('disable and restore preserve history; restore does not activate; active cannot be disabled', async t => {
  const { studio, body } = await setup(t);
  await assert.rejects(studio.manageVersion(ahuPill.id, '2.0.0', 'disable', await body()), { status: 409 });
  await studio.manageVersion(ahuPill.id, '1.0.0', 'disable', await body());
  await assert.rejects(studio.manageVersion(ahuPill.id, '1.0.0', 'activate', await body()), { status: 409 });
  await studio.manageVersion(ahuPill.id, '1.0.0', 'restore', await body());
  assert.equal((await studio.active()).version, '2.0.0'); assert.equal((await studio.library()).length, 2);
});
test('version mutations require explicit confirmation and reject stale or duplicate operations', async t => {
  const { studio, body } = await setup(t), good = await body();
  for (const change of [{ confirmed: false }, { notes: '' }, { reviewer: '' }]) await assert.rejects(studio.manageVersion(ahuPill.id, '1.0.0', 'activate', { ...good, ...change }), { status: 422 });
  const results = await Promise.allSettled([studio.manageVersion(ahuPill.id, '1.0.0', 'activate', good), studio.manageVersion(ahuPill.id, '1.0.0', 'activate', good)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  await assert.rejects(studio.manageVersion(ahuPill.id, '1.0.0', 'activate', await body()), { status: 409 });
});
test('publication of another Pill invalidates stale library token but keeps one active version per Pill', async t => {
  const { studio, body } = await setup(t), stale = await body();
  const r = await studio.create({ name: 'Second AHU', authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  await publish(studio, r.id, c => { c.pill = { ...structuredClone(ahuPill), id: r.id, domain: 'ahu_cooling' }; });
  await assert.rejects(studio.manageVersion(ahuPill.id, '1.0.0', 'activate', stale), { status: 409 });
  await studio.manageVersion(ahuPill.id, '1.0.0', 'activate', await body());
  assert.equal((await studio.library()).filter(p => p.active).length, 2);
  const otherHistory = await studio.versionHistory(r.id); assert.equal(otherHistory.active.id, r.id);
  assert.equal((await studio.runtimePills()).find(p => p.id === ahuPill.id).version, '1.0.0');
  assert.ok(!otherHistory.events.some(e => e.action === 'activate'));
});
test('comparison aligns rule IDs, ignores object key ordering and exposes changed safety and evidence', async t => {
  const { studio } = await setup(t), result = await studio.compareVersions(ahuPill.id, '1.0.0', '2.0.0');
  assert.ok(result.changes.some(c => c.key === 'HVAC-01.guidance' && c.type === 'modified'));
  assert.ok(result.changes.some(c => c.key === 'boundaries')); assert.ok(!result.changes.some(c => c.key === 'version'));
  const h = await studio.versionHistory(ahuPill.id), a = h.releases[0], b = structuredClone(a);
  b.pill.rules.reverse(); assert.equal(compareReleases(a, b).changes.length, 0);
  b.pill.rules.pop(); b.pill.actions.push({ id: 'new-action', title: 'New check' }); b.sources.push({ expert: 'New source' });
  const diff = compareReleases(a, b); assert.ok(diff.changes.some(c => c.section === 'rules' && c.type === 'removed')); assert.ok(diff.changes.some(c => c.key === 'new-action' && c.type === 'added')); assert.ok(diff.changes.some(c => c.key === 'sources'));
  await assert.rejects(studio.compareVersions(ahuPill.id, 'missing', '2.0.0'), { status: 404 });
});
test('non-AHU published applicability survives restart and is included in version comparison', async t => {
  const { studio, file } = await setup(t), draft = await studio.create({ name: 'Energy', authenticatedActor: adminActor, authenticatedRoles: adminRoles });
  const scope = { categories: ['energy', 'hvac_cooling'], assetPrefixes: ['AHU-'], keywords: ['energy'] };
  await publish(studio, draft.id, c => { c.pill = { ...structuredClone(ahuPill), id: draft.id, domain: 'energy', applicability: scope }; });
  await publish(studio, draft.id, c => { c.pill.applicability.keywords.push('demand'); });
  const restarted = createPillStudio(file), active = await restarted.runtimePills();
  assert.equal(active.length, 2); assert.equal(active.find(p => p.id === draft.id).domain, 'energy');
  const comparison = await restarted.compareVersions(draft.id, '1.0.0', '2.0.0'); assert.ok(comparison.changes.some(c => c.key === 'applicability'));
  const history = await restarted.versionHistory(draft.id);
  await restarted.manageVersion(draft.id, '1.0.0', 'disable', { revision: history.revision, libraryToken: history.libraryToken, reviewer: 'Expert', notes: 'Old scope', confirmed: true });
  assert.equal((await restarted.runtimePills()).find(p => p.id === draft.id).version, '2.0.0');
});
test('older stored releases without management fields remain readable and can be activated', async t => {
  const { file } = await setup(t); const records = JSON.parse(await readFile(file, 'utf8'));
  for (const r of records[0].releases) { delete r.contentHash; delete r.disabled; }
  await writeFile(file, JSON.stringify(records)); const studio = createPillStudio(file), h = await studio.versionHistory(ahuPill.id);
  assert.equal(h.releases[0].disabled, false); assert.match(h.releases[0].contentHash, /^[a-f0-9]{64}$/);
  await studio.manageVersion(ahuPill.id, '1.0.0', 'activate', { revision: h.revision, libraryToken: h.libraryToken, reviewer: 'A', notes: 'Legacy release reviewed.', confirmed: true });
  assert.equal((await studio.active()).version, '1.0.0');
});
test('altered published snapshot fails its saved checksum before reactivation', async t => {
  const { file } = await setup(t), records = JSON.parse(await readFile(file, 'utf8'));
  records[0].releases[0].pill.scope = 'Unexpected edit'; await writeFile(file, JSON.stringify(records));
  const studio = createPillStudio(file), h = await studio.versionHistory(ahuPill.id);
  await assert.rejects(studio.manageVersion(ahuPill.id, '1.0.0', 'activate', { revision: h.revision, libraryToken: h.libraryToken, reviewer: 'A', notes: 'Attempt', confirmed: true }), { status: 409 });
});
test('rollback changes future triage and review currency without rewriting historical reports', async t => {
  const { studio, store, body } = await setup(t);
  const i = await store.create({ title: 'Warm', description: 'AHU warm', category: 'hvac_cooling', asset: 'AHU-01', location: 'Floor 1', occurredAt: 'today', impact: 'Office', observations: 'Room temperature 29 C', priority: 'high', status: 'ready_for_triage', revision: 0 });
  const agent = async () => ({ summary: 'Verify readings.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
  const triage = createTriageService(store, agent, undefined, undefined, () => studio.active());
  const old = await triage.run(i.id, 0); assert.equal(old.pill.version, '2.0.0');
  await studio.manageVersion(ahuPill.id, '1.0.0', 'activate', await body());
  const review = await createReviewService(store, () => studio.active()).get(i.id); assert.equal(review.package.canApprove, false);
  assert.ok(review.package.findings.some(f => f.code === 'pill_version'));
  const current = await triage.run(i.id, 1); assert.equal(current.pill.version, '1.0.0');
  assert.deepEqual((await store.list())[0].triageReports[0].pill, old.pill);
});
test('version API returns history and comparison and rejects unsupported/deletion routes', async t => {
  const { studio, store, body } = await setup(t), handler = createHandler(store, undefined, undefined, studio), path = `/api/library/${ahuPill.id}`;
  assert.equal((await request(handler, 'GET', path)).releases.length, 2);
  assert.ok((await request(handler, 'GET', `${path}/compare?from=1.0.0&to=2.0.0`)).changes.length);
  assert.equal((await request(handler, 'POST', `${path}/versions/1.0.0/activate`, await body())).status, 200);
  assert.equal((await request(handler, 'DELETE', `${path}/versions/1.0.0/activate`)).status, 405);
  assert.equal((await request(handler, 'GET', '/api/library/unknown')).status, 404);
  assert.equal((await request(handler, 'GET', `${path}/compare?from=bad&to=2.0.0`)).status, 404);
});
