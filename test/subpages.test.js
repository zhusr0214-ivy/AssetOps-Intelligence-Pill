import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { navigationMarkup, workspaceLinks, selectSubview, pageTabsMarkup, syncPageTabs } from '../public/subpages.js';
import { editorMarkup } from '../public/studio.js';

const modules = ['overview', 'cases', 'studio', 'library'].map(id => ({ id, title: id }));
test('tabs replace duplicate navigation without removing edits, record links or commands', t => {
  const dom = new JSDOM(`<main><header class="workspace-heading"><h2>Case</h2></header><div class="detail-meta"><a href="/incidents/C1">Case details</a><a href="/review/C1">Review</a><a href="/incidents/C1/edit">Edit facts</a></div><aside class="next-step"><p>Human review required</p><a href="/cases/C1/review">Review status</a></aside><a class="back-link" href="/cases">All cases</a><div class="actions"><button>Save</button><a href="/cases/C1/handling">Handling</a></div><table><tbody><tr><td><a href="/cases/C1/review">Recorded decision</a></td></tr></tbody></table></main>`);
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main');
  syncPageTabs(root, '/cases/C1/triage', '', true);
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
  assert.equal(root.querySelectorAll('aside a').length, 5);
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
test('case links preserve incident identity and library links preserve selected version', () => {
  const cases = workspaceLinks('/cases/INC-1/triage');
  assert.ok(cases.some(([href]) => href === '/cases/INC-1/review'));
  assert.ok(cases.some(([href]) => href === '/cases/INC-1/handling'));
  assert.ok(workspaceLinks('/library/PILL-1/versions/2').some(([href]) => href === '/library/PILL-1/versions/2?view=evidence'));
  assert.equal(workspaceLinks('/settings', false).length, 1);
  assert.equal(workspaceLinks('/settings', true).length, 4);
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
