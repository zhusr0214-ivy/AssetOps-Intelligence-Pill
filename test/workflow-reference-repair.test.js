import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveStepEvidence,applyStepReferenceRepair,createWorkflowAssessment,workflowEvidenceCatalog} from '../workflow-assessment.js';
const env={SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'};
const report={actions:[{id:'A1',instruction:'核查卡片权限、有效期及卡片状态。'}]};
const input={expected:{steps:'核查卡片权限、有效期及卡片状态。'},report,facts:{},pill:{boundaries:[]}};
const checks={steps:true,responsibility:true,information:true,completion:true,scope:true};
const verdict=refs=>({checks:{...checks},differences:[],stepCoverage:[{id:'S1',covered:true,evidence:refs}]});
function mock(replies){let calls=0;return {agent:createWorkflowAssessment({env,fetchImpl:async()=>{const reply=replies[calls++];if(reply?.httpError)return {ok:false};return {ok:true,json:async()=>({choices:[{finish_reason:reply?.truncated?'length':'stop',message:{content:typeof reply==='string'?reply:JSON.stringify(reply)}}]})};}}),calls:()=>calls};}
test('equivalent evidence encodings resolve to server-owned originals without model calls',()=>{
 const catalog=workflowEvidenceCatalog(report);
 for(const evidence of [[{evidenceId:'W1'}],['W1'],[{id:'w1'}],[{evidenceId:' W1 ',quote:'invented'}],[{source:'actions',actionId:'A1',quote:report.actions[0].instruction}]]){
  const resolved=resolveStepEvidence([{id:'S1',covered:true,evidence}],catalog);assert.equal(resolved[0].evidence[0].quote,report.actions[0].instruction);assert.equal(resolved[0].evidence[0].actionId,'A1');
 }
 const ids=resolveStepEvidence([{requirementId:'S1',covered:true,evidenceIds:['W1']}],catalog);assert.equal(ids[0].id,'S1');assert.equal(ids[0].evidence[0].evidenceId,'W1');
 for(const ref of [{evidenceId:'W999',source:'action',actionId:'A1',quote:report.actions[0].instruction},{source:'action',actionId:'A1',quote:'改写的核查步骤'},{evidenceId:'W1',id:'W2'},{evidenceId:1}])assert.equal(resolveStepEvidence([{evidence:[ref]}],catalog)[0].evidence[0].source,'invalid_evidence_id');
});
test('valid string IDs succeed in one call; unknown IDs receive exactly one bounded correction',async()=>{
 const valid=mock([verdict(['W1'])]);assert.equal((await valid.agent(input)).passed,true);assert.equal(valid.calls(),1);
 const fixed=mock([verdict([{evidenceId:'W999'}]),{stepCoverage:[{id:'S1',evidenceIds:['W1']}]}]);const result=await fixed.agent(input);assert.equal(result.passed,true);assert.equal(result.referenceRepairUsed,true);assert.equal(fixed.calls(),2);
});
test('reference correction cannot change verdicts, coverage decisions, or missing-task outcomes',async()=>{
 const failed=verdict(['W999']);failed.checks.steps=false;failed.differences=['具体核查步骤未满足。'];
 const m=mock([failed,{checks,stepCoverage:[{id:'S1',covered:true,evidenceIds:['W1']}]}]);const result=await m.agent(input);assert.equal(result.passed,false);assert.equal(result.checks.steps,false);assert.ok(result.differences.includes('具体核查步骤未满足。'));
 const patched=applyStepReferenceRepair([{id:'S1',covered:false,evidence:[]}],[{id:'S1',covered:true,evidenceIds:['W1']}]);assert.equal(patched[0].covered,false);
 const generic={...input,report:{actions:[{id:'A1',instruction:'收集门的位置及刷卡提示。'}]}};const g=mock([verdict(['W1'])]);assert.equal((await g.agent(generic)).passed,false);
});
test('bad corrections fail closed with no third call or fallback success',async()=>{
 for(const patch of [{stepCoverage:[{id:'S1',evidenceIds:['W999']}]},{stepCoverage:[{id:'S2',evidenceIds:['W1']}]},{stepCoverage:[]},{httpError:true},{truncated:true},'{invalid']){
  const m=mock([verdict(['W999']),patch]);await assert.rejects(m.agent(input));assert.equal(m.calls(),2);
 }
});

 test('unique verbatim excerpts and single evidence objects resolve without another model request',async()=>{
 const m=mock([verdict({source:'action',quote:'核查卡片权限、有效期及卡片状态'})]);
 const result=await m.agent(input);assert.equal(result.passed,true);assert.equal(m.calls(),1);
 assert.equal(result.stepCoverage[0].evidence[0].actionId,'A1');
 assert.equal(result.stepCoverage[0].evidence[0].quote,report.actions[0].instruction);
 const catalog=workflowEvidenceCatalog({actions:[...report.actions,{id:'A2',instruction:'由另一位管理员核查卡片权限、有效期及卡片状态。'}]});
 const resolve=ref=>resolveStepEvidence([{id:'S1',covered:true,evidence:[ref]}],catalog)[0].evidence[0];
 assert.equal(resolve({source:'action',quote:'核查卡片权限'}).source,'invalid_evidence_id');
 assert.equal(resolve({source:'action',actionId:'A1',quote:'核查卡片权限'}).actionId,'A1');
 assert.equal(resolve({source:'action',actionId:'A999',quote:report.actions[0].instruction}).source,'invalid_evidence_id');
 assert.equal(resolve({source:'action',evidenceId:'W999',quote:report.actions[0].instruction}).source,'invalid_evidence_id');
 });
