import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderStudio} from '../public/studio.js';
import {canonicalPath} from '../public/routes.js';

test('Studio lists both sources, searches Case experience and filters source with owner',async t=>{
 const dom=new JSDOM('<main></main>',{url:'http://localhost/studio'}),old=globalThis.fetch;
 t.after(()=>{globalThis.fetch=old;dom.window.close();});
 const record={id:'p',state:'draft',content:{pill:{name:'Lighting',owner:'Author',scope:'Office lights',actions:[],rules:[]}}};
 const batch={id:'b',caseId:'c',title:'Floor 12 outage',owner:'Expert',experience:'Record the damaged wiring.',summary:'Update safety limits',status:'in_review',targets:[{name:'Electrical precautions'}]};
 globalThis.fetch=async()=>({ok:true,json:async()=>({records:[record,{...record,id:'legacy',learningImports:[{caseId:'old-case'}]},{...record,id:'released',state:'published'}],improvements:[batch,{...batch,id:'closed',status:'closed'},{...batch,id:'published',status:'published'}]})});
 const root=dom.window.document.querySelector('main');await renderStudio(root,'/studio',()=>{});
 assert.equal(root.querySelectorAll('tbody a').length,3);assert.equal(root.querySelector('a[href="/studio/improvements"]'),null);
 const source=root.querySelector('[data-filter-source]'),search=root.querySelector('[data-filter-search]'),owner=root.querySelector('[data-filter-owner]');
 source.value='Case';source.dispatchEvent(new dom.window.Event('change'));assert.equal(root.querySelectorAll('tbody a').length,2);
 owner.value='Expert';owner.dispatchEvent(new dom.window.Event('change'));assert.equal(root.querySelectorAll('tbody a').length,1);
 search.value='damaged wiring';search.dispatchEvent(new dom.window.Event('input'));assert.ok(root.querySelector('a[href="/studio/improvements/c/b"]'));
 search.value='Electrical precautions';search.dispatchEvent(new dom.window.Event('input'));assert.equal(root.querySelectorAll('tbody a').length,1);
 source.value='Studio';source.dispatchEvent(new dom.window.Event('change'));assert.equal(root.querySelectorAll('tbody a').length,0);assert.match(root.textContent,/No matching items/);
 owner.value='';search.value='';source.dispatchEvent(new dom.window.Event('change'));assert.equal(root.querySelectorAll('tbody a').length,1);
 assert.equal(canonicalPath('/studio/improvements'),'/studio');
});
