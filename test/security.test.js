import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createAuth, permitted } from '../auth.js';
import { secureApplication } from '../application.js';
import { createAudit } from '../runtime.js';
import { createHandler } from '../server.js';
import { createIncidentStore } from '../incident-store.js';
import { createPillStudio } from '../pill-studio.js';
import { ahuPill } from '../triage.js';

const password = 'test-password-12345';
async function setup(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-security-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = createAuth(join(dir, 'users.json'), options), audit = createAudit(join(dir, 'audit'));
  const admin = await auth.create({ username: 'admin', name: 'Administrator', roles: ['admin'], password }, true);
  return { dir, auth, audit, admin };
}
async function request(handler, method, url, data, headers = {}) {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { method, url, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const result = { headers: {}, status: null, body: null };
  const res = { statusCode: 200, headersSent: false, setHeader(k, v) { result.headers[k.toLowerCase()] = v; }, writeHead(status, extra = {}) { this.statusCode = result.status = status; Object.assign(result.headers, extra); this.headersSent = true; }, end(value) { result.body = JSON.parse(value); } };
  await handler(req, res); return result;
}
const headersFor = session => ({ cookie: `assetops_session=${session.id}`, 'x-csrf-token': session.csrf });

test('salted passwords, bootstrap guard, last-admin protection and session revocation', async t => {
  const { dir, auth, admin } = await setup(t);
  assert.ok(!(await readFile(join(dir, 'users.json'), 'utf8')).includes(password));
  assert.ok(!JSON.stringify(await auth.list()).includes('hash'));
  await assert.rejects(auth.create({ username: 'other', name: 'Other', roles: ['admin'], password }, true), { status: 409 });
  await assert.rejects(auth.update(admin.id, { disabled: true }), { status: 409 });
  const user = await auth.create({ username: 'operator', name: 'Operator', roles: ['operator'], password });
  const session = await auth.login(user.username, password);
  assert.ok(await auth.session({ headers: headersFor(session) }));
  await auth.update(user.id, { disabled: true });
  assert.equal(await auth.session({ headers: headersFor(session) }), null);
});

test('login throttling, expiry, password change and secure cookie flags', async t => {
  let now = 0; const { auth, admin } = await setup(t, { clock: () => now, ttl: 100, secure: true });
  for (let i = 0; i < 10; i++) await assert.rejects(auth.login('admin', 'wrong', 'blocked-ip'), { status: 401 });
  await assert.rejects(auth.login('admin', password, 'blocked-ip'), { status: 429 });
  const s = await auth.login('admin', password, 'another-ip');
  assert.match(auth.cookie(s.id), /HttpOnly; SameSite=Strict/); assert.match(auth.cookie(s.id), /Secure/);
  now = 101; assert.equal(await auth.session({ headers: headersFor(s) }), null);
  await assert.rejects(auth.changePassword(admin.id, 'wrong', 'changed-password-123'), { status: 403 });
  await auth.changePassword(admin.id, password, 'changed-password-123');
  await assert.rejects(auth.login('admin', password, 'clean-ip'), { status: 401 });
  assert.equal((await auth.login('admin', 'changed-password-123', 'clean-ip')).user.id, admin.id);
});

test('role matrix allows expert knowledge publication but preserves other approval boundaries', () => {
  const u = role => ({ roles: [role], disabled: false });
  for (const path of ['/api/review/case', '/api/library/p/versions/1.0/activate', '/api/studio/p/publish', '/api/learning/c/r/p/review']) {
    assert.equal(permitted(u('operator'), path, 'POST'), false);
    assert.equal(permitted(u('expert'), path, 'POST'), path==='/api/studio/p/publish');
    assert.equal(permitted(u('viewer'), path, 'POST'), false);
    assert.equal(permitted(u('reviewer'), path, 'POST'), true);
  }
  assert.equal(permitted(u('viewer'), '/api/incidents', 'POST'), false);
  assert.equal(permitted(u('viewer'), '/api/studio', 'GET'), true);
  assert.equal(permitted(u('viewer'), '/api/admin/users', 'GET'), false);
});

test('API rejects anonymous, CSRF and cross-origin writes and replaces forged identity', async t => {
  const { dir, auth, audit } = await setup(t);
  const studio = createPillStudio(join(dir, 'pills.json'));
  const app = secureApplication(createHandler(createIncidentStore(join(dir, 'cases.json')), undefined, undefined, studio), { auth, audit, readiness: async () => ({ storage: 'ok' }) });
  assert.equal((await request(app, 'GET', '/api/studio')).status, 401);
  const session = await auth.login('admin', password), headers = headersFor(session);
  assert.equal((await request(app, 'POST', '/api/studio', {}, { cookie: headers.cookie })).status, 403);
  assert.equal((await request(app, 'POST', '/api/studio', {}, { ...headers, origin: 'https://evil.test' })).status, 403);
  const created = await request(app, 'POST', '/api/studio', { name: 'Test', owner: 'Team', authenticatedActor: { id: 'forged', name: 'Impersonator' } }, headers);
  assert.equal(created.status, 201); assert.deepEqual(created.body.record.contributorIds, [session.user.id]);
  const events = await audit.recent(); assert.ok(events.some(e => e.actorId === session.user.id && e.status === 201));
  assert.ok(!JSON.stringify(events).includes(password));
  await auth.create({ username: 'viewer', name: 'Viewer', roles: ['viewer'], password });
  const viewer = headersFor(await auth.login('viewer', password));
  assert.equal((await request(app, 'POST', '/api/studio', {}, viewer)).status, 403);
  assert.equal((await request(app, 'GET', '/api/studio', undefined, viewer)).status, 200);
});

test('runtime rejects writes when pre-action audit cannot persist, and drains on shutdown', async t => {
  const { auth } = await setup(t); let called = false;
  const app = secureApplication(async () => { called = true; }, { auth, audit: { async write() { throw new Error('disk full'); } }, readiness: async () => ({}) });
  const result = await request(app, 'POST', '/api/incidents', {}, headersFor(await auth.login('admin', password)));
  assert.equal(result.status, 503); assert.equal(called, false);
  app.stop(); assert.equal((await request(app, 'GET', '/healthz')).status, 503);
});

test('authenticated author can confirm own knowledge under the default policy', async t => {
  const { dir } = await setup(t), studio = createPillStudio(join(dir, 'pills.json'));
  let r = await studio.get(ahuPill.id);
  r.content.sources = [{ expert: 'Engineer', reference: 'Fixture', knowledge: 'Verify readings.' }];
  r.content.examples = [{ scenario: 'Warm room.', rationale: 'Check readings.', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  const actor = { id: 'author-id', name: 'Author' };
  r = await studio.change(r.id, 'save', { revision: r.revision, content: r.content, authenticatedActor: actor });
  r = await studio.change(r.id, 'validate', { revision: r.revision, authenticatedActor: actor });
  r = await studio.change(r.id, 'submit', { revision: r.revision, authenticatedActor: actor });
  const input = { revision: r.revision, expertConfirmed: true, reviewer: 'Reviewer', notes: 'Reviewed fixture.', authenticatedActor: actor };
  const published = await studio.change(r.id, 'publish', input);
  assert.equal(published.releases.at(-1).identityVerified, true); assert.equal(published.releases.at(-1).actorId, 'author-id');
});
