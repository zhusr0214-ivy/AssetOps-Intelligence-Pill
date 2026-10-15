import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriageAgent} from '../triage-agent.js';
import {triageContractIssues} from '../triage-output-contract.js';
import {validateTriageResult} from '../triage.js';
const snapshot={validationScenario:true,fields:{description:'Reported dripping. Location is known; cause is unknown.'}};
const pill={rules:[{id:'R1',guidance:'Record reported symptoms and unknown causes.',cardExplanation:'Record reported symptoms and unknown causes.',actionIds:['A1']}],actions:[{id:'A1',ruleIds:['R1'],instruction:'Collect reported facts.',requiresApproval:true}]};
const output=()=>({summary:'Record reported dripping; cause is unknown.',hypotheses:[{ruleId:'R1',reasoning:'Reported dripping supports collecting facts.',evidence:[{field:'description',quote:'Reported dripping.'}],uncertainties:['Cause unknown.']}],actionIds:['A1'],missingFields:[],prioritySuggestion:null});
function agentFor(replies,requests){return createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(replies[Math.min(requests.length-1,replies.length-1)])}}]})};}});}
test('catalog and rule association failures get exactly one corrective request and remain strict if unresolved',async()=>{
 for(const bad of [{...output(),actionIds:['invented']},{...output(),hypotheses:[]}]){
   const requests=[],result=await agentFor([bad,output()],requests)(snapshot,pill);assert.equal(requests.length,2);assert.match(requests[1].messages.at(-1).content,/Action/);assert.equal(validateTriageResult(result,snapshot,pill).actions[0].id,'A1');
   const failedRequests=[],unfixed=await agentFor([bad],failedRequests)(snapshot,pill);assert.equal(failedRequests.length,2);assert.throws(()=>validateTriageResult(unfixed,snapshot,pill),e=>e.validationCode==='action_reference');
 }
});
test('hypothetical asset/time blockers need source-rule grounds, never expected-answer substitution',async()=>{
 const bad={...output(),missingFields:['asset','occurredAt']};assert.equal(triageContractIssues(bad,snapshot,pill).length,2);assert.throws(()=>validateTriageResult(bad,snapshot,pill),e=>e.validationCode==='blocking_requirement');
 const requests=[],fixed=await agentFor([bad,output()],requests)(snapshot,pill);assert.equal(requests.length,2);assert.deepEqual(validateTriageResult(fixed,snapshot,pill).missingFields,[]);assert.ok(!JSON.stringify(requests).includes('expectedStatus'));
 const fake={...bad,blockingReasons:[{field:'asset',ruleId:'R1',quote:'Asset identifier is required.',reason:'Need it.'}]};assert.equal(triageContractIssues(fake,snapshot,pill).length,2);
});
test('genuine rule prerequisites and real-incident gaps are preserved',()=>{
 const rule={...pill.rules[0],guidance:'Asset identifier is required before applying this asset-specific rule.'};const governed={...pill,rules:[rule]};const result={...output(),missingFields:['asset'],blockingReasons:[{field:'asset',ruleId:'R1',quote:rule.guidance,reason:'The rule depends on asset-specific identification.'}]};assert.deepEqual(triageContractIssues(result,snapshot,governed),[]);assert.deepEqual(validateTriageResult(result,snapshot,governed).missingFields,['asset']);
 assert.deepEqual(triageContractIssues({...output(),missingFields:['asset','occurredAt']},{...snapshot,validationScenario:false},pill),[]);
 assert.deepEqual(validateTriageResult({...output(),missingFields:['observations']},snapshot,pill).missingFields,['observations']);
});

 test('invalid priority output receives one correction and is rejected if unresolved',async()=>{
  for(const prioritySuggestion of [undefined,{},'medium',{value:'normal',reason:'Check'},{value:'medium',reason:''}]) {
   const bad={...output(),prioritySuggestion};
   const requests=[],fixed=await agentFor([bad,output()],requests)(snapshot,pill);
   assert.equal(requests.length,2);assert.match(requests[1].messages.at(-1).content,/prioritySuggestion/);
   assert.equal(validateTriageResult(fixed,snapshot,pill).prioritySuggestion,null);
   const failedRequests=[],unfixed=await agentFor([bad],failedRequests)(snapshot,pill);
   assert.equal(failedRequests.length,2);assert.throws(()=>validateTriageResult(unfixed,snapshot,pill),e=>e.validationCode==='priority_output');
  }
  const valid={...output(),prioritySuggestion:{value:'medium',reason:'Reported symptoms warrant review.'}};
  const requests=[];await agentFor([valid],requests)(snapshot,pill);assert.equal(requests.length,1);
 });

test('scenario information gaps are reviewed once without substituting expectations or erasing genuine gaps',async()=>{
 const gap={...output(),missingFields:['observations','affectedScope','impact']};
 const requests=[],fixed=await agentFor([gap,output()],requests)(snapshot,pill);
 assert.equal(requests.length,2);assert.match(requests[1].messages.at(-1).content,/Separate prerequisites/);
 assert.deepEqual(validateTriageResult(fixed,snapshot,pill).missingFields,[]);
 const genuineRequests=[],genuine=await agentFor([gap],genuineRequests)(snapshot,pill);
 assert.equal(genuineRequests.length,2);assert.deepEqual(validateTriageResult(genuine,snapshot,pill).missingFields,gap.missingFields);
 const incidentRequests=[];await agentFor([gap],incidentRequests)({...snapshot,validationScenario:false},pill);assert.equal(incidentRequests.length,2);
 assert.ok(!JSON.stringify(requests).includes('expectedStatus'));
});

test('missing report fields get one corrective request while final validation stays strict',async()=>{
 for(const bad of [{...output(),missingFields:null},{...output(),missingFields:Array(6).fill('impact')},{...output(),summary:''},{...output(),hypotheses:[{...output().hypotheses[0],uncertainties:null}]},{...output(),hypotheses:[{...output().hypotheses[0],reasoning:''}]}]){
  const requests=[],result=await agentFor([bad,output()],requests)(snapshot,pill);assert.equal(requests.length,2);assert.match(requests[1].messages.at(-1).content,/reportShape/);assert.doesNotThrow(()=>validateTriageResult(result,snapshot,pill));
 }
});

test('unknown hypothesis rule IDs trigger one correction before final validation',async()=>{
 const requests=[];const bad={...output(),hypotheses:[{...output().hypotheses[0],ruleId:'invented'}]};
 const result=await agentFor([bad,output()],requests)(snapshot,pill);assert.equal(requests.length,2);assert.match(requests[1].messages.at(-1).content,/ruleReference/);assert.doesNotThrow(()=>validateTriageResult(result,snapshot,pill));
});

test('real scoped action verification corrects once and never falls back to a rejected task',async()=>{
 for(const repaired of [true,false]){let calls=0,checks=0;
 const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},scopeVerifier:async()=>({passed:++checks===2&&repaired,differences:['Single-point task requires a confirmed single-point condition.']}),fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output())}}]})};}});
 const work=agent({...snapshot,validationScenario:false},{...pill,domain:'water_leak'});if(repaired)await work;else await assert.rejects(work);assert.equal(calls,2);assert.equal(checks,2);
 }
});

test('action-only correction cannot replace source evidence or introduce uncited rules',async()=>{
 const initial={...output(),actionIds:['unknown']};const malicious={...output(),actionIds:['A1'],hypotheses:[{ruleId:'invented',evidence:[]}],summary:'changed'};
 const requests=[],result=await agentFor([initial,malicious],requests)(snapshot,pill);assert.match(requests[1].messages.at(-1).content,/ONLY action selection/);assert.equal(result.summary,initial.summary);assert.deepEqual(result.hypotheses,initial.hypotheses);assert.deepEqual(result.actionIds,['A1']);assert.doesNotThrow(()=>validateTriageResult(result,snapshot,pill));
 const stillBad=await agentFor([initial,{actionIds:['unknown']}],[])(snapshot,pill);assert.throws(()=>validateTriageResult(stillBad,snapshot,pill));
});
