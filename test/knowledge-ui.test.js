import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderStudio } from '../public/studio.js';
import { ahuPill } from '../triage.js';
import { syncPageTabs } from '../public/subpages.js';

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

test('Studio pages use tabs without duplicate cross-page controls', async t => {
  const { root } = browser(t, async () => ({ records: [record()] }));
  await renderStudio(root, '/studio', () => {});
  syncPageTabs(root, '/studio', '', true);
  assert.ok(root.querySelector('a[href="/studio/new"]'));
  assert.equal(root.querySelectorAll('a[href="/studio/new"]').length, 1);
  assert.equal(root.querySelectorAll('a[href="/studio/improvements"]').length, 1);
  assert.equal(root.querySelector('.studio-entry-actions'), null);
  assert.equal(root.querySelector('.workspace-heading a'), null);
  assert.equal(root.querySelector('a[href="/studio/new/expert"]'), null);
  assert.equal(root.querySelector('#new-pill'), null);
});
test('upload creation parses and extracts a file before opening saved sources', async t => {
  const calls = []; let destination;
  const { root, window } = browser(t, async (url, options) => { calls.push({ url, options }); return { record: { ...record(), documents: url === '/api/studio' ? [] : [{ ...record().documents[0], status: url.endsWith('/analyze') ? 'extracted' : 'ready' }], revision: url.endsWith('/documents') ? 1 : 0 } }; });
  await renderStudio(root, '/studio/new/upload', path => { destination = path; });
  assert.equal(root.querySelector('.workspace-heading h2').textContent, 'Pill Studio');
  assert.equal(root.querySelector('.back-link'), null);
  assert.equal(root.querySelector('.workspace-heading a'), null);
  assert.equal(root.querySelector('#capture-entry').classList.contains('triage-section'), false);
  const form = root.querySelector('form'); form.elements.name.value = 'AHU guide'; form.elements.owner.value = 'Owner';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['AHU notes'], 'source.txt')] });
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.equal(calls.length, 3); assert.ok(calls[1].url.endsWith('/documents'));
  assert.ok(calls[2].url.endsWith('/analyze'));
  assert.equal(calls[1].options.headers['X-Filename'], 'source.txt');
  assert.equal(destination, `/studio/${ahuPill.id}?view=sources`);
});

test('manual-only creation uses the same extraction flow and records provenance', async t => {
  let destination, source;
  const { root, window } = browser(t, async (url, options) => {
    if (url.endsWith('/documents')) source = await options.body.text();
    return { record: { ...record(), documents: url === '/api/studio' ? [] : [{ ...record().documents[0], status: url.endsWith('/analyze') ? 'extracted' : 'ready' }] } };
  });
  await renderStudio(root, '/studio/new', path => { destination = path; });
  const form = root.querySelector('form');
  form.elements.name.value = 'Guide'; form.elements.owner.value = 'Team';
  form.elements.expert.value = 'Expert'; form.elements.reference.value = 'Site interview'; form.elements.experience.value = 'Escalate unknown operating conditions.';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.match(source, /Expert: Expert/); assert.match(source, /Site interview/);
  assert.equal(destination, `/studio/${ahuPill.id}?view=sources`);
});

test('a file and manual context are both retained and extracted in one draft', async t => {
  let current = { ...record(), documents: [], revision: 0 }, destination;
  const uploads = [], analyzed = [];
  const { root, window } = browser(t, async (url, options) => {
    if (url.endsWith('/documents')) {
      uploads.push(await options.body.text()); current.revision++;
      current.documents.push({ ...record().documents[0], id: `DOC-${uploads.length}`, status: 'ready' });
    }
    if (url.endsWith('/analyze')) { analyzed.push(url); current.revision++; current.documents.at(-1).status = 'extracted'; }
    return { record: structuredClone(current) };
  });
  await renderStudio(root, '/studio/new', path => { destination = path; });
  const form = root.querySelector('form'); form.elements.name.value = 'Guide'; form.elements.owner.value = 'Team';
  form.elements.expert.value = 'Expert'; form.elements.reference.value = 'Interview'; form.elements.experience.value = 'Site-specific exception';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['Original source'], 'source.txt')] });
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => destination);
  assert.equal(uploads.length, 2); assert.equal(analyzed.length, 2);
  assert.equal(uploads[0], 'Original source'); assert.match(uploads[1], /Site-specific exception/);
  assert.match(analyzed[1], /DOC-2\/analyze$/);
});

test('empty creation requires a source before any draft is created', async t => {
  let calls = 0;
  const { root, window } = browser(t, async () => { calls++; return {}; });
  await renderStudio(root, '/studio/new', () => {});
  const form = root.querySelector('form'); form.elements.name.value = 'Guide'; form.elements.owner.value = 'Team';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(calls, 0); assert.equal(form.querySelector('.form-error').hidden, false);
  assert.equal(form.querySelector('details').open, true);
});

test('failed creation extraction retries the existing source without creating or uploading twice', async t => {
  let current = { ...record(), documents: [], revision: 0 }, creates = 0, uploads = 0, analyzes = 0, destination;
  const { root, window } = browser(t, async (url, options) => {
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
  const form = root.querySelector('form'); form.elements.name.value = 'Guide'; form.elements.owner.value = 'Team';
  Object.defineProperty(form.elements.file, 'files', { value: [new File(['Notes'], 'source.txt')] });
  const submit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await until(() => root.textContent.includes('Provider unavailable'));
  assert.equal(form.querySelector('[data-open-draft]').hidden, false);
  submit(); await until(() => destination);
  assert.equal(creates, 1); assert.equal(uploads, 1); assert.equal(analyzes, 2);
});

test('extraction gaps and expert supplement are available together without automatic merge', async t => {
  const current = record(); current.documents[0].questions = ['Which asset type?']; current.documents[0].candidates[0].missing = ['Escalation owner'];
  const { root } = browser(t, async url => url === '/api/learning' ? { candidates: [] } : { record: current });
  await renderStudio(root, `/studio/${ahuPill.id}`, () => {});
  assert.match(root.querySelector('.knowledge-gaps').textContent, /Which asset type/);
  assert.match(root.querySelector('.knowledge-gaps').textContent, /Escalation owner/);
  assert.ok(root.querySelector('#manual-source'));
  assert.equal(root.querySelector('#manual-source').closest('details').open, true);
  assert.equal(root.querySelector('[name="accept-0"]').checked, false);
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
  assert.equal(calls, 0); assert.ok(root.querySelector('[data-save-message]').textContent.includes('Save your draft')); assert.equal(root.querySelector('[data-save-continue]').hidden,false);
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


test('save and continue persists edits then analyzes using the new revision', async t => {
  let current=record(); current.documents[0].status='ready'; const calls=[];
  const {root,window}=browser(t,async(url,options)=>{
    if(url==='/api/learning') return {candidates:[]};
    if(options.method==='POST') {
      const body=JSON.parse(options.body);calls.push({url,body});
      if(url.endsWith('/save')) current={...current,revision:3,content:body.content};
      if(url.endsWith('/analyze')) {assert.equal(body.revision,3);current={...current,revision:4,documents:[{...current.documents[0],status:'extracted'}]};}
    }
    return {record:current};
  });
  await renderStudio(root,`/studio/${ahuPill.id}`,()=>{});
  const domain=root.querySelector('[name=domain]');domain.value='lift_fault';domain.dispatchEvent(new window.Event('input',{bubbles:true}));
  root.querySelector('[data-analyze]').click();assert.equal(calls.length,0);
  root.querySelector('[data-save-continue]').click();await until(()=>calls.length===2 && root.textContent.includes('Knowledge source updated.'));
  assert.ok(calls[0].url.endsWith('/save'));assert.ok(calls[1].url.endsWith('/analyze'));assert.equal(calls[0].body.content.pill.domain,'lift_fault');
});


test('source response refreshes evaluation gate before painting the completed extraction', async t => {
  let current=record(),gets=0;current.documents[0].status='ready';
  const {root}=browser(t,async(url,options)=>{
    if(url==='/api/learning') return {candidates:[]};
    if(url.endsWith('/analyze')) {current={...current,revision:3,documents:[{...current.documents[0],status:'extracted'}]};return {record:current};}
    gets++;return {record:{...current,evaluationGate:{state:'not_enabled',required:false}}};
  });
  await renderStudio(root,`/studio/${ahuPill.id}`,()=>{});
  root.querySelector('[data-analyze]').click();await until(()=>root.textContent.includes('Knowledge source updated.'));
  assert.equal(gets,2);assert.ok(root.textContent.includes('Evaluation gate not enabled'));assert.ok(!root.textContent.includes('Evaluation status unavailable'));
});
