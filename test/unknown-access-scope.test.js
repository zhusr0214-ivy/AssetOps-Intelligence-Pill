import test from 'node:test';
import assert from 'node:assert/strict';
import {accessScopeConditionIssues} from '../triage-output-contract.js';
import {validateTriageResult} from '../triage.js';
import {createTriageAgent} from '../triage-agent.js';
import {governancePackage} from '../review.js';
import {caseFingerprint} from '../triage.js';
const pill={id:'access',domain:'asset_operations',rules:[{id:'single',guidance:'当只有一张卡失败且其他人正常时，优先核查卡片权限。',actionIds:['check-card']},{id:'multi',guidance:'当多个人在同一扇门都失败时，暂不确定具体故障。',actionIds:['check-door']}],actions:[{id:'check-card',instruction:'请管理员核查卡片权限。',owner:'管理员',requiresApproval:true,ruleIds:['single']},{id:'check-door',instruction:'请维护人员检查共同设备。',owner:'维护人员',requiresApproval:true,ruleIds:['multi']}],boundaries:['Advisory only.']};
const unknown='一名员工报告会议室入口刷卡打不开门，但尚不清楚是只有这张卡失败，还是其他人的卡也失败。读卡器当时的提示情况未知，尚未查看事件记录。';
const snapshot=text=>({id:'example',validationScenario:true,fields:{description:text,observations:text,asset:'会议室入口门禁',category:'other'}});
const output=(text,ids)=>({summary:'范围尚未确认，不能选定具体分支。',hypotheses:ids.map(ruleId=>({ruleId,reasoning:'需要确认对应条件。',evidence:[{field:'observations',quote:text}],uncertainties:['影响范围未确认']})),actionIds:[],missingFields:[],prioritySuggestion:null});
test('unknown single-versus-multiple scope supports neither conditional rule, even with exact quotes',()=>{
 const value=output(unknown,['single','multi']);assert.equal(accessScopeConditionIssues(value,snapshot(unknown),pill).length,2);
 assert.throws(()=>validateTriageResult(value,snapshot(unknown),pill),e=>e.validationCode==='applicability');
});
test('confirmed single and multiple cases retain their own branch and reject the other',()=>{
 const single='今天上午，一名员工在资料室门口刷卡显示拒绝访问，门没有打开。同一时间，其他员工的卡可以正常打开这扇门。';
 const multi='三名员工先后在会议室入口刷卡，都显示拒绝访问，门未打开。这些员工的卡在其他房间可以正常使用。';
 assert.deepEqual(accessScopeConditionIssues(output(single,['single']),snapshot(single),pill),[]);assert.equal(accessScopeConditionIssues(output(single,['multi']),snapshot(single),pill).length,1);
 assert.deepEqual(accessScopeConditionIssues(output(multi,['multi']),snapshot(multi),pill),[]);assert.equal(accessScopeConditionIssues(output(multi,['single']),snapshot(multi),pill).length,1);
});
test('one corrective request can remove unsupported branch claims without inventing a rule or action',async()=>{
 let calls=0;const corrected={...output(unknown,[]),summary:'现有规则分别要求已确认的单卡或多人失败，当前均未确认。需要专家补充分支未知时的处理知识。',informationNeeds:[{field:'observations',kind:'follow_up',reason:'请确认其他人的卡是否也失败。'}]};
 const replies=[output(unknown,['single','multi']),corrected];const agent=createTriageAgent({env:{SOCLAAS_BASE_URL:'https://fixture.test/v1',SOCLAAS_API_KEY:'fixture'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(replies[calls++])}}]})})});
 const result=validateTriageResult(await agent(snapshot(unknown),pill),snapshot(unknown),pill);assert.equal(calls,2);assert.equal(result.hypotheses.length,0);assert.equal(result.actions.length,0);assert.equal(result.followUpQuestions.length,1);
});
test('repeated unsupported branch claims never become a successful report',async()=>{
 const agent=createTriageAgent({env:{SOCLAAS_BASE_URL:'https://fixture.test/v1',SOCLAAS_API_KEY:'fixture'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output(unknown,['single','multi']))}}]})})});
 const result=await agent(snapshot(unknown),pill);assert.throws(()=>validateTriageResult(result,snapshot(unknown),pill),e=>e.validationCode==='applicability');
});
test('an old complete report with unsupported branches is blocked when reviewed under the new validator',()=>{
 const incident={...snapshot(unknown).fields,status:'ready_for_triage'};
 const report={...output(unknown,['single','multi']),id:'old-report',status:'complete',snapshot:snapshot(unknown),pill,caseFingerprint:caseFingerprint(incident),actions:[]};
 const review=governancePackage(incident,report,pill);assert.equal(review.canApprove,false);assert.ok(review.findings.some(f=>f.code==='evidence'&&f.severity==='block'));
});

test('confirmed single-card scope cannot be reclassified as unknown just because authorization is unverified',()=>{
 const pill={rules:[{id:'unknown',guidance:'当尚不清楚是单卡还是多人同门失败时，不选择任何已确认分支。'}],actions:[]};
 const snapshot={fields:{description:'一名员工刷卡显示拒绝访问，其他员工的卡可以正常打开这扇门。授权范围尚未核查。'}};
 assert.ok(accessScopeConditionIssues({hypotheses:[{ruleId:'unknown'}]},snapshot,pill).some(v=>v.includes('already confirms')));
});
