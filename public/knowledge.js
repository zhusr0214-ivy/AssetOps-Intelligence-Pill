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
  view.innerHTML = `<header class="workspace-heading"><h2>Create Pill</h2></header><section class="pill-create-intro"><p>Turn reference material or expert experience into a reviewed knowledge package.</p><ol class="pill-journey"><li><strong>1 · Prepare knowledge</strong></li><li>2 · Validate recommendations</li><li>3 · Review &amp; release</li></ol></section><form id="capture-entry" class="pill-create-form" novalidate><div class="studio-fields"><label>Pill name<input name="name" maxlength="200" placeholder="For example: Lift initial assessment" required></label><label>Professional domain<select name="domain"><option value="ahu_cooling">HVAC cooling</option><option value="hvac_local_comfort">Indoor comfort</option><option value="energy">Energy</option><option value="electrical_distribution">Electrical distribution</option><option value="water_leak">Water leaks</option><option value="lift_fault">Lift faults</option><option value="asset_operations">General asset operations</option></select></label></div><fieldset class="source-choice"><legend>Knowledge source</legend><label><input type="radio" name="sourceMode" value="file" checked>Upload reference material</label><label><input type="radio" name="sourceMode" value="experience">Enter expert experience</label></fieldset><div data-entry-file><label>Reference file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" hidden></label><div class="file-choice"><button type="button" data-choose-file>Choose reference file</button><span data-file-name>No file selected</span></div><p class="muted-label">PDF, DOCX, TXT, Markdown or image · up to 10 MB</p></div><div data-entry-experience hidden>${manualFields()}</div><details class="entry-metadata"><summary>Owner &amp; source details</summary><label>Knowledge owner<input name="owner" maxlength="120" value="${e(user.name || user.username)}" required></label><p>The signed-in contributor is recorded. You can change the owner before generating the draft.</p></details><p class="form-error" role="alert" hidden></p><p role="status"></p><a data-open-draft hidden>Open saved draft to review knowledge</a><div class="create-submit"><p>Next: review the extracted knowledge and its evidence. Nothing is published automatically.</p><button type="submit" class="primary">Generate knowledge draft</button></div></form>`;
  const form = view.querySelector('form'); let record, sources, index = 0, documentId;
  const related=view.ownerDocument.createElement('section');related.className='expert-create-related';related.innerHTML='<button type="button" data-find-related>Find existing knowledge in this domain</button><div data-related-results aria-live="polite"></div>';form.querySelector('.source-choice').before(related);
  related.querySelector('button').onclick=async()=>{
    const result=related.querySelector('[data-related-results]');result.textContent='Finding related knowledge…';
    try{const {records=[]}=await api('/api/studio');const domain=form.elements.domain.value;const items=records.filter(r=>r.content?.pill?.domain===domain);result.innerHTML=items.length?'<p>Consider adding your experience to one of these capabilities:</p>'+items.map(r=>`<p><a href="/studio/${encodeURIComponent(r.id)}?view=draft">${e(r.content.pill.name)}</a> · ${e(r.state)}</p>`).join(''):'No capability exists in this domain yet. You can start one below.';}catch(error){result.textContent=error.message;}
  };
  form.elements.expert.value = user.name || user.username;
  form.querySelector('[data-choose-file]').onclick=()=>form.elements.file.click();
  form.elements.file.onchange=()=>{form.querySelector('[data-file-name]').textContent=form.elements.file.files[0]?.name || 'No file selected';};
  form.elements.name.addEventListener('blur',()=>{if(form.elements.name.value.trim())related.querySelector('button').click();});
  form.elements.domain.addEventListener('change',()=>related.querySelector('button').click());
  const changeSource = () => { const manual=form.elements.sourceMode.value === 'experience'; form.querySelector('[type=submit]').textContent=manual?'Discuss this experience':'Generate knowledge draft'; form.querySelector('[data-entry-file]').hidden=manual; form.querySelector('[data-entry-experience]').hidden=!manual; };
  form.querySelectorAll('[name="sourceMode"]').forEach(input=>input.addEventListener('change',changeSource));

  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
    const errorEl = form.querySelector('.form-error'), status = form.querySelector('[role="status"]'); errorEl.hidden = true;
    try {
      if (!sources) {
        if (!form.elements.name.value.trim()) throw new Error('Enter the Pill name.');
        if (!form.elements.owner.value.trim()) {form.querySelector('.entry-metadata').open=true;throw new Error('Enter a knowledge owner.');}
        const manualMode=form.elements.sourceMode.value === 'experience';
        const file = manualMode ? null : form.elements.file.files[0], manual = manualMode ? experienceFile(form) : null;
        if (!file && !manual) { throw new Error(manualMode ? 'Enter the expert experience to prepare a draft.' : 'Choose a reference file to generate the draft.'); }
        sources = [file, manual].filter(Boolean);
        if (sources.some(file => !file.size || file.size > 10 * 1024 * 1024)) { sources = null; throw new Error('Select a nonempty file up to 10 MB.'); }
      }
      button.disabled = true; form.querySelectorAll('input, textarea, select').forEach(el => el.disabled = true);
      if (!record) record = (await api('/api/studio', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, owner: form.elements.owner.value, domain: form.elements.domain.value }) })).record;
      else record = (await api(`/api/studio/${encodeURIComponent(record.id)}`)).record;
      const link = form.querySelector('[data-open-draft]'); link.href = `/studio/${encodeURIComponent(record.id)}?view=draft`; link.hidden = false;
      if(form.elements.sourceMode.value==='experience'){
        const message=form.elements.experience.value.trim();
        status.textContent='Organizing your experience and preparing a useful follow-up…';
        const dialogue=record.expertDialogue;
        if(!dialogue||dialogue.status==='failed'||dialogue.messages?.at(-1)?.text!==message){
          record=(await api(`/api/studio/${encodeURIComponent(record.id)}/expert/message`,{method:'POST',body:JSON.stringify({revision:record.revision,...(dialogue?.status==='failed'?{kind:'retry'}:{message,sourceReference:form.elements.reference.value,expertName:form.elements.expert.value})})})).record;
        }
        if(view.isConnected)navigate(`/studio/${encodeURIComponent(record.id)}?view=draft`);
        return;
      }
      while (index < sources.length) {
        if (!documentId) {
          status.textContent = `Saving source ${index + 1} of ${sources.length}...`;
          const previous = new Set((record.documents || []).map(d => d.id));
          record = await uploadSource(record, sources[index]);
          documentId = record.documents.find(d => !previous.has(d.id))?.id;
          if (!documentId) throw new Error('Source response incomplete. Open the saved draft to inspect it.');
        }
        status.textContent = `Extracting knowledge from source ${index + 1} of ${sources.length}...`;
        if (!['extracted', 'reviewed'].includes(record.documents.find(d => d.id === documentId)?.status)) record = await analyzeSource(record, documentId);
        index++; documentId = null;
      }
      if (view.isConnected) navigate(`/studio/${encodeURIComponent(record.id)}?view=draft`);
    } catch (error) {
      if (!view.isConnected) return;
      errorEl.textContent = error.message; errorEl.hidden = false; button.disabled = false;
      status.textContent = record ? 'Draft retained. Retry extraction or inspect the saved sources.' : '';
      button.textContent = record ? 'Retry remaining extraction' : 'Generate knowledge draft';
      if (!record) { sources = null; form.querySelectorAll('input, textarea, select').forEach(el => el.disabled = false); }
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

function incompleteCaptureMarkup(doc){return doc.captureCompleteness==='partial'?`<div class="capture-incomplete triage-notice" role="status"><strong>${doc.sourceOnly?'原文已保留，AI 尚未完成整理':'已保留可核对的提取草稿，仍有待补全项'}</strong><p>可以先查看和保存草稿；完成整理与审核前不能发布。</p><details><summary>查看待处理问题</summary><ul>${(doc.captureIssues||[]).map(issue=>`<li>${e(issue)}</li>`).join('')}</ul></details></div>`:'';}

export function captureMarkup(record) {
  const published = record.state === 'published';
  return `<section class="triage-section capture-panel"><h3>Knowledge capture</h3><p>Upload or supplement knowledge, then review selected candidates before merging.</p>${missingKnowledgeMarkup(record)}${!published ? '<form id="upload-source"><label>Add source file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" required></label><p class="muted-label">PDF, DOCX, TXT, Markdown, PNG or JPEG; up to 10 MB.</p><button type="submit">Upload and extract with AI</button></form>' : ''}${!published ? `<details class="manual-source" ><summary>Complete missing information / add expert experience</summary><form id="manual-source">${manualFields()}<button type="submit">Save supplement and extract with AI</button></form></details>` : ''}${(record.documents || []).map(doc => `<details class="capture-document" ${doc.status === 'ready' || doc.status === 'extracted' || doc.status === 'failed' ? 'open' : ''}><summary>${e(doc.name)} <span class="badge">${e(doc.isRunning ? 'Analyzing...' : doc.status === 'analyzing' ? 'Extraction interrupted' : doc.status)}</span></summary><p><a download href="/api/studio/${e(record.id)}/documents/${e(doc.id)}/file">Download original</a></p>${(doc.warnings || []).map(w => `<p class="triage-notice">${e(w)}</p>`).join('')}<details><summary>Extracted source text (${doc.blocks.length} sections)</summary>${doc.blocks.map(block => `<article><strong>${e(block.location)} / ${e(block.id)}</strong><p class="source-text">${e(block.text)}</p></article>`).join('')}</details>${doc.status!=='extracted'?incompleteCaptureMarkup(doc):''}${doc.status==='failed'&&doc.partialCandidates?.length?`<details class="capture-partial"><summary>${doc.partialCandidates.length} supported proposals retained · extraction incomplete</summary><p>These proposals are saved for the next retry. Complete the missing knowledge before confirming this source.</p>${doc.partialCandidates.map(c=>`<article><strong>${e(c.title)}</strong><p>${e(c.text)}</p>${c.evidence.map(ref=>`<blockquote>${e(ref.quote)}</blockquote>`).join('')}</article>`).join('')}</details>`:''}${doc.error ? published ? `<p class="triage-notice">Historical extraction failure: ${e(doc.error)} This attempt does not change the published version. Retest in a new draft.</p>` : `<p class="form-error" role="alert">${e(doc.error)}</p>` : ''}${!published && !['extracted', 'reviewed'].includes(doc.status) ? `<button type="button" class="primary capture-analyze" data-analyze="${e(doc.id)}" ${doc.isRunning ? 'disabled' : ''}>${doc.isRunning ? 'Analyzing...' : doc.status === 'ready' ? 'Analyze with Knowledge Capture Agent' : 'Retry extraction'}</button>` : ''}${doc.isRunning ? '<button type="button" data-refresh-capture>Refresh extraction status</button>' : ''}${doc.status === 'extracted' && !published ? `<button type="button" data-analyze="${e(doc.id)}" data-reextract="true">${doc.captureCompleteness==='partial'?'继续整理已保存内容':'Re-extract unconfirmed knowledge'}</button><p class="muted-label">Generate new candidates from the same source. Previous extraction is retained; unsaved candidate edits are not carried forward.</p>${candidateForm(doc)}` : ''}${doc.status === 'reviewed' && !published ? `<button type="button" data-analyze="${e(doc.id)}" data-reextract="true">${doc.captureCompleteness==='partial'?'继续整理已保存内容':'Check original source for omissions'}</button><p class="muted-label">Prepare a new proposal from this source. Confirmed knowledge stays in the draft until you review and save changes.</p>` : ''}${doc.status === 'reviewed' ? `<p>Reviewed by ${e(doc.review.reviewer)} / ${e(doc.review.reviewedAt)}</p><details><summary>Capture decisions</summary>${doc.review.decisions.map(c => `<article><span class="badge">${e(c.decision)}</span><p>${e(c.reviewedText || c.originalText)}</p>${(c.existingRuleIds?.length||c.existingActionIds?.length)?`<p>Linked to reviewed knowledge: ${[...(c.existingRuleIds||[]),...(c.existingActionIds||[])].map(id=>e(doc.repairTargets?.find(t=>t.id===id)?.title||id)).join(', ')}</p>`:''}${c.owner?`<p>Responsible role from source: ${e(c.owner)}</p>`:''}${c.evidence.map(ref => `<blockquote>${e(ref.location)}: ${e(ref.quote)}</blockquote>`).join('')}</article>`).join('')}</details>` : ''}</details>`).join('') || '<p class="empty-state">No uploaded knowledge sources.</p>'}</section>`;
}

function candidateForm(doc) {
  const titles = new Map(doc.candidates.map(c => [c.id, c.title]));
  return `<form data-capture-review="${e(doc.id)}"><h4>${doc.repairReview ? 'Review source corrections' : 'Review extracted knowledge'}</h4>${incompleteCaptureMarkup(doc)}${doc.repairReview ? '<p>Compare these proposals with the saved knowledge. Choose whether each proposal adds knowledge or updates an existing item. Updates preserve the item identifier; the previous review remains in history. Omitted items remain unchanged.</p>' : ''}<div class="capture-bulk-selection"><label class="studio-check"><input type="checkbox" data-select-all>Select all knowledge</label></div>${doc.candidates.length ? '' : `<p>${doc.unchangedKnowledge?.length?'This source repeats reviewed knowledge; no new changes need confirmation.':'No reusable knowledge was extracted for this domain.'}</p>`}${doc.comparisonWarning?`<p class="triage-notice" role="status">${e(doc.comparisonWarning)}</p>`:''}${doc.unchangedKnowledge?.length?`<details class="capture-unchanged"><summary>Already covered by reviewed knowledge (${doc.unchangedKnowledge.length})</summary>${doc.unchangedKnowledge.map(item=>`<article><strong>${e(item.candidate.title)}</strong><p>${e(item.reason)}</p></article>`).join('')}</details>`:''}<ul>${[...(doc.questions || []), ...(doc.conflicts || [])].map(v => `<li>${e(v)}</li>`).join('')}</ul>${doc.candidates.map((c, index) => `<article class="capture-candidate"><header class="candidate-heading"><label class="studio-check"><input type="checkbox" name="accept-${index}">${e(c.title)}</label><span class="badge">${e(c.type)}</span></header>${c.change?`<p class="triage-notice">${c.change==='review'?'待核对是否已有覆盖':c.change==='update'?'Update existing knowledge':'New knowledge'}: ${e(c.changeReason)}</p>`:''}${c.change==='update'?`<div class="candidate-before"><strong>Before</strong><p>${e(doc.repairTargets?.find(t=>t.id===c.replacementTargetId)?.text||'')}</p></div>`:''}<label>${c.change==='update'?'After':'Proposed knowledge'}<textarea name="text-${index}" rows="3" maxlength="2000">${e(c.text)}</textarea></label>${doc.repairTargets?.some(t=>t.type===c.type) ? `<label class="candidate-update-choice">Save this proposal as<select name="replace-${index}"><option value="">New knowledge</option>${doc.repairTargets.filter(t=>t.type===c.type).map(t=>`<option value="${e(t.id)}" ${c.replacementTargetId===t.id?'selected':''}>Update: ${e(t.title)}</option>`).join('')}</select></label><details class="candidate-previous"><summary>Existing knowledge for comparison</summary>${doc.repairTargets.filter(t=>t.type===c.type).map(t=>`<article><strong>${e(t.title)}</strong><p>${e(t.text)}</p></article>`).join('')}</details>` : ''}${(c.existingRuleIds?.length||c.existingActionIds?.length)?`<p>Linked to reviewed knowledge: ${[...(c.existingRuleIds||[]),...(c.existingActionIds||[])].map(id=>e(doc.repairTargets?.find(t=>t.id===id)?.title||id)).join(', ')}</p>`:''}${c.owner?`<p>Responsible role from source: ${e(c.owner)}</p>`:''}${c.evidence.map(ref => `<blockquote><strong>${e(ref.location)} / ${e(ref.blockId)}</strong><br>${e(ref.quote)}</blockquote>`).join('')}${c.relatedRuleIds.length || c.relatedActionIds.length ? `<p>Related candidates: ${[...c.relatedRuleIds, ...c.relatedActionIds].map(id => e(titles.get(id) || id)).join(', ')}</p>` : ''}${c.missing.length ? `<ul>${c.missing.map(v => `<li>${e(v)}</li>`).join('')}</ul>` : ''}</article>`).join('')}${doc.expertFeedbackIds?.length?'<label class="studio-check"><input name="feedbackConfirmed" type="checkbox" required>I checked how the example correction is reflected in the selected conditions and actions.</label>':''}<label>Responsible role for selected actions (optional)<input name="actionOwner" maxlength="120" placeholder="Leave blank if not yet confirmed"></label><p>Unknown roles can stay unconfirmed while saving and testing. Leave blank to save as 待确认. The reviewer is recorded separately and is not assigned this action. Roles stated in the source are retained.</p><label ${doc.captureCompleteness==='partial'?'hidden':''}>Reviewer name (signed-in)<input name="reviewer" maxlength="120" ${doc.captureCompleteness==='partial'?'':'required'}></label><label class="studio-check" ${doc.captureCompleteness==='partial'?'hidden':''}><input name="confirmed" type="checkbox" ${doc.captureCompleteness==='partial'?'':'required'}>I checked the selected knowledge against the source, including conditions, missing information and conflicts.</label><p>${doc.captureCompleteness==='partial'?'保存当前编辑，不确认入库；补全后再审核。':'Selected items join the draft. Unselected items are discarded from this extraction.'}</p><button type="submit" class="primary">${doc.captureCompleteness==='partial'?'Save review draft':'Save &amp; continue to Test'}</button></form>`;
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
