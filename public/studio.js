import { simplifyPublication } from './publication-simple.js';
import { currentUser } from './session.js';
import { configureApproval, approvalError, showApprovalError, applyStudioPermissions } from './studio-permissions.js';
import { pillProgressMarkup } from './workflow.js';
import { api, escapeHtml as e } from './incidents.js';
import { pillMarkup } from './library.js';
import { renderLearning } from './learning.js';
import { renderCaptureEntry, captureMarkup, bindCapture } from './knowledge.js';
import { evaluationMarkup, bindEvaluation, publicationStatusMarkup, showEvaluationProgress, compactEvaluation, focusEvaluationResult } from './evaluation.js';
import { bindStudioFlow } from './studio-flow.js';
import { simplifyMake } from './make-simple.js';
import {mountExpertFlow,compactExpertValidation} from './expert-flow.js';

const layouts = {
  sources: [['expert', 'Expert / contributor'], ['reference', 'Source / interview reference'], ['knowledge', 'Captured experience', 'text']],
  rules: [['id', 'Rule ID'], ['title', 'Title'], ['guidance', 'Decision guidance', 'text'], ['cardExplanation', 'Explanation', 'text'], ['actionIds', 'Related action IDs (comma separated)', 'list']],
  actions: [['id', 'Action ID'], ['title', 'Title'], ['instruction', 'Action instruction', 'text'], ['owner', 'Responsible role'], ['ruleIds', 'Related rule IDs (comma separated)', 'list'], ['requiresApproval', 'Requires human approval', 'check'], ['coordinationKey', 'Shared control / constraint key (optional)'], ['coordinationValue', 'Proposed value for shared key (optional)']],
  examples: [['scenario', 'Example case and observations', 'text'], ['rationale', 'Expert rationale', 'text'], ['ruleIds', 'Expected rule IDs (comma separated)', 'list'], ['actionIds', 'Expected action IDs (comma separated)', 'list']]
};
const names = { sources: 'Expert knowledge', rules: 'Decision rules', actions: 'Action catalog', examples: 'Validation examples' };
function field(name, label, value, type = '') {
  const val = type === 'list' ? (Array.isArray(value) ? value.join(', ') : '') : value || '';
  if (type === 'check') return `<label class="studio-check"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
  return `<label>${label}${type === 'text' ? `<textarea name="${name}" rows="3" maxlength="8000">${e(val)}</textarea>` : `<input name="${name}" value="${e(val)}" maxlength="4000">`}</label>`;
}
function row(kind, item = {}) {
  return `<fieldset class="studio-row" data-kind="${kind}"><legend>${names[kind]}</legend><div class="studio-fields">${layouts[kind].map(([key, label, type]) => field(key, label, item[key], type)).join('')}</div><button type="button" data-remove>Remove entry</button></fieldset>`;
}
export function editorMarkup(record) {
  const c = record.content, p = c.pill;
  const published = record.state === 'published';
  return `<a class="back-link" href="/studio">&larr; All Pills</a><header class="workspace-heading"><div><h2>${e(p.name)}</h2><p>${e(p.owner)}</p></div><span class="badge">${e(record.state.replaceAll('_', ' '))}</span></header>
  ${record.validation ? `<section class="triage-section"><h3>${record.validation.passed ? 'Structural validation passed' : 'Validation needs attention'}</h3><p>${e(record.validation.scope)}</p><ul>${record.validation.errors.map(error => `<li>${e(error)}</li>`).join('')}</ul></section>` : ''}
  <p id="studio-error" class="form-error" role="alert" hidden></p><p id="studio-status" role="status"></p>
  ${published ? `${pillMarkup(record.releases.at(-1).pill)}<button type="button" class="primary" data-operation="fork">Create next draft</button>` : `<form id="pill-editor" data-page-panel="draft"><section class="triage-section"><h3>Capability</h3><p class="muted-label">Advisory use / human supervision</p><div class="studio-fields">${[['name', 'Pill name'], ['owner', 'Knowledge owner'], ['source', 'Knowledge provenance'], ['scope', 'Applicable assets, conditions and exclusions']].map(([key, label]) => field(key, label, p[key], key === 'scope' || key === 'source' ? 'text' : '')).join('')}</div></section>
  ${Object.keys(layouts).map(kind => `<section class="triage-section"><h3>${names[kind]}</h3><div data-rows="${kind}">${(c[kind] || p[kind] || []).map(item => row(kind, item)).join('')}</div><button type="button" data-add="${kind}">Add ${kind === 'sources' ? 'source' : kind === 'rules' ? 'rule' : kind === 'actions' ? 'action' : 'example'}</button></section>`).join('')}
  <section class="triage-section"><h3>Boundaries and escalation</h3>${field('boundaries', 'Boundaries (one per line)', p.boundaries.join('\n'), 'text')}${field('escalationConditions', 'Escalation conditions (one per line)', p.escalationConditions.join('\n'), 'text')}</section><div class="actions"><button type="submit" class="primary">Save draft</button><button type="button" data-operation="validate">Validate saved draft</button>${record.state === 'validated' ? '<button type="button" data-operation="submit">Submit for expert review</button>' : ''}</div></form>`}
  ${record.state === 'in_review' ? `<form id="pill-approval" class="triage-section" data-page-panel="publication"><h3>Expert review</h3>${field('reviewer', 'Reviewer name (signed-in)', '')}${field('notes', 'Review rationale', '', 'text')}<label class="studio-check"><input type="checkbox" name="expertConfirmed">I reviewed the sources, decision rules, boundaries and example cases for this version.</label><p>Publishing activates this version of the Pill for matching cases. Equipment execution remains disabled.</p><div class="actions"><button class="primary" type="submit" value="publish">Approve and publish</button><button type="submit" value="return">Return for changes</button></div></form>` : ''}
  <details class="triage-section" data-page-panel="history"><summary>Published versions (${record.releases.length})</summary>${[...record.releases].reverse().map(release => `<article class="studio-version"><h3>${e(release.pill.version)} ${release.active ? '/ Active' : ''}</h3><p>${e(release.publishedAt)} / ${e(release.reviewer)}</p><p>${e(release.notes)}</p><details><summary>Version content and sources</summary>${pillMarkup(release.pill)}${release.sources.map(s => `<p><strong>${e(s.expert)}</strong> / ${e(s.reference)}</p><p>${e(s.knowledge)}</p>`).join('')}</details></article>`).join('') || '<p>No published versions.</p>'}</details>
  <details class="triage-section" data-page-panel="history"><summary>Change history</summary>${[...record.events].reverse().map(event => `<p>${e(event.at)} / ${e(event.action)} ${e(event.reviewer || '')}${event.notes ? `<br>${e(event.notes)}` : ''}</p>`).join('') || '<p>No changes yet.</p>'}</details>`;
}

function readContent(form) {
  const pill = Object.fromEntries(['name', 'owner', 'source', 'scope'].map(key => [key, form.querySelector(`[name="${key}"]`).value.trim()]));
  pill.domain = form.elements.domain?.value || 'ahu_cooling';
  if (form.elements.routingCategory) {
    const selected = [...form.querySelectorAll('[name="routingCategory"]:checked')].map(el => el.value);
    if (selected.length || pill.domain !== 'ahu_cooling' || form.elements.assetPrefixes.value.trim() || form.elements.routingKeywords.value.trim()) pill.applicability = { categories: selected, assetPrefixes: form.elements.assetPrefixes.value.split(',').map(s => s.trim()).filter(Boolean), keywords: form.elements.routingKeywords.value.split(',').map(s => s.trim()).filter(Boolean) };
  }
  for (const key of ['boundaries', 'escalationConditions']) pill[key] = form.elements[key].value.split('\n').map(v => v.trim()).filter(Boolean);
  const content = { pill };
  for (const [kind, layout] of Object.entries(layouts)) {
    const rows = [...form.querySelectorAll(`[data-kind="${kind}"]`)].map(el => Object.fromEntries(layout.map(([key, , type]) => {
      const input = el.querySelector(`[name="${key}"]`);
      return [key, type === 'check' ? input.checked : type === 'list' ? input.value.split(',').map(v => v.trim()).filter(Boolean) : input.value.trim()];
    })));
    if (kind === 'rules' || kind === 'actions') pill[kind] = rows; else content[kind] = rows;
  }
  return content;
}

export function addReferenceHelpers(form) {
  const targets = { rules: { actionIds: 'actions' }, actions: { ruleIds: 'rules' }, examples: { ruleIds: 'rules', actionIds: 'actions' } };
  const rows = kind => [...form.querySelectorAll(`fieldset[data-kind="${kind}"]`)];
  const appendId = (input, id) => {
    const ids = input.value.split(',').map(value => value.trim()).filter(Boolean);
    if (!ids.includes(id)) input.value = [...ids, id].join(', ');
  };
  for (const [kind, fields] of Object.entries(targets)) for (const row of rows(kind)) {
    for (const [fieldName, targetKind] of Object.entries(fields)) {
      const input = row.querySelector(`[name="${fieldName}"]`);
      let helper = row.querySelector(`[data-reference-for="${fieldName}"]`);
      if (!helper) {
        helper = document.createElement('div');
        helper.className = 'studio-reference-helper';
        helper.dataset.referenceFor = fieldName;
        input.closest('label').classList.add('studio-reference-field');
        const select = document.createElement('select');
        select.setAttribute('aria-label', `Choose ${targetKind === 'rules' ? 'rule' : 'action'} for ${kind.slice(0, -1)}`);
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Add selected';
        button.addEventListener('click', () => {
          if (!select.value) return;
          appendId(input, select.value);
          if (kind !== 'examples') {
            const ownId = row.querySelector('[name="id"]').value.trim();
            const other = rows(targetKind).find(item => item.querySelector('[name="id"]').value.trim() === select.value);
            if (ownId && other) appendId(other.querySelector(`[name="${kind === 'rules' ? 'ruleIds' : 'actionIds'}"]`), ownId);
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        helper.append(select, button);
        input.closest('label').after(helper);
      }
      const select = helper.querySelector('select');
      const previous = select.value;
      const placeholder = document.createElement('option');
      placeholder.textContent = `Choose ${targetKind === 'rules' ? 'rule' : 'action'}`;
      placeholder.value = '';
      select.replaceChildren(placeholder);
      for (const item of rows(targetKind)) {
        const id = item.querySelector('[name="id"]').value.trim();
        if (!id) continue;
        const title = item.querySelector('[name="title"]').value.trim();
        const option = document.createElement('option');
        option.textContent = title || id;
        option.title = `${title || id} (${id})`;
        option.value = id;
        select.add(option);
      }
      select.value = previous && [...select.options].some(option => option.value === previous) ? previous : '';
      helper.querySelector('button').disabled = select.options.length < 2;
    }
  }
}

export async function renderStudio(root, path, navigate) {
  const view = document.createElement('section'); root.replaceChildren(view);
  view.innerHTML = '<p role="status">Loading Pill Studio...</p>';
  try {
    if (['/studio/new', '/studio/new/upload', '/studio/new/expert'].includes(path)) { await renderCaptureEntry(view, 'unified', navigate); return; }
    if (path === '/studio/improvements') {
      view.innerHTML = '<header class="workspace-heading"><h2>Pill Studio</h2></header><div class="studio-candidates"></div>';
      await renderLearning(view.querySelector('.studio-candidates')); return;
    }
    if (path === '/studio') {
      const { records } = await api('/api/studio'); if (!view.isConnected) return;
      view.innerHTML = `<header class="workspace-heading"><h2>Pill Studio</h2></header><div class="table-scroll"><table class="incident-table"><thead><tr><th>Pill</th><th>Owner</th><th>Draft status</th><th>Latest release</th></tr></thead><tbody>${records.map(r => `<tr><td><a href="/studio/${e(r.id)}">${e(r.content.pill.name)}</a></td><td>${e(r.content.pill.owner)}</td><td>${e(r.state.replaceAll('_', ' '))}</td><td>${e(r.releases.at(-1)?.pill.version || 'Unpublished')}</td></tr>`).join('')}</tbody></table></div>`;
      return;
    }
    const match = path.match(/^\/studio\/([^/]+)$/); if (!match) throw new Error('Pill page not found.');
    let { record } = await api(`/api/studio/${encodeURIComponent(match[1])}`);
    const { candidates: allCandidates } = await api('/api/learning');
    const candidates = allCandidates.filter(c => c.pillId === record.id);
    let flushCapture=async()=>{},captureSaveQueue=Promise.resolve();
    let dirty = false, busy = false, pendingNext = null, autosaveTimer, savePromise, editVersion=0;
    async function saveDraftAutomatically() {
      clearTimeout(autosaveTimer);
      if(savePromise) await savePromise;
      if(!dirty || busy || !view.isConnected) return;
      const version=editVersion, content=readContent(view.querySelector('#pill-editor'));
      const message=view.querySelector('[data-save-message]'); if(message) message.textContent='Saving...';
      savePromise=(async()=>{
        try {
          record=(await api(`/api/studio/${encodeURIComponent(record.id)}/save`,{method:'POST',body:JSON.stringify({revision:record.revision,content,autoValidate:true})})).record;
          dirty=version!==editVersion;
          if(message) message.textContent=dirty?'Unsaved changes':record.validation?.passed?'Saved · structure valid':'Saved · complete the draft before testing';
          if(!dirty&&view.isConnected)view.querySelector('#studio-status').textContent='Draft saved. Structure checked automatically.';
        } catch(error) {const el=view.querySelector('#studio-error');el.textContent=error.message;el.hidden=false;if(message)message.textContent='Save failed — retry or keep editing';const retry=view.querySelector('[data-save-fixed]');if(retry){retry.hidden=false;retry.textContent='Retry save';}throw error;}
      })();
      try {await savePromise;} finally {savePromise=null;}
    }
    function paint() {
      if (!view.isConnected) return;
      view.innerHTML = editorMarkup(record); dirty = false;
      view.querySelector('.workspace-heading').insertAdjacentHTML('afterend', pillProgressMarkup(record));
      view.querySelector('.next-step')?.remove();
      view.querySelector(':scope > .pill-record')?.setAttribute('data-page-panel', 'draft');
      view.querySelector('[data-operation="fork"]')?.setAttribute('data-page-panel', 'draft');
      view.querySelector(':scope > .triage-section:not(form):not(details)')?.setAttribute('data-page-panel', 'publication');
      view.querySelector('#studio-status').insertAdjacentHTML('afterend', publicationStatusMarkup(record));
      view.querySelector('#studio-status').insertAdjacentHTML('afterend', `<div data-page-panel="evaluation">${evaluationMarkup(record)}</div>`);
      if (record.state !== 'published') {
        const bar = document.createElement('aside'); bar.className = 'studio-savebar';
        bar.innerHTML = '<span data-save-message role="status">All changes saved</span><button type="button" class="primary" data-save-fixed>Save draft</button><button type="button" data-save-continue hidden>Save and continue</button>';
        view.prepend(bar);
        bar.querySelector('[data-save-fixed]').onclick = () => operate('save', {content:readContent(view.querySelector('#pill-editor'))});
        bar.querySelector('[data-save-continue]').onclick = async () => {
          const next = pendingNext; pendingNext = null;
          if (!next || busy) return;
          const errorEl = view.querySelector('#studio-error');
          if (view.querySelector('#evaluation-suite')?.dataset.dirty) { errorEl.textContent = 'Save the changed test suite using its Save suite button before continuing.'; errorEl.hidden = false; errorEl.scrollIntoView?.({block:'center'}); return; }
          busy = true; bar.querySelectorAll('button').forEach(b=>b.disabled=true); bar.querySelector('[data-save-message]').textContent = 'Saving draft...';
          try {
            record = (await api(`/api/studio/${encodeURIComponent(record.id)}/save`, {method:'POST',body:JSON.stringify({content:readContent(view.querySelector('#pill-editor')),revision:record.revision})})).record;
            dirty = false; bar.querySelector('[data-save-message]').textContent = 'Saved. Continuing...';
            busy = false; await next();
          } catch(error) { errorEl.textContent = error.message; errorEl.hidden = false; bar.querySelector('[data-save-message]').textContent='Save failed — edits retained'; }
          finally {busy=false;bar.querySelectorAll('button').forEach(b=>b.disabled=false);}
        };
      }
      bindEvaluation(view, record, operate, () => performCapture(async () => (await api(`/api/studio/${record.id}`)).record, 'Refreshing evaluation...'));
      view.querySelector('#studio-status').insertAdjacentHTML('afterend', `<div data-page-panel="draft sources">${captureMarkup(record)}</div>`);
      flushCapture=bindCapture(view, record, performCapture, (docId,body)=>{
        const job=captureSaveQueue.catch(()=>{}).then(async()=>{await saveDraftAutomatically();const next=(await api(`/api/studio/${record.id}/documents/${docId}/draft`,{method:'POST',body:JSON.stringify({...body,revision:record.revision})})).record;record={...next,evaluationGate:record.evaluationGate};return record;});captureSaveQueue=job;return job;
      });
      if (record.learningImports?.length) {
        const section = document.createElement('section'); section.className = 'triage-section'; section.dataset.pagePanel = 'sources';
        section.innerHTML = `<h3>Imported learning</h3>${record.learningImports.map(item => `<article class="studio-version"><a href="/cases/${e(item.caseId)}/handling">${e(item.caseId)}</a><h4>${e(item.proposal.title)}</h4><p>${e(item.proposal.decision.reviewedAfter)}</p><p>Applicability: ${e(item.proposal.applicability)}</p><p>Limitations: ${e(item.proposal.limitations)}</p><ul>${item.proposal.validationCases.map(v => `<li>${e(v)}</li>`).join('')}</ul><span class="badge">${e(item.releasedVersion || item.status.replaceAll('_', ' '))}</span>${item.status === 'pending_incorporation' ? `<form data-incorporate="${e(item.proposalId)}"><label>Expert name<input name="reviewer" maxlength="120" required></label><label>Changed rule IDs, validation cases and rationale<textarea name="notes" maxlength="3000" required></textarea></label><label class="studio-check"><input name="expertConfirmed" type="checkbox" required>I incorporated the reviewed change into the saved rules and validation cases.</label><button type="submit">Confirm incorporation</button></form>` : ''}</article>`).join('')}`;
        view.querySelector('#studio-status').after(section);
        section.querySelectorAll('[data-incorporate]').forEach(form => form.onsubmit = event => { event.preventDefault(); operate('incorporate-learning', { proposalId: form.dataset.incorporate, ...Object.fromEntries(new FormData(form)), expertConfirmed: form.elements.expertConfirmed.checked }); });
      }
      const form = view.querySelector('#pill-editor');
      if (form) {
        const p = record.content.pill;
        form.insertAdjacentHTML('afterbegin', `<section class="triage-section"><h3>Domain and applicability</h3><label>Domain<select name="domain">${[...new Set([p.domain || 'ahu_cooling', 'ahu_cooling', 'hvac_local_comfort', 'energy', 'electrical_distribution', 'water_leak', 'lift_fault', 'asset_operations'])].map(v => `<option value="${e(v)}" ${p.domain === v ? 'selected' : ''}>${e(v.replaceAll('_', ' '))}</option>`).join('')}</select></label><fieldset><legend>Incident categories (any selected)</legend>${['hvac', 'hvac_cooling', 'hvac_local_comfort', 'energy', 'water_leak', 'electrical_distribution', 'lift_fault', 'other'].map(v => `<label class="studio-check"><input type="checkbox" name="routingCategory" value="${v}" ${p.applicability?.categories.includes(v) ? 'checked' : ''}>${e(v.replaceAll('_', ' '))}</label>`).join('')}</fieldset>${field('assetPrefixes', 'Asset prefixes (comma separated; optional)', p.applicability?.assetPrefixes.join(', ') || '')}${field('routingKeywords', 'Issue keywords (comma separated; optional)', p.applicability?.keywords.join(', ') || '')}</section>`);
        const legacyLabel = form.querySelector('.muted-label'); if (legacyLabel) legacyLabel.textContent = 'Advisory use / human supervision';
      }
      if (form) addReferenceHelpers(form);
      if (candidates.length) {
        const section = document.createElement('details'); section.className = 'triage-section'; section.dataset.pagePanel = 'sources';
        section.innerHTML = `<summary>Related improvement candidates (${candidates.length})</summary>${candidates.map((c, index) => `<article class="studio-version"><a href="/cases/${e(c.incidentId)}/review">${e(c.incidentId)}</a><p>${e(c.notes)}</p>${c.proposals ? `<p>${e(c.proposals)}</p>` : ''}${form ? `<button type="button" data-source="${index}">Add to expert sources</button>` : ''}</article>`).join('')}`;
        view.append(section);
      }
      const markDirty = () => { dirty = true; editVersion++; clearTimeout(autosaveTimer); autosaveTimer=setTimeout(()=>saveDraftAutomatically().catch(()=>{}),900); view.querySelector('#studio-status').textContent = 'Unsaved changes'; const message=view.querySelector('[data-save-message]'); if(message) message.textContent='Unsaved draft changes'; };
      view.querySelectorAll('[data-source]').forEach(button => button.onclick = () => {
        const candidate = candidates[Number(button.dataset.source)];
        form.querySelector('[data-rows="sources"]').insertAdjacentHTML('beforeend', row('sources', { expert: '', reference: `${candidate.incidentId} / ${candidate.reviewId} / ${candidate.id}`, knowledge: [candidate.notes, candidate.proposals, ...(candidate.omittedActions || []).map(a => `${a.title}: ${a.reason}`)].filter(Boolean).join('\n') }));
        button.disabled = true; markDirty();
      });
      form?.addEventListener('input', event => {
        markDirty();
        if (event.target.name === 'id' || event.target.name === 'title') addReferenceHelpers(form);
      });
      form?.addEventListener('click', event => {
        const add = event.target.closest('[data-add]');
        if (add) { const kind = add.dataset.add; form.querySelector(`[data-rows="${kind}"]`).insertAdjacentHTML('beforeend', row(kind)); markDirty(); addReferenceHelpers(form); }
        if (event.target.closest('[data-remove]')) { event.target.closest('.studio-row').remove(); markDirty(); addReferenceHelpers(form); }
      });
      form?.addEventListener('submit', event => { event.preventDefault(); operate('save', { content: readContent(form) }); });
      view.querySelectorAll('[data-operation]').forEach(button => button.onclick = () => operate(button.dataset.operation));
      view.querySelector('#pill-approval')?.addEventListener('submit', event => {
        event.preventDefault(); const approval = event.target;
        const operation=event.submitter.value, problem=approvalError(approval,operation);
        if(problem){view.querySelector('#studio-error').hidden=true;showApprovalError(approval,problem,operation);return;}
        const values=Object.fromEntries(new FormData(approval));
        const evaluationReview=operation === 'publish' && approval.querySelector('[data-combined-review]') ? {runId:record.evaluations.at(-1).id,...Object.fromEntries(['scope','limitations','qualification','reference','notes'].map(k=>[k,k==='notes'?values.notes:values[k]])),confirmed:approval.elements.confirmed.checked} : undefined;
        operate(event.submitter.value, { ...values, evaluationReview, expertConfirmed: approval.elements.expertConfirmed.checked });
      });
      simplifyStudio(view,record);
      bindStudioFlow(view,record,{subpages:true});
      simplifyMake(view,record);
      const savebar=view.querySelector('.studio-savebar'),footer=view.querySelector('.capture-review-footer');
      if(savebar){savebar.classList.add('studio-save-status');savebar.hidden=true;}
      configureApproval(view.querySelector('#pill-approval'),record,currentUser());
      mountExpertFlow(view,record,performCapture,currentUser());
      applyStudioPermissions(view,currentUser());
      compactEvaluation(view,record);
      compactExpertValidation(view,record,performCapture);
      simplifyPublication(view,record,currentUser());
    }
    function simplifyStudio(view,record) {
      const form=view.querySelector('#pill-editor');
      if(form) {
        const domain=form.querySelector('section');
        const sources=view.querySelector('.capture-panel');if(sources&&domain) form.before(sources.closest('[data-page-panel]'));
        for(const key of ['sources','examples']) {
          const section=form.querySelector(`[data-rows="${key}"]`)?.closest('section');if(!section)continue;
          const details=document.createElement('details');details.className='triage-section';details.innerHTML=`<summary>${key==='sources'?'Reviewed source knowledge (filled by capture)':'Legacy validation examples (shared test cases replace these)'}</summary>`;
          section.replaceWith(details);details.append(section);
        }
      }
      const approval=view.querySelector('#pill-approval'), review=view.querySelector('#evaluation-review');
      if(review) {
        review.closest('[data-page-panel]')?.setAttribute('data-page-panel','evaluation');
        if(approval) {
          const fields=document.createElement('fieldset');fields.dataset.combinedReview='true';fields.innerHTML='<legend>Evaluation evidence and operating limits</legend>';
          [...review.querySelectorAll('label')].filter(l=>!l.querySelector('[name="decision"]')).forEach(l=>{if(l.querySelector('[name="notes"]'))return;fields.append(l);});
          for(const [key,value] of Object.entries({scope:record.content.pill.scope,limitations:record.content.pill.boundaries.join('\n'),reference:record.evaluations?.at(-1)?.id||''})) {const input=fields.querySelector(`[name="${key}"]`);if(input)input.value=value;}
          const checked=fields.querySelector('[name="confirmed"]');if(checked){checked.closest('label').remove();checked.type='hidden';checked.checked=true;fields.append(checked);}
          approval.querySelector('[name="expertConfirmed"]').required=true;approval.querySelector('h3').after(fields);review.remove();
          approval.querySelector('[value="publish"]').textContent='Approve evaluation & publish';
        } else {
          const info=document.createElement('p');info.textContent='After testing, continue to confirmation. Review the knowledge and operating limits before publishing.';review.replaceWith(info);
        }
      }
      const evaluation=view.querySelector('[data-page-panel="evaluation"]');
      view.querySelector('[data-operation="validate"]')?.setAttribute('hidden','');
      const pendingSources=record.documents?.some(d=>d.status!=='reviewed');
      const cannotSubmit=pendingSources || record.state==='in_review' || !record.evaluations?.at(-1)?.passed || ['outdated','failed','not_run','not_enabled'].includes(record.evaluationGate?.state);
      const submit=view.querySelector('[data-operation="submit"]');if(submit&&evaluation){evaluation.append(submit);submit.textContent=record.independentReviewRequired?'Submit for independent review':'Continue to confirmation';submit.disabled=cannotSubmit;}
      if(!submit&&form&&evaluation){const button=document.createElement('button');button.type='button';button.dataset.confirmationStep='';button.className='primary';button.textContent=record.independentReviewRequired?'Submit for independent review':'Continue to confirmation';button.onclick=()=>operate('submit',{});button.disabled=cannotSubmit;evaluation.append(button);}
      if(evaluation&&cannotSubmit&&record.state!=='published'){const hint=document.createElement('p');hint.className='triage-notice';hint.textContent=pendingSources ? 'Review pending source proposals in Prepare knowledge before submitting.' : record.state==='in_review' ? 'Ready for confirmation. Continue in Review & release.' : 'Before submitting: save a relevant case and run evaluation. Submission becomes available when the current evaluation passes.';evaluation.append(hint);}
      const publication=view.querySelector('[data-page-panel="publication"]');
      const history=view.querySelectorAll('details[data-page-panel="history"]');if(publication&&history.length){const details=document.createElement('details');details.innerHTML='<summary>Versions and audit history</summary>';history.forEach(n=>{n.dataset.pagePanel='publication history';details.append(n);});publication.append(details);}
    }
    function offerSave(next) {
      pendingNext = next;
      const bar = view.querySelector('.studio-savebar');
      if (!bar) return;
      bar.querySelector('[data-save-message]').textContent = 'Save your draft changes before the next step.';
      bar.querySelector('[data-save-continue]').hidden = false;
      bar.scrollIntoView?.({block:'nearest'});
    }
    async function performCapture(task, message, nextView, resultTarget) {
      if (busy) return;
      let errorEl = view.querySelector('#studio-error'); errorEl.hidden = true;
      try { await flushCapture(); await saveDraftAutomatically(); } catch { return; }
      if (dirty) { offerSave(() => performCapture(task,message,nextView,resultTarget)); return; }
      if (view.querySelector('#evaluation-suite')?.dataset.dirty) { errorEl.textContent = 'Save your test suite before changing knowledge sources.'; errorEl.hidden = false; errorEl.scrollIntoView?.({block:'center'}); return; }
      busy = true;
      const controls = [...view.querySelectorAll('button, input, textarea, select')].map(el => [el, el.disabled]);
      controls.forEach(([el]) => { el.disabled = true; });
      view.querySelector('#studio-status').textContent = message;
      try {
        record = await task(record);
        if (!record.evaluationGate) {
          try { record = (await api(`/api/studio/${encodeURIComponent(record.id)}`)).record; }
          catch { /* Keep the saved extraction; show an unavailable state only if refresh fails. */ }
        }
        paint();
        if (view.isConnected) { view.querySelector('#studio-status').textContent = nextView ? 'Selected knowledge saved. Continue with testing.' : 'Knowledge source updated.'; if (nextView) navigate(`/studio/${encodeURIComponent(record.id)}?view=${nextView}`); else if(resultTarget){const result=view.querySelector(resultTarget);result?.focus?.({preventScroll:true});result?.scrollIntoView?.({block:'start',behavior:'instant'});} }
      } catch (error) {
        if (view.isConnected) {
          // Failed model calls update source status and revision; reload those without losing draft edits.
          try { const result = await api(`/api/studio/${encodeURIComponent(record.id)}`); if (result.record.revision !== record.revision) { record = result.record;
        if (!record.evaluationGate) { try { record = (await api(`/api/studio/${encodeURIComponent(record.id)}`)).record; } catch { /* Preserve committed result; unavailable status is displayed explicitly. */ } }
        paint(); } } catch { /* Keep the original error if refresh also fails. */ }
          errorEl = view.querySelector('#studio-error'); errorEl.textContent = error.message; errorEl.hidden = false; errorEl.scrollIntoView?.({ block: 'center' });
          view.querySelector('#studio-status').textContent = '';
          controls.forEach(([el, disabled]) => { el.disabled = disabled; });
        }
      } finally { busy = false; }
    }
    async function operate(operation, data = {}) {
      if (busy) return;
      const errorEl = view.querySelector('#studio-error'); errorEl.hidden = true;
      try { await flushCapture(); await saveDraftAutomatically(); } catch { return; }
      if (view.querySelector('#evaluation-suite')?.dataset.dirty && operation !== 'save-evaluations') { errorEl.textContent = 'Save the test suite before continuing.'; errorEl.hidden = false; return; }
      if (dirty && operation === 'save-evaluations') data.content = readContent(view.querySelector('#pill-editor'));
      if (dirty && !['save', 'save-evaluations'].includes(operation)) { offerSave(() => operate(operation,data)); return; }
      const previousScroll=view.ownerDocument.defaultView.scrollY;
      busy = true; const operationControls=[...view.querySelectorAll('button, input, textarea, select')].map(el=>[el,el.disabled]);operationControls.forEach(([el])=>{el.disabled=true;});
      const restoreEvaluation=operation==='evaluate'?showEvaluationProgress(view):()=>{};
      const saveMessage=view.querySelector('[data-save-message]'); if(saveMessage && operation==='save') saveMessage.textContent='Saving draft...';
      if (operation === 'evaluate') view.querySelector('#studio-status').textContent = 'Evaluating draft and active baseline...';
      try {
        const result = await api(`/api/studio/${encodeURIComponent(record.id)}/${operation}`, { method: 'POST', body: JSON.stringify({ ...data, autoValidate: true, revision: record.revision }) });
        record = result.record;
        if (!record.evaluationGate) { try { record = (await api(`/api/studio/${encodeURIComponent(record.id)}`)).record; } catch { /* Preserve committed result; unavailable status is displayed explicitly. */ } }
        paint();
        if (view.isConnected) {
          const messages={save:'Draft saved. Continue to validation when ready.',submit:'Ready for expert confirmation. Next: review the scope and limits in Review & release, then confirm publication.',return:'Returned for changes. Next: the author edits the knowledge and validates the recommendations again.',publish:'Version published. Next: use this Pill in a new Case analysis.', 'save-evaluations':data.draftOnly ? 'Scenario draft saved. You can refresh safely. Complete the expected recommendations and rules before evaluation.' : 'Test cases saved. Next: run model evaluation.',evaluate:record.evaluations?.at(-1)?.passed ? 'Evaluation passed. Next: confirm the knowledge and operating limits before publication.' : 'Evaluation failed. Review the trial differences before making changes.'};
          view.querySelector('#studio-status').textContent=messages[operation] || 'Changes saved.';
          if(operation==='save-evaluations'){const suite=view.querySelector('[data-test-suite]');if(suite)suite.open=true;const feedback=view.querySelector('[data-suite-feedback]');if(feedback)feedback.textContent=messages['save-evaluations'];}
          if(operation==='evaluate') focusEvaluationResult(view);
          else if(operation==='save-evaluations'){const restore=()=>view.ownerDocument.defaultView.scrollTo({top:previousScroll,behavior:'instant'});restore();view.ownerDocument.defaultView.requestAnimationFrame?.(restore);}
          if(operation==='submit') navigate(`/studio/${encodeURIComponent(record.id)}?view=publication`);
        }
        return true;
      } catch (error) { if (view.isConnected) {
        view.querySelector('#studio-status').textContent = '';
        errorEl.textContent = error.message; errorEl.hidden = false;
        if(operation==='evaluate') {
          const panel=view.querySelector('.evaluation-panel');
          const notice=view.ownerDocument.createElement('section');notice.className='triage-notice evaluation-result';notice.dataset.evaluationResult='';notice.tabIndex=-1;notice.setAttribute('role','alert');
          const title=view.ownerDocument.createElement('h3');title.textContent='Evaluation could not start or finish';notice.append(title);
          const detail=view.ownerDocument.createElement('p');detail.textContent=error.message;notice.append(detail);
          if(record.validation?.passed===false){const hint=view.ownerDocument.createElement('p');hint.textContent='The knowledge check did not pass. Review the knowledge connections in Prepare knowledge, then run again.';notice.append(hint);}
          (panel.querySelector('.evaluation-actionbar')||panel).after(notice);errorEl.hidden=true;focusEvaluationResult(view);
        } else errorEl.scrollIntoView?.({ block: 'center' });
        operationControls.forEach(([el,disabled])=>{if(el.isConnected)el.disabled=disabled;});
      } }
      finally { restoreEvaluation();busy = false; }
    }
    paint();
  } catch (error) { if (view.isConnected) view.innerHTML = `<a href="/studio">All Pills</a><p class="form-error" role="alert">${e(error.message)}</p>`; }
}
