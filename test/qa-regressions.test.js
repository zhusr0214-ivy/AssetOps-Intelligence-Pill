import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeCaptureAgent} from '../knowledge-agent.js';
import {createTriageAgent} from '../triage-agent.js';
import {recoverInitialFacts} from '../intake-agent.js';
const env = {SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://example.test/v1'};
const response = value => ({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})});
test('invalid model associations remain visible review warnings without invented links', async () => {
 const candidate={key:'r1',type:'rule',title:'Collect',text:'Collect facts.',evidence:[{blockId:'B1',quote:'Collect facts.'}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]};
 let calls=0;
 const agent=createKnowledgeCaptureAgent({env,fetchImpl:async()=>response({candidates:[{...candidate,relatedActionKeys:calls++===0?['missing']:[]}],questions:[],conflicts:[]})});
 const result=await agent({name:'fixture',domain:'lift_fault',blocks:[{id:'B1',location:'Paragraph 1',text:'Collect facts.'}]});
 assert.equal(calls,1);assert.equal(result.candidates.length,1);assert.match(result.candidates[0].missing.join(' '),/Review required/);
 const broken=createKnowledgeCaptureAgent({env,fetchImpl:async()=>response({candidates:[{...candidate,relatedActionKeys:['missing']}],questions:[],conflicts:[]})});
 const incomplete=await broken({name:'fixture',blocks:[{id:'B1',text:'Collect facts.'}]}); assert.deepEqual(incomplete.candidates[0].relatedActionIds,[]); assert.match(incomplete.candidates[0].missing.join(' '),/missing/);
});
test('triage repair requests supported missing-field names without dropping missing information',async()=>{
 let calls=0; const report={summary:'Need observations.',hypotheses:[],actionIds:[],prioritySuggestion:null};
 const agent=createTriageAgent({env,fetchImpl:async()=>response({...report,missingFields:calls++===0?['faultCode']:['observations']})});
 const result=await agent({fields:{description:'Fault code unknown.'}},{rules:[],actions:[]});
 assert.equal(calls,2);assert.deepEqual(result.missingFields,['observations']);
});
test('initial lift intake preserves explicit building and negative observations without inventing facts',()=>{
 const source='Lift LIFT-02 in Test Tower B stopped responding. Its floor indicator remains at floor 3. No passengers trapped, no injuries, no smoke.';
 const value={category:'lift_fault',location:'',observations:''};recoverInitialFacts(source,value,{});
 assert.equal(value.location,'Test Tower B');assert.match(value.observations,/No passengers trapped/);
 const existing={category:'lift_fault',location:'Tower C',observations:'Unknown'};recoverInitialFacts(source,existing,{location:'Tower C',observations:'Unknown'});assert.equal(existing.location,'Tower C');
});
