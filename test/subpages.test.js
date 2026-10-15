import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { navigationMarkup, workspaceLinks, selectSubview, pageTabsMarkup, syncPageTabs, removeDuplicateNavigation } from '../public/subpages.js';
import { editorMarkup } from '../public/studio.js';

const modules = ['overview', 'cases', 'studio', 'library'].map(id => ({ id, title: id }));
test('case home and conversations have no stage tabs, including legacy links', t => {
  assert.equal(pageTabsMarkup('/cases'), '');
  assert.equal(pageTabsMarkup('/cases/new'), '');
  assert.deepEqual(workspaceLinks('/cases/C1'), []);
  const dom = new JSDOM('<main><header class="workspace-heading"><h2>Case Workspace</h2></header></main>');
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main');
  for (const [path, title] of [['/cases/C1', 'Case & analysis'], ['/cases/C1/edit', 'Case & analysis'], ['/cases/C1/triage', 'Case & analysis'], ['/cases/C1/review', 'Review & decision'], ['/cases/C1/tasks', 'Execution & outcome'], ['/cases/C1/handling', 'Execution & outcome']]) {
    syncPageTabs(root, path, '', false);
    assert.equal(root.querySelector('[data-page-tabs]'), null);
  }
  syncPageTabs(root, '/cases', '', false);
  assert.equal(root.querySelector('[data-page-tabs]'), null);
});
test('case creation is not listed as a workspace tab', () => {
  for (const path of ['/cases', '/cases/new', '/cases/tasks', '/cases/INC-1']) {
    assert.ok(!workspaceLinks(path).some(([href]) => href === '/cases/new'));
    assert.ok(!pageTabsMarkup(path).includes('New case'));
  }
});
test('tabs replace duplicate navigation without removing edits, record links or commands', t => {
  const dom = new JSDOM(`<main><header class="workspace-heading"><h2>Case</h2></header><div class="detail-meta"><a href="/incidents/C1">Case details</a><a href="/review/C1">Review</a><a href="/incidents/C1/edit">Edit facts</a></div><aside class="next-step"><p>Human review required</p><a href="/cases/C1/review">Review status</a></aside><a class="back-link" href="/cases">All cases</a><div class="actions"><button>Save</button><a href="/cases/C1/handling">Handling</a></div><table><tbody><tr><td><a href="/cases/C1/review">Recorded decision</a></td></tr></tbody></table></main>`);
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main');
  const tabs = dom.window.document.createElement('nav');
  tabs.innerHTML = '<a href="/cases/C1"></a><a href="/cases/C1/review"></a><a href="/cases/C1/handling"></a>';
  removeDuplicateNavigation(root, tabs);
  assert.equal(root.querySelectorAll('.detail-meta a').length, 1);
  assert.match(root.querySelector('.detail-meta a').href, /\/edit$/);
  assert.equal(root.querySelector('.next-step a'), null);
  assert.match(root.querySelector('.next-step').textContent, /Human review required/);
  assert.ok(root.querySelector('.back-link')); assert.ok(root.querySelector('button')); assert.ok(root.querySelector('td a'));
  assert.equal(root.querySelector('.actions a'), null);
});
test('sidebar contains only main workspaces; subpages use content tabs', t => {
  const dom = new JSDOM(`<aside>${navigationMarkup(modules, '/studio/PILL-1')}</aside><main>${pageTabsMarkup('/studio/PILL-1', '?view=evaluation')}</main>`);
  t.after(() => dom.window.close());
  const root = dom.window.document;
  assert.equal(root.querySelectorAll('.subnav').length, 0);
  assert.equal(root.querySelectorAll('aside a').length, 4);
  assert.equal(root.querySelector('aside a[href="/overview"]'), null);
  assert.equal(root.querySelector('aside a').getAttribute('href'), '/studio');
  assert.equal(root.querySelector('aside [aria-current=page]').getAttribute('href'), '/studio');
  assert.equal(root.querySelector('main [aria-current=page]').textContent, '2 · Validate recommendations');
  assert.equal(root.querySelectorAll('main a').length, 3);
});

test('page tabs sit directly after the heading and synchronize without repeated DOM mutations', t => {
  const dom = new JSDOM('<main><header class="workspace-heading"><h2>Library</h2></header><nav class="workspace-tabs">Old tabs</nav><article>Content</article></main>');
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main');
  syncPageTabs(root, '/library/PILL-1', '?view=versions', true);
  const tabs = root.querySelector('[data-page-tabs]');
  assert.equal(tabs.previousElementSibling.tagName, 'HEADER');
  assert.equal(root.querySelectorAll('.workspace-tabs').length, 1);
  syncPageTabs(root, '/library/PILL-1', '?view=versions', true);
  assert.equal(root.querySelector('[data-page-tabs]'), tabs);
  assert.equal(tabs.querySelector('[aria-current=page]').textContent, 'Versions & management');
});

test('operational analytics remains a Studio tab rather than a Pill editor route', () => {
  const tabs = pageTabsMarkup('/studio/analytics');
  assert.match(tabs, /href="\/studio\/analytics" aria-current="page"/);
  assert.doesNotMatch(tabs, /Draft content|Review &amp; publish|\/overview/);
});
test('case links preserve incident identity and library links preserve selected version', () => {
  const cases = workspaceLinks('/cases/INC-1/triage');
  assert.deepEqual(cases, []);
  assert.ok(workspaceLinks('/library/PILL-1/versions/2').some(([href]) => href === '/library/PILL-1/versions/2?view=evidence'));
  assert.equal(workspaceLinks('/settings', false).length, 0);
  assert.equal(workspaceLinks('/settings', true).length, 0);
});

test('Settings has no tabs even for retired administration URLs', () => {
  for (const view of ['runtime', 'audit', 'users']) {
    const html = pageTabsMarkup('/settings', `?view=${view}`, true);
    assert.equal(html, '');
  }
  assert.equal(pageTabsMarkup('/settings', '?view=users', false), '');
});
test('subpage changes preserve input values and handlers without rendering a long combined page', t => {
  const dom = new JSDOM('<main><form data-page-panel="draft"><input value="saved"><button>Save</button></form><section data-page-panel="evaluation">Evaluation</section></main>');
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main'), form = root.querySelector('form');
  let submitted = false; form.onsubmit = event => { event.preventDefault(); submitted = true; };
  form.querySelector('input').value = 'Unsaved draft';
  selectSubview(root, '?view=evaluation'); assert.equal(form.hidden, true);
  selectSubview(root, '?view=draft'); assert.equal(form.hidden, false);
  assert.equal(form.querySelector('input').value, 'Unsaved draft');
  form.querySelector('button').click(); assert.equal(submitted, true);
  assert.equal(selectSubview(root, '?view=unknown'), 'draft');
  assert.equal(root.querySelector('[data-page-panel=evaluation]').hidden, true);
});
test('draft, publication and history panels remain separate without losing fields', t => {
  const record = { state: 'in_review', releases: [], events: [], content: { sources: [], examples: [], pill: { name: 'Test', owner: 'Team', source: 'Evidence', scope: 'AHU', rules: [], actions: [], boundaries: [], escalationConditions: [] } } };
  const dom = new JSDOM(editorMarkup(record)); t.after(() => dom.window.close());
  const root = dom.window.document;
  selectSubview(root, '?view=publication');
  assert.equal(root.querySelector('#pill-editor').hidden, true);
  assert.equal(root.querySelector('#pill-approval').hidden, false);
  assert.equal(root.querySelectorAll('[data-page-panel=history]:not([hidden])').length, 0);
  selectSubview(root, '?view=history');
  assert.equal(root.querySelectorAll('[data-page-panel=history]:not([hidden])').length, 2);
  assert.equal(root.querySelector('#pill-editor [name=name]').value, 'Test');
});

test('new Pill shows workflow steps instead of workspace navigation',()=>{
 for(const path of ['/studio/new','/studio/new/upload','/studio/new/expert']){
  const dom=new JSDOM(pageTabsMarkup(path));const nav=dom.window.document.querySelector('nav');
  assert.equal(nav.querySelector('[aria-current=step]').textContent,'1 · Prepare knowledge');
  assert.equal(nav.querySelectorAll('[aria-disabled=true]').length,2);
  assert.doesNotMatch(nav.textContent,/Knowledge & drafts|Improvement queue|Operational analytics/);
  assert.equal(nav.querySelectorAll('a').length,1);dom.window.close();
 }
 assert.match(pageTabsMarkup('/studio/p1','?view=evaluation'),/aria-current="page"/);
});
