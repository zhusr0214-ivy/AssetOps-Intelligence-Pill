import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {prioritizeReview} from '../public/make-simple.js';
import {missingKnowledgeMarkup} from '../public/knowledge.js';
test('review prioritizes editable knowledge and collapses ancillary material without losing confirmation',()=>{
 const dom=new JSDOM('<main><section class="capture-panel"><h3>Capture</h3><p>Hint</p><section class="knowledge-gaps"></section><form id="upload-source"></form><details><summary>Source</summary><form data-capture-review="d"><h4>Review</h4><p class="capture-selection-status">0 selected</p><article class="capture-candidate"><label>Keep<input name="accept-0" type="checkbox"></label><textarea name="text-0">Knowledge</textarea></article><label>Role<input name="actionOwner"></label><label>Reviewer<input name="reviewer"></label><label><input type="checkbox" name="confirmed">Confirmed</label><button type="submit">Confirm</button></form><details><summary>Original</summary></details></details></section></main>');
 const before=globalThis.document;globalThis.document=dom.window.document;
 try{const root=dom.window.document.querySelector('main');prioritizeReview(root);assert.ok(root.querySelector('.capture-review-priority textarea'));assert.equal(root.querySelector('.capture-reference-extras').open,false);assert.ok(root.querySelector('.capture-reference-extras #upload-source'));assert.ok(root.querySelector('.capture-review-footer [name=confirmed]'));assert.ok(root.querySelector('.capture-review-context [name=actionOwner]'));assert.equal(root.querySelector('.capture-review-footer [name=actionOwner]'),null);}finally{globalThis.document=before;dom.window.close();}
});
test('association warnings are counted once and kept apart from business questions',()=>{
 const html=missingKnowledgeMarkup({documents:[{questions:['Candidate r: some proposed associations were rejected; verify links before merging.','What is the responsible role?'],candidates:[{title:'Rule',missing:['Review required: ignored unsupported association missing (not present).']}]}]});
 assert.match(html,/1 candidates have association notices/);assert.match(html,/What is the responsible role/);assert.ok(!html.includes('unsupported association missing'));
});
