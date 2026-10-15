import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {sessionRequest} from '../public/session.js';
import {renderCaptureEntry} from '../public/knowledge.js';
test('creation selects one source, defaults owner and validates before creating a record',async t=>{
 const dom=new JSDOM('<main></main>');const previous={fetch:globalThis.fetch};let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({user:{id:'u',name:'Expert A',roles:['expert']},csrf:'test'})};};
 t.after(()=>{globalThis.fetch=previous.fetch;dom.window.close();});await sessionRequest('/api/auth/session');
 const root=dom.window.document.querySelector('main');await renderCaptureEntry(root,'unified',()=>assert.fail('Invalid form must not navigate'));const form=root.querySelector('form');
 assert.equal(form.elements.owner.value,'Expert A');assert.equal(root.querySelector('[data-entry-experience]').hidden,true);
 form.elements.sourceMode.value='experience';form.querySelector('[value=experience]').dispatchEvent(new dom.window.Event('change',{bubbles:true}));assert.equal(root.querySelector('[data-entry-file]').hidden,true);assert.equal(root.querySelector('[data-entry-experience]').hidden,false);
 await form.onsubmit({preventDefault(){}});assert.equal(calls,1);assert.match(root.querySelector('[role=alert]').textContent,/Enter the Pill name/);
 form.elements.name.value='QA';await form.onsubmit({preventDefault(){}});assert.equal(calls,1);assert.match(root.querySelector('[role=alert]').textContent,/expert experience/);
});
test('viewer receives a readable create permission explanation without authoring form',async t=>{
 const dom=new JSDOM('<main></main>'),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;dom.window.close();});globalThis.fetch=async()=>({ok:true,json:async()=>({user:{id:'v',roles:['viewer']}})});await sessionRequest('/api/auth/session');const root=dom.window.document.querySelector('main');await renderCaptureEntry(root,'unified',()=>{});assert.equal(root.querySelector('form'),null);assert.match(root.textContent,/requires an expert account/);
});
