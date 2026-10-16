import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderTasks } from '../public/tasks.js';
import { operationsMarkup, renderOperations } from '../public/operations.js';
import { operationsMetrics } from '../operations-metrics.js';
import { renderReview } from '../public/review.js';
import { renderStudio } from '../public/studio.js';
import {sessionRequest} from '../public/session.js';
import { ahuPill } from '../triage.js';
import { caseRoute } from '../public/routes.js';

function browser(t, responder) {
  const dom = new JSDOM('<main id="root"></main>', { url: 'http://localhost/cases/INC-test/tasks' });
  const old = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = dom.window.document; globalThis.FormData = dom.window.FormData;
  globalThis.fetch = async (url, options = {}) => { const result = await responder(url, options); return { ok: !result.error, json: async () => result }; };
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  return { root: dom.window.document.querySelector('#root'), window: dom.window };
}
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Expected UI update'); }
const task = () => ({ id: 'TASK-1', title: '<script>Task</script>', instruction: 'Read only.', status: 'assigned', assignee: 'Engineer', dueAt: '2026-10-12T10:00:00Z', authorizationCurrent: true, reminder: 'due_soon', events: [] });
const data = () => ({ incidentId: 'INC-test', revision: 4, tasks: [], reviews: [{ id: 'REV-1', eligible: true, decision: 'approve', actions: [{ id: 'a', title: 'Inspect readings' }] }], handlingRecords: [] });

test('task routes and empty operational metrics are explicit, not fabricated percentages', () => {
  assert.equal(caseRoute('/cases/tasks').stage, 'tasks'); assert.equal(caseRoute('/cases/INC-test/tasks').id, 'INC-test');
  const html = operationsMarkup(operationsMetrics([]), []);
  assert.ok(html.includes('No data')); assert.ok(html.includes('No published Pill usage yet')); assert.ok(!html.includes('100%'));
});

test('assignment sends reviewed action, revision and user fields; failure retains input', async t => {
  let submitted, attempts = 0; const current = data();
  const { root, window } = browser(t, async (url, options) => {
    if (options.method === 'POST') { submitted = JSON.parse(options.body); attempts++; if (attempts === 1) return { error: 'Case changed. Reload tasks.' }; current.tasks.push({ ...task(), reviewId: 'REV-1', actionId: 'a' }); }
    return current;
  });
  await renderTasks(root, 'INC-test'); const form = root.querySelector('.task-create form');
  assert.equal(root.querySelector('.workspace-heading button'), null);
  assert.equal(root.querySelectorAll('.task-workspace > .list-toolbar > label').length, 3);
  form.elements.actor.value = 'Dispatcher'; form.elements.assignee.value = 'Engineer'; form.elements.dueAt.value = '2026-10-12T10:00';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.textContent.includes('Case changed.'));
  assert.equal(submitted.reviewId, 'REV-1'); assert.equal(submitted.actionId, 'a'); assert.equal(submitted.revision, 4);
  assert.equal(form.elements.assignee.value, 'Engineer'); assert.equal(form.querySelector('[type=submit]').disabled, false);
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await until(() => root.querySelector('[data-task]'));
  assert.equal(root.querySelector('script'), null);
});

test('task detail submits explicit verification and only current evidence is selectable', async t => {
  let submitted; const current = { ...data(), reviews: [], tasks: [{ ...task(), status: 'awaiting_verification' }], handlingRecords: [{ id: 'old', kind: 'outcome', verified: true }, { id: 'new', kind: 'outcome', verified: true, corrects: 'old', notes: 'Verified outcome' }] };
  const { root, window } = browser(t, async (url, options) => { if (options.method === 'POST') submitted = JSON.parse(options.body); return current; });
  await renderTasks(root, 'INC-test'); root.querySelector('[data-task]').click(); const form = root.querySelector('.task-detail form');
  assert.ok(form.querySelector('[data-reload]'));
  form.elements.operation.value = 'verify'; form.elements.operation.dispatchEvent(new window.Event('change'));
  assert.equal(form.elements.outcomeRecordId.querySelector('[value=old]'), null);
  form.elements.outcomeRecordId.value = 'new'; form.elements.confirmed.checked = true; form.elements.actor.value = 'Expert'; form.elements.notes.value = 'Checked result';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await until(() => submitted);
  assert.equal(submitted.confirmed, true); assert.equal(submitted.outcomeRecordId, 'new'); assert.equal(submitted.operation, 'verify');
});

test('task queue filters by assignee, state and reminder', async t => {
  const { root, window } = browser(t, async () => ({ tasks: [{ ...task(), incidentId: 'INC-test' }, { ...task(), id: 'TASK-2', incidentId: 'INC-other', status: 'blocked', assignee: 'Other', reminder: 'overdue' }] }));
  await renderTasks(root); assert.equal(root.querySelectorAll('tbody tr').length, 2);
  assert.equal(root.querySelector('.workspace-heading button'), null);
  assert.equal(root.querySelectorAll('.task-workspace > .list-toolbar > label').length, 3);
  const filter = root.querySelector('#task-reminder'); filter.value = 'overdue'; filter.dispatchEvent(new window.Event('input'));
  assert.equal(root.querySelectorAll('tbody tr').length, 1); assert.ok(root.querySelector('tbody').textContent.includes('Other'));
  const search = root.querySelector('#task-search'); search.value = 'nobody'; search.dispatchEvent(new window.Event('input')); assert.ok(root.textContent.includes('No matching tasks.'));
});

test('multi-Pill review sends reconciliation as a boolean plus notes', async t => {
  let submitted;
  const current = { incident: { id: 'INC-test', revision: 2, title: 'Case', reviews: [] }, report: { id: 'TRI-1', coordination: { required: true }, actions: [], hypotheses: [] }, package: { canApprove: true, actions: [], findings: [] }, state: 'pending' };
  const { root, window } = browser(t, async (url, options) => { if (options.method === 'POST') submitted = JSON.parse(options.body); return current; });
  await renderReview(root, '/review/INC-test'); const form = root.querySelector('form');
  form.elements.coordinationConfirmed.checked = true; form.elements.coordinationNotes.value = 'Cross-domain review completed';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await until(() => submitted);
  assert.equal(submitted.coordinationConfirmed, true); assert.equal(submitted.coordinationNotes, 'Cross-domain review completed');
});

test('Pill editing preserves routing and action coordination metadata', async t => {
  let submitted;
  const record = { id: ahuPill.id, revision: 1, state: 'draft', content: { pill: { ...structuredClone(ahuPill), domain: 'energy', applicability:{categories:['energy'],assetPrefixes:['AHU-'],keywords:['demand']} }, sources: [], examples: [] }, releases: [], documents: [] };
  record.content.pill.actions[0].coordinationKey='shared-mode';record.content.pill.actions[0].coordinationValue='inspect';
  const {root}=browser(t,async(url,options)=>{
    if(url==='/api/auth/session')return {user:{id:'expert',name:'Expert',roles:['expert']}};
    if(options.method==='POST'){submitted=JSON.parse(options.body);return {record:{...record,content:submitted.content}};}
    return {record};
  });
  await sessionRequest('/api/auth/session');await renderStudio(root,`/studio/${record.id}`,()=>{});
  root.querySelector('[data-edit-preview]').click();root.querySelector('[name=scope]').value='Energy assessment';
  root.querySelector('[data-save-preview]').click();await until(()=>submitted);
  assert.deepEqual(submitted.content.pill.applicability,record.content.pill.applicability);
  assert.equal(submitted.content.pill.domain,'energy');assert.equal(submitted.content.pill.actions[0].coordinationKey,'shared-mode');
});
test('operations filters bind the export to applied criteria and recover from invalid ranges', async t => {
  const calls = [];
  const { root, window } = browser(t, async url => {
    calls.push(url); if (url === '/api/tasks') return { tasks: [] };
    const filters = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
    try { return operationsMetrics([{ id: '1', asset: 'AHU-1', createdAt: '2026-10-10T10:00:00Z' }], filters); }
    catch (error) { return { error: error.message }; }
  });
  await renderOperations(root); const form = root.querySelector('form');
  form.elements.asset.value = 'AHU'; form.elements.from.value = '2026-10-01';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => root.querySelector('[data-export]').getAttribute('href')?.includes('asset=AHU'));
  assert.ok(root.textContent.includes('2026-10')); assert.ok(calls.some(u => u.includes('from=2026-10-01')));
  form.elements.to.value = '2026-09-01'; form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !root.querySelector('[role=alert]').hidden);
  assert.equal(root.querySelector('[data-export]').hidden, true); assert.equal(form.querySelector('[type=submit]').disabled, false);
  form.dispatchEvent(new window.Event('reset', { bubbles: true, cancelable: true })); await until(() => !root.querySelector('[data-export]').hidden);
  assert.equal(form.elements.asset.value, '');
});
test('task progress and escalation controls submit typed values and preserve notes', async t => {
  let submitted; const current = { ...data(), reviews: [], tasks: [{ ...task(), status: 'in_progress', progress: 30 }] };
  const { root, window } = browser(t, async (url, options) => { if (options.method === 'POST') submitted = JSON.parse(options.body); return current; });
  await renderTasks(root, 'INC-test'); root.querySelector('[data-task]').click(); let form = root.querySelector('.task-detail form');
  form.elements.operation.value = 'progress'; form.elements.operation.dispatchEvent(new window.Event('change')); form.elements.progress.value = '45'; form.elements.actor.value = 'Engineer'; form.elements.notes.value = 'Inspection underway';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await until(() => root.querySelector('.task-detail form') !== form);
  assert.equal(submitted.progress, 45); assert.equal(submitted.operation, 'progress');
  root.querySelector('[data-task]').click(); form = root.querySelector('.task-detail form'); form.elements.operation.value = 'escalate'; form.elements.operation.dispatchEvent(new window.Event('change'));
  form.elements.escalationOwner.value = 'Supervisor'; form.elements.actor.value = 'Engineer'; form.elements.notes.value = 'Need support';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await until(() => submitted.operation === 'escalate'); assert.equal(submitted.escalationOwner, 'Supervisor');
});
