import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {createPillStudio} from '../pill-studio.js';
import {ahuPill} from '../triage.js';
import {evaluationGate} from '../pill-evaluation.js';
import {expertDialogueMarkup,expertExamplesMarkup,compactExpertValidation} from '../public/expert-flow.js';
const author={id:'author',name:'Expert'},reviewer={id:'reviewer',name:'Reviewer'};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'unified-expert-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
 const studio=createPillStudio(join(dir,'pills.json'),{evaluationAgent:async snapshot=>{calls++;return {summary:'Compare readings; cause unknown.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Compare reported readings, without confirming a cause.',evidence:[{field:'observations',quote:snapshot.fields.observations}],uncertainties:[]}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null};}});
 let r=await studio.get(ahuPill.id);r.content.sources=[{expert:'Expert',reference:'Interview',knowledge:'Compare readings.'}];r=await studio.change(r.id,'save',{revision:r.revision,content:r.content,authenticatedActor:author});return {studio,r,calls:()=>calls};
}
async function accept(studio,r){r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room temperature 29 C',authenticatedActor:author});const trial=r.expertTrials.at(-1);return studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'accepted',expectedHandling:trial.proposedHandling,authenticatedActor:author});}
test('one model call and expert confirmation create current validation and permit final publication review',async t=>{
 const f=await fixture(t);let r=await accept(f.studio,f.r);assert.equal(f.calls(),1);assert.equal(r.evaluations.at(-1).method,'expert_confirmed_examples');assert.equal(evaluationGate(r).passed,true);assert.equal(r.validation.passed,true);
 r=await f.studio.change(r.id,'submit',{revision:r.revision,authenticatedActor:author});assert.equal(r.state,'in_review');assert.equal(f.calls(),1);
 r=await f.studio.change(r.id,'publish',{revision:r.revision,authenticatedActor:author,reviewer:'Expert',notes:'Reviewed the sources and handling limits.',expertConfirmed:true});assert.equal(r.state,'published');assert.equal(r.releases.at(-1).evaluation.method,'expert_confirmed_examples');assert.equal(f.calls(),1);
});
test('knowledge edits invalidate confirmation and old reports cannot refresh it',async t=>{
 const f=await fixture(t);let r=await accept(f.studio,f.r);r.content.pill.scope+=' Revised.';r=await f.studio.change(r.id,'save',{revision:r.revision,content:r.content});assert.equal(evaluationGate(r).state,'outdated');
 r=await f.studio.expertValidate(r.id,{revision:r.revision,authenticatedActor:author});assert.equal(r.evaluations.at(-1).passed,false);assert.equal(f.calls(),1);await assert.rejects(f.studio.change(r.id,'submit',{revision:r.revision,autoValidate:true}),{status:409});
});
test('independent review remains required and cannot be satisfied by the confirming author',async t=>{
 const f=await fixture(t);let r=f.r;r=await f.studio.change(r.id,'save-evaluations',{revision:r.revision,suite:[{name:'Placeholder',facts:{category:'hvac_cooling'},expected:{status:'complete',ruleIds:[],actionIds:[],missingFields:[],workflow:{steps:'Compare readings.'}}}],options:{independentReviewRequired:true},draftOnly:true});
 // Remove the unconfirmed placeholder through the ordinary editor before the example.
 r=await f.studio.get(r.id);r=await accept(f.studio,r);assert.equal(r.evaluations.at(-1).passed,false);
 const suite=[r.evaluationSuite.at(-1)];r=await f.studio.change(r.id,'save-evaluations',{revision:r.revision,suite,sharedExamples:true});r=await f.studio.expertValidate(r.id,{revision:r.revision,authenticatedActor:author});assert.equal(r.evaluations.at(-1).passed,true);assert.equal(evaluationGate(r).state,'expert_review_required');
 const input={revision:r.revision,runId:r.evaluations.at(-1).id,decision:'accepted',scope:'Warm room',limitations:'Advisory only',qualification:'Operations experience',reference:'Source and example',notes:'Checked the report.',confirmed:true};
 await assert.rejects(f.studio.reviewEvaluation(r.id,{...input,authenticatedActor:author}),{status:403});r=await f.studio.reviewEvaluation(r.id,{...input,authenticatedActor:reviewer});assert.equal(evaluationGate(r).passed,true);
});
test('previously saved expert feedback is adopted without rerunning and with no duplicate evidence',async t=>{
 const f=await fixture(t);let r=await accept(f.studio,f.r);const before=r.evaluations.length;r=await f.studio.expertValidate(r.id,{revision:r.revision,authenticatedActor:author});assert.equal(r.evaluations.length,before);assert.equal(f.calls(),1);
});
test('duplicate automatic trials are removed while expert validation and continuation remain',t=>{
 const dom=new JSDOM('<main><section class="expert-examples"></section><section class="evaluation-panel"><section data-evaluation-result><h3>Evaluation passed</h3><p>All trials passed</p></section><button>Run evaluation</button><button data-confirmation-step>Continue to confirmation</button></section></main>');t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');
 compactExpertValidation(view,{id:'p',evaluationGate:{state:'passed'},evaluations:[{method:'expert_confirmed_examples',passed:true}]},()=>{});assert.equal(view.querySelector('.expert-advanced-evaluation'),null);assert.equal(view.querySelector('.evaluation-panel'),null);assert.equal(view.querySelector('.expert-examples h3').textContent,'Examples confirmed by expert');assert.match(view.querySelector('.expert-examples').textContent,/no second model run/);assert.ok(view.querySelector('.expert-examples [data-confirmation-step]'));assert.doesNotMatch(view.textContent,/Run evaluation/);
});

test('unavailable analysis returns a retained conclusion, cannot pass, and can be retried',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'expert-fallback-'));t.after(()=>rm(dir,{recursive:true,force:true}));let unavailable=true;
 const studio=createPillStudio(join(dir,'pills.json'),{evaluationAgent:async snapshot=>{if(unavailable)throw Object.assign(new Error('private provider diagnostics'),{status:502});return {summary:'Compare readings.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Compare readings.',evidence:[{field:'observations',quote:snapshot.fields.observations}],uncertainties:[]}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null};}});
 let r=await studio.get(ahuPill.id);
 r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room temperature 29 C',authenticatedActor:author});
 assert.equal(r.expertAttempt.status,'analysis_unavailable');assert.equal(r.expertTrials?.length||0,0);
 const html=expertExamplesMarkup(r);assert.match(html,/暂不能可靠判断/);assert.match(html,/Room temperature 29 C/);assert.doesNotMatch(html,/private provider diagnostics|data-expert-feedback/);
 await assert.rejects(studio.change(r.id,'submit',{revision:r.revision,authenticatedActor:author}),{status:409});
 unavailable=false;r=await studio.expertTrial(r.id,{revision:r.revision,description:r.expertAttempt.description,authenticatedActor:author});assert.equal(r.expertAttempt,undefined);assert.equal(r.expertTrials.length,1);
});

test('report correction automatically reanalyses with saved feedback without changing knowledge',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'expert-correction-'));t.after(()=>rm(dir,{recursive:true,force:true}));const requests=[];
 const studio=createPillStudio(join(dir,'pills.json'),{evaluationAgent:async snapshot=>{requests.push(snapshot);return {summary:'Compare readings.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Compare readings.',evidence:[{field:'observations',quote:snapshot.fields.observations}],uncertainties:[]}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null};}});
 let r=await studio.get(ahuPill.id);r=await studio.expertTrial(r.id,{revision:r.revision,description:'Room temperature 29 C',authenticatedActor:author});const before=JSON.stringify(r.content.pill),trial=r.expertTrials.at(-1);
 r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:trial.id,decision:'corrected',feedbackKind:'report',feedback:'Keep the report concise.',expectedHandling:trial.proposedHandling,authenticatedActor:author});
 assert.equal(requests.length,2);assert.deepEqual(requests[1].reportFeedback,[{correction:'Keep the report concise.'}]);assert.equal(r.expertTrials.length,2);assert.equal(r.expertTrials.at(-1).feedback,undefined);assert.equal(JSON.stringify(r.content.pill),before);assert.equal(r.expertFeedback.at(-1).status,'pending_report_fix');
 const revised=r.expertTrials.at(-1);r=await studio.expertFeedback(r.id,{revision:r.revision,trialId:revised.id,decision:'accepted',expectedHandling:revised.proposedHandling,authenticatedActor:author});assert.equal(r.expertFeedback[0].status,'resolved_by_retest');
});
