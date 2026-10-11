import { api, escapeHtml as e } from './incidents.js';

export async function uploadSource(record, file) {
  if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Select a nonempty file up to 10 MB.');
  const response = await fetch(`/api/studio/${encodeURIComponent(record.id)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Revision': String(record.revision) }, body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to upload source.'); return data.record;
}

export async function renderCaptureEntry(view, mode, navigate) {
  const upload = mode === 'upload';
  view.innerHTML = `<a class="back-link" href="/studio">&larr; Pill Studio</a><header class="workspace-heading"><h2>${upload ? 'Create from documents' : 'Capture expert experience'}</h2></header><form id="capture-entry" class="triage-section"><div class="studio-fields"><label>Pill name<input name="name" maxlength="200" required></label><label>Knowledge owner<input name="owner" maxlength="120" required></label></div>${upload ? '<label>Source file<input type="file" name="file" accept=".pdf,.docx,.txt,.md" required></label><p>PDF, DOCX, TXT or Markdown. Up to 10 MB; searchable text required.</p>' : '<label>Expert / contributor<input name="expert" maxlength="120" required></label><label>Interview or source reference<input name="reference" maxlength="1000" required></label><label>Experience, conditions and exceptions<textarea name="experience" rows="8" maxlength="50000" required></textarea></label>'}<p class="form-error" role="alert" hidden></p><p role="status"></p><button type="submit" class="primary">${upload ? 'Upload and create draft' : 'Create knowledge draft'}</button></form>`;
  const form = view.querySelector('form'); let record;
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button'); if (button.disabled) return;
    const errorEl = form.querySelector('.form-error'), status = form.querySelector('[role="status"]'); errorEl.hidden = true;
    const file = upload ? form.elements.file.files[0] : new File([`Expert: ${form.elements.expert.value}\nReference: ${form.elements.reference.value}\n\n${form.elements.experience.value}`], 'expert-experience.txt', { type: 'text/plain' });
    if (!file || !file.size || file.size > 10 * 1024 * 1024) { errorEl.textContent = 'Select a nonempty file up to 10 MB.'; errorEl.hidden = false; return; }
    button.disabled = true; status.textContent = 'Saving and parsing source...';
    try {
      if (!record) record = (await api('/api/studio', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, owner: form.elements.owner.value }) })).record;
      record = await uploadSource(record, file);
      if (view.isConnected) navigate(`/studio/${record.id}`);
    } catch (error) {
      if (view.isConnected) { errorEl.textContent = error.message; errorEl.hidden = false; status.textContent = record ? 'The draft was saved. Retry the upload or open it from Pill Studio.' : ''; button.disabled = false; }
    }
  };
}

export function captureMarkup(record) {
  const published = record.state === 'published';
  return `<section class="triage-section capture-panel"><h3>Knowledge sources</h3>${!published ? '<form id="upload-source"><label>Add source file<input type="file" name="file" accept=".pdf,.docx,.txt,.md" required></label><p class="muted-label">PDF, DOCX, TXT or Markdown; up to 10 MB. Model extraction uses the configured AI provider.</p><button type="submit">Upload source</button></form>' : ''}${(record.documents || []).map(doc => `<details class="capture-document" ${doc.status === 'extracted' || doc.status === 'failed' ? 'open' : ''}><summary>${e(doc.name)} <span class="badge">${e(doc.isRunning ? 'Analyzing...' : doc.status === 'analyzing' ? 'Extraction interrupted' : doc.status)}</span></summary><p><a download href="/api/studio/${e(record.id)}/documents/${e(doc.id)}/file">Download original</a></p>${(doc.warnings || []).map(w => `<p class="triage-notice">${e(w)}</p>`).join('')}<details><summary>Extracted source text (${doc.blocks.length} sections)</summary>${doc.blocks.map(block => `<article><strong>${e(block.location)} / ${e(block.id)}</strong><p class="source-text">${e(block.text)}</p></article>`).join('')}</details>${doc.error ? `<p class="form-error" role="alert">${e(doc.error)}</p>` : ''}${!published && !['extracted', 'reviewed'].includes(doc.status) ? `<button type="button" data-analyze="${e(doc.id)}" ${doc.isRunning ? 'disabled' : ''}>${doc.isRunning ? 'Analyzing...' : doc.status === 'ready' ? 'Analyze with Knowledge Capture Agent' : 'Retry extraction'}</button>` : ''}${doc.isRunning ? '<button type="button" data-refresh-capture>Refresh extraction status</button>' : ''}${doc.status === 'extracted' && !published ? candidateForm(doc) : ''}${doc.status === 'reviewed' ? `<p>Reviewed by ${e(doc.review.reviewer)} / ${e(doc.review.reviewedAt)}</p><details><summary>Capture decisions</summary>${doc.review.decisions.map(c => `<article><span class="badge">${e(c.decision)}</span><p>${e(c.reviewedText || c.originalText)}</p>${c.evidence.map(ref => `<blockquote>${e(ref.location)}: ${e(ref.quote)}</blockquote>`).join('')}</article>`).join('')}</details>` : ''}</details>`).join('') || '<p class="empty-state">No uploaded knowledge sources.</p>'}</section>`;
}

function candidateForm(doc) {
  const titles = new Map(doc.candidates.map(c => [c.id, c.title]));
  return `<form data-capture-review="${e(doc.id)}"><h4>Review extracted knowledge</h4>${doc.candidates.length ? '' : '<p>No reusable knowledge was extracted for this domain.</p>'}<ul>${[...(doc.questions || []), ...(doc.conflicts || [])].map(v => `<li>${e(v)}</li>`).join('')}</ul>${doc.candidates.map((c, index) => `<article class="capture-candidate"><label class="studio-check"><input type="checkbox" name="accept-${index}">${e(c.title)}</label><span class="badge">${e(c.type)}</span><label>Proposed knowledge<textarea name="text-${index}" rows="3" maxlength="2000">${e(c.text)}</textarea></label>${c.evidence.map(ref => `<blockquote><strong>${e(ref.location)} / ${e(ref.blockId)}</strong><br>${e(ref.quote)}</blockquote>`).join('')}${c.relatedRuleIds.length || c.relatedActionIds.length ? `<p>Related candidates: ${[...c.relatedRuleIds, ...c.relatedActionIds].map(id => e(titles.get(id) || id)).join(', ')}</p>` : ''}${c.missing.length ? `<ul>${c.missing.map(v => `<li>${e(v)}</li>`).join('')}</ul>` : ''}</article>`).join('')}<label>Reviewer name (self-declared)<input name="reviewer" maxlength="120" required></label><label class="studio-check"><input name="confirmed" type="checkbox" required>I checked the selected knowledge against the source, including conditions, missing information and conflicts.</label><p>Selected items join the draft. Unselected items are discarded from this extraction.</p><button type="submit" class="primary">Save decisions and merge selected</button></form>`;
}

export function bindCapture(view, record, perform) {
  view.querySelector('#upload-source')?.addEventListener('submit', event => { event.preventDefault(); perform(() => uploadSource(record, event.target.elements.file.files[0]), 'Parsing source...'); });
  view.querySelectorAll('[data-analyze]').forEach(button => button.onclick = () => perform(async () => (await api(`/api/studio/${record.id}/documents/${button.dataset.analyze}/analyze`, { method: 'POST', body: JSON.stringify({ revision: record.revision }) })).record, 'Extracting knowledge with AI...'));
  view.querySelectorAll('[data-refresh-capture]').forEach(button => button.onclick = () => perform(async () => (await api(`/api/studio/${record.id}`)).record, 'Refreshing extraction...'));
  view.querySelectorAll('[data-capture-review]').forEach(form => form.onsubmit = event => {
    event.preventDefault(); const doc = record.documents.find(d => d.id === form.dataset.captureReview);
    const body = { revision: record.revision, reviewer: form.elements.reviewer.value, confirmed: form.elements.confirmed.checked, selections: doc.candidates.flatMap((c, index) => form.elements[`accept-${index}`].checked ? [{ id: c.id, text: form.elements[`text-${index}`].value }] : []) };
    perform(async () => (await api(`/api/studio/${record.id}/documents/${doc.id}/merge`, { method: 'POST', body: JSON.stringify(body) })).record, 'Saving capture decisions...');
  });
}
