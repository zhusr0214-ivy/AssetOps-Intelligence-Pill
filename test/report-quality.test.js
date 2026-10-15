import {cleaningConditionIssues} from '../triage-output-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportQualityIssues} from '../report-quality.js';
import {createTriageAgent} from '../triage-agent.js';
const description='其他员工的卡可以正常打开这扇门，但这名员工的授权范围、有效期和卡片状态尚未核查。';
const snapshot={validationScenario:true,fields:{description,observations:description,category:'other'}};
const pill={id:'p',rules:[{id:'R1',guidance:'单卡失败时先核查卡片，不确认原因。',actionIds:['A1']}],actions:[{id:'A1',instruction:'核查卡片。',ruleIds:['R1']}]};
const response=()=>({summary:'需要核查卡片，尚未确认原因。',hypotheses:[{ruleId:'R1',reasoning:'其他卡正常，先核查该卡。',evidence:[{field:'description',quote:description}],uncertainties:['授权范围、有效期和卡片状态尚未核查。']}],actionIds:['A1'],missingFields:[],prioritySuggestion:null});
test('Chinese narratives and cited unverified facts require visible limitations without changing rule matches',()=>{
 const result=response();assert.deepEqual(reportQualityIssues(result,snapshot),[]);result.hypotheses[0].uncertainties=[];assert.match(reportQualityIssues(result,snapshot).join(' '),/explicitUnknowns/);result.summary='The cause is not confirmed.';assert.match(reportQualityIssues(result,snapshot).join(' '),/reportLanguage/);
 assert.equal(result.hypotheses[0].ruleId,'R1');
});
test('known facts do not force invented unknowns, and English cases retain their language',()=>{
 const r=response();r.hypotheses[0].uncertainties=[];const facts='其他卡正常，这张卡显示拒绝访问，门没有打开。';r.hypotheses[0].evidence=[{field:'description',quote:facts}];assert.deepEqual(reportQualityIssues(r,{fields:{description:facts}}),[]);assert.deepEqual(reportQualityIssues({...r,summary:'Review card authorization.'},{fields:{description:'One card fails while others work.'}}),[]);
});
test('one bounded correction fixes language and unknowns while preserving evidence and branch',async()=>{
 let calls=0;const first=response();first.summary='Review card authorization.';first.hypotheses[0].uncertainties=[];
 const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async(_url,options)=>{calls++;if(calls===2)assert.match(JSON.parse(options.body).messages.at(-1).content,/reportLanguage|explicitUnknowns/);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(calls===1?first:response())}}]})};}});
 const result=await agent(snapshot,pill);assert.equal(calls,2);assert.deepEqual(reportQualityIssues(result,snapshot),[]);assert.equal(result.hypotheses[0].ruleId,'R1');assert.equal(result.hypotheses[0].evidence[0].quote,description);
});

test('omitting the unknown sentence from citations cannot erase explicitly reported limitations',()=>{
 const r=response();r.hypotheses[0].evidence=[{field:'description',quote:'其他员工的卡可以正常打开这扇门'}];r.hypotheses[0].uncertainties=[];assert.match(reportQualityIssues(r,snapshot).join(' '),/ALL uncertainty lists/);
});

test('presentation correction cannot add a branch, change actions or rewrite case evidence',async()=>{
 let calls=0;const first=response();first.summary='Review the card.';first.hypotheses[0].uncertainties=[];
 const corrected=response();corrected.hypotheses.push({...corrected.hypotheses[0],ruleId:'invented-rule'});corrected.actionIds=['invented-action'];corrected.hypotheses[0].evidence=[{field:'description',quote:'Invented facts'}];
 const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(++calls===1?first:corrected)}}]})})});
 const r=await agent(snapshot,pill);assert.equal(calls,2);assert.equal(r.hypotheses.length,1);assert.equal(r.hypotheses[0].ruleId,'R1');assert.equal(r.hypotheses[0].evidence[0].quote,description);assert.deepEqual(r.actionIds,['A1']);assert.ok(r.hypotheses[0].uncertainties.length);
});

test('a calendar date cannot be invented from a reported time of day',()=>{
 const r=response();r.summary='2025年5月15日下午2点收到反馈。';assert.match(reportQualityIssues(r,{fields:{description:'下午2点收到反馈，尚未开始清洁。'}}).join(' '),/unsupportedDate/);
 assert.ok(!reportQualityIssues(r,{fields:{description:'2025-05-15下午2点收到反馈。'}}).some(v=>v.startsWith('unsupportedDate:')));
});
test('an already reported not-started condition enables checking the plan without knowing its details',()=>{
 const p={rules:[{id:'specific',guidance:'如果尚未清洁，需核对清洁计划，不能直接判定人员漏做。',actionIds:['check-plan']}],actions:[]};const snap={fields:{description:'保洁人员表示本轮清洁尚未开始，计划时间为下午2点半。'}};
 assert.match(cleaningConditionIssues({hypotheses:[],actionIds:[]},snap,p).join(' '),/OUTPUT of checking/);
 assert.deepEqual(cleaningConditionIssues({hypotheses:[{ruleId:'specific'}],actionIds:['check-plan']},snap,p),[]);
 assert.deepEqual(cleaningConditionIssues({hypotheses:[],actionIds:[]},{fields:{description:'尚未确认本轮清洁是否尚未开始。'}},p),[]);
});

test('absence of a reported hazard is not a supported safety assurance',()=>{
 const r=response();r.summary='尚未开始清洁，没有紧急安全风险。';assert.match(reportQualityIssues(r,{fields:{description:'清洁尚未开始，会议区地面有纸屑。'}}).join(' '),/unsupportedSafety/);r.summary='案例未报告安全风险，安全状况仍未确认。';assert.ok(!reportQualityIssues(r,snapshot).some(i=>i.startsWith('unsupportedSafety:')));
});

test('an explicit cleaning state does not justify speculative attendance or partial-cleaning questions',()=>{
 const p={rules:[{id:'r',guidance:'如果尚未清洁，需核对清洁计划。',actionIds:['a']}],actions:[]},snap={fields:{description:'本轮清洁尚未开始，计划时间为下午2点半。'}};
 const r={hypotheses:[{ruleId:'r'}],actionIds:['a'],informationNeeds:[{kind:'follow_up',field:'observations',reason:'需要确认人员是否在岗或进行了部分清洁，以排除其他可能性。'}]};assert.match(cleaningConditionIssues(r,snap,p).join(' '),/followUpScope/);
 r.informationNeeds=[{kind:'follow_up',field:'impact',reason:'是否存在现场滑倒风险？'}];assert.deepEqual(cleaningConditionIssues(r,snap,p),[]);
});
test('one scoped correction removes speculative follow-ups without changing the branch or action',async()=>{
 const description='下午2点会议区地面有纸屑，保洁人员表示本轮清洁尚未开始，计划时间为下午2点半。';
 const p={id:'clean',rules:[{id:'r',guidance:'如果尚未清洁，需核对清洁计划。',actionIds:['a']}],actions:[{id:'a',instruction:'核对清洁计划。',ruleIds:['r']}]};
 const first={summary:'尚未开始清洁，先核对计划。',hypotheses:[{ruleId:'r',reasoning:'本轮尚未开始清洁。',evidence:[{field:'description',quote:description}],uncertainties:[]}],actionIds:['a'],missingFields:[],prioritySuggestion:null,informationNeeds:[{kind:'follow_up',field:'observations',reason:'需要确认人员是否在岗，以排除其他可能性。'}]};const second={...first,informationNeeds:[],actionIds:['invented']};let calls=0;
 const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(++calls===1?first:second)}}]})})});
 const r=await agent({validationScenario:true,fields:{description,observations:description}},p);assert.equal(calls,2);assert.equal(r.hypotheses[0].ruleId,'r');assert.deepEqual(r.actionIds,['a']);assert.deepEqual(r.followUpQuestions,[]);
});

test('source-verified repair state limitation is preserved without changing decisions',async()=>{
 const {preserveCitedUnknowns}=await import('../report-quality.js');
 const quote='松动比早上更明显，尚未确认维修完成。';
 const r={summary:'关联原记录。',hypotheses:[{ruleId:'R',evidence:[{field:'description',quote}],uncertainties:[]}],actionIds:['A'],missingFields:[]};
 const result=preserveCitedUnknowns(r,{fields:{description:quote}});
 assert.deepEqual(result.hypotheses[0].uncertainties,[quote]);
 assert.equal(result.hypotheses[0].ruleId,'R');assert.deepEqual(result.actionIds,['A']);
 const invalid={hypotheses:[{evidence:[{field:'description',quote}],uncertainties:[]}]};
 preserveCitedUnknowns(invalid,{fields:{description:'维修完成。'}});assert.deepEqual(invalid.hypotheses[0].uncertainties,[]);
});
