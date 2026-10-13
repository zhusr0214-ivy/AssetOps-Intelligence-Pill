import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { workQueueMarkup, pillProgressMarkup, reportDecisionMarkup, learningTrailMarkup } from '../public/workflow.js';

const pill = () => ({ id: 'P1', state: 'validated', content: { pill: { owner: 'Expert' } }, validation: { passed: true }, releases: [], evaluationGate: { required: true, passed: false, state: 'expert_review_required' } });
test('Pill guidance honors pending learning, validation and evaluation before publication', () => {
  const record = pill();
  assert.match(pillProgressMarkup(record), /Independent evaluation review required/);
  record.state = 'in_review'; assert.match(pillProgressMarkup(record), /Independent evaluation review required/);
  record.evaluationGate.passed = true; assert.match(pillProgressMarkup(record), /Awaiting publication decision/);
  record.learningImports = [{ status: 'pending_incorporation' }]; assert.match(pillProgressMarkup(record), /Learning incorporation pending/);
  record.learningImports = []; record.validation.passed = false; assert.match(pillProgressMarkup(record), /Draft requires validation/);
});
test('AI report guidance never treats a complete or stale report as operational authorization', () => {
  assert.match(reportDecisionMarkup({ status: 'complete' }, 'C1'), /not execution approval/);
  assert.match(reportDecisionMarkup({ status: 'complete', stale: true }, 'C1'), /Outdated evidence/);
  assert.match(reportDecisionMarkup({ status: 'knowledge_gap' }, 'C1'), /Specialist judgement required/);
  assert.match(reportDecisionMarkup({ status: 'partial_failure' }, 'C1'), /Analysis incomplete/);
  assert.match(reportDecisionMarkup({ status: 'needs_information' }, 'C1'), /Add case information/);
});
test('shared work queues deduplicate information requests, cap previews and escape content', t => {
  const incidents = [{ id: 'C1', status: 'needs_info', title: '<img src=x>' }];
  const reviews = [{ id: 'C1', state: 'request_information', title: '<img src=x>' }, ...Array.from({ length: 8 }, (_, n) => ({ id: `R${n}`, title: `Review ${n}`, state: 'pending' }))];
  const dom = new JSDOM(workQueueMarkup(incidents, reviews, [])); t.after(() => dom.window.close());
  const root = dom.window.document, groups = root.querySelectorAll('.queue-group');
  assert.equal(groups[0].querySelectorAll('li').length, 5);
  assert.equal(groups[0].querySelector('.badge').textContent, '8');
  assert.equal(groups[1].querySelectorAll('li').length, 1);
  assert.equal(root.querySelector('img'), null);
  assert.match(root.body.textContent, /Shared queues/);
});
test('learning trace distinguishes accepted proposals and draft receipts from publication', () => {
  const html = learningTrailMarkup({ handlingRecords: [{}], learningRuns: [{ proposals: [{ decision: { status: 'accepted' }, importReceipt: { pillId: 'P1' } }] }] });
  assert.match(html, /\/studio\/P1\?view=sources/);
  assert.match(html, /Draft receipt recorded/);
  assert.match(html, /not proof of a published version/);
  assert.doesNotMatch(learningTrailMarkup({}), /Draft receipt recorded/);
});
