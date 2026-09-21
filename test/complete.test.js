import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeAgent } from '../intake-agent.js';
const empty = {title:'',category:'',location:'',asset:'',occurredAt:'',impact:'',observations:'',actionsTaken:''};
const make = proposal => createIntakeAgent({env:{SOCLAAS_API_KEY:'test',SOCLAAS_BASE_URL:'https://example.test/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...empty,...proposal})}}]})})});
const context = (question,answer,manualFields=[]) => ({manualFields,messages:[{role:'assistant',content:question},{role:'user',content:answer}]});
test('unknown time is saved even when the model leaves it blank',async()=>{
 for(const answer of ['unknown','Unknown','UNKNOWN','not sure',"don't know",'\u4e0d\u77e5\u9053']){
  const r=await make({})({description:'Room is warm.'},context('When did the issue start? Enter Unknown if you do not know. Please choose Priority in the summary.',answer));
  assert.equal(r.fields.occurredAt,'Unknown');
  assert.ok(!r.missingFields.includes('occurredAt'));
 }
});
test('ambiguous or safety unknown is not assigned to occurrence time',async()=>{
 for(const question of ['Is anyone trapped?','When did it start? Who or what is affected?']){
  const r=await make({occurredAt:'Unknown',impact:'Unknown'})({description:'Lift stopped'},context(question,'Unknown'));
  assert.equal(r.fields.occurredAt,'');assert.equal(r.fields.impact,'');
 }
});
test('labelled unknown and unknown impact are field-specific',async()=>{
 const time=await make({})({description:'Room warm'},context('What happened?','Started at: not sure'));
 assert.equal(time.fields.occurredAt,'Unknown');
 const impact=await make({})({description:'Room warm'},context('Who or what is affected? Enter Unknown if you do not know.','unknown'));
 assert.equal(impact.fields.impact,'Unknown');assert.equal(impact.fields.occurredAt,'');
});
test('manually confirmed time cannot be silently replaced by unknown',async()=>{
 const r=await make({})({description:'Room warm',occurredAt:'10 AM'},context('When did the issue start?','Unknown',['occurredAt']));
 assert.equal(r.fields.occurredAt,'10 AM');assert.equal(r.conflicts[0].proposed,'Unknown');
});
test('generated long title is shortened without title conflict',async()=>{
 const description='Level 18 AHU-18-01 is unusually warm and this is a very long original description that should never be copied as the incident title.';
 const r=await make({title:description,category:'hvac_cooling',location:'Level 18',asset:'AHU-18-01'})({description,title:description},context('',description));
 assert.ok(r.fields.title.length<=80);assert.ok(r.fields.title.split(/\s+/).length<=10);assert.match(r.fields.title,/Level 18/);assert.equal(r.conflicts.length,0);
});
test('manual title remains protected',async()=>{
 const r=await make({title:'Level 18 Cooling Issue'})({description:'Room warm',title:'Approved title'},context('','Room warm',['title']));
 assert.equal(r.fields.title,'Approved title');assert.equal(r.conflicts[0].field,'title');
});
test('derived category can update without literal category code in user prose',async()=>{
 const r=await make({category:'lift_fault'})({description:'Lift B stopped',category:'other'},context('','Lift B stopped responding.'));
 assert.equal(r.fields.category,'lift_fault');assert.equal(r.conflicts.length,0);
 const locked=await make({category:'lift_fault'})({description:'Lift B stopped',category:'other'},context('','Lift B stopped responding.',['category']));
 assert.equal(locked.fields.category,'other');assert.equal(locked.conflicts.length,1);
});
test('specific classification does not regress to Other without an explicit correction',async()=>{
 const r=await make({category:'other'})({description:'Lift B stopped',category:'lift_fault'},context('','No one is trapped.'));
 assert.equal(r.fields.category,'lift_fault');
});
