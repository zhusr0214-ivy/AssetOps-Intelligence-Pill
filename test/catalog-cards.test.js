import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageResult, ahuPill } from '../triage.js';
import { reportMarkup } from '../public/triage.js';

const snapshot = { fields: { description: 'AHU cooling issue', observations: 'The fan is running.' } };
const proposal = ruleId => ({ summary: 'Cooling needs verification.', hypotheses: [{
  ruleId, reasoning: 'Unwanted generated narrative.', reasoningSource: 'pill',
  evidence: [{ field: 'observations', quote: 'The fan is running.' }],
  uncertainties: ['Actual airflow is unverified.']
}], actionIds: [], missingFields: [], prioritySuggestion: null });

test('each selected rule uses its own catalog explanation and retains case evidence', () => {
  for (const rule of ahuPill.rules) {
    const value = proposal(rule.id);
    const result = validateTriageResult(value, snapshot, ahuPill);
    assert.equal(result.hypotheses.length, 1);
    assert.equal(result.hypotheses[0].reasoning, rule.cardExplanation);
    assert.equal(result.hypotheses[0].reasoningSource, 'pill');
    assert.deepEqual(result.hypotheses[0].evidence, value.hypotheses[0].evidence);
    assert.deepEqual(result.hypotheses[0].uncertainties, value.hypotheses[0].uncertainties);
    assert.equal(value.hypotheses[0].reasoning, 'Unwanted generated narrative.');
  }
});

test('templates cannot bypass quote validation or add unselected hypotheses', () => {
  const value = proposal('HVAC-03'); value.hypotheses[0].evidence[0].quote = 'Invented reading';
  assert.throws(() => validateTriageResult(value, snapshot, ahuPill), /quote has no unambiguous matching source/);
  const empty = proposal('HVAC-01'); empty.hypotheses = [];
  assert.deepEqual(validateTriageResult(empty, snapshot, ahuPill).hypotheses, []);
});

test('duplicate case wording resolves to the specific structured source', () => {
  const value = proposal('HVAC-01');
  value.hypotheses[0].evidence[0].field = 'location';
  const repeated = { fields: { description: 'The fan is running.', observations: 'The fan is running.' } };
  const result = validateTriageResult(value, repeated, ahuPill);
  assert.deepEqual(result.hypotheses[0].evidence[0], { field: 'observations', quote: 'The fan is running.' });
});

test('matching numbers in different facts cannot repair a mislabeled evidence source', () => {
  const value = proposal('HVAC-01');
  value.hypotheses[0].evidence = [{ field: 'impact', quote: '29 C' }];
  const readings = { fields: { description: 'Supply air temperature was 29 C.', observations: 'Room temperature was 29 C.', impact: 'Office discomfort.' } };
  assert.throws(() => validateTriageResult(value, readings, ahuPill), /quote has no unambiguous matching source/);
});

test('different context or negation cannot be treated as duplicate evidence', () => {
  const value = proposal('HVAC-01');
  value.hypotheses[0].evidence = [{ field: 'location', quote: 'fan is running' }];
  const conflicting = { fields: { description: 'The fan is running.', observations: 'It is not confirmed that the fan is running.' } };
  assert.throws(() => validateTriageResult(value, conflicting, ahuPill), /quote has no unambiguous matching source/);
});

test('a unique alternate source still repairs a mislabeled field', () => {
  const value = proposal('HVAC-01');
  value.hypotheses[0].evidence = [{ field: 'impact', quote: 'Supply air temperature was 29 C.' }];
  const readings = { fields: { description: 'Supply air temperature was 29 C.', observations: 'Room temperature was 29 C.', impact: 'Office discomfort.' } };
  assert.deepEqual(validateTriageResult(value, readings, ahuPill).hypotheses[0].evidence, [{ field: 'description', quote: 'Supply air temperature was 29 C.' }]);
});

test('a matching explicitly named source is preserved even when other fields share the quote', () => {
  const value = proposal('HVAC-01');
  value.hypotheses[0].evidence = [{ field: 'description', quote: '29 C' }];
  const readings = { fields: { description: 'Supply air temperature was 29 C.', observations: 'Room temperature was 29 C.' } };
  assert.deepEqual(validateTriageResult(value, readings, ahuPill).hypotheses[0].evidence, [{ field: 'description', quote: '29 C' }]);
});

test('rendering uses the saved explanation and labels it separately from evidence', () => {
  const result = validateTriageResult(proposal('HVAC-03'), snapshot, ahuPill);
  const report = { ...result, snapshot, pill: structuredClone(ahuPill), status: 'complete', id: 'test', createdAt: '2026-10-08' };
  const html = reportMarkup(report, 'case');
  assert.match(html, /Rule explanation/);
  assert.match(html, /Case evidence/);
  assert.ok(!html.includes('Unwanted generated narrative'));
  report.pill.rules.find(rule => rule.id === 'HVAC-03').cardExplanation = 'Later catalog change';
  assert.equal(reportMarkup(report, 'case'), html);
  report.hypotheses[0].reasoning = 'Historical model text';
  delete report.hypotheses[0].reasoningSource;
  const historical = reportMarkup(report, 'case');
  assert.match(historical, /Historical model text/);
  assert.ok(!historical.includes('Rule explanation'));
});
