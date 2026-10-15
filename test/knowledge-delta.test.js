import test from 'node:test';
import assert from 'node:assert/strict';
import {applyKnowledgeDelta,deltaComparisonInput,recoverKnowledgeDelta} from '../knowledge-delta.js';
import {mergeKnowledge} from '../knowledge-merge.js';
const c=(id,type,text)=>({id,type,title:text,text,evidence:[{blockId:'B1',location:'Experience',quote:text}],missing:[],relatedRuleIds:[],relatedActionIds:[]});
const existing=[{id:'old-rule',type:'rule',title:'Known single card',text:'Only one card fails.'},{id:'old-action',type:'action',title:'Check card',text:'Check card permissions.',owner:'Administrator',requiresApproval:true}];
const result=()=>({candidates:[c('K-r','rule','Only one card fails.'),{...c('K-a','action','Check card permissions.'),relatedRuleIds:['K-r']},{...c('K-new','rule','If scope is unknown, ask first.'),relatedActionIds:['K-a']}],questions:[],conflicts:[]});
const decisions=()=>({decisions:[{id:'K-r',change:'unchanged',targetId:'old-rule',reason:'Same condition.'},{id:'K-a',change:'unchanged',targetId:'old-action',reason:'Owner and approval already recorded.'},{id:'K-new',change:'new',reason:'Adds unknown scope branch.'}],questions:[],conflicts:[]});
test('unchanged branches leave the main review and references reuse existing knowledge',()=>{
 const value=applyKnowledgeDelta(result(),existing,decisions());assert.equal(value.candidates.length,1);assert.equal(value.unchangedKnowledge.length,2);assert.deepEqual(value.candidates[0].relatedActionIds,[]);assert.deepEqual(value.candidates[0].existingActionIds,['old-action']);
 const record={content:{pill:{rules:[{id:'old-rule',actionIds:['old-action']}],actions:[{id:'old-action',ruleIds:['old-rule']}],boundaries:[],escalationConditions:[],scope:''},sources:[],examples:[]}};
 const doc={id:'d',name:'Supplement',repairTargets:existing,...value};const merged=mergeKnowledge(record,doc,{confirmed:true,reviewer:'Expert',selections:[{id:'K-new',text:value.candidates[0].text}]});assert.equal(merged.content.pill.actions.length,1);assert.ok(merged.content.pill.actions[0].ruleIds.includes('CAP-new'));assert.deepEqual(merged.content.pill.rules[1].actionIds,['old-action']);
});
test('real updates expose an explicit existing target, and incomplete or wrong-type comparisons fail closed',()=>{
 const d=decisions();d.decisions[1]={id:'K-a',change:'update',targetId:'old-action',reason:'Changed task.'};const value=applyKnowledgeDelta(result(),existing,d);assert.equal(value.candidates.find(c=>c.id==='K-a').replacementTargetId,'old-action');
 assert.throws(()=>applyKnowledgeDelta(result(),existing,{...d,decisions:d.decisions.slice(1)}),/every proposal/);
 d.decisions[1].targetId='old-rule';assert.throws(()=>applyKnowledgeDelta(result(),existing,d),/invalid change/);
});
test('review cannot reuse an existing link after its target disappears',()=>{
 const value=applyKnowledgeDelta(result(),existing,decisions());assert.throws(()=>mergeKnowledge({content:{pill:{rules:[],actions:[]}}},{...value,repairTargets:existing},{confirmed:true,reviewer:'Expert',selections:[{id:'K-new',text:'Ask first.'}]}),/changed/);
});

test('all repeated knowledge leaves no selectable proposals and retains an inspectable comparison record',()=>{
 const r=result();r.candidates.pop();const d=decisions();d.decisions.pop();const value=applyKnowledgeDelta(r,existing,d);assert.equal(value.candidates.length,0);assert.equal(value.unchangedKnowledge.length,2);assert.equal(value.unchangedKnowledge[0].candidate.evidence[0].blockId,'B1');
});

test('self-contradictory updates and translated reasons cannot silently pass comparison',()=>{
 const d=decisions();d.decisions[1]={id:'K-a',change:'update',targetId:'old-action',reason:'There is no material change.'};assert.throws(()=>applyKnowledgeDelta(result(),existing,d),/contradicts itself/);
 const r=result();r.candidates[0].title='单卡失败';assert.throws(()=>applyKnowledgeDelta(r,existing,decisions()),/Chinese/);
});

test('request-local aliases map back exactly and unknown aliases remain invalid',()=>{
 const r=result(),mapping=deltaComparisonInput(r,existing);assert.equal(mapping.input.proposals[0].id,'P1');assert.equal(mapping.input.existingKnowledge[0].id,'T1');const wire={decisions:[{id:'P1',change:'unchanged',targetId:'T1',reason:'Same.'},{id:'P2',change:'unchanged',targetId:'T2',reason:'Same.'},{id:'P3',change:'new',reason:'New branch.'}],questions:[],conflicts:[]};assert.equal(applyKnowledgeDelta(r,existing,mapping.resolve(wire)).candidates.length,1);wire.decisions[0].id='P99';assert.throws(()=>applyKnowledgeDelta(r,existing,mapping.resolve(wire)),/invalid change/);
});

test('invalid comparison rows preserve uncertain proposals without blocking valid classification',()=>{
 const d=decisions();d.decisions[1].targetId='missing-target';const value=recoverKnowledgeDelta(result(),existing,d);assert.equal(value.comparisonStatus,'partial');assert.equal(value.unchangedKnowledge.length,1);assert.equal(value.candidates.find(c=>c.id==='K-a').change,'review');assert.equal(value.candidates.find(c=>c.id==='K-new').change,'new');assert.equal(value.candidates.find(c=>c.id==='K-a').replacementTargetId,undefined);
});
test('missing or duplicated classifications never silently hide a proposal',()=>{
 for(const value of [undefined,{decisions:[decisions().decisions[0],decisions().decisions[0]]}]){
 const out=recoverKnowledgeDelta(result(),existing,value);assert.equal(out.candidates.length,3);assert.ok(out.candidates.every(c=>c.change==='review'));assert.match(out.comparisonWarning,/remain visible/);
 }
});

test('uncertainty inside a confirmed branch cannot hide a new pre-confirmation branch',()=>{
 const r={candidates:[c('K-unknown','rule','当尚不清楚是单卡还是多人同门失败时，不选择任何已确认分支，先确认其他卡是否受影响。')],questions:[],conflicts:[]};
 const targets=[{id:'old',type:'rule',text:'只有一张卡失败时优先检查该卡权限，原因未知，保留不确定性。'}];const wire={decisions:[{id:'K-unknown',change:'unchanged',targetId:'old',reason:'都是保留不确定性。'}],questions:[],conflicts:[]};
 assert.throws(()=>applyKnowledgeDelta(r,targets,wire),/pre-confirmation/);const out=recoverKnowledgeDelta(r,targets,wire);assert.equal(out.candidates.length,1);assert.equal(out.candidates[0].change,'review');assert.equal(out.unchangedKnowledge.length,0);
});
