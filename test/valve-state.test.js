import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageResult, ahuPill } from '../triage.js';

const command = 'The chilled water valve command is 89%.';
const snapshot = { fields: { description: 'Cooling issue', observations: command } };
const report = () => ({
  summary: 'Cooling requires verification.',
  hypotheses: [{ ruleId: 'HVAC-03', reasoning: 'The actual valve position and water flow are unverified.',
    evidence: [{ field: 'observations', quote: command }], uncertainties: ['Actual position is unknown.'] }],
  actionIds: [], missingFields: [], prioritySuggestion: null
});

test('valid command citation does not authorize an unsupported state in any narrative section', () => {
  for (const section of ['summary', 'reasoning', 'uncertainties', 'priority']) {
    const value = report();
    const wrong = 'Cooling is limited despite the fan running and valve being open.';
    if (section === 'summary') value.summary = wrong;
    if (section === 'reasoning') value.hypotheses[0].reasoning = wrong;
    if (section === 'uncertainties') value.hypotheses[0].uncertainties = [wrong];
    if (section === 'priority') value.prioritySuggestion = { value: 'medium', reason: wrong };
    if (section === 'reasoning') {
      const result = validateTriageResult(value, snapshot, ahuPill);
      assert.equal(result.hypotheses[0].reasoning, ahuPill.rules.find(rule => rule.id === 'HVAC-03').cardExplanation);
    } else {
      assert.throws(() => validateTriageResult(value, snapshot, ahuPill), /actual valve state/);
    }
  }
});

test('commands, conditional hypotheses and uncertainty remain valid', () => {
  for (const reasoning of [command, 'The valve may be stuck open.',
    'It is unknown whether the valve is open.',
    'The command does not prove that the valve is open.',
    'The valve may not be opening fully to match the command.']) {
    const value = report(); value.hypotheses[0].reasoning = reasoning;
    assert.doesNotThrow(() => validateTriageResult(value, snapshot, ahuPill));
  }
});

test('a percentage command cannot become a percentage opening', () => {
  const value = report(); value.summary = 'The valve is 89% open.';
  assert.throws(() => validateTriageResult(value, snapshot, ahuPill), /actual valve state/);
});

test('separately reported physical state remains usable', () => {
  const observed = 'Inspection reports the valve is open.';
  const value = report(); value.summary = observed;
  value.hypotheses[0].evidence.push({ field: 'observations', quote: observed });
  assert.doesNotThrow(() => validateTriageResult(value, { fields: {
    ...snapshot.fields, observations: command + '\n' + observed
  } }, ahuPill));
});

test('a source uncertainty cannot support an affirmative claim', () => {
  const value = report(); value.summary = 'The valve is open.';
  assert.throws(() => validateTriageResult(value, { fields: {
    ...snapshot.fields, observations: command + '\nIt is unknown whether the valve is open.'
  } }, ahuPill), /actual valve state/);
});
