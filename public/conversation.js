import { api, labels, categories, options, escapeHtml as e, details } from './incidents.js';
import { attachmentMarkup, documentMessagesMarkup, uploadCaseFile, compactComposer } from './case-attachments.js';
import { expertMarkup, supervisionMarkup } from './case-records.js';

export function visibleAssistantText(message, incident) {
  if (message.role !== 'assistant') return message.content;
  return message.content
    .replace(/^\s*(?:The case summary is updated\.|已更新事件摘要。)\s*/u, '')
    .replace(/Please choose Priority in the summary\.|\u8bf7\u5728\u6458\u8981\u4e2d\u9009\u62e9 Priority。/g, '').trim();
}


export function recentMessages(incident, supervisionDrafts) {
  const messages = incident.messages || [];
  const render = items => items.map(message => `<article class="message ${message.role === 'user' ? 'user' : 'assistant'}" aria-label="${message.role === 'user' ? 'You' : 'Assistant'}"><p>${e(visibleAssistantText(message, incident))}</p>${message.role === 'assistant' ? caseReferences(message) : ''}${message.state && message.state !== 'complete' ? `<small>${message.state === 'failed' ? 'Reply failed. Message saved.' : 'Awaiting reply'}</small>` : ''}</article>${supervisionDrafts && message.supervision ? supervisionMarkup(incident, supervisionDrafts, message.id) : ''}`).join('');
  return `${messages.length > 4 ? `<details class="conversation-history"><summary>Earlier messages (${messages.length - 4})</summary>${render(messages.slice(0, -4))}</details>` : ''}${render(messages.slice(-4))}`;
}

function caseReferences(message) {
  return `${message.matchedPills?.length ? `<div class="pill-citations">${message.matchedPills.map(p => `<span class="badge">${e(p.name)} / v${e(p.version)}</span>`).join('')}</div>` : ''}
    ${message.citations?.length ? `<details class="chat-evidence"><summary>Sources (${message.citations.length})</summary>${message.citations.map(c => `<blockquote><strong>${e(c.kind === 'pill' ? `${c.name} / v${c.version}` : `${c.filename} / ${c.location}`)}</strong><p>${e(c.quote)}</p></blockquote>`).join('')}</details>` : ''}`;
}

export function renderConversation(view, initial, navigate, { compact = false, onChange } = {}) {
  let incident = initial;
  let draftText = '';
  let busy = false;
  let handedOff = false;
  let errorText = '';
  let notice = '';
  let summaryDraft = {};
  let summaryOpen = false;
  let selectedDocuments = [];
  let expertDraft = {};
  const supervisionDrafts = {};
  const pending = () => incident.messages?.find(message => message.role === 'user' && message.state !== 'complete');
  const missing = () => ['description', 'location', 'occurredAt', 'impact'].filter(key => !incident[key]);
  async function run(operation, message) {
    if (busy) return;
    busy = true; errorText = ''; notice = message;
    paint();
    let saved = false;
    try { await operation(); notice = 'Saved'; saved = true; }
    catch (error) {
      errorText = error.message; notice = '';
      if (incident.id) {
        try { incident = (await api(`/api/incidents/${incident.id}`)).incident; }
        catch { /* Preserve the visible case if the refresh also fails. */ }
      }
    } finally { busy = false; if (view.isConnected && !handedOff) paint(); }
    if (saved && view.isConnected) onChange?.(incident);
  }
  async function patch(data) {
    incident = (await api(`/api/incidents/${incident.id}`, { method: 'PATCH', body: JSON.stringify({ ...data, revision: incident.revision || 0 }) })).incident;
  }
  function paint() {
    const waiting = pending();
    const complete = missing().length === 0 && !incident.conflicts?.length && !waiting && !Object.keys(summaryDraft).length;
    view.innerHTML = `${compact ? '' : '<a class="back-link" href="/incidents"><span class="back-arrow" aria-hidden="true">&larr;</span>Back to incidents</a>'}
      <header class="workspace-heading"><div class="${incident.id ? 'case-record-heading' : 'case-page-title'}"><p class="eyebrow">${e(incident.id || 'Case intake')}</p><h2>${incident.id ? e(incident.title || incident.id) : 'New incident'}</h2></div><span class="save-status" role="status">${e(notice)}</span></header>
      <p class="form-error" role="alert" ${errorText ? '' : 'hidden'}>${e(errorText)}</p>
      ${compact ? '' : '<nav class="section-jumps" aria-label="Intake sections"><a href="#message-form">Write a message</a><a href="#case-summary">Case summary / confirm</a></nav>'}<div class="conversation-layout${compact ? ' conversation-compact' : ''}" aria-busy="${busy}">
        <section class="conversation-main" aria-label="Incident conversation">
          <div class="message-log" role="log" aria-label="Case messages">
            ${recentMessages(incident, compact ? supervisionDrafts : undefined)}${documentMessagesMarkup(incident)}${compact ? expertMarkup(incident, expertDraft) : ''}
          </div>
          ${waiting ? `<div class="retry-row"><span>Message saved. ${busy ? 'Analyzing...' : 'Analysis incomplete.'}</span><button type="button" id="retry-message" ${busy ? 'disabled' : ''}>Retry analysis</button></div>` : ''}
          ${attachmentMarkup(incident, selectedDocuments, busy || Boolean(waiting))}
          <form id="message-form" class="message-composer"><label for="case-message">${selectedDocuments.length ? 'Question about selected files' : 'Message'}<textarea id="case-message" maxlength="${selectedDocuments.length ? 2000 : 6000}" rows="3" required ${busy || waiting ? 'disabled' : ''} placeholder="Describe the issue or ask about an attachment">${e(draftText)}</textarea></label><div class="actions"><button class="primary" type="submit" ${busy || waiting ? 'disabled' : ''}>Send message</button></div></form>
        </section>
        <${compact ? 'details' : 'aside'} id="case-summary" class="case-summary" aria-label="Incident summary" ${compact && (summaryOpen || complete || incident.conflicts?.length) ? 'open' : ''}>${compact ? '<summary>Case facts & confirmation</summary>' : '<h3>Case summary</h3>'}
          ${(incident.conflicts || []).map((item, index) => `<div class="field-conflict"><strong>Confirm ${e(labels[item.field])}</strong><p>Current: ${e(item.current || 'Not provided')}<br>New: ${e(item.proposed)}</p><div class="actions"><button data-conflict="${index}" data-choice="current" ${busy ? 'disabled' : ''}>Keep current</button><button data-conflict="${index}" data-choice="proposed" ${busy ? 'disabled' : ''}>Use new value</button></div></div>`).join('')}
          ${details(incident)}
          ${incident.id ? `<details class="summary-editor" ${Object.keys(summaryDraft).length ? 'open' : ''}><summary>Edit summary</summary><form id="summary-form"><fieldset ${busy ? 'disabled' : ''}>${Object.entries(labels).filter(([key]) => key !== 'priority').map(([key, label]) => `<label>${label}${key === 'category' ? `<select name="${key}">${options(categories, summaryDraft[key] ?? incident[key], 'Unclassified')}</select>` : `<textarea name="${key}" maxlength="6000" rows="${key === 'description' ? 3 : 1}">${e(summaryDraft[key] ?? incident[key])}</textarea>`}</label>`).join('')}<button type="submit">Save changes</button></fieldset></form></details>` : ''}
          <div class="summary-submit"><p>${missing().length ? `Still needed: ${missing().map(key => labels[key]).join(', ')}` : incident.conflicts?.length ? 'Resolve the highlighted information.' : waiting ? 'Complete message analysis before submitting.' : 'Ready for your confirmation.'}</p><button id="confirm-case" class="primary" ${busy || !complete || !incident.id ? 'disabled' : ''}>Confirm &amp; submit</button></div>
        </${compact ? 'details' : 'aside'}>
      </div>`;
    if (compact) {
      const summary = view.querySelector('#case-summary');
      const log = view.querySelector('.message-log');
      summary.querySelectorAll('.field-conflict').forEach(el => log.append(el));
      summary.remove();
    }
    view.querySelectorAll('[data-supervision-message]').forEach(form => {
      const id = form.dataset.supervisionMessage;
      const capture = () => { supervisionDrafts[id] = { ...Object.fromEntries(new FormData(form)), confirmed: form.elements.confirmed.checked }; };
      form.oninput = capture;
      form.onsubmit = event => {
        event.preventDefault(); capture();
        run(async () => {
          incident = (await api(`/api/cases/${encodeURIComponent(incident.id)}/confirmations`, { method: 'POST', body: JSON.stringify({ ...supervisionDrafts[id], messageId: id, revision: incident.revision || 0 }) })).incident;
          delete supervisionDrafts[id];
        }, 'Recording decision...');
      };
      form.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = busy; });
    });
    const expertForm = view.querySelector('[data-expert-solution]');
    if (expertForm) {
      const capture = () => {
        const messageId = expertForm.dataset.messageId;
        const pendingImport = incident.expertSolutions?.find(s => s.messageId === messageId && !s.pillDraftId);
        expertDraft = { ...Object.fromEntries(new FormData(expertForm)), messageId, requestId: pendingImport?.requestId || (expertDraft.messageId === messageId && expertDraft.requestId) || crypto.randomUUID() };
      };
      expertForm.oninput = capture;
      expertForm.onsubmit = event => {
        event.preventDefault(); capture();
        run(async () => {
          incident = (await api(`/api/cases/${encodeURIComponent(incident.id)}/expert-solutions`, { method: 'POST', body: JSON.stringify({ ...expertDraft, confirmed: true, revision: incident.revision || 0 }) })).incident;
          expertDraft = {};
        }, 'Saving expert solution...');
      };
      expertForm.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = busy; });
    }
    compactComposer(view);
    view.querySelector('#case-message').oninput = event => { draftText = event.target.value; };
    view.querySelectorAll('[data-document-id]').forEach(input => input.onchange = () => {
      selectedDocuments = [...view.querySelectorAll('[data-document-id]:checked')].map(el => el.dataset.documentId); paint();
    });
    view.querySelector('[data-case-file]').onchange = event => {
      const file = event.target.files[0]; if (!file) return;
      run(async () => {
        if (!incident.id) {
          incident = (await api('/api/incidents', { method: 'POST', body: JSON.stringify({ description: `Attachment query: ${file.name}` }) })).incident;
          if (view.isConnected) window.history.replaceState({}, '', `/cases/${incident.id}/edit`);
        }
        incident = await uploadCaseFile(incident.id, file);
        selectedDocuments = [incident.caseDocuments.at(-1).id];
      }, 'Reading attachment...');
    };
    view.querySelector('#message-form').onsubmit = event => {
      event.preventDefault();
      const content = draftText.trim();
      if (!content) return;
      const requestId = crypto.randomUUID();
      run(async () => {
        if (!incident.id) {
          incident = (await api('/api/incidents', { method: 'POST', body: JSON.stringify({ description: content }) })).incident;
          if (view.isConnected) window.history.replaceState({}, '', `/incidents/${incident.id}/edit`);
        }
        try {
          incident = (await api(`/api/incidents/${incident.id}/messages`, { method: 'POST', body: JSON.stringify({ content, requestId, documentIds: selectedDocuments }) })).incident;
          draftText = '';
        } catch (error) {
          incident = (await api(`/api/incidents/${incident.id}`)).incident;
          if (incident.messages?.some(message => message.requestId === requestId)) draftText = '';
          throw error;
        }
      }, 'Preparing reply...');
    };
    view.querySelector('#retry-message')?.addEventListener('click', () => run(async () => {
      incident = (await api(`/api/incidents/${incident.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: waiting.requestId, retry: true }) })).incident;
    }, 'Retrying reply...'));
    view.querySelector('#summary-form')?.addEventListener('input', event => {
      if (event.target.name) summaryDraft[event.target.name] = event.target.value;
      view.querySelector('#confirm-case').disabled = true;
    });
    view.querySelector('#summary-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target));
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value.trim() !== (incident[key] || '')));
      run(async () => { await patch(changed); summaryDraft = {}; }, 'Saving changes...');
    });
    view.querySelectorAll('[data-conflict]').forEach(button => button.onclick = () => {
      const item = incident.conflicts[Number(button.dataset.conflict)];
      run(() => patch({ [item.field]: item[button.dataset.choice] }), 'Saving confirmation...');
    });
    const confirmButton = view.querySelector('#confirm-case');
    if (confirmButton) confirmButton.onclick = () => run(async () => {
      await api(`/api/incidents/${incident.id}/finalize`, { method: 'POST', body: JSON.stringify({ revision: incident.revision || 0 }) });
      if (view.isConnected) {
        handedOff = true;
        try { await navigate(`/incidents/${incident.id}`); }
        catch (failure) { handedOff = false; throw failure; }
      }
    }, 'Submitting...');

  }
  paint();
  return { update(next) { if (!busy) { incident = next; paint(); } } };
}
