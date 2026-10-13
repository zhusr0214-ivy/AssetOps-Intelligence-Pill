import { api, escapeHtml as e } from './incidents.js';
import { csrfHeaders } from './session.js';

export async function uploadSource(record, file) {
  if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Select a nonempty file up to 10 MB.');
  const response = await fetch(`/api/studio/${encodeURIComponent(record.id)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Revision': String(record.revision), ...csrfHeaders() }, body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to upload source.'); return data.record;
}

function experienceFile(form) {
  const experience = form.elements.experience.value.trim();
  if (!experience) return null;
  const expert = form.elements.expert.value.trim(), reference = form.elements.reference.value.trim();
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

const manualFields = () => '<div class="studio-fields"><label>Expert / contributor<input name="expert" maxlength="120"></label><label>Interview or source reference<input name="reference" maxlength="1000"></label></div><label>Experience, conditions, exceptions or missing information<textarea name="experience" rows="6" maxlength="50000"></textarea></label>';

export async function renderCaptureEntry(view, mode, navigate) {
  view.innerHTML = `<header class="workspace-heading"><h2>Pill Studio</h2></header><form id="capture-entry"><div class="studio-fields"><label>Pill name<input name="name" maxlength="200" required></label><label>Knowledge owner<input name="owner" maxlength="120" required></label></div><label>Source file (optional)<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg"></label><p class="muted-label">PDF, DOCX, TXT, Markdown, PNG or JPEG · up to 10 MB</p><details class="manual-source"><summary>Expert experience / additional information</summary>${manualFields()}</details><p class="form-error" role="alert" hidden></p><p role="status"></p><a data-open-draft hidden>Open saved sources</a><button type="submit" class="primary">Create and extract with AI</button></form>`;
  const form = view.querySelector('form'); let record, sources, index = 0, documentId;
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button'); if (button.disabled) return;
    const errorEl = form.querySelector('.form-error'), status = form.querySelector('[role="status"]'); errorEl.hidden = true;
    try {
      if (!sources) {
        const file = form.elements.file.files[0], manual = experienceFile(form);
        if (!file && !manual) { form.querySelector('details').open = true; throw new Error('Upload a source file or enter expert experience.'); }
        sources = [file, manual].filter(Boolean);
        if (sources.some(file => !file.size || file.size > 10 * 1024 * 1024)) { sources = null; throw new Error('Select a nonempty file up to 10 MB.'); }
      }
      button.disabled = true; form.querySelectorAll('input, textarea').forEach(el => el.disabled = true);
      if (!record) record = (await api('/api/studio', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, owner: form.elements.owner.value }) })).record;
      else record = (await api(`/api/studio/${encodeURIComponent(record.id)}`)).record;
      const link = form.querySelector('[data-open-draft]'); link.href = `/studio/${encodeURIComponent(record.id)}?view=sources`; link.hidden = false;
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
      if (view.isConnected) navigate(`/studio/${encodeURIComponent(record.id)}?view=sources`);
    } catch (error) {
      if (!view.isConnected) return;
      errorEl.textContent = error.message; errorEl.hidden = false; button.disabled = false;
      status.textContent = record ? 'Draft retained. Retry extraction or inspect the saved sources.' : '';
      button.textContent = record ? 'Retry remaining extraction' : 'Create and extract with AI';
      if (!record) { sources = null; form.querySelectorAll('input, textarea').forEach(el => el.disabled = false); }
    }
  };
}

export function missingKnowledgeMarkup(record) {
  const gaps = [...new Set((record.documents || []).flatMap(doc => [
    ...(doc.questions || []), ...(doc.conflicts || []),
    ...(doc.candidates || []).flatMap(c => (c.missing || []).map(m => `${c.title}: ${m}`))
  ]))];
  return `<section class="knowledge-gaps"><h3>Information to complete</h3>${gaps.length ? `<ul>${gaps.map(g => `<li>${e(g)}</li>`).join('')}</ul>` : '<p>No extraction gaps listed. Saved rules, boundaries and examples still require validation.</p>'}</section>`;
}

export function captureMarkup(record) {
  const published = record.state === 'published';
  return `<section class="triage-section capture-panel"><h3>Knowledge capture</h3>${missingKnowledgeMarkup(record)}${!published ? '<form id="upload-source"><label>Add source file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" required></label><p class="muted-label">PDF, DOCX, TXT, Markdown, PNG or JPEG; up to 10 MB.</p><button type="submit">Upload and extract with AI</button></form>' : ''}${!published ? `<details class="manual-source" ${(record.documents || []).some(d => d.questions?.length || d.conflicts?.length || d.candidates?.some(c => c.missing?.length)) ? 'open' : ''}><summary>Complete missing information / add expert experience</summary><form id="manual-source">${manualFields()}<button type="submit">Save supplement and extract with AI</button></form></details>` : ''}${(record.documents || []).map(doc => `<details class="capture-document" ${doc.status === 'extracted' || doc.status === 'failed' ? 'open' : ''}><summary>${e(doc.name)} <span class="badge">${e(doc.isRunning ? 'Analyzing...' : doc.status === 'analyzing' ? 'Extraction interrupted' : doc.status)}</span></summary><p><a download href="/api/studio/${e(record.id)}/documents/${e(doc.id)}/file">Download original</a></p>${(doc.warnings || []).map(w => `<p class="triage-notice">${e(w)}</p>`).join('')}<details><summary>Extracted source text (${doc.blocks.length} sections)</summary>${doc.blocks.map(block => `<article><strong>${e(block.location)} / ${e(block.id)}</strong><p class="source-text">${e(block.text)}</p></article>`).join('')}</details>${doc.error ? `<p class="form-error" role="alert">${e(doc.error)}</p>` : ''}${!published && !['extracted', 'reviewed'].includes(doc.status) ? `<button type="button" data-analyze="${e(doc.id)}" ${doc.isRunning ? 'disabled' : ''}>${doc.isRunning ? 'Analyzing...' : doc.status === 'ready' ? 'Analyze with Knowledge Capture Agent' : 'Retry extraction'}</button>` : ''}${doc.isRunning ? '<button type="button" data-refresh-capture>Refresh extraction status</button>' : ''}${doc.status === 'extracted' && !published ? candidateForm(doc) : ''}${doc.status === 'reviewed' ? `<p>Reviewed by ${e(doc.review.reviewer)} / ${e(doc.review.reviewedAt)}</p><details><summary>Capture decisions</summary>${doc.review.decisions.map(c => `<article><span class="badge">${e(c.decision)}</span><p>${e(c.reviewedText || c.originalText)}</p>${c.evidence.map(ref => `<blockquote>${e(ref.location)}: ${e(ref.quote)}</blockquote>`).join('')}</article>`).join('')}</details>` : ''}</details>`).join('') || '<p class="empty-state">No uploaded knowledge sources.</p>'}</section>`;
}

function candidateForm(doc) {
  const titles = new Map(doc.candidates.map(c => [c.id, c.title]));
  return `<form data-capture-review="${e(doc.id)}"><h4>Review extracted knowledge</h4>${doc.candidates.length ? '' : '<p>No reusable knowledge was extracted for this domain.</p>'}<ul>${[...(doc.questions || []), ...(doc.conflicts || [])].map(v => `<li>${e(v)}</li>`).join('')}</ul>${doc.candidates.map((c, index) => `<article class="capture-candidate"><label class="studio-check"><input type="checkbox" name="accept-${index}">${e(c.title)}</label><span class="badge">${e(c.type)}</span><label>Proposed knowledge<textarea name="text-${index}" rows="3" maxlength="2000">${e(c.text)}</textarea></label>${c.evidence.map(ref => `<blockquote><strong>${e(ref.location)} / ${e(ref.blockId)}</strong><br>${e(ref.quote)}</blockquote>`).join('')}${c.relatedRuleIds.length || c.relatedActionIds.length ? `<p>Related candidates: ${[...c.relatedRuleIds, ...c.relatedActionIds].map(id => e(titles.get(id) || id)).join(', ')}</p>` : ''}${c.missing.length ? `<ul>${c.missing.map(v => `<li>${e(v)}</li>`).join('')}</ul>` : ''}</article>`).join('')}<label>Reviewer name (signed-in)<input name="reviewer" maxlength="120" required></label><label class="studio-check"><input name="confirmed" type="checkbox" required>I checked the selected knowledge against the source, including conditions, missing information and conflicts.</label><p>Selected items join the draft. Unselected items are discarded from this extraction.</p><button type="submit" class="primary">Save decisions and merge selected</button></form>`;
}

export function bindCapture(view, record, perform) {
  view.querySelector('#manual-source')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    perform(async () => {
      const file = experienceFile(form);
      if (!file) throw new Error('Enter the missing information or expert experience.');
      return uploadAndExtract(record, file);
    }, 'Saving and extracting expert supplement...');
  });
  view.querySelector('#upload-source')?.addEventListener('submit', event => { event.preventDefault(); perform(() => uploadAndExtract(record, event.target.elements.file.files[0]), 'Parsing and extracting source...'); });
  view.querySelectorAll('[data-analyze]').forEach(button => button.onclick = () => perform(async () => (await api(`/api/studio/${record.id}/documents/${button.dataset.analyze}/analyze`, { method: 'POST', body: JSON.stringify({ revision: record.revision }) })).record, 'Extracting knowledge with AI...'));
  view.querySelectorAll('[data-refresh-capture]').forEach(button => button.onclick = () => perform(async () => (await api(`/api/studio/${record.id}`)).record, 'Refreshing extraction...'));
  view.querySelectorAll('[data-capture-review]').forEach(form => form.onsubmit = event => {
    event.preventDefault(); const doc = record.documents.find(d => d.id === form.dataset.captureReview);
    const body = { revision: record.revision, reviewer: form.elements.reviewer.value, confirmed: form.elements.confirmed.checked, selections: doc.candidates.flatMap((c, index) => form.elements[`accept-${index}`].checked ? [{ id: c.id, text: form.elements[`text-${index}`].value }] : []) };
    perform(async () => (await api(`/api/studio/${record.id}/documents/${doc.id}/merge`, { method: 'POST', body: JSON.stringify(body) })).record, 'Saving capture decisions...');
  });
}
