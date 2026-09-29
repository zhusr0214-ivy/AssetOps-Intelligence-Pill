import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';
const empty = { title:'', category:'', location:'', asset:'', occurredAt:'', impact:'', observations:'', actionsTaken:'' };
const make = fields => createIntakeAgent({ env: { SOCLAAS_API_KEY:'test', SOCLAAS_BASE_URL:'https://example.test/v1' }, fetchImpl: async () => ({ ok:true, json:async () => ({choices:[{message:{content:JSON.stringify({...empty,...fields})}}]}) }) });
const ctx = (first, latest, manualFields=[]) => ({ manualFields, messages:[{role:'user', content:first},{role:'user',content:latest}] });
test('lift status additions retain car position and negative entrapment evidence', async () => {
 const old = 'The car is currently at Level 11 with the doors closed.';
 const latest = 'No one is trapped. Lift B shows a door control fault. The other lifts are operating normally.';
 const result = await make({observations:'No one is trapped.\nLift B shows a door control fault.\nThe other lifts are operating normally.'})({description:old, observations:old},ctx(old,latest));
 assert.equal(result.fields.observations,old+'\nNo one is trapped.\nLift B shows a door control fault.\nThe other lifts are operating normally.');
 assert.equal(result.conflicts.length,0);
});
test('electrical observations and completed actions append into separate fields', async () => {
 const old = 'Voltage alarms appeared. Security was notified.';
 const latest = 'No smoke or burning smell has been observed. One breaker has tripped twice and was manually reset.';
 const result = await make({observations:'No smoke or burning smell has been observed.\nOne breaker has tripped twice',actionsTaken:'was manually reset'})({description:old, observations:'Voltage alarms appeared.',actionsTaken:'Security was notified.'},ctx(old,latest));
 assert.equal(result.fields.observations,'Voltage alarms appeared.\nNo smoke or burning smell has been observed.\nOne breaker has tripped twice');
 assert.equal(result.fields.actionsTaken,'Security was notified.\nwas manually reset');
});
test('leak source unknown is retained when nearby lighting and mitigation are added', async () => {
 const old = 'The source is unknown.';
 const latest = 'A lighting fixture is nearby but no exposed wiring is visible. Security has placed warning signs and restricted access.';
 const result = await make({observations:'A lighting fixture is nearby but no exposed wiring is visible.',actionsTaken:'Security has placed warning signs and restricted access.'})({description:old,observations:old},ctx(old,latest));
 assert.match(result.fields.observations,/source is unknown/);
 assert.match(result.fields.observations,/no exposed wiring/);
 assert.equal(result.fields.asset,'');
});
test('replayed and repeated quotes do not duplicate evidence', async () => {
 const old = 'Room temperature is 28°C.';
 const latest = 'Setpoint is 24°C.';
 const proposal = {observations:old+'\n'+latest+'\n'+latest};
 const first = await make(proposal)({description:old,observations:old},ctx(old,latest));
 const again = await make(proposal)(first.fields,ctx(old,latest));
 assert.equal(first.fields.observations,old+'\n'+latest);
 assert.equal(again.fields.observations,first.fields.observations);
});
test('manual evidence is protected and review proposal retains old facts', async () => {
 const old = 'Room is warm.';
 const latest = 'No smoke is visible.';
 const result = await make({observations:latest})({description:old,observations:old},ctx(old,latest,['observations']));
 assert.equal(result.fields.observations,old);
 assert.equal(result.conflicts[0].proposed,old+'\n'+latest);
});
test('reported contradictions and corrections require confirmation instead of silently merging', async () => {
 const old = 'The temperature is 28°C.';
 const latest = 'Correction: the temperature is 26°C.';
 for (const flag of ['corrections','contradictions']) {
  const result = await make({observations:'the temperature is 26°C.',[flag]:['observations']})({description:old,observations:old},ctx(old,latest));
  assert.equal(result.fields.observations,old);
  assert.equal(result.conflicts.length,1);
 }
});
test('unrelated historical facts are not reintroduced as new observations', async () => {
 const old = 'Temperature is 28°C. The setpoint is 24°C.';
 const latest = 'No smoke is visible.';
 const result = await make({observations:'The setpoint is 24°C.'})({description:old,observations:'Temperature is 28°C.'},ctx(old,latest));
 assert.equal(result.fields.observations,'Temperature is 28°C.');
});
test('unsupported values are rejected and length overflow is not silently truncated', async () => {
 const old = 'x'.repeat(5990);
 const latest = 'New measured temperature is 26°C.';
 await assert.rejects(make({observations:latest})({description:old,observations:old},ctx(old,latest)),{status:422});
 const result = await make({observations:'Invented pressure is 100 Pa'})({description:'Warm room',observations:'Warm room'},ctx('Warm room',latest));
 assert.equal(result.fields.observations,'Warm room');
});
test('scalar asset differences still require confirmation', async () => {
 const result = await make({asset:'Lift C'})({description:'Lift B stopped',asset:'Lift B'},ctx('Lift B stopped','Lift C stopped'));
 assert.equal(result.fields.asset,'Lift B');
 assert.equal(result.conflicts.length,1);
});
