import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeCaptureAgent,recoverCaptureDraft,restoreLiteralTasks} from '../knowledge-agent.js';
const env={SOCLAAS_API_KEY:'fixture-secret',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'};
const blocks=[{id:'B1',location:'Expert statement',text:'Do not operate equipment. Check the reported information.'}];
const candidate=(key,quote)=>({key,type:'boundary',title:key,text:quote,evidence:[{blockId:'B1',quote}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]});
const value=candidates=>({candidates,questions:[],conflicts:[]});
const response=content=>({ok:true,json:async()=>({choices:[{message:{content:typeof content==='string'?content:JSON.stringify(content)}}]})});
test('one invalid candidate cannot erase source-validated siblings or preserve its unsafe claims',async()=>{
 const proposal=value([candidate('safe','Do not operate equipment.'),candidate('unsafe','Invented equipment diagnosis.')]);
 const agent=createKnowledgeCaptureAgent({env,fetchImpl:async()=>response(proposal)});const r=await agent({blocks});assert.equal(r.captureCompleteness,'partial');assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].text,'Do not operate equipment.');assert.equal(r.rejectedCandidates.length,1);assert.ok(!r.candidates.some(c=>c.text.includes('Invented')));
});
test('malformed JSON, timeout and missing model configuration retain original evidence with an explicit incomplete state',async()=>{
 for(const fetchImpl of [async()=>response('{broken'),async()=>{throw Object.assign(Error('offline fixture-secret'),{name:'TimeoutError'});}]){
 const r=await createKnowledgeCaptureAgent({env,fetchImpl})({blocks});assert.equal(r.captureCompleteness,'partial');assert.equal(r.sourceOnly,true);assert.ok(r.candidates.every(c=>c.type==='evidence'));assert.ok(r.candidates.every(c=>blocks[0].text.includes(c.evidence[0].quote)));assert.ok(!JSON.stringify(r).includes('fixture-secret'));
 }
 const r=await createKnowledgeCaptureAgent({env:{}})({blocks});assert.equal(r.sourceOnly,true);assert.match(r.captureIssues[0],/not configured/);
});
test('transient provider errors retry once before downgrading to a retained draft',async()=>{
 let calls=0;const agent=createKnowledgeCaptureAgent({env,fetchImpl:async()=>++calls===1?{ok:false,status:503}:response(value([candidate('safe','Do not operate equipment.')]))});
 const r=await agent({blocks});assert.equal(calls,2);assert.equal(r.captureCompleteness,'complete');assert.equal(r.candidates.length,1);
});
test('a later batch failure retains completed batches and resuming skips their model requests',async()=>{
 const largeBlocks=[...blocks,{id:'B2',location:'Appendix',text:'x'.repeat(12000)}];let calls=0;
 const first=createKnowledgeCaptureAgent({env,fetchImpl:async()=>{calls++;if(calls===1)return response(value([candidate('safe','Do not operate equipment.')]));throw Error('temporary');}});
 const partial=await first({blocks:largeBlocks});assert.equal(partial.captureCompleteness,'partial');assert.ok(partial.candidates.some(c=>c.text==='Do not operate equipment.'));assert.equal(partial.captureProgress[0].complete,true);
 let resumedCalls=0;const resume=createKnowledgeCaptureAgent({env,fetchImpl:async(_url,options)=>{resumedCalls++;const request=JSON.parse(JSON.parse(options.body).messages[1].content);assert.equal(request.blocks[0].id,'B2');return response(value([]));}});
 const completed=await resume({blocks:largeBlocks,captureProgress:partial.captureProgress});assert.equal(resumedCalls,1);assert.equal(completed.captureCompleteness,'complete');assert.equal(completed.candidates[0].text,'Do not operate equipment.');
});
test('non-array or malformed candidate collections safely fall back to source evidence',()=>{
 for(const input of [null,{candidates:{}},{candidates:[null]}]){const r=recoverCaptureDraft(input,blocks);assert.equal(r.sourceOnly,true);assert.ok(r.candidates.every(c=>c.type==='evidence'));}
});

test('a literal source task can restore a missing action without another model guess',()=>{
 const quote='如果记录显示已完成，但现场仍有明显污渍，就结合现场情况核实是清洁遗漏，还是清洁后再次被污染。';
 const r={key:'r',type:'rule',title:'污渍核实规则',text:'如果记录显示已完成，但现场仍有明显污渍，需结合现场情况核实是清洁遗漏，还是清洁后再次被污染。',evidence:[{blockId:'B1',quote}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]};const result=restoreLiteralTasks(value([r]));assert.equal(result.candidates.length,2);assert.equal(result.candidates[1].text,'结合现场情况核实是清洁遗漏，还是清洁后再次被污染');assert.equal(result.candidates[0].relatedActionKeys[0],result.candidates[1].key);assert.deepEqual(result.candidates[1].relatedRuleKeys,['r']);
 const unsupported=restoreLiteralTasks(value([{...r,text:'需拆卸设备检查。'}]));assert.equal(unsupported.candidates.length,1);
});
test('ambiguous or multiple source conditions do not justify an automatic new action',()=>{
 const r={key:'r',type:'rule',title:'General rule',text:'如果尚未清洁就核对计划，如果已经清洁就核实污渍。',evidence:[{blockId:'B1',quote:'如果尚未清洁，就核对计划；如果已经清洁，就核实污渍。'}],relatedActionKeys:[],relatedRuleKeys:[],missing:[]};assert.equal(restoreLiteralTasks(value([r])).candidates.length,1);
});

test('a focused final repair adds only the omitted action without rewriting supported candidates',async()=>{
 const blocks=[{id:'B1',text:'When a complaint arrives, check the schedule. After handling, inspect the site.',location:'Interview'}];
 const rule=(key,text,evidenceId,actions)=>({key,type:'rule',title:key,text,evidence:[{evidenceId}],relatedRuleKeys:[],relatedActionKeys:actions,missing:[]});
 const initial=value([rule('r1','For incoming reports verify the schedule.','E1',[]),rule('r2','Following handling, verify completion.','E2',['a2']),{key:'a2',type:'action',title:'Inspect site',text:'Inspect the site after handling.',evidence:[{evidenceId:'E2'}],relatedRuleKeys:['r2'],relatedActionKeys:[],missing:[]}]);let calls=0;
 const agent=createKnowledgeCaptureAgent({env,fetchImpl:async(_url,options)=>{calls++;if(calls<3)return response(initial);const request=JSON.parse(JSON.parse(options.body).messages[1].content);assert.equal(request.existingCandidates[0].key,'C1');return response({candidates:[{key:'N1',type:'action',title:'Check schedule',text:'Check the schedule.',evidence:[{evidenceId:'E1'}],relatedRuleKeys:['C1'],relatedActionKeys:[],missing:[]}],links:[{ruleKey:'C1',actionKey:'N1'}],questions:[],conflicts:[]});}});
 const r=await agent({blocks});assert.equal(calls,3);assert.equal(r.captureCompleteness,'complete');assert.equal(r.candidates.length,4);assert.equal(r.candidates.find(c=>c.title==='r1').text,initial.candidates[0].text);assert.ok(r.candidates.filter(c=>c.type==='rule').every(c=>c.relatedActionIds.length));
});
