import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createPillStudio,validateDraft} from '../pill-studio.js';
import {createExpertInterviewAgent,relatedKnowledge} from '../expert-interview.js';
import {createHandler} from '../server.js';
import {ahuPill} from '../triage.js';
import {permitted} from '../auth.js';

const expert={id:'expert',name:'Expert A'};
const answer={understanding:'先比较读数；不根据单一现象确认原因。',question:'不同区域是否同时发生？',reason:'这会影响检查范围。'};
const triage=async snapshot=>({summary:'Compare reported readings.',hypotheses:[{ruleId:'HVAC-01',reasoning:'The room is reported warm; the cause is not confirmed.',evidence:[{field:'observations',quote:snapshot.fields.observations}],uncertainties:['Cause unknown.']}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null});
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'expert-flow-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const studio=createPillStudio(join(dir,'pills.json'),{interviewAgent:async()=>answer,evaluationAgent:triage,...options});
  return {studio,get:()=>studio.get(ahuPill.id)};
}

test('experience survives provider failure; retry does not duplicate the expert message',async t=>{
  let calls=0;const {studio,get}=await fixture(t,{interviewAgent:async()=>{if(++calls===1)throw Object.assign(Error('offline'),{status:502});return answer;}});
  let r=await get();await assert.rejects(studio.expertTurn(r.id,{revision:r.revision,message:'Room warm; compare readings.',authenticatedActor:expert}));
  r=await get();assert.equal(r.expertDialogue.status,'failed');assert.equal(r.expertDialogue.messages.length,1);
  r=await studio.expertTurn(r.id,{revision:r.revision,kind:'retry',authenticatedActor:expert});
  assert.equal(r.expertDialogue.messages.length,1);assert.equal(r.expertDialogue.reply.question,answer.question);
  r=await studio.expertTurn(r.id,{revision:r.revision,kind:'defer',authenticatedActor:expert});
  assert.equal(r.expertDialogue.messages.at(-1).deferredQuestion,answer.question);
  assert.equal(r.expertDialogue.reply.question,null);
  assert.equal(r.content.pill.rules.length,ahuPill.rules.length);
});

test('confirmation extracts only expert statements, preserves source provenance and retries the same document',async t=>{
  let captured,calls=0;const {studio,get}=await fixture(t,{captureAgent:async doc=>{captured=doc;if(++calls===1)throw Object.assign(Error('offline'),{status:502});return {candidates:[],questions:[],conflicts:[]};}});
  let r=await get();r=await studio.expertTurn(r.id,{revision:r.revision,message:'Compare readings. Never operate equipment.',sourceReference:'Interview 1',authenticatedActor:expert});
  await assert.rejects(studio.expertConfirm(r.id,{revision:r.revision,confirmed:true,authenticatedActor:expert}));
  r=await get();const docId=r.expertDialogue.documentId;assert.equal(r.documents.length,1);
  const original=(await studio.original(r.id,docId)).bytes.toString();assert.match(original,/Interview 1/);assert.match(original,/Compare readings/);assert.ok(!original.includes(answer.understanding));assert.ok(!original.includes(answer.question));
  r=await studio.expertConfirm(r.id,{revision:r.revision,confirmed:true,authenticatedActor:expert});
  assert.equal(r.documents.length,1);assert.equal(r.expertDialogue.documentId,docId);assert.equal(r.documents[0].status,'extracted');assert.equal(captured.domain,'ahu_cooling');
});

test('example is analyzed without expected answers; confirmed feedback becomes a saved regression case',async t=>{
  const {studio,get}=await fixture(t);let r=await get();
  r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room temperature 29 C',authenticatedActor:expert});
  const trial=r.expertTrials[0];assert.equal(trial.report.status,'complete');assert.equal(r.evaluationSuite,undefined);
  r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'accepted',expectedHandling:trial.proposedHandling,authenticatedActor:expert});
  assert.equal(r.evaluationSuite.length,1);assert.equal(r.evaluationSuite[0].expected.workflow.steps,trial.proposedHandling);assert.equal(r.evaluationRequired,true);
  await assert.rejects(studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'accepted',expectedHandling:trial.proposedHandling}),{status:409});
  r=await studio.change(r.id,'save-evaluations',{revision:r.revision,suite:r.evaluationSuite,sharedExamples:true});assert.equal(r.content.examples.length,1);assert.deepEqual(r.content.examples[0].ruleIds,['HVAC-01']);
});

test('expert correction returns to source review and cannot silently pass publication',async t=>{
  const {studio,get}=await fixture(t,{captureAgent:async()=>({candidates:[{id:'K-1',type:'boundary',title:'No guessed cause',text:'Do not confirm a cause without comparison.',evidence:[{blockId:'B1',location:'Expert correction',quote:'Do not confirm a cause without comparison.'}],relatedRuleIds:[],relatedActionIds:[],missing:[]}],questions:[],conflicts:[]})});
  let r=await get();r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room warm',authenticatedActor:expert});const trial=r.expertTrials[0];
  r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'corrected',feedback:'Do not confirm a cause without comparison.',expectedHandling:'Compare affected and unaffected areas before referring.',expectedStatus:'complete',authenticatedActor:expert});
  assert.equal(r.expertFeedback[0].status,'pending_knowledge_review');assert.match(r.expertDialogue.messages[0].text,/Do not confirm a cause/);
  await assert.rejects(studio.change(r.id,'submit',{revision:r.revision}),/pending expert (?:corrections|discussion)/);
  r=await studio.expertConfirm(r.id,{revision:r.revision,confirmed:true,authenticatedActor:expert});const doc=r.documents.at(-1);
  assert.ok(doc.repairTargets.some(t=>t.id==='HVAC-01'&&t.type==='rule'));
  const body={revision:r.revision,confirmed:true,reviewer:'Expert A',selections:[{id:'K-1',text:doc.candidates[0].text}],authenticatedActor:expert};
  await assert.rejects(studio.merge(r.id,doc.id,body),/example correction/);
  r=await studio.merge(r.id,doc.id,{...body,feedbackConfirmed:true});assert.equal(r.expertFeedback[0].status,'reviewed_in_knowledge');assert.ok(r.content.pill.boundaries.includes(doc.candidates[0].text));assert.equal(r.state,'draft');
});

test('stale example feedback and concurrent expert requests cannot overwrite changed knowledge',async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve);const {studio,get}=await fixture(t,{interviewAgent:async()=>{started();await new Promise(resolve=>release=resolve);return answer;}});
  let r=await get();const pending=studio.expertTurn(r.id,{revision:r.revision,message:'Compare readings.'});await ready;
  await assert.rejects(studio.expertTurn(r.id,{revision:r.revision,message:'Other experience'}),{status:409});release();r=await pending;
  r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room warm'});const trial=r.expertTrials[0];
  r.content.pill.scope+=' Updated scope.';r=await studio.change(r.id,'save',{revision:r.revision,content:r.content});
  await assert.rejects(studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'accepted',expectedHandling:'Check readings'}),/Knowledge changed/);
});

test('same-domain knowledge is related but never implicitly activated or merged',()=>{
  const r=(id,domain)=>({id,state:'draft',content:{pill:{id,name:id,domain,scope:'Scope',applicability:{categories:[domain]}}},releases:[]});
  const current=r('current','water_leak'),related=r('other','water_leak'),different=r('lift','lift_fault');
  assert.deepEqual(relatedKnowledge([current,related,different],current).map(p=>p.id),['other']);assert.equal(related.content.pill.rules,undefined);
});

test('expert API is routed through studio authoring roles and preserves authenticated identity',async t=>{
  const {studio,get}=await fixture(t);let r=await get();const handler=createHandler({list:async()=>[]},undefined,undefined,studio);
  const req=Readable.from([JSON.stringify({revision:r.revision,message:'Compare readings',authenticatedActor:{id:'spoof'}})]);Object.assign(req,{method:'POST',url:`/api/studio/${r.id}/expert/message`,headers:{host:'localhost'},authenticatedActor:expert});
  let status,result;await handler(req,{writeHead(v){status=v;},end(raw){result=JSON.parse(raw);}});assert.equal(status,200);assert.equal(result.record.expertDialogue.messages[0].actorId,expert.id);
  for(const operation of ['message','confirm','example','feedback']){assert.equal(permitted({roles:['viewer']},`/api/studio/${r.id}/expert/${operation}`,'POST'),false);assert.equal(permitted({roles:['expert']},`/api/studio/${r.id}/expert/${operation}`,'POST'),true);}
});

test('interview adapter rejects malformed output and uses one targeted question without requesting a schema',async()=>{
  let request;const agent=createExpertInterviewAgent({env:{SOCLAAS_BASE_URL:'https://fixture.test/v1',SOCLAAS_API_KEY:'fixture'},fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(answer)}}]})};}});
  assert.equal((await agent({messages:[{text:'专家经验'}]})).question,answer.question);assert.match(request.messages[0].content,/at most ONE/);assert.match(request.messages[0].content,/Do not ask the expert to classify/);
  const bad=createExpertInterviewAgent({env:{SOCLAAS_BASE_URL:'https://fixture.test/v1',SOCLAAS_API_KEY:'fixture'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'{}'}}]})})});await assert.rejects(bad({}));
});


 test('interview wire formats preserve complete content despite a known provider field typo',async()=>{
 const {parseInterviewResponse}=await import('../expert-interview.js');
 for(const key of ['summary','understanding','underding']){
  const value=parseInterviewResponse(JSON.stringify({[key]:'单卡失败先核查卡片权限，原因仍未确认。',question:'',reason:''}));
  assert.equal(value.understanding,'单卡失败先核查卡片权限，原因仍未确认。');assert.equal(value.question,null);assert.equal(value.reason,null);
 }
 for(const value of [{summary:'A',understanding:'B',question:null,reason:null},{summary:'',question:null,reason:null},{unrecognized:'A'},{summary:'A',question:[]},{summary:'A',reason:'x'.repeat(501)}])assert.throws(()=>parseInterviewResponse(JSON.stringify(value)));
 });

 test('Chinese expert discussion corrects the reply language once and rejects repeated translation',async()=>{
 const {createExpertInterviewAgent}=await import('../expert-interview.js');
 const input={messages:[{text:'只有一张卡失败时优先核查卡片权限，但不能认定也不能完全排除读卡器故障。'}]};
 const chinese={summary:'单卡失败时优先核查卡片权限，但不能认定也不能完全排除读卡器故障。',question:null,reason:null};
 let calls=0;const responses=[{summary:'Check the card, but neither establish nor exclude a reader fault.',question:null,reason:null},chinese];
 const agent=createExpertInterviewAgent({env:{SOCLAAS_BASE_URL:'https://fixture.test/v1',SOCLAAS_API_KEY:'fixture'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(responses[calls++])}}]})})});
 assert.equal((await agent(input)).understanding,chinese.summary);assert.equal(calls,2);
 calls=0;responses[1]=responses[0];await assert.rejects(agent(input),/未保持中文/);assert.equal(calls,2);
 });

test('report-only corrections avoid knowledge extraction and an accepted retest resolves the issue',async t=>{
 const {studio,get}=await fixture(t);let r=await get();r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room warm',authenticatedActor:expert});let trial=r.expertTrials.at(-1);
 r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'corrected',feedbackKind:'report',feedback:'Keep missing verification visible.',expectedHandling:trial.proposedHandling,authenticatedActor:expert});assert.equal(r.expertFeedback[0].status,'pending_report_fix');assert.equal(r.expertDialogue,undefined);
 trial=r.expertTrials.at(-1);assert.equal(trial.feedback,undefined);r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'accepted',expectedHandling:trial.proposedHandling,authenticatedActor:expert});assert.equal(r.expertFeedback[0].status,'resolved_by_retest');assert.equal(r.evaluationSuite.length,1);
});
test('an unsourced knowledge feedback can explicitly be reclassified without losing its correction',async t=>{
 const {studio,get}=await fixture(t);let r=await get();r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room warm',authenticatedActor:expert});const trial=r.expertTrials.at(-1);r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'corrected',feedback:'Keep missing verification visible.',expectedHandling:trial.proposedHandling,authenticatedActor:expert});assert.equal(r.expertDialogue.messages.length,1);
 r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,reclassify:true,feedbackKind:'report',authenticatedActor:expert});assert.equal(r.expertDialogue,undefined);assert.equal(r.expertFeedback[0].status,'pending_report_fix');assert.equal(r.expertFeedback[0].correction,'Keep missing verification visible.');assert.equal(r.expertDialogueHistory.at(-1).messages.length,1);
});

test('a source with no escalation condition does not need an invented trigger to validate',()=>{
 const content={pill:{...structuredClone(ahuPill),escalationConditions:[]},sources:[{expert:'Expert',reference:'Interview',knowledge:'Recorded conditions and handling.'}],examples:[]};assert.ok(!validateDraft(content).errors.some(e=>/escalationConditions/.test(e)));
 content.pill.escalationConditions=[''];assert.ok(validateDraft(content).errors.some(e=>/escalationConditions/.test(e)));
});
