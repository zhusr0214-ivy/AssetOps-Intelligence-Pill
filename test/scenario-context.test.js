import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createTriageAgent} from '../triage-agent.js';
import {evaluationMarkup,bindEvaluation} from '../public/evaluation.js';
import {validateSuite} from '../pill-evaluation.js';
const r=()=>({id:'p',state:'draft',content:{pill:{applicability:{categories:['water_leak']},rules:[{id:'R1',title:'Record unknowns'},{id:'R2',title:'Safety escalation'}],actions:[{id:'A1',title:'Collect facts',ruleIds:['R1']},{id:'A2',title:'Check reported risks',ruleIds:['R2']}]}},evaluationRequired:true,evaluationSuite:[{name:'Leak',mode:'scenario',facts:{category:'water_leak',description:'Reported dripping'},expected:{status:'complete',ruleIds:[],actionIds:['A1','A2'],missingFields:[]}}],evaluations:[],evaluationGate:{state:'not_run'}});
test('scenario metadata reaches initial and corrective requests without leaking expected results',async()=>{
 const requests=[];const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:'Record unknown facts.',hypotheses:[],actionIds:[],missingFields:requests.length===1?['faultCode']:[],prioritySuggestion:null})}}]})};}});
 const fields={category:'water_leak',description:'Reported dripping',asset:'',occurredAt:''};const result=await agent({validationScenario:true,fields},{id:'p',rules:[],actions:[]});assert.deepEqual(result.missingFields,[]);assert.equal(requests.length,2);
 for(const body of requests){const data=JSON.parse(body.messages.find(m=>m.role==='user').content);assert.equal(data.validationScenario,true);assert.deepEqual(data.case,fields);assert.equal(data.expected,undefined);}
 requests.length=0;await agent({fields},{id:'p',rules:[],actions:[]});assert.equal(JSON.parse(requests[0].messages[1].content).validationScenario,false);
});
test('saved scenario derives readable expected rules from recommendations and preserves an explicit override',async t=>{
 const record=r(),dom=new JSDOM(`<main><p id="studio-error"></p>${evaluationMarkup(record)}</main>`);t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');let sent;
 bindEvaluation(view,record,async(op,body)=>{if(op==='save-evaluations')sent=body;return false;},()=>{});
 const row=view.querySelector('[data-evaluation-case]');assert.match(row.querySelector('[data-rule-summary]').textContent,/Record unknowns.*Safety escalation/);assert.equal(row.querySelector('[data-rule-refresh]').hidden,false);assert.equal(row.querySelector('[data-expected=ruleIds]').disabled,true);
 view.querySelector('[data-run-evaluation]').click();assert.deepEqual(sent.suite[0].expected.ruleIds,['R1','R2']);assert.equal(sent.suite[0].ruleMode,'linked');assert.equal(validateSuite(sent.suite)[0].ruleMode,'linked');
 const override=row.querySelector('[data-rule-override]');override.checked=true;override.dispatchEvent(new dom.window.Event('input',{bubbles:true}));const rule=row.querySelector('[data-expected=ruleIds][value=R2]');assert.equal(rule.disabled,false);rule.checked=false;rule.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 view.querySelector('[data-run-evaluation]').click();assert.deepEqual(sent.suite[0].expected.ruleIds,['R1']);assert.equal(sent.suite[0].ruleMode,'manual');
});

