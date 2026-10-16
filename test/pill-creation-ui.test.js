import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {sessionRequest} from '../public/session.js';
import {renderCaptureEntry} from '../public/knowledge.js';
test('creation shows only name, knowledge and file controls and validates before creating a record',async t=>{
 const dom=new JSDOM('<main></main>');const previous={fetch:globalThis.fetch};let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({user:{id:'u',name:'Expert A',roles:['expert']},csrf:'test'})};};
 t.after(()=>{globalThis.fetch=previous.fetch;dom.window.close();});await sessionRequest('/api/auth/session');
 const root=dom.window.document.querySelector('main');await renderCaptureEntry(root,'unified',()=>assert.fail('Invalid form must not navigate'));const form=root.querySelector('form');
 assert.deepEqual([...form.querySelectorAll('input,textarea,select')].map(el=>el.name),['name','experience','file']);
 assert.equal(form.querySelector('details'),null);assert.equal(form.querySelector('[name=sourceMode]'),null);
 assert.equal(form.elements.experience.hidden,false);assert.ok(form.querySelector('[data-choose-file]'));
 await form.onsubmit({preventDefault(){}});assert.equal(calls,1);assert.match(root.querySelector('[role=alert]').textContent,/Enter the Pill name/);
 form.elements.name.value='QA';await form.onsubmit({preventDefault(){}});assert.equal(calls,1);assert.match(root.querySelector('[role=alert]').textContent,/Enter knowledge or upload/);
});
test('viewer receives a readable create permission explanation without authoring form',async t=>{
 const dom=new JSDOM('<main></main>'),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;dom.window.close();});globalThis.fetch=async()=>({ok:true,json:async()=>({user:{id:'v',roles:['viewer']}})});await sessionRequest('/api/auth/session');const root=dom.window.document.querySelector('main');await renderCaptureEntry(root,'unified',()=>{});assert.equal(root.querySelector('form'),null);assert.match(root.textContent,/requires an expert account/);
});
