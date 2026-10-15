import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {studioStep,bindStudioFlow} from '../public/studio-flow.js';
test('next step follows draft, evaluation and publication state',()=>{
 const r={state:'draft',content:{pill:{applicability:{categories:['lift_fault']},rules:[],actions:[]}},documents:[{status:'extracted'}]};
 assert.equal(studioStep(r),0);r.content.pill.rules=[{}];r.content.pill.actions=[{}];assert.equal(studioStep(r),0);r.documents[0].status='reviewed';assert.equal(studioStep(r),2);
 r.validation={passed:true};r.evaluationRequired=true;r.evaluationGate={passed:false};assert.equal(studioStep(r),2);
 r.state='in_review';assert.equal(studioStep(r),3);
});
test('only current group opens and stage navigation does not submit a form',()=>{
 const dom=new JSDOM('<main><header class="workspace-heading"></header><section class="capture-panel"></section><form id="pill-editor"></form><section class="evaluation-panel"></section></main>');
 const root=dom.window.document.querySelector('main'); const before=globalThis.document;globalThis.document=dom.window.document;
 try{bindStudioFlow(root,{state:'draft',content:{pill:{applicability:{categories:['lift_fault']},rules:[]}},documents:[{status:'extracted'}]});assert.equal(root.querySelectorAll('.studio-stage[open]').length,1);assert.match(root.querySelector('.studio-next-step').textContent,/Extraction is complete/);root.querySelector('[data-step="2"]').click();assert.equal(root.querySelector('[data-stage="2"]').open,true);assert.equal(root.querySelector('[data-stage="0"]').open,false);assert.equal(root.querySelector('#pill-editor').tagName,'FORM');}finally{globalThis.document=before;dom.window.close();}
});
