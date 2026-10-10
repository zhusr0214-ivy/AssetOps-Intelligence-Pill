import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStudio } from '../public/studio.js';
import { ahuPill } from '../triage.js';

function browser(t, responder) {
  const dom = new JSDOM('<main id="root"></main>', { url: 'http://localhost/studio' });
  const old = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = dom.window.document; globalThis.FormData = dom.window.FormData;
  globalThis.fetch = async (url, options = {}) => { const result = await responder(url, options); return { ok: !result.error, json: async () => result }; };
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  return { root: dom.window.document.querySelector('#root'), window: dom.window };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('UI did not complete the expected operation.');
}
function record() {
  return { id: ahuPill.id, revision: 2, state: 'draft', content: { pill: { ...structuredClone(ahuPill), domain: 'ahu_cooling' }, sources: [], examples: [] }, releases: [], events: [], validation: null, documents: [{ id: 'DOC-test', name: 'test.txt', status: 'extracted', warnings: [], blocks: [{ id: 'B1', location: 'Paragraph 1', text: 'Do not change setpoints.' }], candidates: [{ id: 'K-test', type: 'boundary', title: 'No setting changes', text: 'Do not change setpoints.', evidence: [{ blockId: 'B1', location: 'Paragraph 1', quote: 'Do not change setpoints.' }], relatedRuleIds: [], relatedActionIds: [], missing: [] }], questions: [], conflicts: [] }] };
}

test('Studio home exposes upload and expert entry paths', async t => {
  const { root } = browser(t, async () => ({ records: [record()] }));
  await renderStudio(root, '/studio', () => {});
  assert.ok(root.querySelector('a[href="/studio/new/upload"]'));
  assert.ok(root.querySelector('a[href="/studio/new/expert"]'));
  assert.equal(root.querySelector('#new-pill'), null);
});
test('upload creation parses a file and opens the saved draft without calling the model', async t => {
  const calls = []; let destination;
  const { root, window } = browser(t, async (url, options) => { calls.push({ url, options }); return { record: { ...record(), revision: url.endsWith('/documents') ? 1 : 0 } }; });
  await renderStudio(root, '/studio/new/upload', path => { destination = path; });
  const form = root.querySelector('form'); form.elements.name.value = 'AHU guide'; form.elements.owner.value = 'Owner';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['AHU notes'], 'source.txt')] });
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.equal(calls.length, 2); assert.ok(calls[1].url.endsWith('/documents'));
  assert.equal(calls[1].options.headers['X-Filename'], 'source.txt');
  assert.equal(destination, `/studio/${ahuPill.id}`);
});
test('candidate form submits only checked, edited text and retains source citations', async t => {
  let current = record(), submitted;
  const { root, window } = browser(t, async (url, options) => {
    if (url === '/api/learning') return { candidates: [] };
    if (url.endsWith('/merge')) {
      submitted = JSON.parse(options.body);
      current = { ...current, revision: 3, documents: [{ ...current.documents[0], status: 'reviewed', review: { reviewer: 'Expert', reviewedAt: 'Now', decisions: [{ decision: 'accepted', reviewedText: submitted.selections[0].text, evidence: current.documents[0].candidates[0].evidence }] } }] };
    }
    return { record: current };
  });
  await renderStudio(root, `/studio/${ahuPill.id}`, () => {});
  const form = root.querySelector('[data-capture-review]');
  assert.equal(form.parentElement.closest('form'), null);
  assert.equal(form.elements['accept-0'].checked, false);
  form.elements['accept-0'].checked = true; form.elements['text-0'].value = 'Do not change settings without site approval.';
  form.elements.reviewer.value = 'Expert'; form.elements.confirmed.checked = true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.textContent.includes('Reviewed by Expert'));
  assert.equal(submitted.confirmed, true); assert.equal(submitted.revision, 2);
  assert.deepEqual(submitted.selections, [{ id: 'K-test', text: 'Do not change settings without site approval.' }]);
  assert.ok(root.textContent.includes('Paragraph 1: Do not change setpoints.'));
});
test('unsaved draft blocks source operations and save reads owner correctly despite action owner fields', async t => {
  let saved, calls = 0; const current = record();
  const { root, window } = browser(t, async (url, options) => {
    if (url === '/api/learning') return { candidates: [] };
    if (options.method === 'POST') { calls++; saved = JSON.parse(options.body); return { record: { ...current, content: saved.content, revision: 3 } }; }
    return { record: current };
  });
  await renderStudio(root, `/studio/${ahuPill.id}`, () => {});
  const form = root.querySelector('#pill-editor');
  const owner = form.querySelector('[name="owner"]'); owner.value = 'Correct knowledge owner'; owner.dispatchEvent(new window.Event('input', { bubbles: true }));
  const review = root.querySelector('[data-capture-review]'); review.elements.reviewer.value = 'Expert'; review.elements.confirmed.checked = true;
  review.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(calls, 0); assert.ok(root.querySelector('#studio-error').textContent.includes('Save your draft'));
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.textContent.includes('Draft saved.'));
  assert.equal(saved.content.pill.owner, 'Correct knowledge owner');
});
test('failed AI extraction refreshes revision and offers retry without clearing source', async t => {
  let current = record(); current.documents[0].status = 'ready';
  const { root } = browser(t, async (url, options) => {
    if (url === '/api/learning') return { candidates: [] };
    if (url.endsWith('/analyze')) { current = { ...current, revision: 4, documents: [{ ...current.documents[0], status: 'failed', error: 'Model unavailable.' }] }; return { error: 'Model unavailable.' }; }
    return { record: current };
  });
  await renderStudio(root, `/studio/${ahuPill.id}`, () => {});
  root.querySelector('[data-analyze]').click();
  await until(() => root.textContent.includes('Retry extraction'));
  assert.equal(root.querySelector('[data-analyze]').disabled, false);
  assert.ok(root.textContent.includes('Do not change setpoints.'));
});
