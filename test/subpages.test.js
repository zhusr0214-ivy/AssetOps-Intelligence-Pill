import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { navigationMarkup, workspaceLinks, selectSubview, pageTabsMarkup, syncPageTabs, removeDuplicateNavigation } from '../public/subpages.js';
import { previewMarkup } from '../public/pill-preview.js';

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
  assert.equal(root.querySelector('main [aria-current=page]'), null);
  assert.equal(root.querySelectorAll('main a').length, 0);
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
  assert.equal(tabs.querySelector('[aria-current=page]').textContent, 'Version management');
});

test('case links preserve incident identity and library links preserve selected version', () => {
  const cases = workspaceLinks('/cases/INC-1/triage');
  assert.deepEqual(cases, []);
  assert.ok(workspaceLinks('/library/PILL-1/versions/2').some(([href]) => href === '/library/PILL-1/versions/2?view=versions'));
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
test('Pill content no longer has separate validation, publication or history panels',t=>{
 const record={state:'draft',content:{pill:{name:'Test',scope:'Lighting',actions:[],rules:[],boundaries:[],escalationConditions:[]},sources:[],examples:[]}};
 const dom=new JSDOM(previewMarkup(record));t.after(()=>dom.window.close());
 assert.equal(dom.window.document.querySelector('[data-page-panel],#pill-editor,#pill-approval'),null);
 assert.match(dom.window.document.body.textContent,/Lighting/);
});
test('new and existing Pills have no workflow-step tabs',()=>{
 for(const path of ['/studio/new','/studio/new/upload','/studio/new/expert','/studio/p1']){
  assert.equal(pageTabsMarkup(path),'');assert.equal(pageTabsMarkup(path,'?view=evaluation'),'');
 }
});


test('Library exposes exactly content and version-management tabs, including comparison', t => {
 const dom=new JSDOM(pageTabsMarkup('/library/P1/compare',''));
 t.after(()=>dom.window.close());
 const links=[...dom.window.document.querySelectorAll('a')];
 assert.deepEqual(links.map(a=>a.textContent),['Content','Version management']);
 assert.equal(dom.window.document.querySelector('[aria-current="page"]').textContent,'Version management');
});
