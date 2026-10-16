import test from 'node:test';
import assert from 'node:assert/strict';
import {caseEvidenceCatalog,resolveCaseEvidence,createTriageAgent} from '../triage-agent.js';
import {validateTriageResult} from '../triage.js';
import {evaluatePill} from '../pill-evaluation.js';
const facts={category:'water_leak',description:'未报告人员滑倒，水是否接触电器未确认。漏水原因未知。',observations:'水槽持续滴水。'};
const pill={id:'qa',domain:'water_leak',applicability:{categories:['water_leak'],assetPrefixes:[],keywords:[]},rules:[{id:'R1',guidance:'Record unknowns.',cardExplanation:'Record unknowns.',actionIds:['A1']}],actions:[{id:'A1',ruleIds:['R1'],instruction:'Collect facts.',owner:'Engineer',requiresApproval:true}]};
const output=evidence=>({summary:'Review reported facts.',hypotheses:[{ruleId:'R1',reasoning:'Review.',evidence,uncertainties:[]}],actionIds:['A1'],missingFields:[],prioritySuggestion:null});
test('catalog keeps negation and exact source text; resolution never trusts model quote or field',()=>{
 const catalog=caseEvidenceCatalog(facts);assert.equal(catalog[0].quote,'未报告人员滑倒，水是否接触电器未确认。');
 const resolved=resolveCaseEvidence(output([{evidenceId:'E1',field:'asset',quote:'没有风险'}]),catalog);
 assert.deepEqual(resolved.hypotheses[0].evidence,[{field:'description',quote:catalog[0].quote}]);
 const validated=validateTriageResult(resolved,{validationScenario:true,fields:facts},pill);assert.equal(validated.hypotheses[0].evidence[0].quote,catalog[0].quote);
 assert.ok(!catalog.some(e=>['priority','category','title'].includes(e.field)));
 assert.throws(()=>validateTriageResult(resolveCaseEvidence(output([{evidenceId:'E999'}]),catalog),{validationScenario:true,fields:facts},pill),e=>e.validationCode==='evidence_source'&&e.evidenceDiagnostic.reason==='invalid_source_field_or_evidence_id');
});
test('adapter resolves corrected evidence IDs and retries unknown IDs without making up evidence',async()=>{
 const facts={category:'water_leak',description:'Water is dripping from the sink.',observations:'Dripping continues.'};
 for(const repairs of [true,false]){
 let calls=0;const requests=[];
 const agent=createTriageAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output([{evidenceId:calls===2&&repairs?'E1':'E999'}]))}}]})};}});
 const result=await agent({validationScenario:true,fields:facts},pill);assert.equal(calls,2);assert.ok(JSON.parse(requests[0].messages[1].content).caseEvidence.length);
 if(repairs)assert.equal(validateTriageResult(result,{validationScenario:true,fields:facts},pill).hypotheses[0].evidence[0].field,'description');
 else assert.throws(()=>validateTriageResult(result,{validationScenario:true,fields:facts},pill),e=>e.validationCode==='evidence_source');
 }
});
test('failed evidence persists its location and safely bounded quote',async()=>{
 const record={content:{pill},releases:[],evaluationSuite:[{name:'Case',mode:'scenario',facts,expected:{status:'complete',ruleIds:['R1'],actionIds:['A1'],missingFields:[]}}]};
 const run=await evaluatePill(record,async()=>output([{field:'observations',quote:'不存在的证据<script>'}]));
 const diagnostic=run.results[0].candidate.evidenceDiagnostic;assert.equal(run.passed,false);assert.equal(diagnostic.hypothesis,1);assert.equal(diagnostic.evidence,1);assert.equal(diagnostic.reason,'quote_not_found_or_ambiguous_source');
});
