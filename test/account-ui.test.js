import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { requireSession, sessionRequest, bindAccountIdentity } from '../public/session.js';
import { api } from '../public/incidents.js';
import { renderSettings } from '../public/settings.js';

function setup(t, responder) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/settings' });
  const old = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, FormData: globalThis.FormData };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, FormData: dom.window.FormData, fetch: responder });
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); }); return document.querySelector('main');
}
const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
test('anonymous entry renders accessible login without revealing workspace data', async t => {
  const root = setup(t, async path => { assert.equal(path, '/api/auth/session'); return response({ user: null, csrf: null }); });
  assert.equal(await requireSession(root), false);
  assert.equal(root.querySelector('[name=password]').type, 'password'); assert.equal(root.querySelector('[name=username]').autocomplete, 'username');
});
test('authenticated API adds CSRF and account identity is readonly; viewer has no user admin UI', async t => {
  const user = { id: 'u', name: 'Operator <one>', username: 'operator', roles: ['viewer'] }; let headers;
  const root = setup(t, async (path, options) => { if (path === '/api/auth/session') return response({ user, csrf: 'token' }); headers = options.headers; return response({ ok: true }); });
  await sessionRequest('/api/auth/session'); await api('/api/test', { method: 'POST', headers: { 'X-Test': 'yes' }, body: '{}' });
  assert.equal(headers['X-CSRF-Token'], 'token'); assert.equal(headers['X-Test'], 'yes');
  root.innerHTML = '<input name="reviewer"><input name="owner">'; bindAccountIdentity(root);
  assert.equal(root.querySelector('[name=reviewer]').value, user.name); assert.equal(root.querySelector('[name=reviewer]').readOnly, true); assert.equal(root.querySelector('[name=owner]').readOnly, false);
  await renderSettings(root); assert.equal(root.querySelector('form'), null); assert.ok(root.querySelector('#sign-out')); assert.equal(root.querySelector('one'), null);
});
test('settings displays a fixed profile and real account identity without administration requests', async t => {
  const user = { id: 'admin', name: 'Admin', username: 'admin', roles: ['admin'] };
  const root = setup(t, async path => {
    if (path === '/api/auth/session') return response({ user, csrf: 'token' });
    throw new Error(path);
  });
  await sessionRequest('/api/auth/session'); await renderSettings(root);
  assert.equal(root.querySelector('form, input, select'), null);
  assert.equal(root.querySelector('h2').textContent, 'Settings');
  assert.deepEqual([...root.querySelectorAll('.settings-profile h3')].map(h => h.textContent), ['Account', 'Personal information']);
  assert.match(root.textContent, /Asset Operations/);
  assert.match(root.textContent, /Demo workspace/);
  assert.match(root.textContent, /admin/);
  assert.equal(root.querySelector('[data-page-panel="runtime"], [data-page-panel="audit"]'), null);
});
