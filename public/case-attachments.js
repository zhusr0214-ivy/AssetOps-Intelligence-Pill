import { api, escapeHtml as e } from './incidents.js';
import { csrfHeaders } from './session.js';

export function attachmentMarkup(incident, selected = [], busy = false) {
  return `<div class="case-attachments"><details class="attachment-menu"><summary aria-label="Add attachment" title="Add attachment">+</summary><div class="attachment-popover"><button type="button" data-select-file ${busy ? 'disabled' : ''}>Add photos &amp; files</button><small>PDF, DOCX, TXT, MD, PNG, JPG · up to 10 MB</small><input type="file" data-case-file aria-label="Upload attachment" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" hidden ${busy ? 'disabled' : ''}></div></details>
    ${(incident.caseDocuments || []).map(d => `<details><summary>${e(d.filename)}</summary><label class="attachment-choice"><input type="checkbox" data-document-id="${e(d.id)}" ${selected.includes(d.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>Use for this question</label>${d.warnings.map(w => `<p class="triage-notice">${e(w)}</p>`).join('')}<small>Reference material, not approved Pill knowledge. Extracted text is saved; the original file is not retained.</small>${d.blocks.map(b => `<details><summary>${e(b.location)} / ${e(b.id)}</summary><pre class="attachment-text">${e(b.text)}</pre></details>`).join('')}</details>`).join('')}
    ${selected.length ? '<p class="attachment-mode" role="status">Selected files are reference material, not confirmed case facts or approved Pills.</p>' : ''}</div>`;
}
export function compactComposer(root) {
  const form = root.querySelector('#message-form, #triage-chat-form');
  const attachments = root.querySelector('.case-attachments');
  if (!form || !attachments) return;
  form.classList.add('chat-input-bar');
  form.prepend(attachments.querySelector('.attachment-menu'));
  const popover = form.querySelector('.attachment-popover');
  while (attachments.firstChild) popover.append(attachments.firstChild);
  attachments.remove();
  form.querySelector('[data-select-file]').onclick = () => form.querySelector('[data-case-file]').click();
  const textarea = form.querySelector('textarea');
  textarea.rows = 1; textarea.placeholder = 'Ask Pill Assistant';
  textarea.setAttribute('aria-label', 'Message or attachment question');
  const button = form.querySelector('[type="submit"]');
  if (button) { button.classList.add('chat-send'); button.textContent = 'Send message'; }
  let composing = false;
  textarea.addEventListener('compositionstart', () => { composing = true; });
  textarea.addEventListener('compositionend', () => { composing = false; });
  textarea.onkeydown = event => {
    if (event.key !== 'Enter' || event.shiftKey || composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat || textarea.disabled || !textarea.value.trim() || !button || button.disabled) return;
    form.requestSubmit(button);
  };
}
export function documentMessagesMarkup(incident) {
  return (incident.documentMessages || []).map(m => `<article class="message ${m.role === 'user' ? 'user' : 'assistant'}"><strong>${m.role === 'user' ? 'You · attachment question' : 'Attachment assistant'}</strong><p>${e(m.content)}</p>${m.citations?.length ? `<details><summary>Attachment citations</summary>${m.citations.map(c => `<blockquote><strong>${e(c.filename)} / ${e(c.location)}</strong><p>${e(c.quote)}</p></blockquote>`).join('')}</details>` : ''}</article>`).join('');
}
export async function uploadCaseFile(id, file) {
  if (!file || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Select a nonempty file up to 10 MB.');
  const response = await fetch(`/api/incidents/${encodeURIComponent(id)}/documents`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Attachment upload failed.'); return data.incident;
}
export async function askCaseDocuments(id, question, documentIds) {
  return (await api(`/api/incidents/${encodeURIComponent(id)}/document-questions`, { method: 'POST', body: JSON.stringify({ question, documentIds }) })).incident;
}
