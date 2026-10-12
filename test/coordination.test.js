import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIncidentStore } from '../incident-store.js';
import { createTriageService, ahuPill } from '../triage.js';
import { createReviewService } from '../review.js';
import { createTaskService } from '../tasks.js';
import { validateCoordination, createCoordinationAgent } from '../coordination-agent.js';

const plan = () => ({ summary: 'Check prerequisites with the engineer.', conflicts: [], dependencies: [{ before: 'a', after: 'b', reason: 'Readings are needed before comparison.' }], questions: [] });
test('coordinator validates action references, cycles and strips unauthorized fields', () => {
  const actions = [{ id: 'a' }, { id: 'b' }];
  const result = validateCoordination({ ...plan(), execute: true }, actions);
  assert.deepEqual(result.suggestedOrder, ['a', 'b']); assert.equal(result.execute, undefined); assert.equal(result.executionAllowed, false);
  assert.throws(() => validateCoordination({ ...plan(), dependencies: [{ before: 'a', after: 'invented', reason: 'Invalid' }] }, actions), /invalid actions/);
  assert.throws(() => validateCoordination({ ...plan(), dependencies: [...plan().dependencies, { before: 'b', after: 'a', reason: 'Cycle' }] }, actions), /cycle/);
  assert.throws(() => validateCoordination({ ...plan(), conflicts: [{ actionIds: ['a', 'invented'], reason: 'Invalid' }] }, actions), /invalid actions/);
});

test('coordinator adapter rejects insecure endpoints and bounds model request', async () => {
  await assert.rejects(createCoordinationAgent({ baseUrl: 'http://unsafe.test', apiKey: 'test' })({}), /HTTPS/);
  let request;
  const agent = createCoordinationAgent({ baseUrl: 'https://provider.test/v1', apiKey: 'test', fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan()) } }] })); } });
  const result = await agent({ snapshot: {}, specialists: [], actions: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(result.humanApprovalRequired, true); assert.equal(request.options.redirect, 'error'); assert.equal(JSON.parse(request.options.body).max_tokens, 3500);
});

async function setup(t, coordinator) {
  const dir = await mkdtemp(join(tmpdir(), 'assetops-coordinator-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createIncidentStore(join(dir, 'cases.json'));
  const incident = await store.create({ title: 'Warm room', description: 'Cooling issue', category: 'hvac_cooling', asset: 'AHU-01', location: 'Floor 1', occurredAt: 'Today', observations: 'Room temperature 29 C', impact: 'Office', affectedScope: 'Office', priority: 'high', status: 'ready_for_triage' });
  const pills = ['a', 'b'].map(id => ({ ...structuredClone(ahuPill), id, status: 'approved' }));
  const agent = async () => ({ summary: 'Check measurements.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Readings require checking.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
  const triage = createTriageService(store, agent, 'test', undefined, async () => pills, coordinator);
  const report = await triage.run(incident.id, 0), review = createReviewService(store, async () => pills);
  const approve = async edits => review.submit(incident.id, { revision: (await store.list())[0].revision, reportId: report.id, reviewer: 'Reviewer', notes: 'Checked', owner: 'Engineer', decision: 'approve', assessment: 'accepted', factsVerified: true, coordinationConfirmed: true, coordinationNotes: 'Reconciled', actions: report.actions.map(a => ({ id: a.id, choice: 'accept' })), ...edits });
  return { report, review, incident, approve, store, pills };
}
test('bounded coordination is persisted, semantic conflicts block accepting both actions', async t => {
  const s = await setup(t, async ({ actions }) => ({ summary: 'Potential conflict.', dependencies: [], questions: [], conflicts: [{ actionIds: actions.map(a => a.id), reason: 'The checks need different operating conditions.' }] }));
  assert.equal(s.report.status, 'complete'); assert.equal(s.report.coordination.agent.status, 'complete'); assert.equal(s.report.governance.executionAllowed, false);
  await assert.rejects(s.approve(), /incompatible/);
  assert.equal((await s.approve({ decision: 'approve_with_changes', actions: s.report.actions.map((a, i) => ({ id: a.id, choice: i ? 'omit' : 'accept', reason: 'Keep one safe plan.' })) })).decision, 'approve_with_changes');
});
test('coordinator failure preserves specialists and blocks approval; missing prerequisites are rejected', async t => {
  const failed = await setup(t, async () => { throw new Error('provider unavailable'); });
  assert.equal(failed.report.status, 'partial_failure'); assert.equal(failed.report.specialists.length, 2);
  assert.equal((await failed.review.get(failed.incident.id)).package.canApprove, false);
  const s = await setup(t, async ({ actions }) => ({ summary: 'Ordered checks.', conflicts: [], questions: [], dependencies: [{ before: actions[0].id, after: actions[1].id, reason: 'Validate readings first.' }] }));
  await assert.rejects(s.approve({ decision: 'approve_with_changes', actions: s.report.actions.map((a, i) => ({ id: a.id, choice: i ? 'accept' : 'omit', reason: 'Omitted' })) }), /prerequisite/);
});

test('task start enforces coordinated prerequisites with current verification evidence', async t => {
  const s = await setup(t, async ({ actions }) => ({ summary: 'Ordered checks.', conflicts: [], questions: [], dependencies: [{ before: actions[0].id, after: actions[1].id, reason: 'Validate readings first.' }] }));
  const review = await s.approve(), tasks = createTaskService(s.store, async () => s.pills);
  const revision = async () => (await s.store.list())[0].revision;
  const task = await tasks.create(s.incident.id, { revision: await revision(), reviewId: review.id, actionId: s.report.actions[1].id, actor: 'Dispatcher', assignee: 'Engineer', dueAt: '2027-01-01' });
  await assert.rejects(tasks.update(s.incident.id, task.id, { revision: await revision(), operation: 'start', actor: 'Engineer', notes: 'Begin' }), /prerequisite/);
  const first = await tasks.create(s.incident.id, { revision: await revision(), reviewId: review.id, actionId: s.report.actions[0].id, actor: 'Dispatcher', assignee: 'Engineer', dueAt: '2027-01-01' });
  const incident = (await s.store.list())[0]; Object.assign(incident.tasks.find(t => t.id === first.id), { status: 'completed', actionRecordId: 'act', outcomeRecordId: 'out' });
  await s.store.update(s.incident.id, { tasks: incident.tasks, handlingRecords: [{ id: 'act', kind: 'action' }, { id: 'out', kind: 'outcome', verified: true }] }, await revision());
  assert.equal((await tasks.update(s.incident.id, task.id, { revision: await revision(), operation: 'start', actor: 'Engineer', notes: 'Begin' })).status, 'in_progress');
});
