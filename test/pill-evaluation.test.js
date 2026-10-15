import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPillStudio } from '../pill-studio.js';
import { ahuPill } from '../triage.js';
import { validateSuite, evaluationGate, evaluatePill } from '../pill-evaluation.js';
import { releaseHash } from '../pill-versions.js';
import { JSDOM } from 'jsdom';
import { evaluationMarkup, bindEvaluation } from '../public/evaluation.js';

const suite = () => [{ name: 'Grounded condition', facts: { category: 'hvac_cooling', asset: 'AHU-1', observations: 'Room temperature 29 C' }, expected: { status: 'complete', ruleIds: ['HVAC-01'], actionIds: ['check-readings'], missingFields: [] } }, { name: 'Other domain', facts: { category: 'lift_fault', asset: 'Lift-1', observations: 'Stopped' }, expected: { status: 'out_of_scope', ruleIds: [], actionIds: [], missingFields: [] } }];
const agent = async () => ({ summary: 'Verify readings.', hypotheses: [{ ruleId: 'HVAC-01', reasoning: 'Check readings.', evidence: [{ field: 'observations', quote: 'Room temperature 29 C' }], uncertainties: [] }], actionIds: ['check-readings'], missingFields: [], prioritySuggestion: null });
async function setup(t, evaluationAgent = agent) {
  const dir = await mkdtemp(join(tmpdir(), 'pill-eval-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pills.json'), studio = createPillStudio(file, { evaluationAgent });
  let r = await studio.get(ahuPill.id);
  r.content.sources = [{ expert: 'Expert', reference: 'Fixture', knowledge: 'Verify readings.' }];
  r.content.examples = [{ scenario: 'Warm room', rationale: 'Compare readings.', ruleIds: ['HVAC-01'], actionIds: ['check-readings'] }];
  await studio.change(r.id, 'save', { revision: r.revision, content: r.content });
  const change = async (op, body = {}) => studio.change(r.id, op, { revision: (await studio.get(r.id)).revision, ...body });
  await change('save-evaluations', { suite: suite() });
  const evaluate = async () => studio.evaluate(r.id, { revision: (await studio.get(r.id)).revision });
  const review = async () => { await change('validate'); await change('submit'); };
  const publish = () => change('publish', { reviewer: 'Expert', notes: 'Reviewed sources and evaluation.', expertConfirmed: true });
  return { file, studio, change, evaluate, review, publish, get: () => studio.get(r.id) };
}
test('suite accepts relevant supported cases and enforces strict expected result types', () => {
  assert.equal(validateSuite(suite()).length, 2);assert.equal(validateSuite([suite()[0]]).length,1);assert.throws(()=>validateSuite([suite()[1]]),{status:422});
  for (const value of [[], [{ ...suite()[0], expected: { ...suite()[0].expected, ruleIds: 'HVAC-01' } }, suite()[1]]]) assert.throws(() => validateSuite(value), { status: 422 });
});
test('release gate, evaluation evidence and checksums survive restart', async t => {
  const s = await setup(t); await assert.rejects(s.review(), /successful evaluation/);
  const r = await s.evaluate(); assert.equal(r.evaluationGate.passed, true); assert.equal(r.evaluations[0].results.length, 2);
  await s.review(); const released = await s.publish(), release = released.releases.at(-1);
  assert.equal(release.evaluation.passed, true); assert.equal(release.contentHash, releaseHash(release));
  assert.equal((await createPillStudio(s.file).get(ahuPill.id)).evaluationGate.state, 'published_with_evaluation');
  await s.change('fork'); assert.equal((await s.get()).evaluationGate.state, 'outdated');
  const second = await s.evaluate(); assert.ok(second.evaluations.at(-1).results.every(r => r.baseline.passed));
});
test('edits invalidate evaluation and suite cannot be emptied to remove its gate', async t => {
  const s = await setup(t); await s.evaluate(); const r = await s.get(); r.content.pill.scope += ' Updated scope.';
  await s.change('save', { content: r.content }); assert.equal((await s.get()).evaluationGate.state, 'outdated');
  await assert.rejects(s.review(), /successful evaluation/);
  await assert.rejects(s.change('save-evaluations', { suite: [] }), { status: 422 });
  assert.equal((await s.get()).evaluationRequired, true);
});
test('provider and ungrounded evidence failures persist as failed evaluations', async t => {
  const s = await setup(t, async () => { throw new Error('secret provider detail'); });
  const r = await s.evaluate(); assert.equal(r.evaluationGate.state, 'failed'); assert.ok(!JSON.stringify(r.evaluations).includes('secret provider'));
  await assert.rejects(s.review(), /successful evaluation/);
  const record = await s.get(); const run = await evaluatePill(record, async () => { const result = await agent(); result.hypotheses[0].evidence[0].quote = 'invented'; return result; });
  assert.equal(run.passed, false);
});
test('evaluation retains stale results without overwriting edits and rejects duplicate runs', async t => {
  let release, entered; const ready = new Promise(r => { entered = r; }), wait = new Promise(r => { release = r; });
  const s = await setup(t, async () => { entered(); await wait; return agent(); });
  const pending = s.evaluate(); await ready;
  try {
    await assert.rejects(s.evaluate(), { status: 409 });
    const r = await s.get(); r.content.pill.name = 'Changed while running'; await s.change('save', { content: r.content });
  } finally { release(); }
  await pending; const r = await s.get(); assert.equal(r.content.pill.name, 'Changed while running'); assert.equal(r.evaluationGate.state, 'outdated');
});
test('current baseline is replayed on identical cases and regressions are identified', async t => {
  const s = await setup(t); await s.evaluate(); await s.review(); await s.publish(); await s.change('fork');
  const r = await s.get(); r.content.pill.name = 'Candidate';
  const result = await evaluatePill(r, async (snap, pill) => { const value = await agent(); if (pill.name === 'Candidate') value.actionIds = []; return value; });
  assert.equal(result.results[0].regression, true); assert.equal(result.passed, false);
  assert.equal(evaluationGate({ ...r, evaluations: [result] }).passed, false);
});
test('evaluation UI preserves dirty suites, sends structured tests and escapes results', t => {
  const r = { state: 'draft', evaluationSuite: validateSuite(suite()), evaluationRequired: true, evaluations: [], evaluationGate: { state: 'not_run' } };
  const dom = new JSDOM(`<main><p id="studio-error" hidden></p>${evaluationMarkup(r)}</main>`); t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main'); let operation;
  bindEvaluation(root, r, (op, data) => { operation = { op, data }; }, () => {});
  const name = root.querySelector('[name=testName]'); name.value = '<script>test</script>'; name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelectorAll('[name=workflow-steps]').forEach(el=>el.value='Record symptoms and refer within the supplied knowledge scope.');
  root.querySelector('[data-run-evaluation]').click(); assert.equal(operation.op,'save-evaluations');assert.equal(operation.data.sharedExamples,true);
  root.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(operation.op, 'save-evaluations'); assert.equal(operation.data.suite.length, 2);
  assert.ok(!evaluationMarkup({ ...r, evaluationSuite: operation.data.suite }).includes('<script>'));
});

test('Save only persists an incomplete scenario across restart without allowing evaluation', async t => {
 const s=await setup(t);const row={name:'Unfinished scenario',mode:'scenario',facts:{category:'hvac_cooling',description:'Reported warm room'},expected:{status:'complete',ruleIds:[],actionIds:[],missingFields:[]}};
 await s.change('save-evaluations',{suite:[row],draftOnly:true,sharedExamples:true,autoValidate:true});
 const restored=await createPillStudio(s.file).get(ahuPill.id);assert.equal(restored.evaluationSuite[0].name,'Unfinished scenario');assert.equal(restored.evaluationSuite[0].facts.description,'Reported warm room');assert.equal(restored.validation.passed,false);await assert.rejects(s.evaluate(),{status:422});
});
