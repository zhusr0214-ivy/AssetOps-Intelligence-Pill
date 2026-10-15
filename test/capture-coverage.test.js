import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCaptureCoverage,createKnowledgeCaptureAgent,validateCapture,validateCaptureTypes,normalizeCaptureLinks,normalizeCaptureMetadata} from '../knowledge-agent.js';
const text='这一步只做信息收集和转介。若报告了相关风险，应按现场规定联系负责人员处理。';
const blocks=[{id:'B1',location:'Paragraph 1',text}];
const candidate=(type)=>({key:type,type,title:type==='rule'?'安全风险判断':'安全风险上报',text:'若报告了相关风险，应按现场规定联系负责人员处理。',evidence:[{blockId:'B1',quote:'若报告了相关风险，应按现场规定联系负责人员处理。'}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]});
test('explicit source escalation cannot be buried solely in a rule or action',()=>{
 assert.throws(()=>validateCaptureCoverage({candidates:[candidate('rule')],questions:[]},blocks),/no escalation candidate/);
 const valid={candidates:[candidate('rule'),candidate('escalation')],questions:[]};assert.equal(validateCaptureCoverage(valid,blocks),valid);
 assert.doesNotThrow(()=>validateCaptureCoverage({candidates:[candidate('rule')],questions:[]},[{text:'记录已知位置；禁止猜测。'}]));
});
test('information-only knowledge rejects nonblocking implementation questions but retains decision ambiguities',()=>{
 const valid={candidates:[candidate('escalation')],questions:['未确认安全状况时，应继续收集哪些事实？']};assert.equal(validateCaptureCoverage(valid,blocks),valid);
 for(const question of ['“现场规定”的具体内容是什么？','负责人员的具体名单或联系方式在哪里查找？','转交管道专业人员的标准流程是什么？'])assert.throws(()=>validateCaptureCoverage({...valid,questions:[question]},blocks),/nonblocking implementation/);
 const missing={...candidate('escalation'),missing:['未指定记录的具体格式或系统入口。']};assert.throws(()=>validateCaptureCoverage({candidates:[missing],questions:[]},blocks),/nonblocking implementation/);
 assert.doesNotThrow(()=>validateCaptureCoverage({...valid,questions:['现场规定的具体内容是什么？']},[{text:'执行维修须依据现场规定，禁止遗漏步骤。'}]));
});
test('capture repairs missing escalation once and retains an explicitly incomplete draft on repeated omission',async()=>{
 let calls=0,correction;
 const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1',SOCLAAS_MODEL:'fixture'},fetchImpl:async(url,options)=>{calls++;const body=JSON.parse(options.body);correction=body.messages.at(-1).content;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({candidates:calls===1?[candidate('rule')]:[candidate('rule'),candidate('escalation')],questions:[],conflicts:[]})}}]})};}});
 const result=await agent({name:'fixture',domain:'water_leak',blocks});assert.equal(calls,2);assert.ok(result.candidates.some(c=>c.type==='escalation'));assert.match(correction,/no escalation candidate/);
 calls=0;const failing=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({candidates:[candidate('rule')],questions:[],conflicts:[]})}}]})};}});
 const partial=await failing({name:'fixture',blocks});assert.equal(partial.captureCompleteness,'partial');assert.match(partial.captureIssues.join(' '),/no escalation candidate/);assert.ok(partial.candidates.some(c=>c.type==='rule'));assert.ok(partial.candidates.every(c=>c.evidence.length));assert.equal(calls,2);
});

test('coverage repair adds missing knowledge without replacing supported proposals',async()=>{
 let calls=0;const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({candidates:++calls===1?[candidate('rule')]:[candidate('escalation'),{...candidate('rule'),text:'Changed existing rule'}],questions:[],conflicts:[]})}}]})})});
 const result=await agent({name:'fixture',blocks});assert.equal(calls,2);assert.ok(result.candidates.some(c=>c.type==='escalation'));assert.equal(result.candidates.find(c=>c.type==='rule').text,candidate('rule').text);
});
test('incomplete extraction retains grounded proposals and resumes from them on a later retry',async()=>{
 const env={SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'};let failure;
 const agent=createKnowledgeCaptureAgent({env,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({candidates:[candidate('rule')],questions:[],conflicts:[]})}}]})})});
 failure=await agent({name:'fixture',blocks});
 assert.equal(failure.captureCompleteness,'partial');assert.equal(failure.captureProgress.length,1);assert.ok(failure.candidates.some(c=>c.type==='rule'));let request;
 const resume=createKnowledgeCaptureAgent({env,fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({candidates:[candidate('escalation')],questions:[],conflicts:[]})}}]})};}});
 const result=await resume({name:'fixture',blocks,captureProgress:failure.captureProgress});assert.ok(result.candidates.some(c=>c.type==='rule'));assert.ok(result.candidates.some(c=>c.type==='escalation'));assert.match(request.messages.at(-1).content,/savedCandidates/);
 // Changing the actual source invalidates progress, so stale claims cannot be reused.
 const changed=await resume({name:'fixture',blocks:[{...blocks[0],text:blocks[0].text+' 新增说明。'}],captureProgress:failure.captureProgress});assert.equal(changed.candidates.length,1);assert.doesNotMatch(request.messages.at(-1).content,/savedCandidates/);
});

test('invalid comparison and comparison transport failure cannot discard a grounded extraction',async()=>{
 for(const mode of ['references','network']){
 let calls=0;const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>{
 calls++;if(calls>1&&mode==='network')throw new Error('Comparison transport failed');
 const output=calls===1?{candidates:[candidate('rule'),candidate('escalation')],questions:[],conflicts:[]}:{decisions:[{id:'P1',change:'unchanged',targetId:'T999',reason:'无效引用'}],questions:[],conflicts:[]};return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})};}});
 const result=await agent({name:'fixture',blocks,repairTargets:[{id:'existing-rule',type:'rule',text:'Existing rule'}]});assert.ok(result.candidates.length>=2);assert.equal(result.comparisonStatus,'partial');assert.ok(result.candidates.every(c=>c.change==='review'));assert.equal(result.unchangedKnowledge.length,0);
 }
});

test('comparison-only retry revalidates saved extraction and skips model extraction',async()=>{
 const saved=validateCapture({candidates:[candidate('rule'),candidate('escalation')],questions:[],conflicts:[]},blocks);let calls=0;
 const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async(_url,options)=>{
 calls++;const input=JSON.parse(JSON.parse(options.body).messages[1].content);assert.ok(input.proposals);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({decisions:input.proposals.map(c=>({id:c.id,change:'new',reason:'新增条件。'})),questions:[],conflicts:[]})}}]})};}});
 const result=await agent({name:'fixture',blocks,comparisonCandidates:saved.candidates,repairTargets:[{id:'old',type:'boundary',text:'Existing boundary'}]});assert.equal(calls,1);assert.equal(result.candidates.length,2);assert.equal(result.comparisonStatus,'complete');
});

test('independent conditional branches cannot all be compressed into a single rule and final action',()=>{
 const value={candidates:[{...candidate('rule'),text:'如果尚未清洁，核对计划；如果已经完成但有污渍，核实遗漏或再次污染。'}],questions:[],conflicts:[]};assert.throws(()=>validateCaptureCoverage(value,[{id:'B1',text:value.candidates[0].text}]),/Distinct conditional branches/);
});

test('source-stated intake and completion triggers cannot be dismissed as missing expert knowledge',()=>{
 const value={candidates:[{...candidate('rule'),key:'known',relatedActionKeys:['linked']},{...candidate('action'),key:'linked',relatedRuleKeys:['known']},{...candidate('action'),key:'recheck',text:'处理后需要复查现场，不能以已通知作为问题已解决。',missing:['关联条件待专家补充。']}]};assert.throws(()=>validateCaptureTypes(value),/explicitly states its own trigger/);
});

test('a pure unlinked non-attribution limit becomes a boundary rather than a fabricated rule/action pair',()=>{
 const value={candidates:[{...candidate('rule'),key:'limit',text:'缺少的信息保留为未知，不直接归责于个人。'},{...candidate('rule'),key:'condition',text:'当收到反馈时收集信息。',relatedActionKeys:['task']},{...candidate('action'),key:'task',text:'收集现场反馈。',relatedRuleKeys:['condition']}],questions:[],conflicts:[]};const normalized=normalizeCaptureLinks(value);assert.equal(normalized.candidates[0].type,'boundary');assert.doesNotThrow(()=>validateCaptureTypes(normalized));assert.equal(normalized.candidates[0].relatedActionKeys.length,0);
});

test('optional extraction notes normalize without guessing evidence or knowledge content',()=>{
 const raw={candidates:[{...candidate('rule'),missing:undefined,evidence:[{blockId:'B1',quote:text},{blockId:'B1',quote:text}]}],questions:[],conflicts:[]};const normalized=normalizeCaptureMetadata(raw);assert.deepEqual(normalized.candidates[0].missing,[]);assert.equal(normalized.candidates[0].evidence.length,1);assert.equal(normalized.candidates[0].text,raw.candidates[0].text);assert.doesNotThrow(()=>validateCapture(normalized,blocks));
 const bad={...normalized,candidates:[{...normalized.candidates[0],text:''}]};assert.throws(()=>validateCapture(bad,blocks),e=>e.captureDiagnostic.reason==='invalid_candidate_fields'&&e.captureDiagnostic.fields.some(v=>v.startsWith('text')));
 normalized.candidates[0].evidence[0].quote='Invented quote';assert.throws(()=>validateCapture(normalized,blocks),/citation did not match/);
});
