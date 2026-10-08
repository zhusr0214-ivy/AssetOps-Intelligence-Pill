import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';

const variants = [
  ['English complete correction', 'The room temperature is 28.4°C.\nThe fan is running.', 'Actually, the room temperature is 26°C.', 'the room temperature is 26°C\nThe fan is running.', 'The fan is running.'],
  ['English partial correction', 'The room temperature is 28.4°C.\nThe fan is running.', 'Actually, the room temperature is 26°C.', 'the room temperature is 26°C', 'The fan is running.'],
  ['Chinese complete correction', '室温为28.4°C。\n风机正在运行。', '更正：室温为26°C，其他信息不变。', '室温为26°C\n风机正在运行。', '风机正在运行。'],
  ['Chinese partial correction', '室温为28.4°C。\n风机正在运行。', '更正：室温为26°C，其他信息不变。', '室温为26°C', '风机正在运行。'],
  ['Two assets complete correction', 'AHU-18-01 room temperature is 28°C.\nAHU-18-02 room temperature is 27°C.', 'Correction: AHU-18-01 room temperature is 26°C.', 'AHU-18-01 room temperature is 26°C.\nAHU-18-02 room temperature is 27°C.', 'AHU-18-02 room temperature is 27°C.'],
  ['Two assets partial correction', 'AHU-18-01 room temperature is 28°C.\nAHU-18-02 room temperature is 27°C.', 'Correction: AHU-18-01 room temperature is 26°C.', 'AHU-18-01 room temperature is 26°C.', 'AHU-18-02 room temperature is 27°C.']
];
const results = [];
for (const [name, before, latest, extracted, unchanged] of variants) {
  const agent = createIntakeAgent({
    env: { SOCLAAS_API_KEY: 'mock', SOCLAAS_BASE_URL: 'https://example.test/v1' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      title: 'Cooling issue', category: 'hvac_cooling', location: '', asset: '', occurredAt: '', impact: '',
      observations: extracted, actionsTaken: '', affectedScope: '', corrections: ['observations'], contradictions: []
    }) } }] }) })
  });
  const result = await agent({ description: before, observations: before, category: 'hvac_cooling' }, {
    manualFields: [], messages: [{ role: 'user', content: before }, { role: 'user', content: latest }]
  });
  const proposed = result.conflicts.find(item => item.field === 'observations')?.proposed;
  results.push({ name, confirmationShown: Boolean(proposed), unchangedEvidencePreserved: Boolean(proposed?.includes(unchanged)), currentFieldProtected: result.fields.observations === before });
}
for (const result of results) { assert.ok(result.confirmationShown, result.name); assert.ok(result.unchangedEvidencePreserved, result.name); assert.ok(result.currentFieldProtected, result.name); }
console.log('PASS: six correction variants preserve unrelated facts and require confirmation.');
