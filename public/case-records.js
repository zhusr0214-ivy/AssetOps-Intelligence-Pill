import { api, escapeHtml as e } from './incidents.js';
import { currentUser } from './session.js';

export const canRecord = roles => currentUser()?.roles?.some(r => r === 'admin' || roles.includes(r));
export const caseDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Not recorded';

export function expertRequest(incident) {
  const governed = incident.messages?.find(m => m.role === 'assistant' && m.supervision?.mode === 'expert' && !incident.expertSolutions?.some(s => s.messageId === m.id));
  if (governed) return governed;
  const latest = [...(incident.messages || [])].reverse().find(m => m.role === 'assistant' && m.expertRequest?.required);
  return latest && !(incident.expertSolutions || []).some(s => s.messageId === latest.id) ? latest : null;
}

export function expertMarkup(incident, draft) {
  const request = expertRequest(incident);
  if (!request) return '';
  const pending = incident.expertSolutions?.find(s => s.messageId === request.id);
  const values = draft.messageId === request.id ? draft : pending || {};
  return `<section class="expert-solution expert-entry"><h3 id="expert-solution-heading">Expert solution required</h3>${canRecord(['expert']) ? `<form data-expert-solution data-message-id="${e(request.id)}"><textarea name="solution" aria-labelledby="expert-solution-heading" rows="4" maxlength="4000" required>${e(values.solution || '')}</textarea><button type="submit">Submit experience</button></form>` : '<p>An expert account is required to submit a solution.</p>'}</section>`;
}

export function supervisionMarkup(incident, drafts = {}, messageId) {
  return (incident.messages || []).filter(m => (!messageId || m.id === messageId) && m.supervision?.required && ['review', 'escalation'].includes(m.supervision.mode)).map(m => {
    const request = m.supervision, record = incident.humanConfirmations?.find(c => c.sourceMessageId === m.id && c.decision), draft = drafts[m.id] || {};
    return `<section class="expert-solution"><h3>${request.mode === 'escalation' ? 'Human escalation required' : 'Human review required'}</h3><p>${e(request.subject)}</p><p>${e(request.reason)}</p><small>${(request.pillVersions || []).map(p => `${e(p.id)} / v${e(p.version)}`).join(', ')}</small>${record ? `<p>${e(record.decision)}: ${e(record.subject)}</p><small>${e(record.confirmedBy)} / ${e(caseDate(record.createdAt))}</small>` : canRecord(['reviewer']) ? `<form data-supervision-message="${e(m.id)}"><label>Decision<select name="decision" required><option value="">Select decision</option>${(request.mode === 'escalation' ? ['escalated'] : ['approved', 'rejected', 'escalated']).map(v => `<option value="${v}" ${draft.decision === v ? 'selected' : ''}>${e(v)}</option>`).join('')}</select></label><label>Rationale / handoff record<textarea name="subject" maxlength="3000" rows="3" required>${e(draft.subject || '')}</textarea></label><label class="studio-check"><input name="confirmed" type="checkbox" required ${draft.confirmed ? 'checked' : ''}>I record this decision for this recommendation only, not execution or Pill publication.</label><button type="submit">Record decision</button></form>` : '<p>A reviewer account is required to record this decision.</p>'}</section>`;
  }).join('');
}

export function confirmationMarkup(incident) {
  const requests = (incident.messages || []).filter(m => m.role === 'assistant' && (m.expertRequest?.required || m.supervision?.required));
  const records = incident.humanConfirmations || [];
  return `${!requests.length && !records.length ? '<p>No human-confirmation requests or records.</p>' : ''}
    ${requests.map(m => {
      const response = incident.expertSolutions?.find(s => s.messageId === m.id);
      const decision = records.find(c => c.sourceMessageId === m.id && c.decision);
      return `<article><strong>${decision ? e(decision.decision) : response ? 'Expert response recorded' : m.supervision?.mode === 'review' ? 'Awaiting human review' : m.supervision?.mode === 'escalation' ? 'Awaiting escalation record' : 'Awaiting expert response'}</strong><p>${e(m.supervision?.subject || m.expertRequest.reason)}</p><small>Requested: ${e(caseDate(m.createdAt))}</small>${response ? `<p>${e(response.solution)}</p><small>${e(response.expert)} / ${e(caseDate(response.createdAt))}</small>` : ''}</article>`;
    }).join('')}
    ${records.map(c => `<article><strong>${c.decision ? e(c.decision) : 'Confirmation recorded'}</strong><p>${e(c.subject)}</p><small>${e(c.confirmedBy)} / ${e(caseDate(c.createdAt))}</small></article>`).join('')}
    ${(incident.reviews || []).length ? `<details><summary>Earlier formal review records</summary>${incident.reviews.map(r => `<article><p>${e(r.notes)}</p><small>${e(r.reviewer)} / ${e(r.decision)} / ${e(caseDate(r.createdAt))} / Historical record</small></article>`).join('')}</details>` : ''}`;
}

export function mountCaseRecords(root, onSaved) {
  root.innerHTML = '<details class="case-chat-tool" data-tool="review"><summary>Expert experience confirmation</summary><div data-confirmation-body></div></details><details class="case-chat-tool" data-tool="outcome"><summary>Summary</summary><div data-feedback-body></div></details>';
  let incident = {}, summaryBusy = false, summaryError = '', confirming = false, confirmError = '', experienceCount = 0;
  const feedbackPanel = root.querySelector('[data-tool="outcome"]');
  function paint() {
    if (!root.isConnected) return;
    const confirm = root.querySelector('[data-confirmation-body]');
    confirm.innerHTML = experienceMarkup(incident, confirming) + (confirmError ? `<p role="alert">${e(confirmError)}</p>` : '');
    confirm.querySelectorAll('[data-confirm-experience]').forEach(button => button.onclick = async () => {
      if (confirming) return;
      confirming = true; confirmError = ''; paint();
      try {
        incident = (await api(`/api/cases/${encodeURIComponent(incident.id)}/expert-experience-confirmation`, { method: 'POST', body: JSON.stringify({ solutionId: button.dataset.confirmExperience, revision: incident.revision || 0, confirmed: true }) })).incident;
        if (root.isConnected) onSaved(incident);
      } catch (error) {
        confirmError = error.message;
        try {
          const latest = (await api(`/api/incidents/${encodeURIComponent(incident.id)}`)).incident;
          if (root.isConnected) { incident = latest; onSaved(incident); }
        } catch { /* Keep the saved experience visible when refresh also fails. */ }
      }
      finally { confirming = false; if (root.isConnected) paint(); }
    });
    const summary = incident.resultFeedback;
    root.querySelector('[data-feedback-body]').innerHTML = `${summary ? `<p>${e(summary.summary.replace(/\s+/g, ' ').trim())}</p>` : '<p>No summary yet.</p>'}
      ${summaryBusy ? '<p role="status">Summarizing conversation...</p>' : ''}${summaryError ? `<p role="alert">${e(summaryError)}</p><button type="button" data-retry-summary>Retry summary</button>` : ''}`;
    root.querySelector('[data-retry-summary]')?.addEventListener('click', summarize);
  }
  async function summarize() {
    if (!root.isConnected || !incident.id || summaryBusy || !feedbackPanel.open || incident.messages?.some(m => m.role === 'user' && m.state && m.state !== 'complete') || incident.resultFeedback?.caseRevision === incident.revision || !canRecord(['operator', 'expert', 'reviewer'])) return;
    summaryBusy = true; summaryError = ''; paint();
    try {
      const result = await api(`/api/cases/${encodeURIComponent(incident.id)}/result-summary`, { method: 'POST', body: '{}' });
      incident = result.incident; if (root.isConnected) onSaved(incident);
    } catch (error) { summaryError = error.message; }
    finally { summaryBusy = false; if (root.isConnected) paint(); }
  }
  feedbackPanel.addEventListener('toggle', summarize);
  return { update(next) { incident = next; const count = next.expertSolutions?.length || 0; if (count > experienceCount) root.querySelector('[data-tool="review"]').open = true; experienceCount = count; paint(); void summarize(); }, open(key) { const panel = root.querySelector(`[data-tool="${key}"]`); if (panel) panel.open = true; } };
}

export function experienceMarkup(incident, busy = false) {
  return (incident.expertSolutions || []).map(s => `<article><p>${e(s.solution)}</p><small>${e(s.expert)} / ${e(caseDate(s.createdAt))}</small>${s.improvementBatchId?`<a href="/studio/improvements/${e(incident.id)}/${e(s.improvementBatchId)}">Review improvement proposal</a>`:s.pillDraftId ? `<a href="/studio/${e(s.pillDraftId)}">Open Pill draft</a>` : canRecord(['expert']) ? `<button type="button" data-confirm-experience="${e(s.id)}" ${busy ? 'disabled' : ''}>Confirm &amp; prepare improvements</button>` : '<p>Awaiting expert confirmation.</p>'}${s.experienceConfirmation?`<small>Confirmed by ${e(s.experienceConfirmation.name)} / ${e(caseDate(s.experienceConfirmation.at))}</small>`:''}</article>`).join('') || '<p>No expert experience recorded.</p>';
}
