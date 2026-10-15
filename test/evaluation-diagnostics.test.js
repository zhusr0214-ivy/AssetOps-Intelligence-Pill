import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePill} from '../pill-evaluation.js';
import {ahuPill} from '../triage.js';
test('invalid output persists a safe category without leaking untrusted values',async()=>{
 const record={content:{pill:ahuPill},releases:[],evaluationOptions:{repetitions:1,minimumPassRate:1,expertReviewRequired:true},evaluationSuite:[{name:'Supported',facts:{category:'hvac_cooling',asset:'AHU-1',observations:'Room warm'},expected:{status:'complete',ruleIds:['HVAC-01'],actionIds:[],missingFields:[]}},{name:'Outside',facts:{category:'lift_fault',asset:'LIFT-1',observations:'Stopped'},expected:{status:'out_of_scope',ruleIds:[],actionIds:[],missingFields:[]}}]};
 const run=await evaluatePill(record,async()=>({summary:'Check',hypotheses:[{ruleId:'SECRET-INVALID-ID',reasoning:'Check',evidence:[],uncertainties:[]}],actionIds:[],missingFields:[],prioritySuggestion:null}));
 assert.equal(run.results[0].candidate.validationCode,'rule_reference');assert.match(run.results[0].candidate.error,/rule ID/);assert.equal(run.passed,false);assert.ok(!JSON.stringify(run).includes('SECRET-INVALID-ID'));
});

test('evaluation keeps the scenario context through final validation and rejects unsupported blockers',async()=>{
 const facts={category:'hvac_cooling',asset:'',observations:'Room warm'};
 const record={content:{pill:ahuPill},releases:[],evaluationOptions:{repetitions:1,minimumPassRate:1,expertReviewRequired:true},evaluationSuite:[{name:'Supported scenario',mode:'scenario',facts,expected:{status:'complete',ruleIds:['HVAC-01'],actionIds:[],missingFields:[]}}]};
 let seen;
 const output={summary:'Reported room warmth.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Review warmth.',evidence:[{field:'observations',quote:'Room warm'}],uncertainties:[]}],actionIds:[],missingFields:['asset'],prioritySuggestion:null};
 const run=await evaluatePill(record,async snapshot=>{seen=snapshot;return output;});
 assert.equal(seen.validationScenario,true);assert.equal(run.passed,false);assert.equal(run.results[0].candidate.validationCode,'blocking_requirement');assert.equal(run.results[0].candidate.actual,undefined);assert.match(run.results[0].candidate.error,/without a supported Pill rule/);
 const valid=await evaluatePill(record,async()=>({...output,missingFields:[]}));assert.equal(valid.passed,true);
});
