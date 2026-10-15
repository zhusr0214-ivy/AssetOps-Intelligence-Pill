import {captureMarkup,bindCapture} from '../public/knowledge.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {expertDialogueMarkup,expertExamplesMarkup,mountExpertFlow,knowledgeGapMarkup} from '../public/expert-flow.js';
import {validateCapture,createKnowledgeCaptureAgent,omitUnsupportedOwners} from '../knowledge-agent.js';
import {mergeKnowledge} from '../knowledge-merge.js';
import {releaseHash} from '../pill-versions.js';

const record=()=>({id:'p1',revision:2,state:'draft',content:{pill:{rules:[]}},relatedPills:[{id:'other',name:'Related drainage',scope:'Slow drainage',approved:true}],expertDialogue:{id:'d',status:'ready',messages:[{contributor:'Expert',text:'<script>not instructions</script>'}],reply:{understanding:'单点和多点要分别判断。',question:'其他排水点也受影响吗？',reason:'这会影响检查范围。'}},expertTrials:[]});

test('expert sees a restatement, one optional question and same-domain knowledge without technical classification fields',t=>{
  const dom=new JSDOM(expertDialogueMarkup(record()));t.after(()=>dom.window.close());const root=dom.window.document;
  assert.ok(root.querySelector('[data-expert-defer]'));assert.ok(root.querySelector('[data-expert-confirm]'));assert.equal(root.querySelectorAll('[data-expert-message] textarea').length,1);
  assert.match(root.body.textContent,/其他排水点/);assert.ok(!root.querySelector('script'));assert.ok(!root.querySelector('[name=ruleIds]'));assert.ok(root.querySelector('a[href="/studio/other?view=draft"]'));
});

test('discussion actions use the latest revision and explicit confirmation, viewers cannot write',async t=>{
  const dom=new JSDOM('<main><div data-page-panel="draft sources"><section class="capture-panel"></section></div><div data-page-panel="evaluation"></div></main>');t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main'),r=record();
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);const sent=[];globalThis.fetch=async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({record:r})};};
  mountExpertFlow(view,r,async(task)=>task({...r,revision:7}),{roles:['expert']});view.querySelector('[data-expert-confirm]').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sent[0].body.revision,7);assert.equal(sent[0].body.confirmed,true);assert.equal(sent[0].body.confirmedUnderstanding,true);
  view.innerHTML='<div data-page-panel="draft sources"><section class="capture-panel"></section></div><div data-page-panel="evaluation"></div>';
  mountExpertFlow(view,r,()=>assert.fail('viewer must not write'),{roles:['viewer']});assert.equal(view.querySelector('[data-expert-message]'),null);assert.equal(view.querySelector('[data-expert-example]'),null);
});

test('example feedback is ordinary language; corrected knowledge links back to review and escapes report content',t=>{
  const r=record();r.expertTrials=[{id:'t1',facts:{description:'One drain is slow'},report:{status:'complete',summary:'<img src=x onerror=bad>',hypotheses:[],actions:[{owner:'Plumber',instruction:'Compare nearby drains.'}]},proposedHandling:'Compare nearby drains.'}];
  const dom=new JSDOM(expertExamplesMarkup(r));t.after(()=>dom.window.close());assert.ok(dom.window.document.querySelector('[name=expectedHandling]'));assert.equal(dom.window.document.querySelector('img'),null);assert.equal(dom.window.document.querySelector('[name=ruleIds]'),null);
  r.expertTrials[0].feedback={decision:'corrected',expectedHandling:'Ask about backflow.'};assert.match(expertExamplesMarkup(r),/Continue the correction in Prepare knowledge/);
});

test('source-provided responsible roles survive extraction and merging without another owner form entry',()=>{
  const blocks=[{id:'B1',location:'Expert statement',text:'When the room is warm, the duty engineer compares readings.'}];
  const validated=validateCapture({candidates:[{key:'r',type:'rule',title:'Warm room',text:'When the room is warm, compare readings.',evidence:[{blockId:'B1',quote:blocks[0].text}],relatedRuleKeys:[],relatedActionKeys:['a'],missing:[]},{key:'a',type:'action',title:'Compare readings',text:'The duty engineer compares readings.',owner:'Duty engineer',evidence:[{blockId:'B1',quote:blocks[0].text}],relatedRuleKeys:['r'],relatedActionKeys:[],missing:[]}],questions:[],conflicts:[]},blocks);
  const record={content:{pill:{scope:'Room comfort',rules:[],actions:[],boundaries:[],escalationConditions:[],source:''},examples:[],sources:[]}};
  const doc={id:'d',name:'Experience',sha256:'hash',...validated};
  const result=mergeKnowledge(record,doc,{confirmed:true,reviewer:'Expert',actionOwner:'',selections:validated.candidates.map(c=>({id:c.id,text:c.text}))});
  assert.equal(result.content.pill.actions[0].owner,'Duty engineer');assert.equal(result.content.pill.actions[0].requiresApproval,true);
});

test('a runtime gap returns case context to the appropriate expert without silently importing knowledge',async t=>{
  const html=knowledgeGapMarkup({status:'knowledge_gap',pill:{id:'p1'}},'CASE-1');assert.match(html,/exampleCase=CASE-1/);assert.equal(knowledgeGapMarkup({status:'complete'},'c'),'');
  const dom=new JSDOM('<main><div data-page-panel="draft sources"><section class="capture-panel"></section></div><div data-page-panel="evaluation"></div></main>',{url:'http://localhost/studio/p1?view=draft&exampleCase=CASE-1'});t.after(()=>dom.window.close());const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);let requests=0;
  globalThis.fetch=async()=>{requests++;return {ok:true,json:async()=>({incident:{description:'Two drains back up.',observations:'Nearby drains are affected.'}})};};
  const r=record();delete r.expertDialogue;mountExpertFlow(dom.window.document.querySelector('main'),r,()=>assert.fail('Context must not be imported automatically'),{roles:['expert']});await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(dom.window.document.querySelector('[data-expert-message] textarea').value,/Two drains back up/);assert.equal(requests,1);
});

test('source-backed updates suggest only same-type existing knowledge and reject invented owners',async()=>{
  const blocks=[{id:'B1',location:'Expert correction',text:'Do not confirm the cause without comparing readings.'}];let request;
  const result={candidates:[{key:'b',type:'boundary',title:'No guessed cause',text:blocks[0].text,replacementTargetId:'existing-limit',evidence:[{evidenceId:'E1'}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]}],questions:[],conflicts:[]};
  const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_BASE_URL:'https://fixture.test/v1',SOCLAAS_API_KEY:'fixture'},fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);const input=JSON.parse(request.messages[1].content);const answer=input.proposals?{decisions:input.proposals.map(c=>({id:c.id,change:'update',targetId:input.existingKnowledge[0].id,reason:'补充原有边界的明确限制。'})),questions:[],conflicts:[]}:result;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(answer)}}]})};}});
  const doc={name:'Correction',domain:'ahu_cooling',blocks,repairTargets:[{id:'existing-limit',type:'boundary',text:'No guesses.'}]};
  assert.equal((await agent(doc)).candidates[0].replacementTargetId,'existing-limit');assert.equal(JSON.parse(request.messages[1].content).existingKnowledge.length,1);
  const incomplete=await agent({...doc,repairTargets:[{id:'existing-limit',type:'rule',text:'Different type'}]});assert.equal(incomplete.captureCompleteness,'partial');assert.equal(incomplete.candidates[0].replacementTargetId,undefined);assert.match(incomplete.captureIssues.join(' '),/same type/);
  const invented={candidates:[{key:'a',type:'action',title:'Compare',text:'Compare readings.',owner:'Invented engineer',evidence:[{blockId:'B1',quote:blocks[0].text}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]}],questions:[],conflicts:[]};assert.throws(()=>validateCapture(invented,blocks),/responsible role/);
});

test('feedback snapshots affect new release hashes without changing the legacy release format',()=>{
  const release={pill:{id:'p1'},sources:[],examples:[]};const old=releaseHash(release);
  const added={...release,expertFeedback:[{decision:'corrected',correction:'Compare nearby points.'}],expertTrials:[]};assert.notEqual(releaseHash(added),old);
  assert.notEqual(releaseHash({...added,expertFeedback:[{decision:'corrected',correction:'Different correction.'}]}),releaseHash(added));assert.equal(releaseHash(release),old);
});

 test('a translated restatement cannot be adopted when confirming the saved Chinese expert source',async t=>{
 const r=record();r.expertDialogue.messages=[{contributor:'Expert',text:'单卡失败时应核查卡片权限，但不能直接认定或完全排除读卡器故障，原因仍未确认。'}];r.expertDialogue.reply={understanding:'Check the card, without establishing or excluding reader failure.',question:null,reason:null};
 const dom=new JSDOM('<main><div data-page-panel="draft sources"><section class="capture-panel"></section></div><div data-page-panel="evaluation"></div></main>');t.after(()=>dom.window.close());const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let sent;
 globalThis.fetch=async(_url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({record:r})};};
 const view=dom.window.document.querySelector('main');mountExpertFlow(view,r,async task=>task(r),{roles:['expert']});assert.match(view.textContent,/only your original experience and corrections/);view.querySelector('[data-expert-confirm]').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sent.confirmed,true);assert.equal(sent.confirmedUnderstanding,false);
 });

 test('saved discussion leads to extraction confirmation while optional uploads stay collapsed',t=>{
 const dom=new JSDOM('<main><div data-page-panel="draft sources"><section class="capture-panel"><h3>1 · Provide material</h3><p>Upload material</p><form id="upload-source"></form></section></div><div data-page-panel="evaluation"></div></main>');t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');const r=record();r.documents=[];
 mountExpertFlow(view,r,()=>{}, {roles:['expert']});const optional=view.querySelector('.expert-optional-material');assert.equal(optional.open,false);assert.ok(optional.querySelector('#upload-source'));assert.match(view.querySelector('[data-expert-stage-status]').textContent,/not extracted yet/);
 const dialogue=view.querySelector('.expert-dialogue');const nodes=[...dialogue.children];assert.ok(nodes.indexOf(view.querySelector('[data-expert-confirm]'))<nodes.indexOf(view.querySelector('[data-expert-message]')));
 });

 test('historical sources do not expose uploads or hide pending extraction status',t=>{
 for(const status of ['reviewed','failed','extracted']){
 const dom=new JSDOM('<main><div data-page-panel="draft sources"><section class="capture-panel"><h3>1 · Provide material</h3><p>Upload a file or add experience.</p><form id="upload-source"></form><details class="manual-source"></details><div data-source-status>Saved extraction status</div><button data-retry>Retry</button></section></div></main>');t.after(()=>dom.window.close());
 const r=record();r.documents=[{status:'reviewed'},{status}];const view=dom.window.document.querySelector('main');mountExpertFlow(view,r,()=>{}, {roles:['expert']});
 const optional=view.querySelector('.expert-optional-material');assert.equal(optional.open,false);assert.ok(optional.querySelector('#upload-source'));
 if(status!=='reviewed'){assert.equal(view.querySelector('[data-source-status]').closest('.expert-optional-material'),null);assert.equal(view.querySelector('[data-retry]').closest('.expert-optional-material'),null);assert.equal(view.querySelector('.capture-panel h3').textContent,'Knowledge extraction');}
 }
 });

test('failed source status does not promise available review candidates',()=>{
 const r=record();r.expertDialogue.documentId='failed-doc';r.documents=[{id:'failed-doc',status:'failed'}];const html=expertDialogueMarkup(r);assert.match(html,/Extraction failed/);assert.match(html,/Retry extraction/);assert.doesNotMatch(html,/Review the extracted proposals below/);
});
test('unsupported optional owner becomes a review question while evidence checks stay strict',()=>{
 const blocks=[{id:'B1',text:'Record the event log before deciding the cause.',location:'Experience'}];
 const value={candidates:[{key:'a',type:'action',title:'Record logs',text:blocks[0].text,owner:'Invented technician',evidence:[{blockId:'B1',quote:blocks[0].text}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]}],questions:[],conflicts:[]};
 const result=validateCapture(omitUnsupportedOwners(value,blocks),blocks);assert.equal(result.candidates[0].owner,undefined);assert.match(result.candidates[0].missing[0],/confirm it during review/);
 value.candidates[0].evidence[0].quote='Invented evidence';assert.throws(()=>validateCapture(omitUnsupportedOwners(value,blocks),blocks),/citation did not match/);
});

test('change review shows before and after while repeated knowledge stays in closed reference details',t=>{
 const r=record();r.documents=[{id:'d',name:'Supplement',status:'extracted',blocks:[],questions:[],conflicts:[],repairTargets:[{id:'old',type:'boundary',title:'Original limit',text:'Old limit.'}],unchangedKnowledge:[{candidate:{title:'Repeated single card branch'},reason:'Already covered.'}],candidates:[{id:'K-1',type:'boundary',title:'Changed limit',text:'New limit.',change:'update',changeReason:'Adds a real restriction.',replacementTargetId:'old',evidence:[],relatedRuleIds:[],relatedActionIds:[],missing:[]}]}];
 const dom=new JSDOM(captureMarkup(r));t.after(()=>dom.window.close());const root=dom.window.document;assert.equal(root.querySelectorAll('.capture-candidate').length,1);assert.equal(root.querySelector('.capture-unchanged').open,false);assert.match(root.querySelector('.candidate-before').textContent,/Old limit/);assert.equal(root.querySelector('.capture-candidate textarea').value,'New limit.');assert.equal(root.querySelector('[name="replace-0"]').value,'old');
});

test('unknown action responsibility can submit blank and does not inherit the reviewer name',async t=>{
 const r=record();r.documents=[{id:'d',name:'Experience',status:'extracted',blocks:[],candidates:[{id:'K-r',type:'rule',title:'Unknown scope',text:'If scope is unknown, ask first.',evidence:[],missing:[],relatedActionIds:['K-a'],relatedRuleIds:[]},{id:'K-a',type:'action',title:'Ask scope',text:'Ask which other cards are affected.',evidence:[],missing:[],relatedRuleIds:['K-r'],relatedActionIds:[]}],questions:[],conflicts:[]}];
 const dom=new JSDOM('<main>'+captureMarkup(r)+'</main>',{url:'http://localhost/studio/p1'});t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');let posted;
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);globalThis.fetch=async(_url,options)=>{posted=JSON.parse(options.body);return {ok:true,json:async()=>({record:r})};};
 bindCapture(view,r,async task=>task(r));const form=view.querySelector('[data-capture-review]');form.elements['accept-0'].checked=true;form.elements['accept-1'].checked=true;form.elements.reviewer.value='Reviewer RR';form.elements.confirmed.checked=true;await form.onsubmit({preventDefault(){}});assert.equal(posted.actionOwner,'');assert.equal(posted.reviewer,'Reviewer RR');
 const merged=mergeKnowledge({content:{pill:{scope:'',rules:[],actions:[],boundaries:[],escalationConditions:[]},examples:[],sources:[]}},r.documents[0],posted);assert.equal(merged.content.pill.actions[0].owner,'待确认');
});

test('example review prioritizes handling and unknowns, revealing correction controls only when needed',t=>{
 const r=record();r.expertTrials=[{id:'t1',facts:{description:'测试案例原文'},report:{status:'complete',summary:'分析说明只在依据里展示',hypotheses:[{ruleId:'r1',reasoning:'规则原文只在依据里展示',uncertainties:['污渍产生时间尚未核实'],evidence:[{field:'description',quote:'测试案例原文'}]}],actions:[{owner:'待确认',instruction:'核实是清洁遗漏还是再次污染。'}]},proposedHandling:'原样保存的完整确认内容'}];
 const dom=new JSDOM('<main><section class="capture-panel"></section><div data-page-panel="evaluation"></div></main>');t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');mountExpertFlow(view,r,()=>{}, {roles:['expert']});
 const trial=view.querySelector('[data-expert-trial]'),basis=trial.querySelector('.expert-result-evidence'),form=view.querySelector('[data-expert-feedback]');assert.equal(basis.open,false);assert.match(basis.textContent,/分析说明只在依据里展示/);assert.match(trial.querySelector('.expert-result-actions').textContent,/核实是清洁遗漏还是再次污染/);assert.match(trial.querySelector('.expert-result-unknowns').textContent,/尚未核实/);assert.match(trial.querySelector('.badge').textContent,/Recommendations ready/);assert.equal(form.querySelector('.expert-feedback-expectation').open,false);assert.equal(form.elements.expectedHandling.value,'原样保存的完整确认内容');
 assert.ok(form.querySelector('button[type=submit]').classList.contains('primary'));
 const correction=form.querySelector('[data-feedback-correction]');assert.equal(correction.hidden,true);form.elements.decision.value='corrected';form.elements.decision.dispatchEvent(new dom.window.Event('change'));assert.equal(correction.hidden,false);form.elements.decision.value='accepted';form.elements.decision.dispatchEvent(new dom.window.Event('change'));assert.equal(correction.hidden,true);form.elements.expectedHandling.value='修正后的处理方式';form.elements.expectedHandling.dispatchEvent(new dom.window.Event('input'));assert.equal(form.elements.decision.value,'corrected');assert.equal(correction.hidden,false);
});

test('retained incomplete extraction saves edits without merging or claiming extraction is complete',async t=>{
 const r=record();r.documents=[{id:'partial',name:'Source',status:'extracted',captureCompleteness:'partial',sourceOnly:true,captureIssues:['Model unavailable'],blocks:[],questions:[],conflicts:[],candidates:[{id:'K-source',type:'evidence',title:'原文片段',text:'原始经验内容。',evidence:[{blockId:'B1',quote:'原始经验内容。'}],missing:[],relatedRuleIds:[],relatedActionIds:[]}]}];
 const dom=new JSDOM('<main>'+captureMarkup(r)+'</main>',{url:'http://localhost/studio/p1'});t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');let saved,next;
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);globalThis.fetch=()=>assert.fail('Incomplete drafts must not call merge');
 bindCapture(view,r,async(task,_message,nextView)=>{next=nextView;await task(r);},async(id,payload)=>{saved={id,payload};return r;});const form=view.querySelector('[data-capture-review]');assert.match(view.querySelector('.capture-incomplete').textContent,/Source saved/);assert.match(form.querySelector('button[type=submit]').textContent,/Save review draft/);assert.equal(form.checkValidity(),true);form.elements['text-0'].value='修改后的草稿。';await form.onsubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(saved.id,'partial');assert.equal(saved.payload.items[0].text,'修改后的草稿。');assert.equal(next,'draft');
});
