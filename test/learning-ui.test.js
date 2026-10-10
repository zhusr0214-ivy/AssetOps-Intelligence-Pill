import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderHandling, renderLearning, handlingMarkup, proposalMarkup } from '../public/learning.js';
import { caseRoute } from '../public/routes.js';

const incident = () => ({ id: 'INC-test', title: 'AHU case', revision: 3, handlingRecords: [], learningRuns: [] });
const run = () => ({ id: 'LRN-test', incidentId: 'INC-test', title: 'AHU case', revision: 3, summary: 'Evidence reviewed.', questions: [], proposals: [{ id: 'IMP-test', title: 'Check comparison', cause: 'pill_gap', disposition: 'update_pill', before: 'Missing condition', after: 'Proposed condition', reason: 'Evidence', applicability: 'AHU', limitations: 'One case', validationCases: ['Applies', 'Does not apply'], evidence: [{ blockId: 'OPS-test', quote: 'Sensor evidence' }], decision: null }] });
function browser(t, responder) {
  const dom = new JSDOM('<main id="root"></main>', { url: 'http://localhost/cases/INC-test/handling' });
  const old = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = dom.window.document; globalThis.FormData = dom.window.FormData;
  globalThis.fetch = async (url, options = {}) => { const result = await responder(url, options); return { ok: !result.error, json: async () => result }; };
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  return { root: dom.window.document.querySelector('#root'), window: dom.window };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Expected UI update did not finish.'); }
test('handling route and new markup escape operational text and proposal content', () => {
  assert.equal(caseRoute('/cases/INC-test/handling').stage, 'handling');
  const i = incident(); i.title = '<script>bad</script>'; assert.ok(handlingMarkup(i).includes('&lt;script&gt;')); assert.ok(!handlingMarkup(i).includes('<script>'));
  const r = run(); r.proposals[0].after = '<img src=x onerror=bad()>'; assert.ok(!proposalMarkup(r, r.proposals[0]).includes('<img'));
  assert.ok(handlingMarkup(i).includes('data-record="action"')); assert.ok(handlingMarkup(i).includes('data-record="outcome"'));
});
test('action submission preserves pending outcome draft and sends revision without executing equipment', async t => {
  let current = incident(), submitted;
  const { root, window } = browser(t, async (url, options) => {
    if (options.method === 'POST') { submitted = JSON.parse(options.body); current = { ...current, revision: 4 }; }
    return { incident: current, running: false };
  });
  await renderHandling(root, current.id);
  const outcome = root.querySelector('[data-record="outcome"]'); outcome.elements.notes.value = 'Unsaved observation'; outcome.elements.notes.dispatchEvent(new window.Event('input', { bubbles: true }));
  const form = root.querySelector('[data-record="action"]');
  for (const [key, value] of Object.entries({ author: 'Expert', notes: 'Action recorded', rationale: 'Rationale', deviation: 'No approved plan', occurredAt: '2026-01-01T10:00' })) form.elements[key].value = value;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.querySelector('[data-record="action"]') !== form);
  assert.equal(submitted.revision, 3); assert.equal(submitted.kind, 'action'); assert.equal(submitted.verified, false);
  assert.equal(root.querySelector('[data-record="outcome"]').elements.notes.value, 'Unsaved observation');
  root.querySelector('[data-analyze]').click(); assert.ok(root.querySelector('[role="alert"]').textContent.includes('Save pending'));
});
test('learning model failure retains recorded history and re-enables retry', async t => {
  const i = incident(); i.handlingRecords = [{ id: 'OPS-1', kind: 'action', author: 'Expert', notes: 'Actual action', rationale: 'Reason', deviation: 'None' }];
  const { root } = browser(t, async (url, options) => options.method === 'POST' ? { error: 'Model unavailable.' } : { incident: i, running: false });
  await renderHandling(root, i.id); root.querySelector('[data-analyze]').click();
  await until(() => root.querySelector('[role="alert"]').textContent === 'Model unavailable.');
  assert.ok(root.textContent.includes('Actual action')); assert.equal(root.querySelector('[data-analyze]').disabled, false);
});
test('proposal review submits edited text and confirmation and then exposes import', async t => {
  let current = run(), submitted;
  const { root, window } = browser(t, async (url, options) => {
    if (options.method === 'POST') { submitted = JSON.parse(options.body); current.proposals[0].decision = { status: submitted.decision, reviewer: submitted.reviewer, notes: submitted.notes, reviewedAfter: submitted.reviewedAfter }; }
    return { runs: [current], candidates: [] };
  });
  await renderLearning(root); const form = root.querySelector('[data-review]');
  form.elements.reviewer.value = 'Expert'; form.elements.notes.value = 'Reviewed'; form.elements.decision.value = 'accepted'; form.elements.reviewedAfter.value = 'Human edited condition'; form.elements.confirmed.checked = true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.querySelector('[data-apply]'));
  assert.equal(submitted.revision, 3); assert.equal(submitted.confirmed, true); assert.equal(submitted.reviewedAfter, 'Human edited condition');
});
test('published target directs expert to fork before import without mutating the Pill', async t => {
  const current = run(); current.proposals[0].decision = { status: 'accepted', reviewer: 'Expert', notes: 'Reviewed', reviewedAfter: 'Condition' }; let posts = 0;
  const { root, window } = browser(t, async (url, options) => {
    if (options.method === 'POST') posts++;
    if (url === '/api/learning') return { runs: [current], candidates: [] };
    if (url.includes('/handling')) return { incident: { learningRuns: [{ id: current.id, snapshot: { pill: { id: 'ahu' } } }] } };
    return { record: { state: 'published', revision: 7 } };
  });
  await renderLearning(root); root.querySelector('[data-apply]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.querySelector('[role="alert"]').textContent.includes('next draft'));
  assert.equal(posts, 0); assert.equal(root.querySelector('[data-apply] button').disabled, false);
});
