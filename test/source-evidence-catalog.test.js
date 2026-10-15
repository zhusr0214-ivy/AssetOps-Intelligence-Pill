import test from 'node:test';import assert from 'node:assert/strict';
import {sourceEvidenceCatalog,resolveSourceEvidence,validateCapture,createKnowledgeCaptureAgent,validateCaptureCoverage,validateCaptureTypes} from '../knowledge-agent.js';
const blocks=[{id:'B1',location:'Expert note, paragraph 1',text:'Do not operate equipment. Record unknown facts as unknown.'}];
const output=id=>({candidates:[{key:'b1',type:'boundary',title:'No equipment operation',text:'Do not operate equipment.',evidence:[{evidenceId:id}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]},{key:'a1',type:'action',title:'Record unknowns',text:'Record unknown facts as unknown.',evidence:[{evidenceId:'E2'}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]}],questions:[],conflicts:[]});
test('selected source evidence retrieves original quote, negation and provenance',()=>{
 const catalog=sourceEvidenceCatalog(blocks),raw=output('E1');raw.candidates[0].evidence[0].quote='Operate equipment';raw.candidates[0].evidence[0].blockId='invented';
 const result=validateCapture(resolveSourceEvidence(raw,catalog),blocks);assert.equal(result.candidates[0].evidence[0].quote,'Do not operate equipment.');assert.equal(result.candidates[0].evidence[0].location,blocks[0].location);
 assert.throws(()=>validateCapture(resolveSourceEvidence(output('E999'),catalog),blocks),e=>e.captureDiagnostic.candidate===1&&e.captureDiagnostic.evidence===1&&e.captureDiagnostic.reason==='invalid_source_or_evidence_id');
});
test('model gets a source catalog and unknown IDs get one corrective retry and unsafe items are excluded from retained drafts',async()=>{
 for(const fix of [true,false]){let calls=0,request;
 const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async(url,options)=>{request=JSON.parse(options.body);calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output(fix&&calls===2?'E1':'E999'))}}]})};}});
 if(fix){const result=await agent({name:'note',blocks});assert.equal(result.candidates.length,2);assert.equal(result.candidates[0].evidence[0].quote,'Do not operate equipment.');}
 else {const result=await agent({name:'note',blocks});assert.equal(result.captureCompleteness,'partial');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].title,'Record unknowns');assert.equal(result.rejectedCandidates.length,1);}
 assert.equal(calls,2);assert.ok(JSON.parse(request.messages[1].content).sourceEvidence.length);}
});

test('invalid JSON receives one correction rather than being reported as a transport failure',async()=>{
 let calls=0;const agent=createKnowledgeCaptureAgent({env:{SOCLAAS_API_KEY:'fixture',SOCLAAS_BASE_URL:'https://fixture.invalid/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:++calls===1?'{broken':JSON.stringify(output('E1'))}}]})})});
 const result=await agent({name:'note',blocks});assert.equal(calls,2);assert.equal(result.candidates.length,2);
});

test('distinct possible-cause passages cannot be replaced with generic referral knowledge',()=>{
 const source=[{id:'B1',text:'长期停用后出现异味，可能与水封不足有关。异味伴随咕噜声，可能涉及通气异常或管道受阻。',location:'Expert notes'}];
 const catalog=sourceEvidenceCatalog(source);const rule=(key,id)=>({key,type:'rule',title:'Possible causes',text:'Possible causes remain unconfirmed.',evidence:[{evidenceId:id}],relatedRuleKeys:[],relatedActionKeys:[],missing:[]});
 const incomplete=resolveSourceEvidence({candidates:[rule('r1','E1')],questions:[],conflicts:[]},catalog);
 assert.throws(()=>validateCaptureCoverage(incomplete,source),e=>e.captureDiagnostic.reason==='missing_possible_cause_rule');
 const complete=resolveSourceEvidence({candidates:[rule('r1','E1'),rule('r2','E2')],questions:[],conflicts:[]},catalog);assert.doesNotThrow(()=>validateCaptureCoverage(complete,source));
 const candidates=Array.from({length:12},(_,i)=>({...rule('r'+i,'E1'),evidence:[{blockId:'B1',quote:catalog[0].quote}]}));assert.equal(validateCapture({candidates,questions:[],conflicts:[]},source).candidates.length,12);
});

 test('partial links are checked individually and reciprocal links count',()=>{
 const r=(key,links=[])=>({key,type:'rule',relatedActionKeys:links,missing:[]});const a=(key,links=[])=>({key,type:'action',relatedRuleKeys:links,missing:[]});
 assert.throws(()=>validateCaptureTypes({candidates:[r('r1',['a1']),a('a1',['r1']),r('r2'),a('a2')]}),/r2, a2/);
 assert.doesNotThrow(()=>validateCaptureTypes({candidates:[r('r1'),a('a1',['r1'])]}));
 assert.doesNotThrow(()=>validateCaptureTypes({candidates:[r('r1',['a1']),a('a1'),{...r('r2'),missing:['The source gives no action relationship.']}]}));
 });
