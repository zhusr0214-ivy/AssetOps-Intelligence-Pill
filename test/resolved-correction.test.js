import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageResult, ahuPill } from '../triage.js';
const quote = 'the room temperature is 26°C, not 28.4°C.';
const uncertainty = 'Room temperature discrepancy context is unclear.';
const proposal = () => ({ summary: 'Room temperature is 26°C.', hypotheses: [{
  ruleId: 'HVAC-01', reasoning: 'Verify readings.', evidence: [{ field: 'observations', quote }],
  uncertainties: [uncertainty, 'Reading timestamps are not provided.']
}], actionIds: [], missingFields: [], prioritySuggestion: null });

test('confirmed correction removes the known spurious discrepancy but keeps timestamps and full evidence', () => {
  const result = validateTriageResult(proposal(), { fields: { observations: quote } }, ahuPill);
  assert.deepEqual(result.hypotheses[0].uncertainties, ['Reading timestamps are not provided.']);
  assert.equal(result.hypotheses[0].evidence[0].quote, quote);
});

test('another affirmative incompatible reading preserves the conflict warning', () => {
  const result = validateTriageResult(proposal(), { fields: { observations: quote + '\nThe room temperature is 28.4°C.' } }, ahuPill);
  assert.ok(result.hypotheses[0].uncertainties.includes(uncertainty));
});
