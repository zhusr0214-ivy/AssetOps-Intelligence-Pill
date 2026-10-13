import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCaptureLinks,validateCapture} from '../knowledge-agent.js';
import {captureMarkup} from '../public/knowledge.js';
test('existing candidate links use actual types; citations remain strictly enforced',()=>{
 const candidate=(key,type)=>({key,type,title:'Test',text:'Collect facts.',evidence:[{blockId:'B1',quote:'Collect facts.'}],missing:[],relatedRuleKeys:[],relatedActionKeys:[]});
 const rule=candidate('r','rule'),action=candidate('a','action');action.relatedRuleKeys=['r'];rule.relatedRuleKeys=['a'];
 const normalized=normalizeCaptureLinks({candidates:[rule,action],questions:[],conflicts:[]});
 assert.deepEqual(normalized.candidates[0].relatedActionKeys,['a']);assert.deepEqual(normalized.candidates[0].relatedRuleKeys,[]);
 assert.equal(validateCapture(normalized,[{id:'B1',text:'Collect facts.'}]).candidates.length,2);
 normalized.candidates[0].evidence[0].quote='Invented';assert.throws(()=>validateCapture(normalized,[{id:'B1',text:'Collect facts.'}]),/citation/);
});
test('ready source opens with a prominent Analyze action; published failures are historical',()=>{
 const doc={id:'d',name:'fixture.txt',status:'ready',blocks:[],warnings:[]};
 const ready=captureMarkup({id:'p',state:'draft',documents:[doc]});assert.match(ready,/capture-document" open/);assert.match(ready,/primary capture-analyze/);
 const history=captureMarkup({id:'p',state:'published',documents:[{...doc,status:'failed',error:'Old invalid links'}]});assert.match(history,/Historical extraction failure/);assert.ok(!history.includes('data-analyze'));
});
