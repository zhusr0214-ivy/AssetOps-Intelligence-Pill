export function configureApproval(form, record, user) {
  if (!form) return;
  form.noValidate = true;
  const reason = form.querySelector('[name="notes"]');
  if (reason) reason.closest('label').firstChild.textContent = 'Decision / return reason';
  const evidence = form.querySelector('[name="evaluationNotes"]');
  if (evidence) evidence.closest('label').firstChild.textContent = 'Publication evidence rationale';
  const publish = form.querySelector('[value="publish"]');
  if (publish) {
    const own = record.independentReviewRequired && record.contributorIds?.includes(user?.id);
    publish.disabled = Boolean(own || (record.evaluationRequired && (!record.evaluations?.at(-1)?.passed || record.evaluationGate?.state === 'outdated')));
    if (publish.disabled) { const message=form.ownerDocument.createElement('p');message.className='triage-notice';message.textContent=own ? 'An independent reviewer must publish this draft.' : 'Publishing is unavailable until the current evaluation passes.';publish.before(message); }
  }
}
export function approvalError(form, operation) {
  if (!form.querySelector('[name="notes"]')?.value.trim()) return operation==='return'?'Return not submitted. Enter the changes required.':'Publication was not completed. Enter your review comments.';
  if (operation === 'return') return null;
  const invalid = [...form.querySelectorAll('input, textarea, select')].find(el => !el.checkValidity());
  if (invalid) {
    if(invalid.name==='qualification')return 'Publication was not completed. Enter your professional role or relevant expertise.';
    if(invalid.type==='checkbox')return 'Publication was not completed. Confirm that you checked the sources, test results and operating limits.';
    const label=invalid.closest('label')?.firstChild?.textContent?.trim()||invalid.name||'the required field';
    return `Publication was not completed. Complete: ${label}.`;
  }
  return null;
}
export function applyStudioPermissions(view, user) {
  const roles=user?.roles || [], edit=roles.includes('admin') || roles.includes('expert'), review=roles.includes('admin') || roles.includes('reviewer') || roles.includes('expert');
  if (!edit) {
    view.querySelector('.studio-savebar')?.remove();
    view.querySelectorAll('#upload-source, #manual-source, [data-capture-review]').forEach(form=>form.hidden=true);
    view.querySelectorAll('#pill-editor input, #pill-editor textarea, #pill-editor select, #evaluation-suite input, #evaluation-suite textarea, #evaluation-suite select, #evaluation-options input').forEach(el=>el.disabled=true);
    view.querySelectorAll('#pill-editor button, #evaluation-suite button, [data-analyze], [data-add-test], [data-run-evaluation], [data-operation], [data-source], [data-incorporate] button').forEach(el=>el.hidden=true);
    const notice=view.ownerDocument.createElement('p');notice.className='studio-readonly triage-notice';notice.textContent='Read-only knowledge and test evidence. Draft changes require an expert account.';view.querySelector('.workspace-heading')?.after(notice);
    // The simplified workflow creates its submit button outside the editor.
    view.querySelectorAll('button').forEach(el=>{if(el.matches('[data-confirmation-step]')||el.textContent==='Submit for final review')el.hidden=true;});
  }
  if (!review) {view.querySelector('#pill-approval')?.remove();view.querySelector('#evaluation-review')?.remove();}
}

export function showApprovalError(form,message,operation='publish') {
 if(!form)return;
 let alert=form.querySelector('[data-approval-error]');
 if(!alert){alert=form.ownerDocument.createElement('p');alert.dataset.approvalError='';alert.className='form-error';alert.setAttribute('role','alert');const button=form.querySelector('[value="publish"]');(button?.closest('.actions')||button||form.lastElementChild).before(alert);}
 alert.textContent=message;alert.hidden=false;
 const fields=[...form.querySelectorAll('input,textarea,select')];
 for(const el of fields){el.removeAttribute('aria-invalid');el.removeAttribute('aria-errormessage');}
 const invalid=operation==='return'?form.querySelector('[name="notes"]'):fields.find(el=>!el.checkValidity());
 if(invalid){if(!alert.id)alert.id='publication-submit-error';invalid.setAttribute('aria-invalid','true');invalid.setAttribute('aria-errormessage',alert.id);invalid.focus({preventScroll:true});invalid.scrollIntoView?.({block:'center',behavior:'instant'});}
 else {alert.tabIndex=-1;alert.focus({preventScroll:true});alert.scrollIntoView?.({block:'center'});}
}
