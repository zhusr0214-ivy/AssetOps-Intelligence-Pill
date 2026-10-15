import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyInformationNeeds} from '../triage-output-contract.js';
import {validateTriageResult} from '../triage.js';
const pill={rules:[{id:'R1',guidance:'Record reported dripping and refer; unknown details can be collected later.',cardExplanation:'Record facts.'}],actions:[]};
const snapshot={fields:{observations:'Water dripping',impact:'实际影响未知'}};
const output={summary:'Record and refer.',hypotheses:[{ruleId:'R1',reasoning:'Reported dripping supports referral.',evidence:[{field:'observations',quote:'Water dripping'}],uncertainties:['Impact unknown.']}],actionIds:[],missingFields:['impact','affectedScope'],prioritySuggestion:null};
test('follow-up impact and scope questions do not block a supported referral or invent facts',()=>{
 const value={...output,informationNeeds:[{field:'impact',kind:'follow_up',reason:'Collect the effect on occupants if known.'},{field:'affectedScope',kind:'follow_up',reason:'Record affected areas.'}]};
 const result=validateTriageResult(value,snapshot,pill);assert.deepEqual(result.missingFields,[]);assert.equal(result.followUpQuestions.length,2);assert.equal(result.hypotheses[0].uncertainties[0],'Impact unknown.');assert.equal(snapshot.fields.impact,'实际影响未知');
});
test('a rule-grounded safety prerequisite stays blocking; fabricated requirements fail',()=>{
 const governed={...pill,rules:[{...pill.rules[0],guidance:'Confirm electrical contact status before recommending this inspection.'}]};
 const value={...output,missingFields:['observations'],informationNeeds:[{field:'observations',kind:'blocking',ruleId:'R1',quote:governed.rules[0].guidance,reason:'Electrical contact affects whether inspection is appropriate.'}]};
 assert.deepEqual(validateTriageResult(value,snapshot,governed).missingFields,['observations']);
 assert.throws(()=>classifyInformationNeeds({...value,informationNeeds:[{...value.informationNeeds[0],quote:'Invented prerequisite'}]},governed),e=>e.validationCode==='blocking_requirement');
 assert.deepEqual(classifyInformationNeeds(output,pill).missingFields,output.missingFields);
 assert.throws(()=>classifyInformationNeeds({...output,informationNeeds:[]},pill),e=>e.validationCode==='blocking_requirement');
});

test('domain-specific follow-up questions keep their meaning without creating a prerequisite field',()=>{
 for(const need of [{field:'cardPermissions',kind:'follow_up',reason:'请门禁管理员核查该卡权限。'},{field:null,detail:'卡片有效期',kind:'follow_up',reason:'请核查卡片是否在有效期内。'}]){
 const raw={...output,missingFields:[],informationNeeds:[need]};const result=classifyInformationNeeds(raw,pill);assert.deepEqual(result.missingFields,[]);assert.equal(result.followUpQuestions[0].field,null);assert.equal(result.followUpQuestions[0].reason,need.reason);assert.ok(result.followUpQuestions[0].detail);assert.equal(raw.informationNeeds[0].field,need.field);
 }
 assert.throws(()=>classifyInformationNeeds({...output,missingFields:[],informationNeeds:[{field:'cardPermissions',kind:'blocking',reason:'Need rights.',ruleId:'R1',quote:pill.rules[0].guidance}]},pill));
 assert.throws(()=>classifyInformationNeeds({...output,missingFields:['cardPermissions'],informationNeeds:[{field:'cardPermissions',kind:'follow_up',reason:'Check rights.'}]},pill));
});
