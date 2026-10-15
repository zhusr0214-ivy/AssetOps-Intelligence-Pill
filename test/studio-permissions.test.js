import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {configureApproval,approvalError,showApprovalError,applyStudioPermissions} from '../public/studio-permissions.js';
test('return only needs reason, publication needs evidence and failed evaluation disables publish',t=>{
 const dom=new JSDOM('<form><label>Evidence<textarea name="evaluationNotes" required></textarea></label><label>Reason<textarea name="notes" required>Needs correction</textarea></label><button value="publish">Publish</button><button value="return">Return</button></form>');t.after(()=>dom.window.close());const form=dom.window.document.querySelector('form');
 configureApproval(form,{evaluationRequired:true,evaluations:[{passed:false}]},{id:'reviewer'});assert.equal(form.noValidate,true);assert.equal(form.querySelector('[value=publish]').disabled,true);assert.equal(approvalError(form,'return'),null);assert.ok(approvalError(form,'publish'));form.querySelector('[name=notes]').value=' ';assert.ok(approvalError(form,'return'));
});
test('reviewer and viewer have read-only draft controls, only reviewer keeps approval',t=>{
 for(const role of ['reviewer','viewer']){const dom=new JSDOM('<main><header class="workspace-heading"></header><aside class="studio-savebar"></aside><form id="upload-source"></form><form id="pill-editor"><input><button>Save</button></form><button data-add-test>Add</button><form id="pill-approval"></form></main>');t.after(()=>dom.window.close());const view=dom.window.document.querySelector('main');applyStudioPermissions(view,{roles:[role]});assert.equal(view.querySelector('.studio-savebar'),null);assert.equal(view.querySelector('#upload-source').hidden,true);assert.equal(view.querySelector('#pill-editor input').disabled,true);assert.equal(view.querySelector('[data-add-test]').hidden,true);assert.equal(Boolean(view.querySelector('#pill-approval')),role==='reviewer');}
});

test('publication failure names the missing role and focuses that field next to visible feedback',t=>{
 const dom=new JSDOM('<form><label>Professional role<textarea name="qualification" required></textarea></label><label>Comments<textarea name="notes" required>Reviewed</textarea></label><div class="actions"><button value="publish">Publish</button></div></form>');t.after(()=>dom.window.close());const form=dom.window.document.querySelector('form');
 const message=approvalError(form,'publish');assert.match(message,/Publication was not completed/);assert.match(message,/professional role/);showApprovalError(form,message);const field=form.querySelector('[name=qualification]');assert.equal(dom.window.document.activeElement,field);assert.equal(field.getAttribute('aria-invalid'),'true');assert.equal(form.querySelector('[role=alert]').textContent,message);
});
