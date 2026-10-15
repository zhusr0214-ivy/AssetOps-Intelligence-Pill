import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {bindStudioFlow} from '../public/studio-flow.js';
import {selectSubview} from '../public/subpages.js';
test('merged Studio keeps teammate subpages and local next-step and candidate review',()=>{
 const dom=new JSDOM('<main><header class="workspace-heading"></header><form id="pill-editor" data-page-panel="draft"></form><div data-page-panel="sources"><section class="capture-panel"><form data-capture-review="d"><h4>Review</h4><article class="capture-candidate"><label class="studio-check"><input type="checkbox" name="accept-0">Rule</label><span class="badge">rule</span><textarea>Evidence</textarea><ul><li>Review required</li></ul></article></form></section></div></main>');
 const root=dom.window.document.querySelector('main');const before=globalThis.document;globalThis.document=dom.window.document;
 try{bindStudioFlow(root,{id:'p',state:'draft',content:{pill:{applicability:{categories:['lift_fault']},rules:[]}},documents:[{status:'extracted'}]},{subpages:true});assert.equal(root.querySelectorAll('.studio-stage').length,0);assert.equal(root.querySelector('.studio-next-step a').getAttribute('href'),'/studio/p?view=draft');assert.equal(selectSubview(root,'?view=sources'),'sources');assert.equal(root.querySelector('#pill-editor').hidden,true);assert.equal(root.querySelector('[data-page-panel="sources"]').hidden,false);assert.ok(root.querySelector('.candidate-evidence'));assert.ok(root.querySelector('.capture-candidate > ul'));}finally{globalThis.document=before;dom.window.close();}
});
