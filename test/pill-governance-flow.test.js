import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mergeKnowledge} from '../knowledge-merge.js';
import {pillMarkup,knowledgePackage} from '../public/library.js';
const record=()=>({content:{pill:{id:'p',name:'Leak response',owner:'Knowledge lead',status:'draft',version:'draft',scope:'Initial leak assessment',rules:[{id:'r-old',title:'Original rule',guidance:'Reported leak',cardExplanation:'Reported leak',actionIds:['a-old','a-other']}],actions:[{id:'a-old',title:'Record facts',instruction:'Record facts',owner:'Duty manager',requiresApproval:true,ruleIds:['r-old']},{id:'a-other',title:'Old response',instruction:'Old response',owner:'Duty manager',requiresApproval:true,ruleIds:['r-old']}],boundaries:['Do not repair equipment'],escalationConditions:['Electrical risk']},sources:[],examples:[]}});
const doc=()=>({id:'d',name:'source',sha256:'fixture',repairTargets:[{id:'r-old',type:'rule'},{id:'a-old',type:'action'}],candidates:[{id:'K-rule',type:'rule',title:'Renamed decision',text:'Known location and observed dripping',relatedRuleIds:[],relatedActionIds:['K-action'],evidence:[]},{id:'K-action',type:'action',title:'Renamed response',text:'Record available facts',relatedRuleIds:['K-rule'],relatedActionIds:[],evidence:[]}],questions:[],conflicts:[]});
const body=()=>({confirmed:true,reviewer:'Reviewer',actionOwner:'Duty manager',selections:[{id:'K-rule',text:'Known location and observed dripping',replaceId:'r-old'},{id:'K-action',text:'Record available facts',replaceId:'a-old'}]});
test('explicit source corrections preserve IDs despite changed titles and remove obsolete links',()=>{
 const before=record(),result=mergeKnowledge(before,doc(),body());
 assert.equal(result.content.pill.rules.length,1);assert.equal(result.content.pill.actions.length,2);
 assert.equal(result.content.pill.rules[0].id,'r-old');assert.equal(result.content.pill.rules[0].title,'Renamed decision');
 assert.deepEqual(result.content.pill.rules[0].actionIds,['a-old']);assert.deepEqual(result.content.pill.actions[0].ruleIds,['r-old']);assert.deepEqual(result.content.pill.actions[1].ruleIds,[]);
 assert.equal(before.content.pill.rules[0].title,'Original rule');assert.equal(result.review.decisions[0].change,'updated');
 const invalid=body();invalid.selections[0].replaceId='foreign-id';assert.throws(()=>mergeKnowledge(before,doc(),invalid),/valid existing item/);
});
test('decision cards show their response, roles and evidence without repeating shared actions',()=>{
 const r=record();r.content.pill.rules.push({...r.content.pill.rules[0],id:'r-second',actionIds:['a-old']});
 const html=pillMarkup(r.content.pill,{captureHistory:[{decisions:[{targetId:'r-old',decision:'accepted',evidence:[{location:'Paragraph 1',quote:'Original expert passage'}]}]}]});
 const dom=new JSDOM(html);assert.equal(dom.window.document.querySelectorAll('[id="p-a-old"]').length,1);
 assert.ok(dom.window.document.querySelector('.pill-rule .pill-action'));assert.match(dom.window.document.body.textContent,/Responsible role: Duty manager/);assert.match(dom.window.document.querySelector('.knowledge-evidence').textContent,/Original expert passage/);dom.window.close();
});
test('portable knowledge package includes approved content, evidence and governed feedback',()=>{
 const release={pill:record().content.pill,sources:[{reference:'Original expert'}],captureHistory:[{reviewer:'Expert'}],learningImports:[{proposalId:'feedback'}],examples:[],validation:{passed:true},evaluation:{passed:true},reviewer:'Reviewer',publishedAt:'fixture',contentHash:'hash'};
 const saved=JSON.parse(JSON.stringify(knowledgePackage(release)));assert.equal(saved.schemaVersion,1);assert.equal(saved.pill.rules[0].id,'r-old');assert.equal(saved.learningImports[0].proposalId,'feedback');assert.equal(saved.captureHistory[0].reviewer,'Expert');assert.equal(saved.contentHash,'hash');
});

test('reviewed scope and operating limits update in place without appending contradictory old text',()=>{
 const original=record(),document={id:'d',name:'source',sha256:'fixture',questions:[],conflicts:[],repairTargets:[{id:'scope-id',type:'scope',text:original.content.pill.scope},{id:'boundary-id',type:'boundary',text:original.content.pill.boundaries[0]}],candidates:[{id:'K-scope',type:'scope',title:'Updated scope',text:'Only initial sink leak assessment',relatedRuleIds:[],relatedActionIds:[],evidence:[]},{id:'K-boundary',type:'boundary',title:'Updated limit',text:'Do not repair or operate equipment',relatedRuleIds:[],relatedActionIds:[],evidence:[]}]};
 const result=mergeKnowledge(original,document,{confirmed:true,reviewer:'Expert',selections:document.candidates.map(c=>({id:c.id,text:c.text,replaceId:c.type==='scope'?'scope-id':'boundary-id'}))});
 assert.equal(result.content.pill.scope,'Only initial sink leak assessment');assert.deepEqual(result.content.pill.boundaries,['Do not repair or operate equipment']);assert.equal(original.content.pill.scope,'Initial leak assessment');
});
