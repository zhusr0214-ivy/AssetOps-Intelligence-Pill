import test from 'node:test';import assert from 'node:assert/strict';
import {evaluatePill,validateSuite} from '../pill-evaluation.js';import {ahuPill} from '../triage.js';import {createWorkflowAssessment,workflowReportInput,workflowStepRequirements,stepCoverageIssues,workflowEvidenceCatalog,resolveStepEvidence} from '../workflow-assessment.js';
const workflow={steps:'Record symptoms and ask a qualified specialist to assess.',responsibility:'Facilities team records facts.',information:'Keep unknown cause unknown.',completion:'Record the referral.'};
const record=()=>({content:{pill:ahuPill},releases:[],evaluationSuite:[{name:'Case',mode:'scenario',facts:{category:'hvac_cooling',observations:'Room warm'},expected:{status:'complete',workflow,ruleIds:[],actionIds:[],missingFields:[]}}]});
const report=()=>({summary:'Record symptoms and refer.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Review.',evidence:[{field:'observations',quote:'Room warm'}],uncertainties:[]}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null});
test('expert workflow is saved and evaluated separately, never disclosed to the answering agent',async()=>{
 assert.deepEqual(validateSuite(record().evaluationSuite)[0].expected.workflow,workflow);
 let asked,compared;const run=await evaluatePill(record(),async snapshot=>{asked=snapshot;return report();},async input=>{compared=input;return {passed:true,checks:{steps:true},differences:[]};});
 assert.equal(run.passed,true);assert.ok(!JSON.stringify(asked).includes(workflow.steps));assert.equal(compared.expected.steps,workflow.steps);assert.equal(run.results[0].candidate.workflowAssessment.passed,true);
});
test('workflow differences and comparison failures cannot become successful trials',async()=>{
 const mismatch=await evaluatePill(record(),async()=>report(),async()=>({passed:false,checks:{steps:false},differences:['Missing professional referral.']}));assert.equal(mismatch.passed,false);
 const failed=await evaluatePill(record(),async()=>report(),async()=>{throw new Error('offline');});assert.equal(failed.passed,false);assert.equal(failed.results[0].candidate.failureCode,'workflow_comparison');
});
test('workflow comparator rejects malformed and truncated output',async()=>{
 for(const choices of [[{message:{content:'{}'}}],[{finish_reason:'length',message:{content:'{}'}}]]){
 const compare=createWorkflowAssessment({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices})})});await assert.rejects(compare({expected:workflow,report:report(),facts:{},pill:ahuPill}));}
});

test('reported workflow omissions cannot pass even when model booleans contradict them',async()=>{
 const checks={steps:true,responsibility:true,information:true,completion:true,scope:true};
 for(const differences of [[],['Missing required professional referral.']]){
 const compare=createWorkflowAssessment({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({checks,differences})}}]})})});
 assert.equal((await compare({expected:{},report:report(),facts:{},pill:ahuPill})).passed,differences.length===0);
 }
});

test('workflow comparison separates assessment readiness from physical resolution without discarding hypotheses',()=>{
 const source={...report(),status:'complete',summary:'Cause unknown; inspection pending.'};const input=workflowReportInput(source);
 assert.equal(input.status,undefined);assert.equal(input.assessmentState,'scoped_assessment_ready');assert.equal(source.status,'complete');assert.deepEqual(input.hypotheses,source.hypotheses);assert.match(input.assessmentStateMeaning,/does not describe/);
});

test('concrete expected tasks need actual selected action evidence, never a catalog action or uncertainty',()=>{
 const expected={steps:'由门禁管理员核查卡片权限、有效期及状态。'};const requirements=workflowStepRequirements(expected);assert.equal(requirements[0].kind,'action');
 const report={summary:'卡片权限可能有问题',hypotheses:[{ruleId:'R1',reasoning:'可能涉及权限或有效期'}],actions:[{id:'generic',instruction:'收集现场信息。'}]};
 const coverage=evidence=>[{id:'S1',covered:true,evidence}];
 assert.ok(stepCoverageIssues(coverage([{source:'summary',quote:report.summary}]),requirements,report).length);
 assert.ok(stepCoverageIssues(coverage([{source:'action',actionId:'unselected',quote:'核查卡片权限、有效期及状态'}]),requirements,report).length);
 const specific={id:'specific',instruction:'由门禁管理员核查卡片权限、有效期及状态。'};report.actions.push(specific);
 assert.deepEqual(stepCoverageIssues(coverage([{source:'action',actionId:'specific',quote:specific.instruction}]),requirements,report),[]);
 assert.ok(stepCoverageIssues([],requirements,report).length);assert.ok(stepCoverageIssues([{id:'S1',covered:false,evidence:[]}],requirements,report).length);
});

test('comparison evidence IDs resolve only server-owned report text',()=>{
 const report={actions:[{id:'specific',instruction:'核查卡片权限。'}]};const catalog=workflowEvidenceCatalog(report);
 const coverage=resolveStepEvidence([{id:'S1',covered:true,evidence:[{evidenceId:'W1',quote:'invented',source:'summary'}]}],catalog);
 assert.equal(coverage[0].evidence[0].quote,'核查卡片权限。');assert.equal(coverage[0].evidence[0].source,'action');
 const invalid=resolveStepEvidence([{id:'S1',covered:true,evidence:[{evidenceId:'W999'}]}],catalog);assert.equal(invalid[0].evidence[0].source,'invalid_evidence_id');
});

test('generic action evidence cannot satisfy named card checks even if comparator marks it covered',()=>{
 const requirements=workflowStepRequirements({steps:'核查卡片权限、有效期及卡片状态。'});const report={actions:[{id:'generic',instruction:'收集刷卡提示、门的位置和其他人员通行情况。'}]};
 const coverage=[{id:'S1',covered:true,evidence:[{source:'action',actionId:'generic',quote:report.actions[0].instruction}]}];assert.ok(stepCoverageIssues(coverage,requirements,report).length>=3);
 report.actions[0].instruction='核查卡片权限、有效期及卡片状态。';coverage[0].evidence[0].quote=report.actions[0].instruction;assert.deepEqual(stepCoverageIssues(coverage,requirements,report),[]);
});

 test('comparison outage retains the validated advisory report and never changes publication outcome',async()=>{
 const run=await evaluatePill(record(),async()=>report(),async()=>{throw new Error('secret provider details');});
 const sample=run.results[0].candidate;
 assert.equal(sample.failureKind,'comparison_error');assert.equal(sample.failureCode,'workflow_comparison');
 assert.equal(sample.actual.status,'complete');assert.equal(sample.report.summary,report().summary);
 assert.equal(sample.checks.status,true);assert.equal(sample.passed,false);assert.equal(run.passed,false);
 assert.ok(!JSON.stringify(run).includes('secret provider details'));
 });
