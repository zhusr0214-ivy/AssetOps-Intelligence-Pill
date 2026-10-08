import { api, labels, priorities, categories, options, escapeHtml as e, details } from './incidents.js';

export function visibleAssistantText(message, incident) {
  if (message.role !== 'assistant' || !incident.priority || message !== incident.messages?.at(-1)) return message.content;
  return message.content.replace(/Please choose Priority in the summary\.|\u8bf7\u5728\u6458\u8981\u4e2d\u9009\u62e9 Priority。/g, '').trim();
}


export function recentMessages(incident) {
  const messages = incident.messages || [];
  const render = items => items.map(message => `<article class="message ${message.role === 'user' ? 'user' : 'assistant'}"><strong>${message.role === 'user' ? 'You' : 'Intake assistant'}</strong><p>${e(visibleAssistantText(message, incident))}</p>${message.state && message.state !== 'complete' ? `<small>${message.state === 'failed' ? 'Analysis failed. Message saved.' : 'Awaiting analysis'}</small>` : ''}</article>`).join('');
  return `${messages.length > 4 ? `<details class="conversation-history"><summary>Earlier messages (${messages.length - 4})</summary>${render(messages.slice(0, -4))}</details>` : ''}${render(messages.slice(-4))}`;
}

export function renderConversation(view, initial, navigate) {
  let incident = initial;
  let draftText = '';
  let busy = false;
  let errorText = '';
  let notice = '';
  let summaryDraft = {};
  const pending = () => incident.messages?.find(message => message.role === 'user' && message.state !== 'complete');
  const missing = () => ['description', 'location', 'priority', 'occurredAt', 'impact'].filter(key => !incident[key]);
  async function run(operation, message) {
    if (busy) return;
    busy = true; errorText = ''; notice = message;
    paint();
    try { await operation(); notice = 'Saved'; }
    catch (error) {
      errorText = error.message; notice = '';
      if (incident.id) {
        try { incident = (await api(`/api/incidents/${incident.id}`)).incident; }
        catch { /* Preserve the visible case if the refresh also fails. */ }
      }
    } finally { busy = false; if (view.isConnected) paint(); }
  }
  async function patch(data) {
    incident = (await api(`/api/incidents/${incident.id}`, { method: 'PATCH', body: JSON.stringify({ ...data, revision: incident.revision || 0 }) })).incident;
  }
  function paint() {
    const waiting = pending();
    const complete = missing().length === 0 && !incident.conflicts?.length && !waiting && !Object.keys(summaryDraft).length;
    view.innerHTML = `<a class="back-link" href="/incidents"><span class="back-arrow" aria-hidden="true">&larr;</span>Back to incidents</a>
      <header class="workspace-heading"><div><p class="eyebrow">${e(incident.id || 'Case intake')}</p><h2>${incident.id ? 'Incident intake' : 'New incident'}</h2></div><span class="save-status" role="status">${e(notice)}</span></header>
      <p class="form-error" role="alert" ${errorText ? '' : 'hidden'}>${e(errorText)}</p>
      <nav class="section-jumps" aria-label="Intake sections"><a href="#message-form">Write a message</a><a href="#case-summary">Case summary / confirm</a></nav><div class="conversation-layout" aria-busy="${busy}">
        <section class="conversation-main" aria-label="Incident conversation"><h3>Conversation</h3>
          <div class="message-log" role="log" aria-label="Case messages">
            <article class="message assistant"><strong>Intake assistant</strong><p>Please describe the incident, including its location, symptoms, and any known readings or actions already taken.</p></article>
            ${recentMessages(incident)}
          </div>
          ${waiting ? `<div class="retry-row"><span>Message saved. ${busy ? 'Analyzing...' : 'Analysis incomplete.'}</span><button type="button" id="retry-message" ${busy ? 'disabled' : ''}>Retry analysis</button></div>` : ''}
          <form id="message-form" class="message-composer"><label for="case-message">Message<textarea id="case-message" maxlength="6000" rows="3" required ${busy || waiting ? 'disabled' : ''} placeholder="Describe the issue or add an update">${e(draftText)}</textarea></label><div class="actions"><button class="primary" type="submit" ${busy || waiting ? 'disabled' : ''}>Send message</button></div></form>
        </section>
        <aside id="case-summary" class="case-summary" aria-label="Incident summary"><h3>Case summary</h3>
          <label for="case-priority">Priority<select id="case-priority" ${busy ? 'disabled' : ''}>${options(priorities, incident.priority, 'Select priority')}</select></label>
          ${(incident.conflicts || []).map((item, index) => `<div class="field-conflict"><strong>Confirm ${e(labels[item.field])}</strong><p>Current: ${e(item.current || 'Not provided')}<br>New: ${e(item.proposed)}</p><div class="actions"><button data-conflict="${index}" data-choice="current" ${busy ? 'disabled' : ''}>Keep current</button><button data-conflict="${index}" data-choice="proposed" ${busy ? 'disabled' : ''}>Use new value</button></div></div>`).join('')}
          ${details(incident)}
          ${incident.id ? `<details class="summary-editor" ${Object.keys(summaryDraft).length ? 'open' : ''}><summary>Edit summary</summary><form id="summary-form"><fieldset ${busy ? 'disabled' : ''}>${Object.entries(labels).filter(([key]) => key !== 'priority').map(([key, label]) => `<label>${label}${key === 'category' ? `<select name="${key}">${options(categories, summaryDraft[key] ?? incident[key], 'Unclassified')}</select>` : `<textarea name="${key}" maxlength="6000" rows="${key === 'description' ? 3 : 1}">${e(summaryDraft[key] ?? incident[key])}</textarea>`}</label>`).join('')}<button type="submit">Save changes</button></fieldset></form></details>` : ''}
          <div class="summary-submit"><p>${missing().length ? `Still needed: ${missing().map(key => labels[key]).join(', ')}` : incident.conflicts?.length ? 'Resolve the highlighted information.' : waiting ? 'Complete message analysis before submitting.' : 'Ready for your confirmation.'}</p><button id="confirm-case" class="primary" ${busy || !complete || !incident.id ? 'disabled' : ''}>Confirm &amp; submit</button></div>
        </aside>
      </div>`;
    view.querySelector('#case-message').oninput = event => { draftText = event.target.value; };
    view.querySelector('#message-form').onsubmit = event => {
      event.preventDefault();
      const content = draftText.trim();
      if (!content) return;
      const requestId = crypto.randomUUID();
      run(async () => {
        if (!incident.id) {
          incident = (await api('/api/incidents', { method: 'POST', body: JSON.stringify({ description: content, priority: incident.priority || '' }) })).incident;
          if (view.isConnected) window.history.replaceState({}, '', `/incidents/${incident.id}/edit`);
        }
        try {
          incident = (await api(`/api/incidents/${incident.id}/messages`, { method: 'POST', body: JSON.stringify({ content, requestId }) })).incident;
          draftText = '';
        } catch (error) {
          incident = (await api(`/api/incidents/${incident.id}`)).incident;
          if (incident.messages?.some(message => message.requestId === requestId)) draftText = '';
          throw error;
        }
      }, 'Analyzing message...');
    };
    view.querySelector('#retry-message')?.addEventListener('click', () => run(async () => {
      incident = (await api(`/api/incidents/${incident.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: waiting.requestId, retry: true }) })).incident;
    }, 'Retrying analysis...'));
    view.querySelector('#case-priority').onchange = event => {
      const priority = event.target.value;
      if (!incident.id) { incident.priority = priority; return; }
      run(() => patch({ priority }), 'Saving priority...');
    };
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
    view.querySelector('#confirm-case').onclick = () => run(async () => {
      await api(`/api/incidents/${incident.id}/finalize`, { method: 'POST', body: JSON.stringify({ revision: incident.revision || 0 }) });
      if (view.isConnected) navigate(`/incidents/${incident.id}`);
    }, 'Submitting...');

  }
  paint();
}
