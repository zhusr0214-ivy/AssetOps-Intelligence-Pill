import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';

const initial = 'AHU-18-02 on Level 18 is not cooling adequately. Two occupants report discomfort. The start time is unknown.';
const readings = [
  'The room temperature is 28.4°C and the setpoint is 24°C.',
  'The supply air temperature is 18.2°C.',
  'The filter differential pressure is reported as high.',
  'The chilled water valve command is 89%.',
  'The fan is running.'
];
const latest = 'The east zone and two meeting rooms are affected. ' + readings.join(' ');
const input = { description: initial, category: 'hvac_cooling', observations: 'not cooling adequately.', occurredAt: 'Unknown' };
const context = (message = latest, manualFields = ['description', 'priority', 'occurredAt']) => ({
  manualFields, messages: [{ role: 'user', content: initial }, { role: 'user', content: message }]
});
const agent = (extra = {}) => createIntakeAgent({
  env: { SOCLAAS_API_KEY: 'test', SOCLAAS_BASE_URL: 'https://example.test/v1' },
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
    title: 'Level 18 Cooling Issue', category: 'hvac_cooling', location: '', asset: '', occurredAt: '', impact: '',
    observations: 'room temperature is 28.4°C', actionsTaken: '', affectedScope: '',
    corrections: [], contradictions: ['observations'], ...extra
  }) } }] }) })
});

test('screenshot regression: all six HVAC facts survive a partial model result and false conflict', async () => {
  const result = await agent()(input, context());
  assert.equal(result.fields.observations, [input.observations, ...readings].join('\n'));
  assert.equal(result.fields.occurredAt, 'Unknown');
  assert.deepEqual(result.conflicts, []);
  const repeat = await agent()(result.fields, context());
  assert.equal(repeat.fields.observations, result.fields.observations);
  assert.deepEqual(repeat.conflicts, []);
});

test('manual observations remain protected with complete proposed evidence', async () => {
  const result = await agent()(input, context(latest, ['observations']));
  assert.equal(result.fields.observations, input.observations);
  assert.equal(result.conflicts[0].proposed, [input.observations, ...readings].join('\n'));
});

test('a changed specific reading and explicit corrections still require confirmation', async () => {
  const result = await agent()({ ...input, observations: 'The room temperature is 27°C.' }, context());
  assert.equal(result.fields.observations, 'The room temperature is 27°C.');
  assert.equal(result.conflicts.length, 1);
  const corrected = await agent({ corrections: ['observations'] })(input, context());
  assert.equal(corrected.conflicts.length, 1);
});

test('questions, proposed settings and unknown start time are not recovered as measurements', async () => {
  const message = 'Is the fan running? The room temperature is 28.4°C? Set the chilled water valve command to 89%. The start time is unknown.';
  const result = await agent({ observations: '', contradictions: [] })(input, context(message));
  assert.equal(result.fields.observations, input.observations);
});

test('different readings and negative fan state are preserved verbatim without invented actual position', async () => {
  const message = 'The supply air temperature is 16.7°C. The chilled water valve command is 63%. The fan is not running.';
  const result = await agent({ observations: '', contradictions: [] })(input, context(message));
  assert.equal(result.fields.observations, input.observations + '\n' + message.split('. ').join('.\n'));
  assert.ok(!result.fields.observations.includes('position'));
});
