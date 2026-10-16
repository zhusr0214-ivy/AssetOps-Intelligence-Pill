import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { syncWorkspaceHeader } from '../public/workspace-shell.js';
import { navigationMarkup } from '../public/subpages.js';

test('workspace header keeps actions and metadata, uses safe account text, and is idempotent', t => {
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const doc = dom.window.document, root = doc.querySelector('#page');
  root.innerHTML = '<header class="workspace-heading"><div><h2>Pill title</h2><p>Owner</p></div><button>Save</button></header>';
  const user = { username: '<img src=x>', name: 'Display name', roles: ['expert', 'reviewer'] };
  syncWorkspaceHeader(root, '/studio/P1', user);
  assert.equal(doc.querySelector('#page-title').textContent, 'Pill title');
  assert.equal(doc.querySelector('[data-account-role]').textContent, 'Expert, Reviewer');
  assert.equal(doc.querySelector('[data-account-username]').textContent, user.username);
  assert.equal(doc.querySelector('.context img'), null);
  assert.equal(root.querySelector('h2').hidden, true);
  assert.equal(root.querySelector('p').textContent, 'Owner');
  assert.equal(root.querySelector('button').hidden, false);
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(doc.body, { childList: true, subtree: true });
  syncWorkspaceHeader(root, '/studio/P1', user);
  assert.equal(observer.takeRecords().length, 0);
  observer.disconnect();
  root.replaceChildren();
  syncWorkspaceHeader(root, '/studio', user);
  assert.equal(doc.querySelector('#page-title').textContent, 'Pill Studio');
  syncWorkspaceHeader(root, '/settings', null);
  assert.equal(doc.querySelector('.context').hidden, true);
});

test('New case is a title action only in the case workspace, not a subpage tab', t => {
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const doc = dom.window.document, root = doc.querySelector('#page');
  const user = { username: 'admin', roles: ['admin'] };
  const button = doc.querySelector('.page-title-group [data-new-case]');
  assert.equal(button.getAttribute('href'), '/cases/new');
  for (const path of ['/cases', '/cases/tasks', '/cases/INC-1/triage']) {
    syncWorkspaceHeader(root, path, user);
    assert.equal(button.hidden, false);
  }
  for (const path of ['/cases/new', '/studio', '/overview', '/settings']) {
    syncWorkspaceHeader(root, path, user);
    assert.equal(button.hidden, true);
  }
  syncWorkspaceHeader(root, '/cases', null);
  assert.equal(button.hidden, true);
});

test('five workspace icons are bundled and decorative while navigation stays labelled', t => {
  const modules = ['overview', 'cases', 'studio', 'library'].map(id => ({ id, title: id }));
  const dom = new JSDOM(navigationMarkup(modules, '/cases'));
  t.after(() => dom.window.close());
  for (const link of dom.window.document.querySelectorAll('a')) {
    const icon = link.querySelector('img');
    assert.ok(existsSync(new URL(`../public${icon.getAttribute('src')}`, import.meta.url)));
    assert.equal(icon.alt, '');
    assert.ok(link.querySelector('.nav-label').textContent);
  }
});

test('Create Pill is a primary home action for experts, not a navigation tab',t=>{
 const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));t.after(()=>dom.window.close());
 const doc=dom.window.document,root=doc.querySelector('#page'),button=doc.querySelector('.page-title-group [data-new-pill]');
 assert.equal(button.getAttribute('href'),'/studio/new');assert.ok(button.classList.contains('primary'));
 for(const role of ['expert','admin']){syncWorkspaceHeader(root,'/studio',{roles:[role]});assert.equal(button.hidden,false);}
 for(const path of ['/studio/new','/studio/p1','/cases','/settings']){syncWorkspaceHeader(root,path,{roles:['expert']});assert.equal(button.hidden,true);}
 syncWorkspaceHeader(root,'/studio',{roles:['viewer']});assert.equal(button.hidden,true);
});
