import test from 'node:test';
import assert from 'node:assert/strict';
import { createTriageAgent } from '../triage-agent.js';
import { validateTriageResult, ahuPill } from '../triage.js';

test('one model retry repairs an unsupported evidence quote using the case source', async () => {
  const snapshot = { fields: { description: 'The fan is running.', observations: 'The fan is running.' } };
  const make = quote => ({ summary: 'Cooling needs review.', hypotheses: [{ ruleId: 'HVAC-02', reasoning: 'Review airflow.', evidence: [{ field: 'observations', quote }], uncertainties: ['Airflow unverified.'] }], actionIds: [], missingFields: [], prioritySuggestion: null });
  const replies = [make('Fan running'), make('The fan is running.')];
  let calls = 0;
  const agent = createTriageAgent({ env: { SOCLAAS_API_KEY: 'test', SOCLAAS_BASE_URL: 'https://example.test/v1' }, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(replies[calls++]) } }] }) }) });
  const result = await agent(snapshot, ahuPill);
  assert.equal(calls, 2);
  assert.equal(validateTriageResult(result, snapshot, ahuPill).hypotheses[0].evidence[0].quote, 'The fan is running.');
});

test('already verbatim evidence does not trigger a second model call', async () => {
  const snapshot = { fields: { observations: 'The fan is running.' } };
  let calls = 0;
  const result = { summary: 'Review airflow.', hypotheses: [{ ruleId: 'HVAC-02', reasoning: 'Review.', evidence: [{ field: 'observations', quote: 'The fan is running.' }], uncertainties: [] }], actionIds: [], missingFields: [], prioritySuggestion: null };
  const agent = createTriageAgent({ env: { SOCLAAS_API_KEY: 'test', SOCLAAS_BASE_URL: 'https://example.test/v1' }, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) }; } });
  await agent(snapshot, ahuPill);
  assert.equal(calls, 1);
});

 test('a quote in another field does not bypass corrective evidence checking',async()=>{
  const snapshot={fields:{description:'The fan is running.',observations:'Airflow is unknown.'}};
  const make=field=>({summary:'Review airflow.',hypotheses:[{ruleId:'HVAC-02',reasoning:'Review.',evidence:[{field,quote:'The fan is running.'}],uncertainties:['Airflow is reported unknown.']}],actionIds:[],missingFields:[],prioritySuggestion:null});
  let calls=0;
  const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(make(calls++===0?'observations':'description'))}}]})})});
  const result=await agent(snapshot,ahuPill);assert.equal(calls,2);assert.equal(validateTriageResult(result,snapshot,ahuPill).hypotheses[0].evidence[0].field,'description');
 });
