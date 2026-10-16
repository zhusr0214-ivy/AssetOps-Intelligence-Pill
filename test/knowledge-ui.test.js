import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStudio } from '../public/studio.js';
import { ahuPill } from '../triage.js';
import {sessionRequest} from '../public/session.js';
import { syncPageTabs } from '../public/subpages.js';

async function browser(t, responder) {
  const dom = new JSDOM('<main id="root"></main>', { url: 'http://localhost/studio' });
  const old = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = dom.window.document; globalThis.FormData = dom.window.FormData;
  globalThis.fetch = async (url, options = {}) => { const result = url==='/api/auth/session' ? {user:{id:'expert',name:'Expert',roles:['expert','reviewer']}} : await responder(url, options); return { ok: !result.error, json: async () => result }; };
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  await sessionRequest('/api/auth/session');
  return { root: dom.window.document.querySelector('#root'), window: dom.window };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('UI did not complete the expected operation.');
}
function record() {
  return { id: ahuPill.id, revision: 2, state: 'draft', content: { pill: { ...structuredClone(ahuPill), domain: 'ahu_cooling' }, sources: [], examples: [] }, releases: [], events: [], validation: null, documents: [{ id: 'DOC-test', name: 'test.txt', status: 'extracted', warnings: [], blocks: [{ id: 'B1', location: 'Paragraph 1', text: 'Do not change setpoints.' }], candidates: [{ id: 'K-test', type: 'boundary', title: 'No setting changes', text: 'Do not change setpoints.', evidence: [{ blockId: 'B1', location: 'Paragraph 1', quote: 'Do not change setpoints.' }], relatedRuleIds: [], relatedActionIds: [], missing: [] }], questions: [], conflicts: [] }] };
}

test('Studio pages use tabs without duplicate cross-page controls', async t => {
  const { root } = await browser(t, async () => ({ records: [record()] }));
  await renderStudio(root, '/studio', () => {});
  syncPageTabs(root, '/studio', '', true);
  assert.equal(root.querySelector('a[href="/studio/new"]'),null);
  assert.equal(root.querySelectorAll('a[href="/studio/new"]').length, 0);
  assert.equal(root.querySelectorAll('a[href="/studio/improvements"]').length, 0);
  assert.equal(root.querySelector('.studio-entry-actions'), null);
  assert.equal(root.querySelector('.workspace-heading a'), null);
  assert.equal(root.querySelector('a[href="/studio/new/expert"]'), null);
  assert.equal(root.querySelector('#new-pill'), null);
});
test('upload creation parses and extracts a file before opening saved sources', async t => {
  const calls = []; let destination;
  const { root, window } = await browser(t, async (url, options) => { calls.push({ url, options }); return { record: { ...record(), documents: url === '/api/studio' ? [] : [{ ...record().documents[0], status: url.endsWith('/analyze') ? 'extracted' : 'ready' }], revision: url.endsWith('/documents') ? 1 : 0 } }; });
  await renderStudio(root, '/studio/new/upload', path => { destination = path; });
  assert.equal(root.querySelector('.workspace-heading h2').textContent, 'Create Pill');
  assert.equal(root.querySelector('.back-link').getAttribute('href'), '/studio');
  assert.match(root.querySelector('.back-link').textContent, /Pill Studio/);
  assert.equal(root.querySelector('.workspace-heading a'), null);
  assert.equal(root.querySelector('#capture-entry').classList.contains('triage-section'), false);
  const form = root.querySelector('form'); form.elements.name.value = 'AHU guide';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['AHU notes'], 'source.txt')] });
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.equal(calls.length, 3); assert.ok(calls[1].url.endsWith('/documents'));
  assert.ok(calls[2].url.endsWith('/analyze'));
  assert.equal(calls[1].options.headers['X-Filename'], 'source.txt');
  assert.equal(destination, `/studio/${ahuPill.id}?view=preview`);
});

test('manual creation extracts written knowledge with contributor provenance', async t => {
  let destination, source;
  const { root, window } = await browser(t, async (url, options) => {
    if (url.endsWith('/documents')) source = await options.body.text();
    return { record: { ...record(), documents: url === '/api/studio' ? [] : [{ ...record().documents[0], status: url.endsWith('/analyze') ? 'extracted' : 'ready' }] } };
  });
  await renderStudio(root, '/studio/new', path => { destination = path; });
  const form = root.querySelector('form');
  form.elements.name.value = 'Guide';
  form.elements.experience.value = 'Escalate unknown operating conditions.';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.match(source,/Expert: Expert/); assert.match(source,/Direct expert contribution/); assert.match(source,/Escalate unknown operating conditions/);
  assert.equal(destination, `/studio/${ahuPill.id}?view=preview`);
});

test('combined creation extracts the file and submits the written knowledge', async t => {
  let current = { ...record(), documents: [], revision: 0 }, destination;
  const uploads = [], analyzed = [];
  const { root, window } = await browser(t, async (url, options) => {
    if (url.endsWith('/documents')) {
      uploads.push(await options.body.text()); current.revision++;
      current.documents.push({ ...record().documents[0], id: `DOC-${uploads.length}`, status: 'ready' });
    }
    if (url.endsWith('/analyze')) { analyzed.push(url); current.revision++; current.documents.at(-1).status = 'extracted'; }
    return { record: structuredClone(current) };
  });
  await renderStudio(root, '/studio/new', path => { destination = path; });
  const form = root.querySelector('form'); form.elements.name.value = 'Guide';
  form.elements.experience.value = 'Site-specific exception';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['Original source'], 'source.txt')] });
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.equal(uploads.length, 2); assert.equal(analyzed.length, 2);
  assert.equal(uploads[0], 'Original source'); assert.ok(!uploads[0].includes('Site-specific exception'));
  assert.match(analyzed[0], /DOC-1\/analyze$/);
  assert.match(uploads[1],/Site-specific exception/);
  assert.match(analyzed[1], /DOC-2\/analyze$/);
});

test('empty creation requires a source before any draft is created', async t => {
  let calls = 0;
  const { root, window } = await browser(t, async () => { calls++; return {}; });
  await renderStudio(root, '/studio/new', () => {});
  const form = root.querySelector('form'); form.elements.name.value = 'Guide';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(calls, 0); assert.equal(form.querySelector('.form-error').hidden, false);
  assert.equal(form.querySelector('details'), null);
});

test('failed creation extraction retries the existing source without creating or uploading twice', async t => {
  let current = { ...record(), documents: [], revision: 0 }, creates = 0, uploads = 0, analyzes = 0, destination;
  const { root, window } = await browser(t, async (url, options) => {
    if (url === '/api/studio') creates++;
    if (url.endsWith('/documents')) { uploads++; current = { ...record(), documents: [{ ...record().documents[0], status: 'ready' }] }; }
    if (url.endsWith('/analyze')) {
      analyzes++; current.revision++;
      if (analyzes === 1) { current.documents[0].status = 'failed'; return { error: 'Provider unavailable' }; }
      current.documents[0].status = 'extracted';
    }
    return { record: structuredClone(current) };
  });
  await renderStudio(root, '/studio/new', path => { destination = path; });
  const form = root.querySelector('form'); form.elements.name.value = 'Guide';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['Notes'], 'source.txt')] });
  const submit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await until(() => root.textContent.includes('Provider unavailable'));
  assert.equal(form.querySelector('[data-open-draft]'), null);
  submit(); await until(() => destination);
  assert.equal(creates, 1); assert.equal(uploads, 1); assert.equal(analyzes, 2);
});

test('extracted proposals become draft content without a separate review screen', async t => {
  let current=record();const calls=[];
  const {root}=await browser(t,async(url,options)=>{
    calls.push(url);
    if(url.endsWith('/prepare-draft')){current.content.pill.scope='Captured lighting scope';current.documents[0].draftApplied=true;current.revision++;}
    return {record:structuredClone(current)};
  });
  await renderStudio(root,`/studio/${ahuPill.id}`,()=>{});
  assert.ok(calls.some(url=>url.endsWith('/prepare-draft')));
  assert.match(root.textContent,/Captured lighting scope/);
  assert.equal(root.querySelector('[data-capture-review],.expert-dialogue,.evaluation-panel,#pill-editor'),null);
});
