import { api, escapeHtml as e, priorities } from './incidents.js';
import { nextStepMarkup } from './workflow.js';

export const reviewLabels = { pending: 'Pending review', outdated: 'Outdated', approve: 'Plan approved', approve_with_changes: 'Approved with changes', request_information: 'Awaiting information', reanalyze: 'Re-analysis requested', escalate: 'Referred to specialist', reject: 'Plan rejected' };
const decisionLabels = { approve: 'Approve advisory plan', approve_with_changes: 'Approve with changes', request_information: 'Request information', reanalyze: 'Request re-analysis', escalate: 'Refer to specialist', reject: 'Reject plan' };
const back = '<a class="back-link" href="/review">&larr; Back to review queue</a>';
const selectOptions = values => Object.entries(values).map(([value, label]) => `<option value="${e(value)}">${e(label)}</option>`).join('');

export function reviewMarkup(data) {
  const { incident: i, report: r, package: p } = data;
  const previous = i.reviews?.find(review => review.reportId === r.id);
  const next = p.stale ? { title: 'Review evidence is outdated', detail: 'The current case requires a fresh analysis before a new approval.', href: `/cases/${encodeURIComponent(i.id)}/triage`, action: 'Open analysis', blocked: true }
    : ['approve', 'approve_with_changes'].includes(data.state) ? { title: 'Advisory plan reviewed', detail: 'Record what was actually done and verify the operational outcome. Approval alone is not resolution.', href: `/cases/${encodeURIComponent(i.id)}/handling`, action: 'Record handling and outcome' }
    : data.state === 'request_information' ? { title: 'Information requested', detail: 'Update the case facts before resubmitting the analysis.', href: `/cases/${encodeURIComponent(i.id)}/edit`, action: 'Update case facts', blocked: true }
    : data.state === 'reanalyze' ? { title: 'New analysis requested', detail: 'The recorded review requires a new analysis before another decision.', href: `/cases/${encodeURIComponent(i.id)}/triage`, action: 'Open analysis', blocked: true }
    : ['reject', 'escalate'].includes(data.state) ? { title: data.state === 'reject' ? 'Plan rejected' : 'Referred to specialist', detail: 'The saved decision does not authorize the proposed plan. Follow the recorded rationale and capture specialist handling when available.', href: `/cases/${encodeURIComponent(i.id)}/handling`, action: 'Record follow-up', blocked: true }
    : { title: p.canApprove ? 'Human decision required' : 'Approval blocked', detail: p.canApprove ? 'Check the recommendations and evidence below. No equipment operation is automatic.' : 'Review the blocking findings below; request information, re-analysis or specialist escalation as appropriate.', blocked: !p.canApprove };
  return `${back}<header class="workspace-heading"><div><p class="eyebrow">${e(i.id)}</p><h2>${e(i.title)}</h2></div><span class="badge">${e(reviewLabels[data.state])}</span></header>
    ${nextStepMarkup(next)}
    <div class="detail-meta"><span>${e(i.asset || 'Unconfirmed asset')} / ${e(i.location)}</span><span>User priority: ${e(priorities[i.priority])}</span><a href="/incidents/${e(i.id)}">Case details</a><a href="/triage/${e(i.id)}">Full analysis and evidence</a></div>
    <section class="triage-section"><h3>Review essentials</h3><p>${e(r.summary || r.error)}</p><ul>${p.findings.filter(f => f.code !== 'uncertainty').map(f => `<li>${f.severity === 'block' ? '<strong>Approval blocked:</strong> ' : ''}${e(f.message)}</li>`).join('')}${[...new Set((r.hypotheses || []).flatMap(h => h.uncertainties || []))].map(v => `<li>${e(v)}</li>`).join('')}${(r.questions || []).map(q => `<li>${e(q.question)}</li>`).join('')}</ul><small>${e(r.pill?.name || 'No matching Pill')} / ${e(p.pillVersion)}</small></section>
    ${previous ? '<p class="triage-notice" role="status">This report has been reviewed. A new analysis is required for a new decision.</p>' : p.stale ? '<p class="triage-notice">Confirm the latest intake and run a new analysis before reviewing.</p>' : `<form id="review-form" class="triage-section"><h3>Review decision</h3>
      <div class="review-grid"><label>Reviewer name (signed-in)<input name="reviewer" maxlength="100" required></label><label>Assessment of AI analysis<select name="assessment" required><option value="">Select assessment</option><option value="accepted">Supported</option><option value="partly_supported">Partly supported</option><option value="unsupported">Unsupported</option></select></label></div>
      <label class="review-check"><input type="checkbox" name="factsVerified">I verified the case facts and considered the remaining uncertainties.</label>
      ${r.coordination?.required ? '<fieldset><legend>Cross-Pill reconciliation</legend><label class="review-check"><input type="checkbox" name="coordinationConfirmed">I checked cross-domain dependencies and excluded incompatible actions.</label><label>Reconciliation / escalation notes<textarea name="coordinationNotes" maxlength="2000"></textarea></label></fieldset>' : ''}
      <h4>Action decisions</h4>${p.actions.map((a, n) => `<div class="review-action"><strong>${e(a.title)}</strong><span class="badge">${e(a.classification.replaceAll('_', ' '))}</span><p>${e(a.instruction)}</p><label>Decision<select name="action-${n}" required><option value="">Select decision</option>${a.classification !== 'prohibited' ? '<option value="accept">Include in plan</option>' : ''}<option value="omit">Do not include</option></select></label><div data-omission="${n}" hidden><label>Reason for omission<textarea name="reason-${n}" maxlength="1000" rows="2"></textarea></label></div></div>`).join('') || '<p>No proposed actions.</p>'}
      <details><summary>Propose an additional or revised action</summary><label>Action proposal<textarea name="proposals" maxlength="3000" rows="3"></textarea></label><p class="muted-label">Pending expert validation; excluded from the approved plan.</p></details>
      <div class="review-grid"><label>Final decision<select name="decision" required><option value="">Select decision</option>${Object.entries(decisionLabels).map(([v, l]) => `<option value="${v}" ${!p.canApprove && v.startsWith('approve') ? 'disabled' : ''}>${l}</option>`).join('')}</select></label><label>Responsible owner<input name="owner" maxlength="100"></label></div>
      <label>Decision rationale / corrections<textarea name="notes" maxlength="3000" rows="3" required></textarea></label><div id="review-questions" hidden><label>Questions to return to intake<textarea name="questions" maxlength="2000" rows="3"></textarea></label></div><p class="form-error" role="alert" hidden></p><button class="primary" type="submit">Submit review</button></form>`}
    ${previous ? `<section class="triage-section"><h3>Recorded decision</h3><p>${e(reviewLabels[previous.decision])} / ${e(previous.reviewer)}</p><p>${e(previous.notes)}</p>${previous.questions ? `<p>${e(previous.questions)}</p>` : ''}</section>` : ''}
    <details class="triage-section"><summary>Review history (${i.reviews?.length || 0})</summary>${[...(i.reviews || [])].reverse().map(v => `<article class="review-history"><h4>${e(reviewLabels[v.decision])}</h4><p>${e(v.reviewer)} ${v.identityVerified ? '(authenticated)' : '(legacy unverified)'} / ${e(v.createdAt)}</p><p>${e(v.notes)}</p><p>Analysis: ${e(v.assessment)} / Owner: ${e(v.owner || 'Not assigned')}</p>${v.questions ? `<p>Information requested: ${e(v.questions)}</p>` : ''}<ul>${v.actions.map(a => `<li>${e(a.title)}: ${e(a.choice)} ${e(a.reason)}</li>`).join('')}</ul>${v.proposals ? `<p>Pending validation: ${e(v.proposals)}</p>` : ''}<small>${e(v.id)} / ${e(v.reportId)} / Pill ${e(v.governance.pillVersion)}${v.reportId !== r.id || v.caseFingerprint !== p.caseFingerprint || p.stale ? ' / Historical decision; not current authorization' : ''}</small></article>`).join('') || '<p>No decisions recorded.</p>'}</details>`;
}

export async function renderReview(root, pathname) {
  const view = document.createElement('section'); view.className = 'incident-workspace'; root.replaceChildren(view);
  view.innerHTML = '<p role="status">Loading reviews...</p>';
  try {
    const id = pathname.match(/^\/review\/([^/]+)$/)?.[1];
    if (!id) {
      const { cases } = await api('/api/review'); if (!view.isConnected) return;
      view.innerHTML = `<header class="workspace-heading"><h2 class="case-page-title">Review queue</h2></header><div class="list-toolbar"><label>Search<input id="review-search" type="search" placeholder="Case, asset or location"></label><label>Review status<select id="review-filter"><option value="">All reviews</option>${selectOptions(reviewLabels)}</select></label></div><p class="result-count" role="status"></p><div class="table-scroll"><table class="incident-table"><thead><tr><th>Case</th><th>Asset / Location</th><th>Priority</th><th>AI report</th><th>Review</th><th>Submitted</th></tr></thead><tbody></tbody></table></div>`;
      const update = () => {
        const query = view.querySelector('input').value.toLowerCase(); const filter = view.querySelector('select').value;
        const rows = cases.filter(c => (!filter || c.state === filter) && [c.id, c.title, c.asset, c.location].join(' ').toLowerCase().includes(query));
        view.querySelector('.result-count').textContent = `${rows.length} cases`;
        view.querySelector('tbody').innerHTML = rows.map(c => `<tr><td><a href="/review/${e(c.id)}">${e(c.title)}</a><small>${e(c.id)}</small></td><td>${e(c.asset)}<small>${e(c.location)}</small></td><td>${e(priorities[c.priority])}</td><td>${e(c.reportStatus)}</td><td>${e(reviewLabels[c.state])}</td><td>${e(new Date(c.submittedAt).toLocaleString())}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">No matching reviews.</td></tr>';
      }; view.querySelectorAll('input,select').forEach(el => el.oninput = update); update(); return;
    }
    const data = await api(`/api/review/${encodeURIComponent(id)}`); if (!view.isConnected) return;
    view.innerHTML = reviewMarkup(data);
    const form = view.querySelector('#review-form');
    if (form) {
      const updateFields = () => {
        data.package.actions.forEach((a, n) => {
          const omitted = form.elements[`action-${n}`].value === 'omit';
          form.querySelector(`[data-omission="${n}"]`).hidden = !omitted;
          form.elements[`reason-${n}`].required = omitted;
        });
        const decision = form.elements.decision.value;
        const needsInformation = decision === 'request_information';
        form.querySelector('#review-questions').hidden = !needsInformation;
        form.elements.questions.required = needsInformation;
        form.elements.owner.required = decision.startsWith('approve') || decision === 'escalate';
      };
      form.addEventListener('change', updateFields);
      updateFields();
    }
    form?.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button'); if (button.disabled) return;
      const values = Object.fromEntries(new FormData(form));
      const payload = { ...values, revision: data.incident.revision || 0, reportId: data.report.id, factsVerified: form.elements.factsVerified.checked, actions: data.package.actions.map((a, n) => ({ id: a.id, choice: values[`action-${n}`], reason: values[`reason-${n}`] })) };
      payload.coordinationConfirmed = form.elements.coordinationConfirmed?.checked === true;
      button.disabled = true; const error = form.querySelector('.form-error'); error.hidden = true;
      try { await api(`/api/review/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(payload) }); if (view.isConnected) await renderReview(root, pathname); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; button.disabled = false; }
    });
  } catch (error) { if (view.isConnected) view.innerHTML = `${back}<p class="form-error" role="alert">${e(error.message)}</p>`; }
}

export async function renderLearning(root) {
  const view = document.createElement('section'); view.className = 'incident-workspace'; root.replaceChildren(view);
  view.innerHTML = '<p role="status">Loading feedback...</p>';
  try {
    const { candidates } = await api('/api/learning'); if (!view.isConnected) return;
    view.innerHTML = `<header class="workspace-heading"><h2>Improvement candidates</h2></header>${[...candidates].reverse().map(c => `<article class="triage-section"><a href="/review/${e(c.incidentId)}">${e(c.incidentId)}</a> <span class="badge">Pending validation</span><p>${e(c.notes)}</p>${c.proposals ? `<p>Action proposals: ${e(c.proposals)}</p>` : ''}<ul>${c.omittedActions.map(a => `<li>${e(a.title)}: ${e(a.reason)}</li>`).join('')}</ul><small>${e(c.reviewId)} / ${e(c.pillVersion)} / ${e(c.createdAt)}</small></article>`).join('') || '<p class="empty-state">No review feedback yet.</p>'}`;
  } catch (error) { if (view.isConnected) view.innerHTML = `<p class="form-error" role="alert">${e(error.message)}</p>`; }
}
