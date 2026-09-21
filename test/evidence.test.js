import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';
const blank = { title: '', category: '', location: '', asset: '', occurredAt: '', impact: '', observations: '', actionsTaken: '' };
const make = fields => createIntakeAgent({env: {SOCLAAS_API_KEY:'test',SOCLAAS_BASE_URL:'https://example.test/v1'}, fetchImpl: async () => ({ok: true, json: async () => ({choices:[{message:{content:JSON.stringify({...blank,...fields})}}]})})});
const description = 'Room temperature is 28°C while the setpoint is 24°C. No smoke has been observed.';
test('initial intake accepts separately quoted observations', async () => {
 const result = await make({observations:'Room temperature is 28°C\nsetpoint is 24°C\nNo smoke has been observed.'})({description});
 assert.match(result.fields.observations, /28°C/);
 assert.match(result.fields.observations, /24°C/);
 assert.match(result.fields.observations, /No smoke/);
});
test('conversation supports exact quotes from multiple user messages', async () => {
 const result = await make({observations:'Room temperature is 28°C\nNo one is trapped.'})({description}, {manualFields:[], messages:[{role:'user',content:description},{role:'user',content:'No one is trapped.'}]});
 assert.equal(result.fields.observations,'Room temperature is 28°C\nNo one is trapped.');
});
test('fabricated or assistant-only facts are not accepted', async () => {
 const result = await make({observations:'Room temperature is 28°C\nVoltage is 500 V'})({description}, {manualFields:[], messages:[{role:'user',content:description},{role:'assistant',content:'Voltage is 500 V'}]});
 assert.equal(result.fields.observations,'');
});
test('non-list fields cannot combine disconnected facts', async () => {
 const result = await make({asset:'Room temperature is 28°C\nsetpoint is 24°C'})({description});
 assert.equal(result.fields.asset,'');
});
test('existing manually entered observations remain protected', async () => {
 const result = await make({observations:'No smoke has been observed.'})({description,observations:'Checked manually'}, {manualFields:['observations'],messages:[{role:'user',content:description}]});
 assert.equal(result.fields.observations,'Checked manually');
 assert.equal(result.conflicts.length,1);
});
