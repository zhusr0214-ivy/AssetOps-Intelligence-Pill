import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';

test('explicit unknown incident start time in a full intake message is retained', async () => {
  const message = 'Demo case. AHU-18-02 on Level 18 reports inadequate cooling. Incident start time is unknown. Four occupants report warmth.';
  const agent = createIntakeAgent({ env: { SOCLAAS_API_KEY: 'test', SOCLAAS_BASE_URL: 'https://example.test/v1' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      title: 'AHU-18-02 inadequate cooling', category: 'hvac_cooling', location: 'Level 18', asset: 'AHU-18-02', occurredAt: '', impact: 'Four occupants report warmth.', observations: '', actionsTaken: '', affectedScope: 'Level 18', corrections: [], contradictions: []
    }) } }] }) }) });
  const result = await agent({ description: message }, { messages: [{ role: 'user', content: message }], manualFields: [] });
  assert.equal(result.fields.occurredAt, 'Unknown');
});
