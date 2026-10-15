import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

test('retired Settings deep links show the fixed profile and browser back restores it', async t => {
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/settings?view=users' });
  dom.window.scrollTo = () => {};
  const previous = Object.fromEntries(['window', 'document', 'MutationObserver', 'fetch', 'FormData'].map(key => [key, globalThis[key]]));
  const calls = [];
  const user = { id: 'admin', username: 'admin', name: 'Admin', roles: ['admin'] };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, fetch: async path => {
    calls.push(path);
    const responses = {
      '/api/auth/session': { user, csrf: 'token' },
      '/api/modules': { modules: ['overview', 'cases', 'studio', 'library'].map(id => ({ id, title: id })) },
      '/api/admin/users': { users: [user] }, '/api/admin/health': { storageMode: 'json' }, '/api/admin/audit': { events: [] },
      '/api/incidents': { incidents: [] }, '/api/review': { cases: [] }, '/api/studio': { records: [], candidates: [] }, '/api/library': { pills: [] }
    };
    assert.ok(Object.hasOwn(responses, path), `Unexpected API call: ${path}`);
    return new Response(JSON.stringify(responses[path]), { headers: { 'Content-Type': 'application/json' } });
  } });
  t.after(() => { dom.window.close(); Object.assign(globalThis, previous); });
  await import('../public/app.js');
  assert.equal(document.querySelector('#page-title').textContent, 'Settings');
  assert.equal(document.querySelector('[data-account-role]').textContent, 'Administrator');
  assert.equal(document.querySelector('[data-account-username]').textContent, 'admin');
  assert.equal(document.querySelector('.context').hidden, false);
  assert.equal(document.querySelectorAll('#nav .nav-icon').length, 4);
  assert.equal(document.querySelector('.brand strong').textContent, 'AssetOps');
  assert.ok(!document.querySelector('.topbar').textContent.includes('Commercial Real Estate'));
  assert.equal(document.querySelector('#user-editor, #page [data-page-tabs]'), null);
  assert.match(document.querySelector('#page').textContent, /Personal information/);
  assert.equal(calls.filter(path => path.startsWith('/api/admin')).length, 0);
  document.querySelector('#nav a[href="/studio"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.querySelector('#nav .subnav'), null);
  assert.equal(document.querySelector('#nav [aria-current=page]').getAttribute('href'), '/studio');
  assert.equal(document.querySelectorAll('#page [data-page-tabs]').length, 1);
  assert.equal(document.querySelector('#page [data-page-tabs] [aria-current=page]').textContent, 'Knowledge & drafts');
  assert.equal(calls.includes('/api/operations'), false);
  assert.match(document.querySelector('#page').textContent, /Pill Studio/);
  assert.equal(document.querySelector('#page-title').textContent, 'Pill Studio');
  assert.equal(document.querySelector('#page .workspace-heading h2').hidden, true);
  await new Promise(resolve => { window.addEventListener('popstate', resolve, { once: true }); window.history.back(); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.querySelector('#page-title').textContent, 'Settings');
  assert.match(document.querySelector('#page').textContent, /Personal information/);
  assert.equal(document.querySelector('#page form, #page [data-page-tabs]'), null);
});
