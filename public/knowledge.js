import { api, escapeHtml as e } from './incidents.js';
import { csrfHeaders, currentUser } from './session.js';

export async function uploadSource(record, file) {
  if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Select a nonempty file up to 10 MB.');
  const response = await fetch(`/api/studio/${encodeURIComponent(record.id)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Revision': String(record.revision), ...csrfHeaders() }, body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to upload source.'); return data.record;
}

function experienceFile(form) {
  const experience = form.elements.experience.value.trim();
  if (!experience) return null;
  const expert = form.elements.expert.value.trim() || currentUser()?.name || 'Expert contributor', reference = form.elements.reference.value.trim() || 'Direct expert contribution';
  if (!expert || !reference) throw new Error('Add the contributor and source reference for your manual experience.');
  return new File([`Expert: ${expert}\nReference: ${reference}\n\n${experience}`], 'expert-supplement.txt', { type: 'text/plain' });
}

async function analyzeSource(record, id) {
  return (await api(`/api/studio/${encodeURIComponent(record.id)}/documents/${encodeURIComponent(id)}/analyze`, { method: 'POST', body: JSON.stringify({ revision: record.revision }) })).record;
}

export async function uploadAndExtract(record, file) {
  const previous = new Set((record.documents || []).map(d => d.id));
  const uploaded = await uploadSource(record, file);
  const doc = uploaded.documents.find(d => !previous.has(d.id));
  if (!doc) throw new Error('No new source was returned. Reload the saved draft before retrying.');
  return analyzeSource(uploaded, doc.id);
}

const manualFields = () => '<details class="entry-metadata"><summary>Contributor &amp; source details (optional)</summary><div class="studio-fields"><label>Expert / contributor<input name="expert" maxlength="120"></label><label>Source reference (optional)<input name="reference" maxlength="1000"></label></div></details><label>Tell us how you judge and handle this kind of situation<textarea name="experience" rows="6" maxlength="12000" placeholder="Describe your experience freely. We will extract the conditions and handling, then ask only useful follow-up questions."></textarea></label>';

export async function renderCaptureEntry(view, mode, navigate) {
  const user = currentUser();
  if (!user?.roles?.some(role => ['admin','expert'].includes(role))) { view.innerHTML='<header class="workspace-heading"><h2>Create Pill</h2></header><p>Creating knowledge requires an expert account.</p><a href="/studio">Return to Pill Studio</a>'; return; }
  view.innerHTML = `<header class="workspace-heading"><h2>Create Pill</h2></header><form id="capture-entry" class="pill-create-form" novalidate><label>Pill name<input name="name" maxlength="200" placeholder="For example: Floor lighting failure assessment" required></label><label>Knowledge<textarea name="experience" rows="8" maxlength="12000" placeholder="Enter your knowledge or experience"></textarea></label><input type="file" name="file" aria-label="Upload file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" hidden><div class="file-choice"><button type="button" data-choose-file>Upload file</button><span data-file-name aria-live="polite"></span><button type="button" data-remove-file hidden aria-label="Remove file" title="Remove file">&times;</button></div><p class="form-error" role="alert" hidden></p><p role="status"></p><div class="create-submit"><button type="submit" class="primary">Create Pill</button></div></form>`;
  const form = view.querySelector('form');
  const contributor = user.name || user.username;
  let record, sources, index = 0, documentId, message;
  const chooseFile = form.querySelector('[data-choose-file]'), removeFile = form.querySelector('[data-remove-file]');
  chooseFile.onclick = () => form.elements.file.click();
  const showFile = () => {
    const file = form.elements.file.files[0];
    form.querySelector('[data-file-name]').textContent = file?.name || '';
    removeFile.hidden = !file;
  };
  form.elements.file.onchange = showFile;
  removeFile.onclick = () => { form.elements.file.value = ''; showFile(); };

  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const errorEl = form.querySelector('.form-error'), status = form.querySelector('[role="status"]');
    errorEl.hidden = true;
    try {
      if (!sources) {
        if (!form.elements.name.value.trim()) throw new Error('Enter the Pill name.');
        const file = form.elements.file.files[0];
        message = form.elements.experience.value.trim();
        if (!file && !message) throw new Error('Enter knowledge or upload a reference file.');
        if (message.length > 12000) throw new Error('Keep knowledge within 12,000 characters.');
        if (file && (!file.size || file.size > 10 * 1024 * 1024)) throw new Error('Select a nonempty file up to 10 MB.');
        const writtenSource = message ? new File([`Expert: ${contributor}\nReference: Direct expert contribution\n\n${message}`], 'expert-experience.txt', {type:'text/plain'}) : null;
        sources = [file, writtenSource].filter(Boolean);
      }
      button.disabled = true;
      chooseFile.disabled = true; removeFile.disabled = true;
      form.querySelectorAll('input, textarea').forEach(el => el.disabled = true);
      if (!record) record = (await api('/api/studio', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value.trim(), owner: contributor, domain: 'asset_operations' }) })).record;
      else record = (await api(`/api/studio/${encodeURIComponent(record.id)}`)).record;
      while (index < sources.length) {
        if (!documentId) {
          status.textContent = 'Saving reference file...';
          const previous = new Set((record.documents || []).map(d => d.id));
          record = await uploadSource(record, sources[index]);
          documentId = record.documents.find(d => !previous.has(d.id))?.id;
          if (!documentId) throw new Error('Source response incomplete. Open the saved draft to inspect it.');
        }
        status.textContent = 'Extracting knowledge from reference file...';
        if (!['extracted', 'reviewed'].includes(record.documents.find(d => d.id === documentId)?.status)) record = await analyzeSource(record, documentId);
        index++; documentId = null;
      }
      if (view.isConnected) navigate(`/studio/${encodeURIComponent(record.id)}?view=preview`);
    } catch (error) {
      if (!view.isConnected) return;
      errorEl.textContent = error.message; errorEl.hidden = false; button.disabled = false;
      status.textContent = record ? 'Draft retained. Retry to continue.' : '';
      button.textContent = record ? 'Retry' : 'Create Pill';
      if (!record) {
        sources = null;
        chooseFile.disabled = false; removeFile.disabled = false;
        form.querySelectorAll('input, textarea').forEach(el => el.disabled = false);
      }
    }
  };
}

export function missingKnowledgeMarkup(record) {
  const docs=(record.documents||[]).filter(d=>d.status !== 'reviewed');
  const technical=v=>/^Candidate .*some proposed associations|^Review required: ignored unsupported association/.test(v);
  const affected=docs.flatMap(d=>(d.candidates||[]).filter(c=>(c.missing||[]).some(technical)));
  const gaps=[...new Set(docs.flatMap(d=>[...(d.questions||[]),...(d.conflicts||[]),...(d.candidates||[]).flatMap(c=>(c.missing||[]).map(m=>technical(m)?m:`${c.title}: ${m}`))]).filter(v=>!technical(v)))];
  if(!affected.length&&!gaps.length)return '';
  return `<section class="knowledge-gaps">${affected.length?`<p class="association-summary">${affected.length} candidates have association notices. Check the notice on each affected card.</p>`:''}${gaps.length?`<details><summary>Knowledge questions to review (${gaps.length})</summary><ul>${gaps.map(g=>`<li>${e(g)}</li>`).join('')}</ul></details>`:''}</section>`;
}

function incompleteCaptureMarkup(doc){return doc.captureCompleteness==='partial'?`<div class="capture-incomplete triage-notice" role="status"><strong>${doc.sourceOnly?'Source saved. Extraction is incomplete.':'Draft saved. Some items need attention.'}</strong><p>Review and save the draft. Complete extraction before release.</p><details><summary>Items to resolve</summary><ul>${(doc.captureIssues||[]).map(issue=>`<li>${e(issue)}</li>`).join('')}</ul></details></div>`:'';}

export function captureMarkup(record) {
  const published = record.state === 'published';
  return `<section class="triage-section capture-panel"><h3>Knowledge capture</h3><p>Upload or supplement knowledge, then review selected candidates before merging.</p>${missingKnowledgeMarkup(record)}${!published ? '<form id="upload-source"><label>Add source file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" required></label><p class="muted-label">PDF, DOCX, TXT, Markdown, PNG or JPEG; up to 10 MB.</p><button type="submit">Upload and extract with AI</button></form>' : ''}${!published ? `<details class="manual-source" ><summary>Complete missing information / add expert experience</summary><form id="manual-source">${manualFields()}<button type="submit">Save supplement and extract with AI</button></form></details>` : ''}${(record.documents || []).map(doc => `<details class="capture-document" ${doc.status === 'ready' || doc.status === 'extracted' || doc.status === 'failed' ? 'open' : ''}><summary>${e(doc.name)} <span class="badge">${e(doc.isRunning ? 'Analyzing...' : doc.status === 'analyzing' ? 'Extraction interrupted' : doc.status)}</span></summary><p><a download href="/api/studio/${e(record.id)}/documents/${e(doc.id)}/file">Download original</a></p>${(doc.warnings || []).map(w => `<p class="triage-notice">${e(w)}</p>`).join('')}<details><summary>Extracted source text (${doc.blocks.length} sections)</summary>${doc.blocks.map(block => `<article><strong>${e(block.location)} / ${e(block.id)}</strong><p class="source-text">${e(block.text)}</p></article>`).join('')}</details>${doc.status!=='extracted'?incompleteCaptureMarkup(doc):''}${doc.status==='failed'&&doc.partialCandidates?.length?`<details class="capture-partial"><summary>${doc.partialCandidates.length} supported proposals retained · extraction incomplete</summary><p>These proposals are saved for the next retry. Complete the missing knowledge before confirming this source.</p>${doc.partialCandidates.map(c=>`<article><strong>${e(c.title)}</strong><p>${e(c.text)}</p>${c.evidence.map(ref=>`<blockquote>${e(ref.quote)}</blockquote>`).join('')}</article>`).join('')}</details>`:''}${doc.error ? published ? `<p class="triage-notice">Historical extraction failure: ${e(doc.error)} This attempt does not change the published version. Retest in a new draft.</p>` : `<p class="form-error" role="alert">${e(doc.error)}</p>` : ''}${!published && !['extracted', 'reviewed'].includes(doc.status) ? `<button type="button" class="primary capture-analyze" data-analyze="${e(doc.id)}" ${doc.isRunning ? 'disabled' : ''}>${doc.isRunning ? 'Analyzing...' : doc.status === 'ready' ? 'Analyze with Knowledge Capture Agent' : 'Retry extraction'}</button>` : ''}${doc.isRunning ? '<button type="button" data-refresh-capture>Refresh extraction status</button>' : ''}${doc.status === 'extracted' && !published ? `<button type="button" data-analyze="${e(doc.id)}" data-reextract="true">${doc.captureCompleteness==='partial'?'Continue extraction':'Re-extract unconfirmed knowledge'}</button><p class="muted-label">Generate new candidates from the same source. Previous extraction is retained; unsaved candidate edits are not carried forward.</p>${candidateForm(doc)}` : ''}${doc.status === 'reviewed' && !published ? `<button type="button" data-analyze="${e(doc.id)}" data-reextract="true">${doc.captureCompleteness==='partial'?'Continue extraction':'Check original source for omissions'}</button><p class="muted-label">Prepare a new proposal from this source. Confirmed knowledge stays in the draft until you review and save changes.</p>` : ''}${doc.status === 'reviewed' ? `<p>Reviewed by ${e(doc.review.reviewer)} / ${e(doc.review.reviewedAt)}</p><details><summary>Capture decisions</summary>${doc.review.decisions.map(c => `<article><span class="badge">${e(c.decision)}</span><p>${e(c.reviewedText || c.originalText)}</p>${(c.existingRuleIds?.length||c.existingActionIds?.length)?`<p>Linked to reviewed knowledge: ${[...(c.existingRuleIds||[]),...(c.existingActionIds||[])].map(id=>e(doc.repairTargets?.find(t=>t.id===id)?.title||id)).join(', ')}</p>`:''}${c.owner?`<p>Responsible role from source: ${e(c.owner)}</p>`:''}${c.evidence.map(ref => `<blockquote>${e(ref.location)}: ${e(ref.quote)}</blockquote>`).join('')}</article>`).join('')}</details>` : ''}</details>`).join('') || '<p class="empty-state">No uploaded knowledge sources.</p>'}</section>`;
}

function candidateForm(doc) {
  const titles = new Map(doc.candidates.map(c => [c.id, c.title]));
  return `<form data-capture-review="${e(doc.id)}"><h4>${doc.repairReview ? 'Review source corrections' : 'Review extracted knowledge'}</h4>${incompleteCaptureMarkup(doc)}${doc.repairReview ? '<p>Compare these proposals with the saved knowledge. Choose whether each proposal adds knowledge or updates an existing item. Updates preserve the item identifier; the previous review remains in history. Omitted items remain unchanged.</p>' : ''}<div class="capture-bulk-selection"><label class="studio-check"><input type="checkbox" data-select-all>Select all knowledge</label></div>${doc.candidates.length ? '' : `<p>${doc.unchangedKnowledge?.length?'This source repeats reviewed knowledge; no new changes need confirmation.':'No reusable knowledge was extracted for this domain.'}</p>`}${doc.comparisonWarning?`<p class="triage-notice" role="status">${e(doc.comparisonWarning)}</p>`:''}${doc.unchangedKnowledge?.length?`<details class="capture-unchanged"><summary>Already covered by reviewed knowledge (${doc.unchangedKnowledge.length})</summary>${doc.unchangedKnowledge.map(item=>`<article><strong>${e(item.candidate.title)}</strong><p>${e(item.reason)}</p></article>`).join('')}</details>`:''}<ul>${[...(doc.questions || []), ...(doc.conflicts || [])].map(v => `<li>${e(v)}</li>`).join('')}</ul>${doc.candidates.map((c, index) => `<article class="capture-candidate"><header class="candidate-heading"><label class="studio-check"><input type="checkbox" name="accept-${index}">${e(c.title)}</label><span class="badge">${e(c.type)}</span></header>${c.change?`<p class="triage-notice">${c.change==='review'?'Check existing coverage':c.change==='update'?'Update existing knowledge':'New knowledge'}: ${e(c.changeReason)}</p>`:''}${c.change==='update'?`<div class="candidate-before"><strong>Before</strong><p>${e(doc.repairTargets?.find(t=>t.id===c.replacementTargetId)?.text||'')}</p></div>`:''}<label>${c.change==='update'?'After':'Proposed knowledge'}<textarea name="text-${index}" rows="3" maxlength="2000">${e(c.text)}</textarea></label>${doc.repairTargets?.some(t=>t.type===c.type) ? `<label class="candidate-update-choice">Save this proposal as<select name="replace-${index}"><option value="">New knowledge</option>${doc.repairTargets.filter(t=>t.type===c.type).map(t=>`<option value="${e(t.id)}" ${c.replacementTargetId===t.id?'selected':''}>Update: ${e(t.title)}</option>`).join('')}</select></label><details class="candidate-previous"><summary>Existing knowledge for comparison</summary>${doc.repairTargets.filter(t=>t.type===c.type).map(t=>`<article><strong>${e(t.title)}</strong><p>${e(t.text)}</p></article>`).join('')}</details>` : ''}${(c.existingRuleIds?.length||c.existingActionIds?.length)?`<p>Linked to reviewed knowledge: ${[...(c.existingRuleIds||[]),...(c.existingActionIds||[])].map(id=>e(doc.repairTargets?.find(t=>t.id===id)?.title||id)).join(', ')}</p>`:''}${c.owner?`<p>Responsible role from source: ${e(c.owner)}</p>`:''}${c.evidence.map(ref => `<blockquote><strong>${e(ref.location)} / ${e(ref.blockId)}</strong><br>${e(ref.quote)}</blockquote>`).join('')}${c.relatedRuleIds.length || c.relatedActionIds.length ? `<p>Related candidates: ${[...c.relatedRuleIds, ...c.relatedActionIds].map(id => e(titles.get(id) || id)).join(', ')}</p>` : ''}${c.missing.length ? `<ul>${c.missing.map(v => `<li>${e(v)}</li>`).join('')}</ul>` : ''}</article>`).join('')}${doc.expertFeedbackIds?.length?'<label class="studio-check"><input name="feedbackConfirmed" type="checkbox" required>I checked how the example correction is reflected in the selected conditions and actions.</label>':''}<label>Responsible role for selected actions (optional)<input name="actionOwner" maxlength="120" placeholder="Leave blank if not yet confirmed"></label><p>Unknown roles can stay unconfirmed while saving and testing. Leave blank to save as unconfirmed. The reviewer is recorded separately and is not assigned this action. Roles stated in the source are retained.</p><label ${doc.captureCompleteness==='partial'?'hidden':''}>Reviewer name (signed-in)<input name="reviewer" maxlength="120" ${doc.captureCompleteness==='partial'?'':'required'}></label><label class="studio-check" ${doc.captureCompleteness==='partial'?'hidden':''}><input name="confirmed" type="checkbox" ${doc.captureCompleteness==='partial'?'':'required'}>I checked the selected knowledge against the source, including conditions, missing information and conflicts.</label><p>${doc.captureCompleteness==='partial'?'Save edits now; complete extraction before confirming.':'Selected items join the draft. Unselected items are discarded from this extraction.'}</p><button type="submit" class="primary">${doc.captureCompleteness==='partial'?'Save review draft':'Save &amp; continue to Test'}</button></form>`;
}

export function bindCapture(view, record, perform, saveCandidateDraft) {
  view.querySelector('#manual-source')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    perform(async current => {
      const file = experienceFile(form);
      if (!file) throw new Error('Enter the missing information or expert experience.');
      return uploadAndExtract(current || record, file);
    }, 'Saving and extracting expert supplement...');
  });
  view.querySelector('#upload-source')?.addEventListener('submit', event => { event.preventDefault(); perform(current => uploadAndExtract(current || record, event.target.elements.file.files[0]), 'Parsing and extracting source...'); });
  view.querySelectorAll('[data-analyze]').forEach(button => button.onclick = () => perform(async current => (await api(`/api/studio/${record.id}/documents/${button.dataset.analyze}/analyze`, { method: 'POST', body: JSON.stringify({ revision: (current || record).revision, reextract: button.dataset.reextract === 'true' }) })).record, 'Extracting knowledge with AI...'));
  view.querySelectorAll('[data-refresh-capture]').forEach(button => button.onclick = () => perform(async () => (await api(`/api/studio/${record.id}`)).record, 'Refreshing extraction...'));
  view.querySelectorAll('[data-select-all]').forEach(toggle => {
    const form=toggle.closest('[data-capture-review]');
    const inputs=[...form.querySelectorAll('input[name^="accept-"]')];
    const update=()=>{const selected=inputs.filter(i=>i.checked).length;toggle.checked=inputs.length>0&&selected===inputs.length;toggle.indeterminate=selected>0&&selected<inputs.length;};
    toggle.onchange=()=>{inputs.forEach(i=>i.checked=toggle.checked);form.dispatchEvent(new form.ownerDocument.defaultView.Event('change',{bubbles:true}));};
    form.addEventListener('change',update);update();
  });
  const pending=[];
  view.querySelectorAll('[data-capture-review]').forEach(form => {
    const doc=record.documents.find(d=>d.id===form.dataset.captureReview);
    const saved=doc.reviewDraft;
    saved?.items?.forEach(item=>{const index=doc.candidates.findIndex(c=>c.id===item.id);if(index>=0){form.elements[`text-${index}`].value=item.text;form.elements[`accept-${index}`].checked=item.selected;if(form.elements[`replace-${index}`])form.elements[`replace-${index}`].value=item.replaceId||'';}});
    if(saved)form.elements.actionOwner.value=saved.actionOwner;
    form.dispatchEvent(new form.ownerDocument.defaultView.Event('change',{bubbles:true}));
    let timer,dirty=false,active=null;
    const status=()=>form.querySelector('[data-candidate-save-status]');
    const payload=()=>({actionOwner:form.elements.actionOwner.value,items:doc.candidates.map((c,i)=>({id:c.id,text:form.elements[`text-${i}`].value,selected:form.elements[`accept-${i}`].checked,replaceId:form.elements[`replace-${i}`]?.value||''}))});
    const flush=async()=>{
      clearTimeout(timer);if(active)await active;if(!dirty || !form.isConnected || !saveCandidateDraft)return;
      dirty=false;const el=status();if(el)el.textContent='Saving knowledge edits…';
      active=(async()=>{try{const updated=await saveCandidateDraft(doc.id,payload());Object.assign(record,updated);if(el)el.textContent=dirty?'Unsaved knowledge edits':'Knowledge edits saved';const errorEl=view.querySelector('#studio-error');if(errorEl?.dataset.candidateSaveError){errorEl.hidden=true;delete errorEl.dataset.candidateSaveError;}form.querySelector('[data-retry-candidates]')?.setAttribute('hidden','');}catch(error){dirty=true;if(el)el.textContent=`Save failed: ${error.message}`;const errorEl=view.querySelector('#studio-error');if(errorEl){errorEl.dataset.candidateSaveError='true';errorEl.textContent=`Knowledge edits could not be saved: ${error.message} Your edits remain in this page. Use Save & continue to Test to retry.`;errorEl.hidden=false;}form.querySelector('[data-retry-candidates]')?.removeAttribute('hidden');throw error;}})();
      try{await active;}finally{active=null;}
      if(dirty)await flush();
    };
    const changed=event=>{if(event.target.name==='confirmed')return;dirty=true;if(status())status().textContent='Unsaved knowledge edits';clearTimeout(timer);timer=setTimeout(()=>flush().catch(()=>{}),800);};
    form.addEventListener('input',changed);form.addEventListener('change',changed);pending.push(flush);
    form.addEventListener('click',event=>{if(event.target.closest('[data-retry-candidates]'))flush().catch(()=>{});});
  });
  view.querySelectorAll('[data-capture-review]').forEach(form => form.onsubmit = async event => {
    event.preventDefault();try{for(const flush of pending)await flush();}catch{return;} const doc = record.documents.find(d => d.id === form.dataset.captureReview);
    if(doc.captureCompleteness==='partial'){
      if(saveCandidateDraft)perform(async()=>saveCandidateDraft(doc.id,{actionOwner:form.elements.actionOwner.value,items:doc.candidates.map((c,index)=>({id:c.id,text:form.elements[`text-${index}`].value,selected:form.elements[`accept-${index}`].checked,replaceId:form.elements[`replace-${index}`]?.value||''}))}),'Saving extraction draft…','draft');
      return;
    }
    const body = { feedbackConfirmed:form.elements.feedbackConfirmed?.checked===true, actionOwner:form.elements.actionOwner.value.trim(), revision: record.revision, reviewer: form.elements.reviewer.value, confirmed: form.elements.confirmed.checked, selections: doc.candidates.flatMap((c, index) => form.elements[`accept-${index}`].checked ? [{ id: c.id, text: form.elements[`text-${index}`].value,replaceId:form.elements[`replace-${index}`]?.value||'' }] : []) };
    perform(async current => (await api(`/api/studio/${record.id}/documents/${doc.id}/merge`, { method: 'POST', body: JSON.stringify({...body,revision:(current || record).revision}) })).record, 'Saving capture decisions...', doc.captureCompleteness==='partial'?'draft':'evaluation');
  });
  return async()=>{for(const flush of pending)await flush();};
}
