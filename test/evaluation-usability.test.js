import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { evaluationMarkup, bindEvaluation, publicationStatusMarkup,showEvaluationProgress } from '../public/evaluation.js';
const record = () => ({id:'qa',state:'validated',validation:{passed:true},content:{pill:{rules:[{id:'R1',title:'Collect facts'},{id:'R2',title:'Preserve unknowns'}],actions:[{id:'A1',title:'Refer specialist'}],applicability:{categories:['lift_fault']}}},evaluationSuite:[],evaluations:[],evaluationRequired:true,evaluationGate:{state:'failed',passed:false}});
test('visible Add opens suite with correct category and checkbox choices serialize IDs',t=>{
 const r=record(),dom=new JSDOM(`<main><p id="studio-error"></p>${evaluationMarkup(r)}</main>`);t.after(()=>dom.window.close());const root=dom.window.document.querySelector('main');let sent;
 bindEvaluation(root,r,(op,body)=>{sent={op,body};},()=>{});
 assert.equal(root.querySelector('[data-add-test]').closest('details'),null);
 root.querySelector('[data-add-test]').click();assert.equal(root.querySelector('[data-test-suite]').open,true);
 let rows=root.querySelectorAll('[data-evaluation-case]');assert.equal(rows[0].querySelector('[name=category]').value,'lift_fault');
 const override=rows[0].querySelector('[data-rule-override]');override.checked=true;override.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 const choice=rows[0].querySelector('[data-expected=ruleIds]');choice.checked=true;choice.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 assert.equal(rows[0].querySelector('[name=ruleIds]').value,'R1');
 root.querySelector('[data-add-test]').click();rows=root.querySelectorAll('[data-evaluation-case]');rows[0].querySelector('[name=testName]').value='Supported';rows[1].querySelector('[name=testName]').value='Negative';rows[1].querySelector('[name=expectedStatus]').value='out_of_scope';
 root.querySelector('#evaluation-suite').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));assert.deepEqual(sent.body.suite[0].expected.ruleIds,['R1']);assert.deepEqual(sent.body.suite[1].expected.ruleIds,[]);
});
test('every failed trial explains missing rules and escapes summaries; publication shows failed total',()=>{
 const r=record();r.evaluations=[{passed:false,statistics:{passed:4,samples:6},results:[{name:'Lift',expected:{status:'complete',ruleIds:['R1','R2'],actionIds:[],missingFields:[]},candidate:{passed:false,samples:[{passed:false,modelCalled:true,actual:{status:'complete',ruleIds:['R1'],actionIds:[],missingFields:[]},report:{summary:'<script>bad</script>'}}]}}]}];
 const html=evaluationMarkup(r);assert.match(html,/Missing expected judgement: Preserve unknowns/);assert.ok(!html.includes('<script>'));assert.match(publicationStatusMarkup(r),/4\/6 trials/);assert.match(publicationStatusMarkup(r),/View failed trial details/);
});

test('running evaluation hides stale results and clearly labels current progress',t=>{
 const dom=new JSDOM('<main><aside class="studio-next-step"><p>Previous failed result</p></aside><section><fieldset id="evaluation-options"></fieldset><p>1 / 3 passed</p></section><section class="evaluation-panel"><div class="table-scroll">Previous trial results</div><section class="evaluation-differences">Previous failures</section></section><p data-model-statistics>Old statistics</p></main>');t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main'),restore=showEvaluationProgress(view);
 assert.equal(view.querySelector('.evaluation-differences').hidden,true);assert.equal(view.querySelector('.table-scroll').hidden,true);assert.equal(view.querySelector('[data-model-statistics]').hidden,true);assert.match(view.querySelector('.evaluation-progress').textContent,/Running the current evaluation/);
 restore();assert.equal(view.querySelector('.evaluation-differences').hidden,false);assert.equal(view.querySelector('.evaluation-progress'),null);assert.equal(view.querySelector('.studio-next-step p').textContent,'Previous failed result');
});

test('compact results distinguish invalid model output from expectation mismatch and expose one next action', async t=>{
 const {compactEvaluation,focusEvaluationResult}=await import('../public/evaluation.js');
 const r=record();r.evaluations=[{passed:false,statistics:{passed:1,samples:3},results:[{name:'Case',expected:{status:'complete',ruleIds:['R1'],actionIds:[],missingFields:[]},candidate:{passed:false,samples:[{passed:true},{passed:false,error:'Invalid evidence',validationCode:'evidence_source'},{passed:false,actual:{status:'needs_information',ruleIds:['R1'],actionIds:[],missingFields:['observations']}}]}}]}];
 const dom=new JSDOM(`<main><div data-page-panel="evaluation">${evaluationMarkup(r)}<button data-operation="submit" disabled>Submit for final review</button></div></main>`,{url:'http://localhost/studio/qa?view=evaluation'});t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');
 compactEvaluation(view,r);const result=view.querySelector('[data-evaluation-result]');assert.match(result.textContent,/1 invalid outputs · 1 expectation mismatches/);assert.match(result.textContent,/not a finding/);assert.equal(view.querySelector('[data-operation=submit]').hidden,true);
 const details=view.querySelector('.evaluation-differences');details.scrollIntoView=()=>{};assert.equal(details.querySelector('details').open,false);result.querySelector('button').click();assert.equal(details.querySelector('details').open,true);
 let scrolled=false;result.scrollIntoView=()=>{scrolled=true;};focusEvaluationResult(view);assert.equal(dom.window.document.activeElement,result);assert.equal(scrolled,true);
});

test('evidence diagnostics render the failed location and escape returned text',()=>{
 const r=record();r.evaluations=[{passed:false,results:[{name:'Case',expected:{status:'complete',ruleIds:[],actionIds:[],missingFields:[]},candidate:{passed:false,error:'Invalid quote',evidenceDiagnostic:{hypothesis:2,evidence:1,field:'observations',reason:'quote_not_found_or_ambiguous_source',quote:'<script>bad</script>'}}}]}];
 const html=evaluationMarkup(r);assert.match(html,/Hypothesis 2, evidence 1/);assert.match(html,/quote_not_found_or_ambiguous_source/);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
});

test('professional expectations show complete judgement and next-step text without override controls',t=>{
 const r=record();r.content.pill.rules[0].guidance='Two lamps not lit does not establish a wiring fault.';r.content.pill.actions[0].instruction='Record known facts and refer to a qualified electrical specialist.';
 r.evaluationSuite=[{name:'Lighting',mode:'scenario',ruleMode:'manual',facts:{description:'Two lamps are not lit.',category:'electrical_distribution'},expected:{status:'complete',ruleIds:['R1'],actionIds:['A1'],missingFields:[]}}];
 const dom=new JSDOM(evaluationMarkup(r));t.after(()=>dom.window.close());const root=dom.window.document;
 assert.match(root.body.textContent,/Expected handling plan/);assert.ok(root.querySelector('[name=workflow-steps]'));assert.ok(root.querySelector('[data-expected=ruleIds]').closest('[hidden]'));assert.match(root.body.textContent,/Two lamps not lit does not establish a wiring fault/);assert.match(root.body.textContent,/Record known facts and refer/);
 assert.ok(!root.body.textContent.includes('Adjust expected rules'));assert.ok(!root.body.textContent.includes('Choose a different rule expectation'));assert.equal(root.querySelector('[name=ruleMode]').value,'manual');assert.equal(root.querySelector('[data-rule-override]').hidden,true);
});

 test('comparison outages are distinct from invalid analysis and preserve the summary for inspection',async t=>{
 const {compactEvaluation}=await import('../public/evaluation.js');const r=record();
 r.evaluations=[{passed:false,results:[{name:'Case',expected:{status:'complete',workflow:{steps:'Refer safely'},ruleIds:['R1','R2'],actionIds:[],missingFields:[]},candidate:{passed:false,failureCode:'workflow_comparison',error:'Comparison unavailable',actual:{status:'complete',ruleIds:['R1'],actionIds:[],missingFields:[]},report:{summary:'Validated advisory report'}}}]}];
 const dom=new JSDOM(`<main>${evaluationMarkup(r)}</main>`,{url:'http://localhost/studio/qa?view=evaluation'});t.after(()=>dom.window.close());
 compactEvaluation(dom.window.document.querySelector('main'),r);
 const text=dom.window.document.querySelector('[data-evaluation-result]').textContent;
 assert.match(text,/1 comparison errors/);assert.match(text,/0 invalid outputs/);assert.match(text,/0 expectation mismatches/);
 assert.match(dom.window.document.body.textContent,/Validated advisory report/);
 assert.ok(!dom.window.document.body.textContent.includes('Missing expected judgement'));
 });
