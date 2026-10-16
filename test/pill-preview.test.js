import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {previewMarkup,renderPillPreview} from '../public/pill-preview.js';
import {renderStudio} from '../public/studio.js';
import {sessionRequest} from '../public/session.js';
import {pageTabsMarkup} from '../public/subpages.js';
const fixture=()=>({id:'p',revision:1,state:'draft',releases:[],documents:[],content:{pill:{name:'Lighting',owner:'Admin',scope:'Floor lighting',rules:[{id:'r',title:'Lighting failure',guidance:'If lighting fails, record the floor.',actionIds:['a']}],actions:[{id:'a',title:'Record',instruction:'Record the floor.',owner:'',requiresApproval:true,ruleIds:['r']}],boundaries:['No repairs.'],escalationConditions:[]},sources:[],examples:[]}});
async function setup(t,roles=['admin']){
 const dom=new JSDOM('<main></main>',{url:'http://localhost/studio'}),previous=globalThis.fetch;
 t.after(()=>{globalThis.fetch=previous;dom.window.close();});
 let record=fixture();const calls=[];
 globalThis.fetch=async(url,options={})=>({ok:true,json:async()=>{
   if(url==='/api/auth/session')return {user:{id:'u',name:'User',roles}};
   if(url==='/api/studio')return {records:[record,{...record,id:'published',state:'published'}]};
   if(!options.method)return {record:structuredClone(record)};
   const body=JSON.parse(options.body);calls.push({url,body});
   if(body.content)record.content=structuredClone(body.content);
   record.revision++;if(url.endsWith('/publish'))record.state='published';if(url.endsWith('/fork'))record.state='draft';
   return {record:structuredClone(record)};
 }});
 await sessionRequest('/api/auth/session');
 return {dom,view:dom.window.document.querySelector('main'),calls,get record(){return record;}};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('UI did not complete');}
test('default and legacy Studio URLs show compact content without workflow tabs',async t=>{
 const f=await setup(t);await renderStudio(f.view,'/studio',()=>{});
 const links=[...f.view.querySelectorAll('tbody a')];assert.equal(links.length,1);assert.equal(links[0].getAttribute('href'),'/studio/p');
 await renderStudio(f.view,'/studio/p',()=>{});
 assert.ok(f.view.querySelector('.pill-content-preview'));assert.equal(f.view.querySelector('#pill-editor,.evaluation-panel'),null);
 for(const search of ['','?view=draft','?view=evaluation','?view=publication'])assert.equal(pageTabsMarkup('/studio/p',search,true),'');
 assert.equal(pageTabsMarkup('/studio/new','',true),'');
});
test('draft is read-only until Edit, and saves all metadata before disabling inputs',async t=>{
 const f=await setup(t);renderPillPreview(f.view,f.record,()=>{});
 assert.equal(f.view.querySelector('textarea'),null);assert.equal(f.view.querySelectorAll('button').length,4);
 f.view.querySelector('[data-edit-preview]').click();
 f.view.querySelector('[name=name]').value='Updated lighting';f.view.querySelector('[name=scope]').value='Floor 12 lighting';
 f.view.querySelector('[data-collection=actions] textarea').value='Record the room.';
 f.view.querySelector('[data-collection=boundaries] textarea').value='No electrical repairs.';
 f.view.querySelector('[data-save-preview]').click();await until(()=>f.view.textContent.includes('Draft saved.'));
 const p=f.calls[0].body.content.pill;assert.equal(p.name,'Updated lighting');assert.equal(p.scope,'Floor 12 lighting');assert.equal(p.actions[0].instruction,'Record the room.');assert.deepEqual(p.boundaries,['No electrical repairs.']);assert.equal(p.actions[0].requiresApproval,true);
});
test('expert can edit/save/delete but only admin can publish',async t=>{
 const f=await setup(t,['expert']);renderPillPreview(f.view,f.record,()=>{});
 assert.equal(f.view.querySelector('[data-save-preview]').disabled,false);assert.equal(f.view.querySelector('[data-delete-preview]').disabled,false);assert.equal(f.view.querySelector('[data-publish-preview]').disabled,true);
 f.view.querySelector('[data-save-preview]').click();await until(()=>f.calls.length===1);
});
test('admin publish saves then goes to Library without evaluation or review endpoints',async t=>{
 const f=await setup(t);let target;renderPillPreview(f.view,f.record,url=>target=url);
 f.view.querySelector('[data-publish-preview]').click();await until(()=>target);
 assert.equal(target,'/library/p');assert.deepEqual(f.calls.map(c=>c.url),['/api/studio/p/save','/api/studio/p/publish']);
});
test('empty scope, actions or decision rules cannot publish',async t=>{
 const f=await setup(t);
 for(const key of ['scope','action','rules','blank-rule']){
  const r=fixture();if(key==='scope')r.content.pill.scope='';else if(key==='action')r.content.pill.actions[0].instruction='';else if(key==='rules')r.content.pill.rules=[];else r.content.pill.rules[0].guidance=' ';
  renderPillPreview(f.view,r,()=>assert.fail('Invalid draft must not navigate'));
  f.view.querySelector('[data-publish-preview]').click();await until(()=>!f.view.querySelector('[data-preview-error]').hidden);
  assert.equal(f.calls.length,0);
 }
});
test('add/remove action and cancel keep edits local',async t=>{
 const f=await setup(t);renderPillPreview(f.view,f.record,()=>{});
 f.view.querySelector('[data-edit-preview]').click();f.view.querySelector('[data-add=actions]').click();
 assert.equal(f.view.querySelectorAll('[data-collection=actions] textarea').length,2);
 f.view.querySelector('[data-remove=actions][data-index="0"]').click();
 f.view.querySelector('[data-edit-preview]').click();assert.match(f.view.textContent,/Record the floor/);assert.equal(f.calls.length,0);
});
test('Library Edit creates a draft without modifying the release',async t=>{
 const f=await setup(t);f.record.state='published';f.record.releases=[{pill:structuredClone(f.record.content.pill)}];
 f.dom.reconfigure({url:'http://localhost/studio/p?edit=1'});
 await renderStudio(f.view,'/studio/p',()=>{});
 assert.equal(f.calls[0].url,'/api/studio/p/fork');assert.ok(f.view.querySelector('[name=scope]'));
 assert.equal(f.record.releases[0].pill.scope,'Floor lighting');
});
test('rendered metadata is escaped',()=>{
 const r=fixture();r.content.pill.scope='<script>alert(1)</script>';const dom=new JSDOM(previewMarkup(r));assert.equal(dom.window.document.querySelector('script'),null);dom.window.close();
});
test('draft header matches workspace layout and has no Escalation section',()=>{
 const dom=new JSDOM(previewMarkup(fixture(),true));
 assert.equal(dom.window.document.querySelector('.back-link').getAttribute('href'),'/studio');
 assert.equal(dom.window.document.querySelector('.workspace-heading .badge'),null);
 assert.equal(dom.window.document.querySelector('[data-collection=escalationConditions]'),null);
 assert.equal(dom.window.document.querySelector('.workspace-heading h2').textContent,'Pill Studio');
 assert.ok(dom.window.document.querySelector('.workspace-heading .back-link'));
 assert.equal(dom.window.document.querySelector('[name=name]').value,'Lighting');
 assert.equal(dom.window.document.querySelector('.pill-header'),null);
 assert.match(dom.window.document.body.textContent,/Operating limits/);
 assert.doesNotMatch(dom.window.document.body.textContent,/\(optional\)/);dom.window.close();
});
test('empty operating limits are hidden when reading and available when editing',()=>{
 for(const boundaries of [[],['','  '],undefined]){
  const r=fixture();r.content.pill.boundaries=boundaries;
  const read=new JSDOM(previewMarkup(r));assert.equal(read.window.document.querySelector('[data-collection=boundaries]'),null);read.window.close();
  const edit=new JSDOM(previewMarkup(r,true));assert.ok(edit.window.document.querySelector('[data-collection=boundaries]'));edit.window.close();
 }
 const read=new JSDOM(previewMarkup(fixture()));assert.match(read.window.document.querySelector('[data-collection=boundaries]').textContent,/No repairs/);read.window.close();
});
test('editor aligns add controls with labels and focuses new entries',async t=>{
 const f=await setup(t);renderPillPreview(f.view,f.record,()=>{},{editing:true});
 assert.ok(f.view.querySelector('.pill-draft-editor'));
 assert.ok(f.view.querySelector('[data-collection=actions] .pill-field-heading [data-add=actions]'));
 f.view.querySelector('[data-add=actions]').click();
 const inputs=f.view.querySelectorAll('[data-collection=actions] textarea');
 assert.equal(f.dom.window.document.activeElement,inputs[inputs.length-1]);
 assert.ok(f.view.querySelector('.pill-preview-actions [data-save-preview]'));
});
test('Studio supports search, owner and source without completeness filters',async t=>{
 const f=await setup(t);await renderStudio(f.view,'/studio',()=>{});
 const search=f.view.querySelector('[data-filter-search]'),owner=f.view.querySelector('[data-filter-owner]');
 assert.equal(f.view.querySelector('[data-filter-completeness]'),null);
 assert.ok(f.view.querySelector('[data-filter-source]'));
 search.value='floor';search.dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.view.querySelectorAll('tbody a').length,1);
 owner.value='Admin';owner.dispatchEvent(new f.dom.window.Event('change'));assert.equal(f.view.querySelectorAll('tbody a').length,1);
 search.value='unmatched';search.dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.view.querySelectorAll('tbody a').length,0);
});
