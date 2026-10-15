import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCaseSupervision } from '../case-supervision.js';
import { detectCaseOperations } from '../case-operation-policy.js';
import { supervisionMarkup, confirmationMarkup } from '../public/case-records.js';

const plain = { citations: [], expertRequest: { required: false, reason: '' }, supervision: { required: false } };
const context = { sources: [], pills: [], latestText: 'Where is the asset?' };
test('routine fact collection does not require human intervention', () => {
  assert.equal(assessCaseSupervision(plain, context), null);
});

test('important operation requests automatically require expert input without an explicit expert request', () => {
  for (const latestText of ['Should I restart the unit or reset the fault?', 'Can I lower the temperature setpoint?', 'Should we restore the power supply?', 'Please close the valve.', 'Can I replace the compressor?', 'Should I stop the fire pump?', '要不要重启空调？', '可以调整压力吗？', '准备恢复供电']) {
    const result = assessCaseSupervision(plain, { ...context, latestText });
    assert.equal(result?.mode, 'expert', latestText);
    assert.equal(result.kind, 'knowledge_gap', latestText);
  }
});
test('ordinary questions, history and negations do not independently trigger an operation request', () => {
  for (const latestText of ['What is a fault reset?', 'Explain the meaning of restart.', 'We already restarted the unit yesterday.', 'Do not restart the unit.', '空调不制冷，需要提供哪些信息？', '昨天已经重启空调。', '不要屏蔽保护。']) {
    assert.deepEqual(detectCaseOperations(latestText), [], latestText);
    assert.equal(assessCaseSupervision(plain, { ...context, latestText }), null, latestText);
  }
});
test('matching a Pill alone is insufficient, and unsafe generated instructions are also caught', () => {
  assert.equal(assessCaseSupervision(plain, { ...context, pills: [{ id: 'P1', version: '1' }], latestText: 'Should I restart the unit?' }).mode, 'expert');
  assert.equal(assessCaseSupervision({ ...plain, answer: 'Restart the unit now.' }, context).mode, 'expert');
  assert.equal(assessCaseSupervision(plain, { ...context, latestText: 'Can I disable the alarm?' }).mode, 'escalation');
  assert.equal(assessCaseSupervision(plain, { ...context, latestText: '可以绕过安全联锁吗？' }).mode, 'escalation');
});
test('validated model judgments distinguish expert review, approval and safety escalation', () => {
  for (const kind of ['knowledge_gap', 'scope', 'conflict', 'approval', 'safety', 'expert_requested']) {
    const request = assessCaseSupervision({ ...plain, supervision: { required: true, kind, subject: 'Specific question', reason: 'Evidence needs review' } }, context);
    assert.equal(request.mode, kind === 'safety' ? 'escalation' : 'expert');
    assert.equal(request.advisoryOnly, true);
  }
  assert.throws(() => assessCaseSupervision({ ...plain, supervision: { required: true, kind: 'anything' } }, context), { status: 502 });
});
test('Pill approval flags and protected boundary checks cannot be cleared by model output', () => {
  const source = { sourceId: 'action-1', requiresApproval: true, actionTitle: 'Controlled action' };
  const ctx = { ...context, sources: [source], pills: [{ id: 'P1', version: '1.0' }] };
  const proposed = { ...plain, citations: [{ sourceId: source.sourceId }] };
  const request = assessCaseSupervision(proposed, ctx);
  assert.equal(request.mode, 'review'); assert.deepEqual(request.pillVersions, ctx.pills);
  assert.equal(assessCaseSupervision(proposed, { ...ctx, latestText: 'bypass the interlock' }).mode, 'escalation');
  assert.equal(assessCaseSupervision({ ...proposed, supervision: { required: true, kind: 'safety', subject: 'Unsafe', reason: 'Restricted' } }, ctx).mode, 'escalation');
  assert.equal(assessCaseSupervision({ ...proposed, supervision: { required: true, kind: 'conflict', subject: 'Conflict', reason: 'Contradictory guidance' } }, ctx).mode, 'expert');
});
test('explicit expert request and legacy knowledge gaps retain human intervention', () => {
  assert.equal(assessCaseSupervision(plain, { ...context, latestText: '请专家确认' }).kind, 'expert_requested');
  assert.equal(assessCaseSupervision({ ...plain, expertRequest: { required: true, reason: 'No supported solution' } }, context).kind, 'knowledge_gap');
});
test('read-only history preserves pending requests, decision identity and escaped text', () => {
  const incident = { messages: [{ id: 'A1', role: 'assistant', supervision: { required: true, mode: 'review', subject: '<script>x</script>', reason: 'Review scope', pillVersions: [] } }], humanConfirmations: [{ sourceMessageId: 'A1', decision: 'rejected', subject: 'Does not apply', confirmedBy: 'Reviewer' }] };
  const html = confirmationMarkup(incident);
  assert.match(html, /rejected/); assert.match(html, /Reviewer/); assert.doesNotMatch(html, /<script>|<form/);
  assert.match(supervisionMarkup(incident), /Does not apply/);
});
