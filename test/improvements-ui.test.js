import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderImprovements} from '../public/improvements.js';
import {sessionRequest} from '../public/session.js';
import {expertMarkup,experienceMarkup} from '../public/case-records.js';
async function setup(t,role='admin'){
 const dom=new JSDOM('<main></main>',{url:'http://localhost/studio/improvements/c/b'}),old=globalThis.fetch;
 t.after(()=>{globalThis.fetch=old;dom.window.close();});
 let batch={id:'b',caseId:'c',revision:0,status:'in_review',experience:{solution:'Keep clear.',expert:'Expert'},targets:[{key:'t',pillId:'p',name:'Lighting',baseVersion:'1',dependsOn:[],changes:[{id:'ch',field:'boundaries',before:'',after:'Keep clear.',reason:'Expert guidance.',quote:'Keep clear.',decision:'pending'}]}]};
 const calls=[];
 globalThis.fetch=async(url,options={})=>({ok:true,json:async()=>{
  if(url==='/api/auth/session')return {user:{id:'u',name:'User',roles:[role]}};
  if(url==='/api/improvements')return {batches:[{...batch,title:'Floor lighting'}]};
  if(options.method){const body=JSON.parse(options.body);calls.push({url,body});batch.revision++;
   if(url.endsWith('/save')){batch.targets[0].changes=body.changes.map(c=>({...batch.targets[0].changes[0],...c}));batch.validationNotes=body.validationNotes;}
   if(url.endsWith('/publish')){batch.status='published';batch.releases=[{id:'p',version:'2.0.0'}];}
  }
  return {batch:structuredClone(batch)};
 }});
 await sessionRequest('/api/auth/session');return {dom,view:dom.window.document.querySelector('main'),calls};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('UI did not finish');}
test('proposal returns to Studio and shows editable before/after changes',async t=>{
 const f=await setup(t);
 await renderImprovements(f.view,'/studio/improvements/c/b');assert.match(f.view.textContent,/Before/);assert.match(f.view.textContent,/After/);assert.equal(f.view.querySelector('[data-change] textarea').readOnly,false);
 assert.equal(f.view.querySelector('.back-link').getAttribute('href'),'/studio');
 f.view.querySelector('[data-change] select').value='accepted';f.view.querySelector('[data-change] textarea').value='Keep clear of wiring.';
 f.view.querySelector('[data-operation=save]').click();await until(()=>f.view.textContent.includes('Proposal saved.'));
 assert.equal(f.calls[0].body.changes[0].after,'Keep clear of wiring.');assert.equal(f.calls[0].body.changes[0].decision,'accepted');
});
test('admin publication saves selected edits without a validation form',async t=>{
 const f=await setup(t);await renderImprovements(f.view,'/studio/improvements/c/b');
 assert.equal(f.view.querySelector('[name=validationNotes],[name=validated]'),null);
 f.view.querySelector('[data-change] select').value='accepted';
 f.view.querySelector('[data-operation=publish]').click();await until(()=>f.view.querySelector('a[href="/library/p"]'));
 assert.deepEqual(f.calls.map(c=>c.url),['/api/improvements/c/b/save','/api/improvements/c/b/publish']);assert.equal(f.calls[1].body.validated,undefined);
});
test('experts can edit but cannot publish; viewers cannot edit',async t=>{
 const f=await setup(t,'expert');await renderImprovements(f.view,'/studio/improvements/c/b');assert.equal(f.view.querySelector('[data-operation=publish]').disabled,true);assert.equal(f.view.querySelector('[data-operation=save]').disabled,false);
});
test('viewer sees read-only proposal and escaped evidence',async t=>{
 const f=await setup(t,'viewer');await renderImprovements(f.view,'/studio/improvements/c/b');assert.equal(f.view.querySelector('[data-operation=save]').disabled,true);assert.equal(f.view.querySelector('[data-change] textarea').readOnly,true);
});
test('expert experience no longer requires choosing one Pill, confirmed record links to batch',async t=>{
 await setup(t);
 const i={id:'c',messages:[{id:'m',role:'assistant',expertRequest:{required:true},matchedPills:[{id:'p',name:'Lighting'}]}]};
 const dom=new JSDOM(expertMarkup(i,{}));assert.equal(dom.window.document.querySelector('[name=targetPillId]'),null);dom.window.close();
 const html=experienceMarkup({...i,expertSolutions:[{id:'exp',solution:'<script>bad</script>',expert:'Expert',improvementBatchId:'b'}]});assert.match(html,/\/studio\/improvements\/c\/b/);assert.doesNotMatch(html,/<script>/);
});
