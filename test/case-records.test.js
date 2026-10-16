import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createPillStudio } from '../pill-studio.js';
import { createCaseRecords } from '../case-records.js';
import { feedbackEvidence, validateCaseFeedback } from '../case-feedback.js';
import { createHandler } from '../server.js';
import { ahuPill } from '../triage.js';
import { permitted } from '../auth.js';
import { openDatabase } from '../database.js';

const who = { id: 'expert-1', name: 'Authenticated expert' };
const feedback = { summary: 'The issue has been reported.', actions: '', outcome: 'not_reported', remaining: 'Needs verification', feedback: '', evidence: [] };
async function setup(t, sqlite = false) {
  const dir = await mkdtemp(join(tmpdir(), 'case-records-'));
  const db = sqlite ? openDatabase(join(dir, 'data.sqlite')) : null;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const options = db ? { persistence: db } : {};
  const store = createIncidentStore(join(dir, 'cases.json'), options), studio = createPillStudio(join(dir, 'pills.json'), options);
  const incident = await store.create({ title: 'Cooling issue', description: 'AHU warm', category: 'hvac_cooling', revision: 0, messages: [{ id: 'U1', role: 'user', state: 'complete', content: 'AHU warm' }, { id: 'A1', role: 'assistant', content: 'Needs expert judgment', expertRequest: { required: true, reason: 'Knowledge gap' }, matchedPills: [] }] });
  return { store, studio, incident, records: createCaseRecords(store, studio, { answer: async () => ({ resultFeedback: feedback }) }) };
}
const expertBody = i => ({ revision: i.revision, messageId: 'A1', requestId: 'expert-request-001', solution: 'Arrange qualified inspection of the reported condition.', applicability: 'AHU cooling', limitations: 'No execution or verified result yet', confirmed: true, authenticatedActor: who });

for (const sqlite of [false, true]) test(`experience capture waits for confirmation before draft creation (${sqlite ? 'SQLite' : 'JSON'})`, async t => {
  const { records, incident, studio } = await setup(t, sqlite);
  const before = (await studio.list()).length;
  const captured = await records.expertSolution(incident.id, { ...expertBody(incident), deferDraft: true });
  const saved = captured.expertSolutions[0];
  assert.equal(saved.status, 'pending_confirmation'); assert.equal(saved.pillDraftId, undefined);
  assert.equal((await studio.list()).length, before);
  const body = { solutionId: saved.id, revision: captured.revision, confirmed: true, authenticatedActor: { id: 'expert-2', name: 'Confirming expert' } };
  await assert.rejects(records.confirmExperience(incident.id, { ...body, confirmed: false }), { status: 422 });
  await assert.rejects(records.confirmExperience(incident.id, { ...body, revision: 999 }), { status: 409 });
  const result = await records.confirmExperience(incident.id, body);
  const experience = result.expertSolutions[0], draft = await studio.get(experience.pillDraftId);
  assert.equal(experience.experienceConfirmation.name, 'Confirming expert');
  assert.equal(experience.expert, who.name);
  assert.equal(draft.releases.length, 0);
  assert.equal(draft.content.sources[0].expert, who.name);
  await records.confirmExperience(incident.id, body);
  assert.equal((await studio.get(draft.id)).content.sources.length, 1);
});

test('supervision decisions bind a request, identity and version without executing or publishing', async t => {
  const { store, records, incident } = await setup(t);
  incident.messages[1].supervision = { required: true, mode: 'review', kind: 'approval', subject: 'Review this recommendation', reason: 'Pill requires review', pillVersions: [] };
  const current = await store.update(incident.id, { messages: incident.messages }, incident.revision);
  const body = { revision: current.revision, messageId: 'A1', decision: 'approved', subject: 'Suitable for this Case only', confirmed: true, authenticatedActor: who };
  const saved = await records.confirm(incident.id, body);
  assert.equal(saved.humanConfirmations[0].decision, 'approved');
  assert.equal(saved.humanConfirmations[0].sourceMessageId, 'A1');
  assert.equal(saved.humanConfirmations[0].confirmedBy, who.name);
  assert.equal(saved.handlingStatus, undefined); assert.equal(saved.expertSolutions, undefined);
  await assert.rejects(records.confirm(incident.id, { ...body, revision: saved.revision }), { status: 409 });
});

test('safety escalation cannot be approved; changed Pill or Case facts invalidate approval', async t => {
  const { store, records, incident } = await setup(t);
  const message = incident.messages[1];
  message.supervision = { required: true, mode: 'escalation', kind: 'safety', subject: 'Protected boundary', reason: 'Restricted', pillVersions: [] };
  let current = await store.update(incident.id, { messages: incident.messages }, incident.revision);
  const body = { messageId: 'A1', decision: 'approved', subject: 'Attempt', confirmed: true, authenticatedActor: who };
  await assert.rejects(records.confirm(incident.id, { ...body, revision: current.revision }), { status: 422 });
  message.supervision.mode = 'review'; message.supervision.pillVersions = [{ id: 'revoked', version: '1' }];
  current = await store.update(incident.id, { messages: incident.messages }, current.revision);
  await assert.rejects(records.confirm(incident.id, { ...body, revision: current.revision }), { status: 409 });
  message.supervision.pillVersions = []; message.supervision.caseFacts = { asset: 'OLD-ASSET' };
  current = await store.update(incident.id, { messages: incident.messages }, current.revision);
  await assert.rejects(records.confirm(incident.id, { ...body, revision: current.revision }), { status: 409 });
  const rejected = await records.confirm(incident.id, { ...body, revision: current.revision, decision: 'rejected' });
  assert.equal(rejected.humanConfirmations[0].decision, 'rejected');
});

test('confirmation stores what/who/when, rejects stale or unauthenticated writes and never approves actions', async t => {
  const { records, incident } = await setup(t);
  await assert.rejects(records.confirm(incident.id, { revision: 0, subject: 'Verified asset', confirmed: true }), { status: 403 });
  const saved = await records.confirm(incident.id, { revision: 0, subject: 'Verified asset identity', confirmed: true, authenticatedActor: who, confirmedBy: 'Spoofed name' });
  assert.equal(saved.humanConfirmations[0].confirmedBy, who.name);
  assert.equal(saved.humanConfirmations[0].subject, 'Verified asset identity');
  assert.equal(saved.humanConfirmations[0].scope, 'record_only_not_operational_authorization');
  assert.ok(Number.isFinite(Date.parse(saved.humanConfirmations[0].createdAt)));
  assert.equal(saved.reviews, undefined);
  await assert.rejects(records.confirm(incident.id, { revision: 0, subject: 'Another', confirmed: true, authenticatedActor: who }), { status: 409 });
});

test('automatic feedback is cached and never becomes verified or closes the case', async t => {
  const { store, studio, incident } = await setup(t); let calls = 0;
  const records = createCaseRecords(store, studio, { answer: async value => { calls++; assert.equal(value.task, 'summary_only'); return { resultFeedback: feedback }; } });
  const saved = await records.summarize(incident.id);
  assert.equal(saved.resultFeedback.verified, false);
  assert.equal(saved.resultFeedback.caseRevision, saved.revision);
  assert.equal(saved.handlingStatus, undefined);
  await records.summarize(incident.id); assert.equal(calls, 1);
  await records.confirm(incident.id, { revision: saved.revision, subject: 'Confirmed reported symptoms', confirmed: true, authenticatedActor: who });
  await records.summarize(incident.id); assert.equal(calls, 2);
});

test('expert proposals and assistant replies cannot serve as outcome proof; fabricated quotes fail', () => {
  const evidence = feedbackEvidence({ messages: [{ id: 'A1', role: 'assistant', content: 'Resolved' }], expertSolutions: [{ id: 'E1', solution: 'Try this plan' }] });
  assert.equal(evidence.length, 1);
  assert.throws(() => validateCaseFeedback({ ...feedback, outcome: 'reported_resolved', evidence: [{ id: 'E1', quote: 'Try this plan' }] }, evidence), { status: 502 });
  assert.throws(() => validateCaseFeedback({ ...feedback, evidence: [{ id: 'E1', quote: 'Invented result' }] }, evidence), { status: 502 });
  const reported = validateCaseFeedback({ ...feedback, outcome: 'reported_resolved', evidence: [{ id: 'U1', quote: 'It is working again' }] }, [{ id: 'U1', kind: 'user_report', text: 'It is working again' }]);
  assert.equal(reported.verified, false);
});

for (const sqlite of [false, true]) test(`expert solution enters an idempotent governed draft (${sqlite ? 'SQLite' : 'JSON'})`, async t => {
  const { records, store, studio, incident } = await setup(t, sqlite);
  const body = expertBody(incident), saved = await records.expertSolution(incident.id, body);
  const solution = saved.expertSolutions[0], draft = await studio.get(solution.pillDraftId);
  assert.equal(solution.expert, who.name); assert.equal(solution.status, 'pending_incorporation');
  assert.equal(draft.state, 'draft'); assert.equal(draft.releases.length, 0);
  assert.equal(draft.content.sources[0].expert, who.name);
  assert.equal(draft.learningImports[0].kind, 'expert_case_solution');
  assert.equal(draft.learningImports[0].status, 'pending_incorporation');
  assert.ok(draft.contributorIds.includes(who.id));
  await records.expertSolution(incident.id, body);
  assert.equal((await store.list())[0].expertSolutions.length, 1);
  assert.equal((await studio.get(draft.id)).content.sources.length, 1);
  await assert.rejects(records.expertSolution(incident.id, { ...body, solution: 'Changed solution' }), { status: 409 });
});

test('expert update preserves published snapshot and requires incorporation plus independent publication review', async t => {
  const { records, store, studio, incident } = await setup(t);
  let r = await studio.get(ahuPill.id);
  const content = structuredClone(r.content);
  content.sources = [{ expert: 'Original expert', reference: 'Fixture', knowledge: 'Verify readings.' }];
  content.examples = [{ scenario: 'Warm room', rationale: 'Verify readings', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  const auth = { authenticatedActor: { id: 'admin1', name: 'Admin' }, authenticatedRoles: ['admin'] };
  r = await studio.change(r.id, 'save', { revision: r.revision, content, ...auth });
  r = await studio.change(r.id, 'validate', { revision: r.revision, ...auth });
  r = await studio.change(r.id, 'submit', { revision: r.revision, ...auth });
  r = await studio.change(r.id, 'publish', { revision: r.revision, ...auth });
  const original = structuredClone(r.releases);
  incident.messages[1].matchedPills = [{ id: r.id, version: r.releases[0].pill.version, name: r.content.pill.name }];
  const current = await store.update(incident.id, { messages: incident.messages }, incident.revision);
  const saved = await records.expertSolution(incident.id, { ...expertBody(current), targetPillId: r.id });
  const draft = await studio.get(saved.expertSolutions[0].pillDraftId);
  assert.deepEqual(draft.releases, original);
  assert.equal((await studio.runtimePills())[0].version, original[0].pill.version);
  await assert.rejects(studio.change(draft.id, 'publish', { revision: draft.revision, reviewer: 'Other', authenticatedActor: { id: 'reviewer-2', name: 'Other' }, notes: 'Attempt', expertConfirmed: true }), { status: 403 });
  const released=await studio.change(draft.id, 'publish', { revision: draft.revision, authenticatedActor: who, authenticatedRoles: ['admin'] });
  assert.equal(released.state,'published');assert.deepEqual(released.releases[0].pill,original[0].pill);
});

test('failed JSON draft import preserves solution and retry recovers without duplication', async t => {
  const { store, studio, incident } = await setup(t); let first = true;
  const records = createCaseRecords(store, { importExpertSolution: async input => { if (first) { first = false; throw new Error('Temporary storage error'); } return studio.importExpertSolution(input); } });
  const body = expertBody(incident);
  await assert.rejects(records.expertSolution(incident.id, body));
  assert.equal((await store.list())[0].expertSolutions[0].status, 'pending_draft');
  const saved = await records.expertSolution(incident.id, body);
  assert.equal(saved.expertSolutions.length, 1); assert.ok(saved.expertSolutions[0].pillDraftId);
});

test('single expert solution field creates a Case-scoped draft with unverified limits', async t => {
  const { records, incident } = await setup(t);
  const body = expertBody(incident); delete body.applicability; delete body.limitations;
  const saved = await records.expertSolution(incident.id, body);
  assert.match(saved.expertSolutions[0].applicability, /Case-specific/);
  assert.match(saved.expertSolutions[0].limitations, /must be verified before release/);
});

test('route authorization prevents spoofed experts and binds confirmation identity', async t => {
  const { store, studio, incident } = await setup(t);
  const handler = createHandler(store, undefined, undefined, studio);
  const request = async (suffix, roles, body) => {
    const req = Readable.from([JSON.stringify(body)]); Object.assign(req, { method: 'POST', url: `/api/cases/${incident.id}/${suffix}`, headers: { host: 'localhost' }, authenticatedActor: who, authenticatedRoles: roles });
    let status, data; await handler(req, { writeHead(s) { status = s; }, end(text) { data = JSON.parse(text); } }); return { status, ...data };
  };
  assert.equal((await request('expert-solutions', ['operator'], expertBody(incident))).status, 403);
  assert.equal((await request('expert-experience-confirmation', ['reviewer'], { solutionId: 'E1', confirmed: true })).status, 403);
  assert.equal(permitted({ roles: ['operator'] }, `/api/cases/${incident.id}/expert-experience-confirmation`, 'POST'), false);
  assert.equal((await request('confirmations', ['expert'], { revision: 0, messageId: 'A1', decision: 'approved', subject: 'Attempt', confirmed: true })).status, 403);
  assert.equal(permitted({ roles: ['operator'] }, `/api/cases/${incident.id}/expert-solutions`, 'POST'), false);
  const result = await request('confirmations', ['reviewer'], { revision: 0, subject: 'Verified asset', confirmed: true, authenticatedActor: { id: 'fake', name: 'Fake' } });
  assert.equal(result.status, 200); assert.equal(result.incident.humanConfirmations[0].confirmedBy, who.name);
});
