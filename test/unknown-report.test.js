import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageResult, ahuPill } from '../triage.js';

const combined = 'Timestamps for the temperature readings and the start of the incident are missing.';
const proposal = () => ({ summary: 'The incident start time is not provided.', hypotheses: [{
  ruleId: 'HVAC-01', reasoning: 'Verify readings.',
  evidence: [{ field: 'observations', quote: 'Room temperature is 28°C.' }],
  uncertainties: [combined, 'Actual airflow is not reported.']
}], actionIds: [], missingFields: ['occurredAt', 'observations'], prioritySuggestion: null });
const snapshot = occurredAt => ({ fields: { occurredAt, observations: 'Room temperature is 28°C.' } });

test('explicit unknown is retained as a limitation, without asking the same field again', () => {
  for (const occurredAt of ['Unknown', 'unknown', 'Not sure', '未知']) {
    const result = validateTriageResult(proposal(), snapshot(occurredAt), ahuPill);
    assert.equal(result.summary, 'The incident start time is explicitly reported as unknown.');
    assert.equal(result.hypotheses[0].uncertainties[0], 'Timestamps for the temperature readings are not provided. The incident start time is explicitly reported as unknown.');
    assert.equal(result.hypotheses[0].uncertainties[1], 'Actual airflow is not reported.');
    assert.deepEqual(result.missingFields, ['observations']);
    assert.deepEqual(result.hypotheses[0].evidence, proposal().hypotheses[0].evidence);
  }
});

test('empty and absent start times remain unanswered, not explicitly unknown', () => {
  for (const occurredAt of ['', undefined]) {
    const result = validateTriageResult(proposal(), snapshot(occurredAt), ahuPill);
    assert.ok(result.missingFields.includes('occurredAt'));
    assert.equal(result.hypotheses[0].uncertainties[0], combined);
  }
});

test('explicit unknown start does not remove separate reading timestamp uncertainty', () => {
  const value = proposal();
  value.hypotheses[0].uncertainties = ['Reading timestamps are not provided.', 'The start time is missing.'];
  const result = validateTriageResult(value, snapshot('Unknown'), ahuPill);
  assert.deepEqual(result.hypotheses[0].uncertainties, [
    'Reading timestamps are not provided.', 'The incident start time is explicitly reported as unknown.'
  ]);
});
