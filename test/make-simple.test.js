import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {simplifyMake} from '../public/make-simple.js';
import {mergeKnowledge} from '../knowledge-merge.js';
import {captureMarkup} from '../public/knowledge.js';
test('Make hides manual structure in advanced editing without losing source review',()=>{
 const dom=new JSDOM('<main><div data-page-panel="draft sources"><section class="capture-panel"><h3>Capture</h3><p>Hint</p></section></div><form id="pill-editor" data-page-panel="draft"><input name="id" value="R1"></form></main>');const root=dom.window.document.querySelector('main'),before=globalThis.document;globalThis.document=dom.window.document;
 try{simplifyMake(root,{id:'p',content:{pill:{domain:'lift_fault',owner:'QA',rules:[],actions:[],boundaries:[]}},documents:[]});assert.equal(root.querySelector('.make-advanced').open,false);assert.equal(root.querySelector('.make-advanced #pill-editor [name=id]').value,'R1');assert.equal(root.querySelector('.capture-panel h3').textContent,'1 · Provide material');assert.match(root.querySelector('.make-review-summary').textContent,/Knowledge overview/);}finally{globalThis.document=before;dom.window.close();}
});
test('reviewer supplies one role for generated actions and generated IDs remain linked',()=>{
 const candidate=(id,type,relatedRuleIds=[],relatedActionIds=[])=>({id,type,title:type,text:'Collect reported facts.',evidence:[],relatedRuleIds,relatedActionIds});
 const doc={id:'doc',name:'fixture',sha256:'fixture',candidates:[candidate('K-r','rule',[],['K-a']),candidate('K-a','action',['K-r'])],questions:[],conflicts:[]};
 const record={content:{pill:{source:'',scope:'',rules:[],actions:[],boundaries:[],escalationConditions:[]},sources:[],examples:[]}};
 const merged=mergeKnowledge(record,doc,{confirmed:true,reviewer:'QA',actionOwner:'Duty manager',selections:doc.candidates.map(c=>({id:c.id,text:c.text}))});
 assert.equal(merged.content.pill.actions[0].owner,'Duty manager');assert.equal(merged.content.pill.actions[0].requiresApproval,true);assert.deepEqual(merged.content.pill.actions[0].ruleIds,[merged.content.pill.rules[0].id]);
});

test('confirmed source exposes a completeness check while retaining review decisions',()=>{
 const html=captureMarkup({id:'p',state:'draft',documents:[{id:'d',name:'source.txt',status:'reviewed',blocks:[],review:{reviewer:'QA',reviewedAt:'today',decisions:[]}}]});
 const dom=new JSDOM(html);
 const button=dom.window.document.querySelector('[data-analyze=d]');
 assert.equal(button.textContent,'Check original source for omissions');
 assert.equal(button.dataset.reextract,'true');
 assert.match(dom.window.document.body.textContent,/Reviewed by QA/);
 dom.window.close();
});

test('saved correction renders audit history without live replacement controls or undefined index',()=>{
 const html=captureMarkup({id:'p',state:'draft',documents:[{id:'d',name:'source.txt',status:'reviewed',blocks:[],repairTargets:[{id:'old-rule',type:'rule',title:'Old rule',text:'Prior content'}],review:{reviewer:'Expert',reviewedAt:'fixture',decisions:[{id:'K-rule',type:'rule',decision:'accepted',reviewedText:'Corrected knowledge',evidence:[{location:'Paragraph 1',quote:'Original source'}]}]}}]});
 const dom=new JSDOM(html);assert.match(dom.window.document.body.textContent,/Corrected knowledge/);assert.match(dom.window.document.body.textContent,/Original source/);assert.equal(dom.window.document.querySelector('[name^="replace-"]'),null);assert.equal(dom.window.document.querySelector('[data-capture-review]'),null);dom.window.close();
});
