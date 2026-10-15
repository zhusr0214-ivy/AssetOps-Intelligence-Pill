import test from 'node:test';
import assert from 'node:assert/strict';
import {assessIntake,analyzeIntake} from '../intake.js';
import {conversationReply,sendMessage} from '../conversation.js';
const base={description:'Incident reported',location:'Level 9',occurredAt:'Unknown',impact:'Service delay',priority:'high'};
test('lift entrapment is asked ahead of missing time or priority',()=>{
 const reply=conversationReply({description:'Lift B stopped',category:'lift_fault'},'Lift B stopped');
 assert.match(reply,/Is anyone trapped/);assert.ok(!reply.includes('When did'));
});
test('known negative entrapment is not asked again',()=>{
 const reply=conversationReply({...base,category:'lift_fault',observations:'No one is trapped.'},'No one is trapped.');
 assert.ok(!reply.includes('Is anyone trapped'));assert.match(reply,/fault message/);
});
test('leak asks electrical exposure, then access if exposure already reported',()=>{
 const first=conversationReply({...base,category:'water_leak',description:'Water is leaking continuously.'},'Water is leaking');
 assert.match(first,/electrical equipment/);
 const next=conversationReply({...base,category:'water_leak',observations:'A lighting fixture is nearby but no exposed wiring is visible.'},'Water is leaking');
 assert.match(next,/access/);
});
test('electrical case asks critical impact after smoke and trip evidence provided',()=>{
 const reply=conversationReply({...base,category:'electrical_distribution',observations:'No smoke or burning smell has been observed. One breaker has tripped twice.'},'One breaker has tripped twice.');
 assert.match(reply,/critical systems/);assert.ok(!reply.includes('Has any breaker'));
});
test('local HVAC and AHU questions differ',()=>{
 const local=conversationReply({...base,category:'hvac_local_comfort',observations:'Nearby offices appear normal.'},'Room is warm');
 assert.match(local,/VAV/);
 const ahu=conversationReply({...base,category:'hvac_cooling',observations:'Multiple areas are affected.'},'AHU is warm');
 assert.match(ahu,/filter differential pressure/);
});
test('short unknown answer advances instead of repeating but retains safety uncertainty',()=>{
 const first={...base,category:'lift_fault'};
 const question=conversationReply(first,'Lift stopped');
 const messages=[{role:'assistant',content:question},{role:'user',content:'Unknown'}];
 const next=conversationReply({...first,messages},'Unknown');
 assert.ok(!next.includes('Is anyone trapped'));assert.match(next,/still needs verification/);assert.match(next,/fault message/);
});
test('short no is associated with the previous binary question',()=>{
 const first={...base,category:'lift_fault'};
 const messages=[{role:'assistant',content:conversationReply(first,'Lift stopped')},{role:'user',content:'No'}];
 const next=conversationReply({...first,messages},'No');
 assert.ok(!next.includes('Is anyone trapped'));assert.ok(!next.includes('still needs verification'));
});
test('irrelevant answer and assistant-only evidence do not suppress safety question',()=>{
 const first={...base,category:'lift_fault'};
 const messages=[{role:'assistant',content:'No one is trapped.'},{role:'user',content:'The title is wrong.'}];
 assert.match(conversationReply({...first,messages},'The title is wrong.'),/Is anyone trapped/);
});
test('safety question appears even during title conflict; new questions use English and original Chinese conflict text is preserved',()=>{
 const reply=conversationReply({...base,category:'lift_fault',conflicts:[{field:'title'}]},'\u7535\u68af\u6545\u969c');
 assert.match(reply,/Is anyone trapped/);assert.match(reply,/对话中确认/);assert.ok(!reply.includes('undefined'));
});
test('an explicit unknown diagnostic reading is not repeatedly requested',()=>{
 const first={...base,category:'hvac_cooling',observations:'Multiple areas are affected.'};
 const messages=[{role:'assistant',content:conversationReply(first,'AHU issue')},{role:'user',content:'Unknown'}];
 const next=conversationReply({...first,messages},'Unknown');
 assert.ok(!next.includes('filter differential pressure'));assert.match(next,/reported facts/);
});
test('sendMessage supplies saved conversation history to followup generation',async()=>{
 const first={...base,id:'case-1',revision:0,manualFields:[],category:'lift_fault',messages:[]};
 first.messages=[{role:'assistant',content:conversationReply(first,'Lift stopped')}];
 let record=first;
 const store={update:async(id,data)=>record={...record,...data,revision:record.revision+1}};
 const result=await sendMessage(store,first,{requestId:'request-001',content:'Unknown'},async data=>assessIntake(data));
 assert.ok(!result.messages.at(-1).content.includes('Is anyone trapped'));
 assert.match(result.messages.at(-1).content,/verification/);
});
test('restored literal regex extracts floor and decimal temperature',()=>{
 const r=analyzeIntake({description:'AHU-18-01 on Level 18 is warm at 28.4°C today.'});
 assert.equal(r.fields.location,'Level 18');assert.equal(r.fields.observations,'28.4°C');
});
