import test from 'node:test';
import assert from 'node:assert/strict';
import { learningSnapshot, createLearningService } from '../learning.js';

const incident = { id: 'C1', revision: 1, title: 'Cooling issue', messages: [{ id: 'U1', role: 'user', state: 'complete', content: 'Cooling improved' }, { id: 'A1', role: 'assistant', content: 'Advice', matchedPills: [{ id: 'P1', version: '1' }] }], humanConfirmations: [{ id: 'H1', subject: 'Review only' }], expertSolutions: [{ id: 'E1', solution: 'Proposal' }], resultFeedback: { summary: 'Reported improvement', verified: false } };
test('Case handoff retains provenance without converting chat or AI summary into verified outcomes', () => {
  const snapshot = learningSnapshot(incident);
  assert.equal(snapshot.verifiedOutcome, false);
  assert.ok(snapshot.blocks.some(b => b.kind === 'user_report_unverified'));
  assert.ok(snapshot.blocks.some(b => b.kind === 'expert_proposal_not_execution'));
  assert.ok(snapshot.blocks.some(b => b.kind === 'human_decision_not_execution'));
  assert.ok(snapshot.blocks.some(b => b.kind === 'ai_summary_unverified'));
  assert.ok(!snapshot.blocks.some(b => b.id === 'chat:A1'));
});
test('conversation learning resolves the referenced Pill and rejects stale releases', async () => {
  let captured, saved;
  const store = { list: async () => [incident], update: async (id, value) => { saved = value; } };
  const studio = { runtimePills: async () => [{ id: 'P1', version: '1', status: 'approved' }] };
  const service = createLearningService(store, studio, async snapshot => { captured = snapshot; return { summary: 'Needs verified evidence', questions: ['What was verified?'], proposals: [] }; });
  await service.analyze('C1', { revision: 1 });
  assert.equal(captured.pill.id, 'P1'); assert.equal(captured.verifiedOutcome, false);
  assert.equal(saved.learningRuns.length, 1);
  studio.runtimePills = async () => [{ id: 'P1', version: '2', status: 'approved' }];
  await assert.rejects(service.analyze('C1', { revision: 1 }), { status: 409 });
});
