import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePill, evaluationOptions, evaluationGate, sampleStatistics } from '../pill-evaluation.js';
import { createPillStudio } from '../pill-studio.js';
import { ahuPill } from '../triage.js';
import { permitted } from '../auth.js';
import { JSDOM } from 'jsdom';
import { evaluationMarkup, bindEvaluation } from '../public/evaluation.js';

const suite = () => [{ name: 'Warm room', facts: { category: 'hvac_cooling', asset: 'AHU-1', observations: 'Room temperature 29 C' }, expected: { status: 'complete', ruleIds: ['HVAC-01'], actionIds: ['check-readings'], missingFields: [] } }, { name: 'Outside scope', facts: { category: 'lift_fault', asset: 'Lift-1', observations: 'Stopped' }, expected: { status: 'out_of_scope', ruleIds: [], actionIds: [], missingFields: [] } }];
const agent = async () => ({ summary: 'Check readings.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check measurements.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
const record = () => ({ state: 'draft', content: { pill: structuredClone(ahuPill) }, evaluationSuite: suite(), evaluationOptions: { repetitions: 3, minimumPassRate: 1, expertReviewRequired: true }, evaluationRequired: true, releases: [] });

test('repeated trials retain failures, structured variability and uncertainty without cherry-picking', async () => {
  let calls = 0; const r = record(), run = await evaluatePill(r, async () => { const result = await agent(); if (++calls === 2) result.actionIds = []; return result; });
  assert.equal(calls, 3); assert.equal(run.results[0].candidate.samples.length, 3);
  assert.equal(run.results[0].candidate.statistics.passRate, 2 / 3); assert.equal(run.results[0].candidate.statistics.unstable, true);
  assert.equal(run.passed, false); assert.equal(run.statistics.samples, 6); assert.equal(run.coverage.safetyProof, false);
  assert.equal(run.modelStatistics.samples, 3); assert.equal(run.modelStatistics.passRate, 2 / 3);
  assert.ok(run.results[0].candidate.statistics.interval95.lower < 2 / 3); assert.ok(run.results[0].candidate.statistics.interval95.upper > 2 / 3);
});
test('provider failures and unreliable baseline comparison cannot be hidden by a relaxed threshold', async () => {
  const r = record(); r.evaluationOptions = { repetitions: 5, minimumPassRate: 0.8, expertReviewRequired: true };
  let calls = 0; const failed = await evaluatePill(r, async () => { if (++calls === 1) throw new Error('secret'); return agent(); });
  assert.equal(failed.results[0].candidate.statistics.passRate, 0.8); assert.equal(failed.passed, false); assert.ok(!JSON.stringify(failed).includes('secret'));
  r.releases = [{ active: true, pill: { ...structuredClone(ahuPill), name: 'Baseline' } }];
  const baselineFailure = await evaluatePill(r, async (facts, pill) => { if (pill.name === 'Baseline') throw new Error(); return agent(); });
  assert.equal(baselineFailure.results[0].comparisonReliable, false); assert.equal(baselineFailure.passed, false);
});
test('evaluation settings are bounded and become part of freshness checks', async () => {
  for (const options of [{ repetitions: 0 }, { repetitions: 6 }, { minimumPassRate: 0.5 }, { minimumPassRate: 0.8 }, { expertReviewRequired: 'yes' }]) assert.throws(() => evaluationOptions(options));
  const r = record(), run = await evaluatePill(r, agent); r.evaluations = [run];
  assert.equal(evaluationGate(r).state, 'expert_review_required');
  r.evaluationOptions.repetitions = 4; assert.equal(evaluationGate(r).state, 'outdated');
  const stats = sampleStatistics(Array.from({ length: 3 }, () => ({ passed: true, actual: {}, durationMs: 10 })));
  assert.ok(stats.interval95.lower < 1); assert.equal(stats.averageMs, 10);
});
test('expert review is independent, scoped, immutable and captured in publication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'evaluation-review-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const studio = createPillStudio(join(directory, 'pills.json'), { evaluationAgent: agent });
  let r = await studio.get(ahuPill.id);
  const author = { id: 'author', name: 'Author' }, reviewer = { id: 'reviewer', name: 'Expert' };
  r.content.sources = [{ expert: 'Expert', reference: 'Source', knowledge: 'Compare readings.' }];
  r.content.examples = [{ scenario: 'Warm room', rationale: 'Check readings', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  const change = async (operation, input = {}) => { r = await studio.change(r.id, operation, { revision: r.revision, authenticatedActor: author, ...input }); return r; };
  await change('save', { content: r.content }); await change('save-evaluations', { suite: suite(), options: record().evaluationOptions });
  r = await studio.evaluate(r.id, { revision: r.revision, authenticatedActor: author });
  const input = () => ({ revision: r.revision, runId: r.evaluations.at(-1).id, authenticatedActor: reviewer, decision: 'accepted', confirmed: true, scope: 'AHU-1 warm room', limitations: 'No plant control authority', qualification: 'Building operations experience', reference: 'Expert review fixture', notes: 'Reviewed every trial and source' });
  await assert.rejects(studio.reviewEvaluation(r.id, { ...input(), authenticatedActor: author }), { status: 403 });
  await assert.rejects(studio.reviewEvaluation(r.id, { ...input(), reference: '' }), { status: 422 });
  r = await studio.reviewEvaluation(r.id, input()); assert.equal(evaluationGate(r).passed, true);
  assert.equal(r.evaluations.at(-1).expertReview.certification, false);
  await assert.rejects(studio.reviewEvaluation(r.id, input()), { status: 409 });
  await change('validate'); await change('submit');
  const published = await change('publish', { authenticatedActor: reviewer, reviewer: reviewer.name, notes: 'Scoped approval', expertConfirmed: true });
  assert.equal(published.releases.at(-1).evaluation.expertReview.actorId, reviewer.id);
  assert.equal(permitted({ roles: ['expert'] }, `/api/studio/${r.id}/review-evaluation`, 'POST'), false);
  assert.equal(permitted({ roles: ['reviewer'] }, `/api/studio/${r.id}/review-evaluation`, 'POST'), true);
});
test('UI saves repeat policy with suite and labels evidence limitations', t => {
  const r = record(), dom = new JSDOM(`<main><p id="studio-error"></p>${evaluationMarkup(r)}</main>`); t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main'); let sent;
  bindEvaluation(root, r, (operation, body) => { sent = { operation, body }; }, () => {});
  const repeats = root.querySelector('[name=repetitions]'); repeats.value = '5'; repeats.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelector('[data-run-evaluation]').click(); assert.equal(sent, undefined);
  root.querySelector('#evaluation-suite').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(sent.body.options.repetitions, 5); assert.equal(sent.body.options.expertReviewRequired, true);
});
