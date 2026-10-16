import test from 'node:test';
import assert from 'node:assert/strict';
import {retrieveCaseKnowledge,assessKnowledgeCoverage} from '../case-knowledge.js';
import {assessCaseSupervision} from '../case-supervision.js';
const pill=(id,topic)=>({id,name:topic,scope:topic,domain:'electrical_distribution',applicability:{categories:['electrical_distribution'],assetPrefixes:[],keywords:[]},rules:[{id:'r',guidance:topic,actionIds:['a']}],actions:[{id:'a',instruction:topic,ruleIds:['r']} ]});
test('specific question ranks relevant rules/actions above alphabetic Pill order',()=>{
 const found=retrieveCaseKnowledge({category:'electrical_distribution'},[pill('a','Flickering light'),pill('z','Entire floor power outage')],'The entire floor has a power outage');
 assert.equal(found[0].pill.id,'z');assert.ok(found[0].entries.some(e=>e.kind==='action'));
 assert.equal(retrieveCaseKnowledge({category:'water_leak'},[pill('z','Entire floor power outage')],'outage').length,0);
});
test('linked conditions survive entry ranking',()=>{
 const p=pill('p','outage');p.rules.push(...Array.from({length:12},(_,i)=>({id:`r${i}`,guidance:'outage',actionIds:[]})));
 p.rules.push({id:'condition',guidance:'Site prerequisites',actionIds:['a']});
 const [match]=retrieveCaseKnowledge({category:'electrical_distribution'},[p],'outage');
 assert.ok(match.entries.some(e=>e.id==='condition'));
});
const source={sourceId:'p:r',kind:'pill',entryKind:'rule',text:'Record the floor.',pillId:'p',version:'1'};
const coverage={status:'supported',intent:'clarification',reason:'The rule covers location collection.',evidence:[{sourceId:'p:r',quote:'Record the floor.'}],missingFacts:[]};
test('coverage needs exact approved rule/action evidence; attachments cannot establish support',()=>{
 assert.equal(assessKnowledgeCoverage(coverage,[source],coverage.evidence).status,'supported');
 assert.throws(()=>assessKnowledgeCoverage(coverage,[{...source,kind:'document'}],coverage.evidence));
 assert.throws(()=>assessKnowledgeCoverage({...coverage,evidence:[]},[source],[]));
 assert.throws(()=>assessKnowledgeCoverage({...coverage,missingFacts:['Asset model']},[source],coverage.evidence));
 assert.throws(()=>assessKnowledgeCoverage({...coverage,intent:'operation'},[source],coverage.evidence));
});
const proposed={answer:'More information is needed.',citations:[],expertRequest:{required:true,reason:'No matching knowledge'},supervision:{required:true,kind:'knowledge_gap',subject:'Question',reason:'No matching knowledge'}};
const ctx={sources:[],pills:[],latestText:'What is a lighting fault?',coverage:{status:'unsupported',intent:'general',reason:'No rule covers the definition.'}};
test('no Pill for a general question does not create an expert form',()=>{
 assert.equal(assessCaseSupervision(proposed,ctx),null);
 assert.equal(assessCaseSupervision(proposed,{...ctx,coverage:{...ctx.coverage,intent:'clarification'},latestText:'Which floor should I record?'}),null);
});
test('risk and coverage are separate; benign model intent cannot clear restricted operations',()=>{
 assert.equal(assessCaseSupervision(proposed,{...ctx,latestText:'Should I restart the unit?'}).mode,'expert');
 assert.equal(assessCaseSupervision(proposed,{...ctx,latestText:'Can I disable the alarm?'}).mode,'escalation');
 assert.equal(assessCaseSupervision({...proposed,supervision:{required:true,kind:'conflict',subject:'Conflicting guidance',reason:'Opposite actions'}},ctx).mode,'expert');
});
test('partial coverage cannot be converted into approval by citing an approval action',()=>{
 const s={sourceId:'a',actionTitle:'Restart unit',requiresApproval:true};
 const result=assessCaseSupervision({...proposed,citations:[{sourceId:'a'}],expertRequest:{required:false,reason:''},supervision:{required:false}},{sources:[s],pills:[{id:'p',version:'1'}],latestText:'Should I restart the unit?',coverage:{status:'partial',intent:'operation',reason:'Equipment model is unknown.'}});
 assert.equal(result.mode,'expert');assert.equal(result.kind,'scope');
});
