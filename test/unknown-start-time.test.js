import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTriageResult,ahuPill} from '../triage.js';
const output=()=>({summary:'Review reported room warmth; incident start time is missing.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Compare readings.',evidence:[{field:'observations',quote:'Room warm'}],uncertainties:['The incident start time is not established.']}],actionIds:[],missingFields:['occurredAt'],prioritySuggestion:null});
const snapshot=occurredAt=>({fields:{occurredAt,observations:'Room warm'}});
test('reported unknown time must remain explicit in the assessment',()=>{
 const report=output();report.hypotheses[0].uncertainties=[];
 assert.throws(()=>validateTriageResult(report,snapshot('Unknown'),ahuPill),error=>error.validationCode==='explicit_unknowns');
});
test('explicit unknown start time answers do not generate repeat missing-field requests',()=>{
 for(const value of ['未知','开始时间未知','开始时间：未知','发生时间不清楚','起始时间暂时未知。','Unknown','Start time: unknown','The incident start time is unknown.','Onset time not known']){
  const result=validateTriageResult(output(),snapshot(value),ahuPill);assert.deepEqual(result.missingFields,[],value);assert.match(result.summary,/explicitly reported as unknown/);
 }
});
test('blank, unresolved and mixed start-time answers remain missing; other blockers are preserved',()=>{
 for(const value of ['', '时间待确认', '维护记录未知', '开始时间未知，也可能是今天十点', 'start time unknown or 10am'])assert.deepEqual(validateTriageResult(output(),snapshot(value),ahuPill).missingFields,['occurredAt'],value);
 const result=validateTriageResult({...output(),missingFields:['occurredAt','observations']},snapshot('开始时间未知'),ahuPill);assert.deepEqual(result.missingFields,['observations']);
});
