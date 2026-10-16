import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { sessionRequest } from '../public/session.js';
import { ahuPill } from '../triage.js';
import { renderLibrary, renderLibraryPage, comparisonMarkup, releaseMetadataMarkup } from '../public/library.js';

function fixture() {
  return { id: ahuPill.id, revision: 7, libraryToken: 'token-7', active: { id: ahuPill.id, version: '2.0.0' }, events: [], releases: ['1.0.0', '2.0.0'].map((version, i) => ({ pill: { ...structuredClone(ahuPill), status: 'approved', version }, active: i === 1, disabled: false, reviewer: 'Expert', notes: 'Checked release.', publishedAt: '2026-10-01', contentHash: 'abc123', sources: [{ expert: 'Engineer', reference: 'Source', knowledge: 'Compare readings.' }], examples: [], validation: { scope: 'Structure checked.' } })) };
}
function browser(t, responder = async () => ({})) {
  const dom = new JSDOM('<main id="root"></main>', { url: 'http://localhost/library' });
  const old = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = dom.window.document; globalThis.FormData = dom.window.FormData;
  globalThis.fetch = async (url, options = {}) => { const result = await responder(url, options); return { ok: !result.error, json: async () => result }; };
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  return { root: dom.window.document.querySelector('#root'), window: dom.window };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('UI did not complete.'); }

test('library groups releases by Pill and searches historical content without losing latest metadata', t => {
  const { root, window } = browser(t), h = fixture(), pills = h.releases.map(r => ({ ...r.pill, active: r.active, publishedAt: r.publishedAt }));
  pills[0].scope = 'historic-only phrase'; renderLibrary(root, pills);
  assert.equal(root.querySelectorAll('.pill-library-list a').length, 1); assert.ok(root.querySelector('.pill-library-list').textContent.includes('2.0.0'));
  const input = root.querySelector('input'); input.value = 'historic-only'; input.dispatchEvent(new window.Event('input'));
  assert.equal(root.querySelectorAll('.pill-library-list a').length, 1); assert.ok(root.querySelector('.pill-library-list').textContent.includes('2.0.0'));
  input.value = 'absent'; input.dispatchEvent(new window.Event('input')); assert.ok(root.textContent.includes('No approved Pills'));
});
test('comparison renders escaped before and after and correctly encodes selected versions', async t => {
  const h = fixture(), calls = [];
  const comparison = { from: '1.0.0', to: '2.0.0', counts: { added: 0, removed: 0, modified: 1 }, changes: [{ section: 'rules', key: 'HVAC-01.guidance', type: 'modified', before: '<script>old</script>', after: '<img src=x>' }] };
  const { root } = browser(t, async url => { calls.push(url); return url.includes('/compare?') ? comparison : h; });
  await renderLibraryPage(root, `/library/${h.id}/compare`);
  assert.ok(calls.some(url => url.endsWith('/compare?from=1.0.0&to=2.0.0')));
  assert.equal(root.querySelector('script'), null); assert.equal(root.querySelector('img'), null);
  assert.ok(root.textContent.includes('HVAC-01.guidance')); assert.equal(root.querySelector('#version-compare button').disabled, false);
  assert.ok(comparisonMarkup({ from: '1', to: '1', counts: { added: 0, removed: 0, modified: 0 }, changes: [] }).includes('No knowledge content changes'));
});
test('rollback submits operator confirmation and current global token, then refreshes active state', async t => {
  let h = fixture(), posted;
  const { root, window } = browser(t, async (url, options) => {
    if (options.method === 'POST') { posted = { url, body: JSON.parse(options.body) }; h = structuredClone(h); h.revision++; h.releases[0].active = true; h.releases[1].active = false; h.active.version = '1.0.0'; }
    return url === '/api/auth/session' ? {user:{roles:['admin']}} : h;
  });
  await sessionRequest('/api/auth/session');
  await renderLibraryPage(root, `/library/${h.id}/versions/1.0.0`);
  const form = root.querySelector('#version-operation'); form.elements.reviewer.value = 'Operator'; form.elements.notes.value = 'Rollback verified'; form.elements.confirmed.checked = true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !root.querySelector('#version-operation'));
  assert.ok(posted.url.endsWith('/versions/1.0.0/activate')); assert.equal(posted.body.revision, 7); assert.equal(posted.body.libraryToken, 'token-7'); assert.equal(posted.body.confirmed, true);
  assert.equal(root.querySelector('#version-operation'), null);
});
test('disabled releases only offer restore; stale failure keeps reason and enables reload', async t => {
  const h = fixture(); h.releases[0].disabled = true;
  const { root, window } = browser(t, async (url, options) => url === '/api/auth/session' ? {user:{roles:['admin']}} : options.method === 'POST' ? { error: 'Library changed. Reload before continuing.' } : h);
  await sessionRequest('/api/auth/session');
  await renderLibraryPage(root, `/library/${h.id}/versions/1.0.0`);
  const form = root.querySelector('#version-operation'); assert.deepEqual([...form.elements.operation.options].map(o => o.value), ['restore']);
  form.elements.reviewer.value = 'Expert'; form.elements.notes.value = 'Revalidated'; form.elements.confirmed.checked = true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.querySelector('[role="alert"]').textContent.includes('Library changed'));
  assert.equal(form.elements.notes.value, 'Revalidated'); assert.equal(form.querySelector('[data-reload]').disabled, false);
});
test('detail defaults to the active historical version after rollback and rejects missing versions', async t => {
  const h = fixture(); h.releases[0].active = true; h.releases[1].active = false; h.active.version = '1.0.0';
  const { root } = browser(t, async () => h); await renderLibraryPage(root, `/library/${h.id}`);
  assert.ok(root.textContent.includes('Version 1')); assert.ok(!root.textContent.includes('Sources and validation')); assert.equal(root.querySelector('#version-operation'), null);
  await assert.rejects(renderLibraryPage(root, `/library/${h.id}/versions/99.0.0`), /Published version not found/);
});

test('non-administrators can read published content but cannot edit or manage releases', async t => {
  const h=fixture();
  const {root}=browser(t,async url=>url==='/api/auth/session'?{user:{roles:['reviewer','expert']}}:h);
  await sessionRequest('/api/auth/session');
  await renderLibraryPage(root,`/library/${h.id}/versions/1.0.0`);
  assert.equal(root.querySelector('#version-operation'),null);
  assert.equal(root.querySelector('a[href*="edit=1"]'),null);
  assert.equal(root.querySelector('.pill-footer a'),null);
  assert.equal(root.querySelector('[data-page-panel="evidence"]'),null);
  assert.ok(root.textContent.includes('Previous version'));
  assert.ok(root.querySelector('.pill-content-preview'));
});

test('version list is concise, dates are readable and single releases do not offer comparison', async t => {
 const h=fixture();h.releases=[h.releases[1]];
 const {root}=browser(t,async()=>h);
 await renderLibraryPage(root,`/library/${h.id}`);
 assert.equal(root.querySelectorAll('.library-version-list tbody tr').length,1);
 assert.equal(root.querySelectorAll('.library-version-list th').length,4);
 assert.equal(root.querySelector('a[href*="/compare"]'),null);
 assert.equal(root.querySelector('.version-hash'),null);
 assert.ok(!root.textContent.includes('Publication and activation history'));
 assert.ok(!root.textContent.includes('Activate another'));
 assert.ok(root.querySelector('.library-version-list time').textContent);
 assert.notEqual(root.querySelector('.library-version-list time').textContent,h.releases[0].publishedAt);
});

test('Library uses Studio content sections without nested guidance cards or empty optional sections', async t => {
 const h=fixture();for(const release of h.releases){release.pill.boundaries=[];release.pill.escalationConditions=[];}
 const {root}=browser(t,async()=>h);
 await renderLibraryPage(root,`/library/${h.id}`);
 const content=root.querySelector('.pill-content-preview');
 assert.deepEqual([...content.querySelectorAll('h3')].map(h=>h.textContent),['Scope','Actions','Decision rules']);
 assert.equal(content.querySelector('.pill-rule'),null);
 assert.equal(content.querySelector('.knowledge-context'),null);
 assert.ok(content.textContent.includes(h.releases[1].pill.actions[0].instruction));
 assert.ok(content.textContent.includes(h.releases[1].pill.rules[0].guidance));
 assert.equal(content.querySelector('textarea'),null);
});

test('release metadata uses recorded contributors and readable case names without inventing uploaders', () => {
 const release=fixture().releases[1];
 release.captureHistory=[{reviewer:'Alice',documentId:'D1'}];
 release.sources=[{expert:'Reviewed by Alice',reference:'EXPERT-demo.txt / DOC1'}];
 release.reviewer='Bob';
 const dom=new JSDOM(releaseMetadataMarkup(release,[{id:'C1',title:'Lighting follow-up'}]));
 const meta=dom.window.document;
 assert.deepEqual([...meta.querySelectorAll('dd')].slice(0,2).map(el=>el.textContent),['Alice','Bob']);
 assert.equal(meta.querySelector('.library-release-state'),null);
 assert.equal(meta.querySelector('a'),null);
 assert.ok(!meta.body.textContent.includes('Source'));
 assert.ok(!meta.body.textContent.includes('DOC1'));
 dom.window.close();
 assert.match(releaseMetadataMarkup({pill:{version:'1.0.0'},sources:[],reviewer:'Bob'}),/Not recorded/);
});
