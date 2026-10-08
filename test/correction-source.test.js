import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';

const prior = 'The room temperature is 28.4°C and the setpoint is 24°C. The supply air temperature is 18.2°C. The fan is running.';
const latest = 'Correction: the room temperature is 26°C, not 28.4°C. The setpoint remains 24°C. All other information is unchanged.';
const observations = 'not cooling adequately.\n' + prior;
const make = (setpoint, partial = false, overrides = {}) => createIntakeAgent({ env: { SOCLAAS_API_KEY: 'test', SOCLAAS_BASE_URL: 'https://example.test/v1' },
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
    title: 'Cooling issue', category: 'hvac_cooling', location: '', asset: '', occurredAt: '', impact: '', actionsTaken: '', affectedScope: '',
    observations: `Correction: the room temperature is 26°C, not 28.4°C.\n${setpoint}` + (partial ? '' : '\nThe supply air temperature is 18.2°C.\nThe fan is running.'),
    corrections: ['observations'], contradictions: [], ...overrides
  }) } }] }) }) });
const input = { description: 'not cooling adequately.', category: 'hvac_cooling', occurredAt: 'Unknown', observations };
const context = { manualFields: ['occurredAt'], messages: [input.description, prior, latest].map(content => ({ role: 'user', content })) };

test('capitalization-only quote mismatch surfaces the full correction for confirmation', async () => {
  const result = await make('The setpoint is 24°C.')(input, context);
  assert.equal(result.fields.observations, observations);
  assert.equal(result.fields.occurredAt, 'Unknown');
  assert.equal(result.conflicts.length, 1);
  const value = result.conflicts[0].proposed;
  assert.ok(value.includes('not cooling adequately.'));
  assert.ok(value.includes('the setpoint is 24°C.'));
  assert.ok(value.includes('The supply air temperature is 18.2°C.'));
  assert.ok(value.includes('The fan is running.'));
  assert.ok(value.includes('26°C, not 28.4°C'));
  assert.ok(!value.includes('temperature is 28.4°C'));
});

test('latest model variant with an added terminal period yields a complete correction', async () => {
  const result = await make('', false, {
    observations: 'The room temperature is 26°C.\nThe setpoint remains 24°C.\nThe supply air temperature is 18.2°C.\nThe fan is running.',
    corrections: [], contradictions: ['observations']
  })(input, context);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.fields.observations, observations);
  const next = result.conflicts[0].proposed;
  assert.ok(next.includes('the room temperature is 26°C'));
  assert.ok(!next.includes('temperature is 28.4°C'));
  for (const fact of ['not cooling adequately.', 'The setpoint remains 24°C.', 'The supply air temperature is 18.2°C.', 'The fan is running.']) assert.ok(next.includes(fact));
  for (const line of next.split('\n')) assert.ok(context.messages.some(message => message.content.includes(line)), line);
});

test('changed numbers and paraphrases still fail source validation', async () => {
  for (const quote of ['The setpoint is 25°C.', 'The target temperature equals 24°C.']) {
    const result = await make(quote)(input, context);
    assert.equal(result.fields.observations, observations);
    assert.deepEqual(result.conflicts, []);
  }
});

test('room-only model correction cannot drop the unchanged setpoint from the old combined sentence', async () => {
  const result = await make('', true, {
    observations: 'the room temperature is 26°C, not 28.4°C',
    corrections: ['observations']
  })(input, context);
  const next = result.conflicts[0].proposed;
  for (const fact of ['The setpoint remains 24°C.', 'The supply air temperature is 18.2°C.', 'The fan is running.', 'not cooling adequately.']) assert.ok(next.includes(fact), fact);
  assert.ok(!next.includes('temperature is 28.4°C'));
});

test('a partial correction preserves omitted measurements and states in the confirmation', async () => {
  const extra = '\nThe filter differential pressure is reported as high.\nThe chilled water valve command is 89%.';
  const result = await make('The setpoint remains 24°C.', true)(
    { ...input, observations: observations + extra },
    { ...context, messages: [...context.messages.slice(0, -1), { role: 'user', content: extra }, context.messages.at(-1)] }
  );
  const replacement = result.conflicts[0].proposed;
  for (const fact of ['not cooling adequately.', 'The supply air temperature is 18.2°C.', 'The fan is running.', 'The filter differential pressure is reported as high.', 'The chilled water valve command is 89%.', 'The setpoint remains 24°C.']) {
    assert.ok(replacement.includes(fact), fact);
  }
  assert.ok(!replacement.includes('temperature is 28.4°C'));
  assert.equal(result.fields.observations, observations + extra);
});
