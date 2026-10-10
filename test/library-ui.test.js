import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ahuPill } from '../triage.js';
import { renderLibrary, renderLibraryPage, comparisonMarkup } from '../public/library.js';

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
  assert.equal(root.querySelectorAll('tbody tr').length, 1); assert.ok(root.querySelector('tbody').textContent.includes('2.0.0'));
  const input = root.querySelector('input'); input.value = 'historic-only'; input.dispatchEvent(new window.Event('input'));
  assert.equal(root.querySelectorAll('tbody tr').length, 1); assert.ok(root.querySelector('tbody').textContent.includes('2.0.0'));
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
    return h;
  });
  await renderLibraryPage(root, `/library/${h.id}/versions/1.0.0`);
  const form = root.querySelector('#version-operation'); form.elements.reviewer.value = 'Operator'; form.elements.notes.value = 'Rollback verified'; form.elements.confirmed.checked = true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.textContent.includes('This version is active.'));
  assert.ok(posted.url.endsWith('/versions/1.0.0/activate')); assert.equal(posted.body.revision, 7); assert.equal(posted.body.libraryToken, 'token-7'); assert.equal(posted.body.confirmed, true);
  assert.equal(root.querySelector('#version-operation'), null);
});
test('disabled releases only offer restore; stale failure keeps reason and enables reload', async t => {
  const h = fixture(); h.releases[0].disabled = true;
  const { root, window } = browser(t, async (url, options) => options.method === 'POST' ? { error: 'Library changed. Reload before continuing.' } : h);
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
  assert.ok(root.textContent.includes('Version 1.0.0')); assert.ok(root.textContent.includes('Sources and validation')); assert.equal(root.querySelector('#version-operation'), null);
  await assert.rejects(renderLibraryPage(root, `/library/${h.id}/versions/99.0.0`), /Published version not found/);
});
