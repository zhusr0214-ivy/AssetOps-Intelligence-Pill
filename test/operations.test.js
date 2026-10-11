import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createTriageService, ahuPill } from '../triage.js';
import { createReviewService } from '../review.js';
import { createTaskService, taskReminder } from '../tasks.js';
import { operationsMetrics, operationsCSV } from '../operations-metrics.js';
import { matchPill, routingErrors, bundlePills } from '../pill-routing.js';
import { createHandler } from '../server.js';
import { createLearningService } from '../learning.js';

const facts = { title: 'Warm room', description: 'Cooling and energy issue', category: 'hvac_cooling', asset: 'AHU-01', location: 'Floor 1', occurredAt: 'Today', observations: 'Room temperature 29 C', impact: 'Office', affectedScope: 'Office', priority: 'high', status: 'ready_for_triage', revision: 0 };
const pill = (id = 'cooling') => ({ ...structuredClone(ahuPill), id, name: id, status: 'approved', version: '1.0.0', domain: 'ahu_cooling' });
const agent = async () => ({ summary: 'Verify readings.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check measured conditions.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
async function setup(t, pills = [pill()]) {
  const dir = await mkdtemp(join(tmpdir(), 'operations-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'cases.json'), store = createIncidentStore(file), i = await store.create(facts);
  const getter = async () => pills;
  const triage = createTriageService(store, agent, undefined, undefined, getter), review = createReviewService(store, getter), tasks = createTaskService(store, getter, () => Date.parse('2026-10-11T12:00:00Z'));
  const current = async () => (await store.list())[0];
  const analyze = async () => triage.run(i.id, (await current()).revision);
  const approve = async (report, edits = {}) => review.submit(i.id, { revision: (await current()).revision, reportId: report.id, reviewer: 'Expert', decision: 'approve', assessment: 'accepted', factsVerified: true, notes: 'Verified readings.', owner: 'Operations', actions: report.actions.map(a => ({ id: a.id, choice: 'accept' })), coordinationConfirmed: true, coordinationNotes: 'Dependencies verified.', ...edits });
  const create = async (r, edits = {}) => tasks.create(i.id, { revision: (await current()).revision, reviewId: r.id, actionId: r.actions[0]?.id, actor: 'Dispatcher', assignee: 'Engineer', dueAt: '2026-10-12T10:00:00Z', ...edits });
  const update = async (task, operation, extra = {}) => tasks.update(i.id, task.id, { revision: (await current()).revision, actor: 'Engineer', notes: 'Reviewed task update.', operation, ...extra });
  return { file, store, i, getter, current, triage, review, tasks, analyze, approve, create, update };
}

test('routing requires category and each configured dimension; malformed criteria fail closed', () => {
  const p = { ...pill(), domain: 'energy', applicability: { categories: ['hvac_cooling'], assetPrefixes: ['AHU-'], keywords: ['energy'] } };
  assert.equal(routingErrors(p).length, 0); assert.equal(matchPill(facts, p).length, 3);
  for (const edit of [{ category: 'lift_fault' }, { asset: 'VAV-01' }, { description: 'Warm room only' }]) assert.equal(matchPill({ ...facts, ...edit }, p), null);
  assert.ok(routingErrors({ ...p, applicability: { categories: 'hvac', assetPrefixes: [], keywords: [] } }).length);
  assert.equal(matchPill(facts, { ...p, applicability: undefined }), null);
  assert.deepEqual(bundlePills([pill('b'), pill('a')]), bundlePills([pill('a'), pill('b')]));
});

test('multiple specialists keep provenance, namespace duplicate IDs and require reconciliation', async t => {
  const s = await setup(t, [pill('cooling'), { ...pill('energy'), domain: 'energy', applicability: { categories: ['hvac_cooling'], assetPrefixes: [], keywords: ['energy'] } }]);
  const report = await s.analyze(); assert.equal(report.status, 'complete'); assert.equal(report.sourcePills.length, 2);
  assert.deepEqual(report.actions.map(a => a.id), ['cooling::check-readings', 'energy::check-readings']);
  assert.equal((await s.review.get(s.i.id)).package.canApprove, true);
  await assert.rejects(s.approve(report, { coordinationConfirmed: false }), /cross-Pill/);
  const decision = await s.approve(report); assert.equal(decision.coordination.confirmed, true);
  const task = await s.create(decision); assert.equal(task.sourceAction.sourcePillId, 'cooling');
});

test('declared cross-domain conflicts must be omitted or escalated before assigning actions', async t => {
  const a = pill('a'), b = pill('b');
  Object.assign(a.actions[0], { coordinationKey: 'shared-mode', coordinationValue: 'inspect' });
  Object.assign(b.actions[0], { coordinationKey: 'shared-mode', coordinationValue: 'hold' });
  const s = await setup(t, [a, b]), report = await s.analyze(); assert.equal(report.coordination.conflicts.length, 1);
  await assert.rejects(s.approve(report), /Conflicting actions/);
  const review = await s.approve(report, { decision: 'approve_with_changes', actions: [{ id: 'a::check-readings', choice: 'accept' }, { id: 'b::check-readings', choice: 'omit', reason: 'Incompatible with selected plan.' }] });
  await assert.rejects(s.create(review, { actionId: 'b::check-readings' }), { status: 409 });
  assert.equal((await s.create(review)).actionId, 'a::check-readings');
});

test('specialist failure blocks plan approval without discarding successful analysis', async t => {
  const s = await setup(t, [pill('a'), pill('b')]);
  const triage = createTriageService(s.store, async (snap, p) => { if (p.id === 'b') throw new Error('Provider failure'); return agent(); }, undefined, undefined, s.getter);
  const report = await triage.run(s.i.id, 0);
  assert.equal(report.status, 'partial_failure'); assert.equal(report.actions.length, 1); assert.equal(report.coverage.status, 'partial');
  await assert.rejects(s.approve(report), /governance blockers/);
  const decision = await s.approve(report, { decision: 'escalate' }); const task = await s.create(decision);
  assert.equal(task.kind, 'escalation');
});

test('excess matches are not silently truncated and changed Pill versions invalidate tasks', async t => {
  const many = await setup(t, Array.from({ length: 6 }, (_, n) => pill(`p${n}`)));
  await assert.rejects(many.analyze(), { status: 409 }); assert.equal((await many.current()).triageReports, undefined);
  const pills = [pill('a'), pill('b')], s = await setup(t, pills);
  const task = await s.create(await s.approve(await s.analyze())); pills[1].version = '2.0.0';
  assert.equal((await s.tasks.get(s.i.id)).tasks[0].authorizationCurrent, false);
  await assert.rejects(s.update(task, 'start'), { status: 409 });
});

test('task lifecycle requires reviewed published knowledge and validated execution evidence', async t => {
  const s = await setup(t), decision = await s.approve(await s.analyze()), task = await s.create(decision);
  await assert.rejects(s.create(decision), { status: 409 });
  await assert.rejects(s.update(task, 'verify', { confirmed: true }), { status: 422 });
  await s.update(task, 'start'); await s.update(task, 'block'); await s.update(task, 'start');
  await assert.rejects(s.update(task, 'submit', { actionRecordId: 'missing' }), { status: 422 });
  await s.store.update(s.i.id, { handlingRecords: [{ id: 'act', kind: 'action', occurredAt: '2026-10-10T10:00:00Z', notes: 'Inspected' }, { id: 'out', kind: 'outcome', status: 'resolved', verified: true, occurredAt: '2026-10-10T11:00:00Z', notes: 'Verified' }] }, (await s.current()).revision);
  await s.update(task, 'submit', { actionRecordId: 'act' });
  await assert.rejects(s.update(task, 'verify', { outcomeRecordId: 'out', confirmed: false }), { status: 422 });
  await s.update(task, 'verify', { outcomeRecordId: 'out', confirmed: true });
  const persisted = await createTaskService(createIncidentStore(s.file), s.getter).get(s.i.id);
  assert.equal(persisted.tasks[0].status, 'completed'); assert.equal(persisted.tasks[0].reminder, null);
  assert.equal(persisted.tasks[0].outcomeEvidence.notes, 'Verified'); assert.equal(persisted.tasks[0].events.length, 6);
  await s.update(task, 'reopen'); await s.update(task, 'assign', { assignee: 'Second engineer', dueAt: '2026-10-13T10:00:00Z' });
  await assert.rejects(s.update(task, 'link', { externalId: 'WO-1', externalUrl: 'javascript:alert(1)' }), { status: 422 });
  await s.update(task, 'link', { externalId: 'WO-1', externalUrl: 'https://workorders.example/1' });
  assert.equal((await s.tasks.get(s.i.id)).tasks[0].external.id, 'WO-1');
  await s.update(task, 'cancel'); assert.equal((await s.tasks.get(s.i.id)).tasks[0].status, 'cancelled');
});

test('task CAS rejects concurrent transitions; demo plan cannot dispatch operational tasks', async t => {
  const s = await setup(t), task = await s.create(await s.approve(await s.analyze())), revision = (await s.current()).revision;
  const body = { revision, operation: 'start', actor: 'A', notes: 'Start' };
  const results = await Promise.allSettled([s.tasks.update(s.i.id, task.id, body), s.tasks.update(s.i.id, task.id, body)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const d = await setup(t, [structuredClone(ahuPill)]), decision = await d.approve(await d.analyze());
  await assert.rejects(d.create(decision), { status: 409 });
});

test('corrected action evidence cannot complete a task', async t => {
  const s = await setup(t), task = await s.create(await s.approve(await s.analyze())); await s.update(task, 'start');
  const records = [{ id: 'a', kind: 'action', occurredAt: '2026-10-10T10:00:00Z' }];
  await s.store.update(s.i.id, { handlingRecords: records }); await s.update(task, 'submit', { actionRecordId: 'a' });
  records.push({ id: 'b', kind: 'action', corrects: 'a', occurredAt: '2026-10-10T11:00:00Z' });
  await s.store.update(s.i.id, { handlingRecords: records });
  await assert.rejects(s.update(task, 'verify', { confirmed: true }), /corrected/);
});

test('in-app reminders are deterministic and completed/cancelled tasks never alert', () => {
  const at = Date.parse('2026-10-11T12:00:00Z'), task = { status: 'assigned', dueAt: '2026-10-11T11:00:00Z' };
  assert.equal(taskReminder(task, at), 'overdue');
  task.dueAt = '2026-10-12T11:00:00Z'; assert.equal(taskReminder(task, at), 'due_soon');
  task.status = 'blocked'; assert.equal(taskReminder(task, at), 'blocked');
  task.status = 'awaiting_verification'; assert.equal(taskReminder(task, at), 'verification_due');
  for (const status of ['completed', 'cancelled']) assert.equal(taskReminder({ ...task, status }, at), null);
});

test('metrics distinguish empty data, distinct-case reuse, corrections, gaps and version outcomes', () => {
  const empty = operationsMetrics([]); assert.equal(empty.reuse.percent, null); assert.equal(empty.resolution.medianHours, null);
  const report = { id: 'r1', status: 'complete', sourcePills: [pill()] };
  const a = { id: 'a', createdAt: '2026-10-10T10:00:00Z', triageReports: [report, { ...report, id: 'r2' }], reviews: [{ reportId: 'r2', assessment: 'partly_supported', actions: [] }], handlingStatus: 'resolved', handlingRecords: [{ kind: 'outcome', status: 'resolved', verified: true, occurredAt: '2026-10-10T12:00:00Z' }] };
  assert.equal(operationsMetrics([a]).reuse.percent, 0);
  const b = { id: 'b', triageReports: [{ ...report, id: 'r3', sourcePills: [{ ...pill(), version: '2.0.0' }] }] };
  const c = { id: 'c', triageReports: [{ id: 'r4', status: 'out_of_scope' }] };
  const m = operationsMetrics([a, b, c]); assert.equal(m.reuse.percent, 100); assert.equal(m.correction.percent, 100);
  assert.equal(m.gapRate.percent, 33.3); assert.equal(m.resolution.medianHours, 2); assert.equal(m.versions.length, 2);
  assert.equal(m.versions[0].caseCount, 1); assert.equal(m.versions[0].reports, 2); assert.equal(m.versions[0].resolvedCases, 1);
});

test('learning on a multi-Pill report requires one explicit original target', async t => {
  const s = await setup(t, [pill('a'), pill('b')]); await s.approve(await s.analyze());
  let captured;
  const learning = createLearningService(s.store, {}, async snapshot => { captured = snapshot; return { summary: 'No change', questions: [], proposals: [] }; });
  await assert.rejects(learning.analyze(s.i.id, { revision: (await s.current()).revision }), /Choose/);
  await learning.analyze(s.i.id, { revision: (await s.current()).revision, targetPillId: 'b' }); assert.equal(captured.pill.id, 'b');
});

test('task and metrics HTTP routes expose persisted data and reject unsupported methods', async t => {
  const s = await setup(t), decision = await s.approve(await s.analyze());
  const handler = createHandler(s.store, undefined, agent, { runtimePills: s.getter });
  const request = async (method, url, body) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []); Object.assign(req, { method, url, headers: { host: 'localhost' } }); let result;
    await handler(req, { writeHead(status) { result = { status }; }, end(text) { Object.assign(result, JSON.parse(text)); } }); return result;
  };
  const response = await request('POST', `/api/cases/${s.i.id}/tasks`, { revision: (await s.current()).revision, reviewId: decision.id, actionId: decision.actions[0].id, actor: 'A', assignee: 'B', dueAt: '2026-10-12T10:00:00Z' }); assert.equal(response.status, 201);
  assert.equal((await request('GET', '/api/tasks')).tasks.length, 1);
  assert.equal((await request('GET', '/api/operations')).reuse.denominator, 1);
  assert.equal((await request('DELETE', `/api/cases/${s.i.id}/tasks`)).status, 405);
});
test('task progress cannot claim completion; escalation and acknowledgement are audited', async t => {
  const s = await setup(t), task = await s.create(await s.approve(await s.analyze()));
  await assert.rejects(s.update(task, 'progress', { progress: 20 }), { status: 422 });
  await s.update(task, 'start'); await s.update(task, 'progress', { progress: 40 });
  for (const progress of [100, -1, 2.5, '30']) await assert.rejects(s.update(task, 'progress', { progress }), { status: 422 });
  await s.update(task, 'escalate', { escalationOwner: 'Supervisor' });
  await assert.rejects(s.update(task, 'escalate', { escalationOwner: 'Other' }), { status: 409 });
  await s.update(task, 'acknowledge');
  const current = (await s.tasks.get(s.i.id)).tasks[0]; assert.equal(current.progress, 40); assert.equal(current.escalation.acknowledgedBy, 'Engineer');
  assert.equal(current.events.at(-2).escalation.acknowledgedAt, null);
  assert.ok(current.events.at(-1).escalation.acknowledgedAt);
  await s.update(task, 'cancel'); await s.update(task, 'reopen'); assert.equal((await s.tasks.get(s.i.id)).tasks[0].status, 'assigned');
});
test('completed task whose cited result is corrected returns a re-verification reminder', async t => {
  const s = await setup(t), task = await s.create(await s.approve(await s.analyze())); await s.update(task, 'start');
  const records = [{ id: 'a', kind: 'action', occurredAt: '2026-10-10T10:00:00Z' }, { id: 'o', kind: 'outcome', status: 'resolved', verified: true, occurredAt: '2026-10-10T11:00:00Z' }];
  await s.store.update(s.i.id, { handlingRecords: records }); await s.update(task, 'submit', { actionRecordId: 'a' }); await s.update(task, 'verify', { confirmed: true, outcomeRecordId: 'o' });
  records.push({ id: 'correction', corrects: 'o', kind: 'outcome', verified: false }); await s.store.update(s.i.id, { handlingRecords: records });
  const saved = (await s.tasks.get(s.i.id)).tasks[0]; assert.equal(saved.evidenceCurrent, false); assert.equal(saved.reminder, 'evidence_corrected');
  assert.equal(saved.outcomeEvidence.id, 'o'); assert.equal(saved.status, 'completed');
});
test('metrics filter creation cohorts inclusively in UTC and produce reproducible monthly counts', () => {
  const cases = [{ id: 'a', asset: 'AHU-1', category: 'hvac', createdAt: '2026-01-31T23:59:59Z' }, { id: 'b', asset: 'AHU-2', category: 'hvac', createdAt: '2026-02-01T00:00:00Z' }, { id: 'c', asset: 'Lift-1', category: 'lift_fault', createdAt: '2026-01-20T00:00:00Z' }];
  const result = operationsMetrics(cases, { from: '2026-01-01', to: '2026-01-31', asset: 'ahu', category: 'hvac' });
  assert.equal(result.caseCount, 1); assert.deepEqual(result.caseIds, ['a']); assert.equal(result.trends[0].month, '2026-01');
  assert.equal(result.trends[0].created, 1); assert.equal(result.reuse.percent, null);
  for (const filters of [{ from: '2026-02-30' }, { from: 'bad' }, { from: '2026-02-01', to: '2026-01-01' }]) assert.throws(() => operationsMetrics(cases, filters), { status: 422 });
});
test('CSV export includes metric definitions and neutralizes spreadsheet formulas', () => {
  const result = operationsMetrics([{ id: 'case', title: '=HYPERLINK("evil")', triageReports: [{ status: 'knowledge_gap' }] }]);
  const csv = operationsCSV(result); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('""evil""'));
  assert.ok(csv.includes('No data')); assert.ok(csv.includes(result.definitions.cohort));
});
