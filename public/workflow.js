import { escapeHtml as e } from './incidents.js';

export function nextStepMarkup({ title, detail, href, action, blocked = false }) {
  return `<aside class="next-step${blocked ? ' is-blocked' : ''}" aria-label="Current status and next step"><div><strong>${e(title)}</strong><p>${e(detail)}</p></div>${href ? `<a class="button" href="${e(href)}">${e(action)}</a>` : ''}</aside>`;
}

export function pillProgressMarkup(record) {
  const base = `/studio/${encodeURIComponent(record.id)}`, gate = record.evaluationGate;
  let next;
  if (record.state === 'published') next = { title: 'Published knowledge', detail: 'New analyses use the active approved version. Further changes require a new draft.', href: `/library/${encodeURIComponent(record.id)}`, action: 'View released versions' };
  else if (record.learningImports?.some(item => item.status === 'pending_incorporation')) next = { title: 'Learning incorporation pending', detail: 'Reviewed feedback still needs to be incorporated into the saved draft and examples.', href: `${base}?view=sources`, action: 'Review imported learning', blocked: true };
  else if (record.validation?.passed !== true) next = { title: 'Draft requires validation', detail: 'Save the rules, actions and examples, then validate the saved draft.', href: `${base}?view=draft`, action: 'Review draft', blocked: true };
  else if (gate?.required && !gate.passed) next = { title: gate.state === 'expert_review_required' ? 'Independent evaluation review required' : 'Current evaluation required', detail: `Release gate: ${String(gate.state || 'not_run').replaceAll('_', ' ')}. Publication remains subject to an independent reviewer.`, href: `${base}?view=evaluation`, action: 'Open evaluation', blocked: true };
  else if (record.state === 'in_review') next = { title: 'Awaiting publication decision', detail: 'An independent reviewer must check the saved knowledge and release requirements.', href: `${base}?view=publication`, action: 'Review publication' };
  else next = { title: 'Validated draft', detail: 'Submit the saved draft for independent review. Validation alone is not publication.', href: `${base}?view=draft`, action: 'Open draft submission' };
  return `<div class="knowledge-context"><span>Knowledge owner: <strong>${e(record.content.pill.owner || 'Not recorded')}</strong></span><span>Draft state: <strong>${e(record.state.replaceAll('_', ' '))}</strong></span><span>Latest release: <strong>${e(record.releases.at(-1)?.pill.version || 'Not published')}</strong></span></div>${nextStepMarkup(next)}`;
}

export function reportDecisionMarkup(report, id) {
  const base = `/cases/${encodeURIComponent(id)}`;
  let next;
  if (report.stale) next = { title: 'Outdated evidence', detail: 'This saved analysis does not match the current case. Reconfirm the facts and run a new analysis.', href: `${base}/edit`, action: 'Check current facts', blocked: true };
  else if (['failed', 'partial_failure'].includes(report.status)) next = { title: 'Analysis incomplete', detail: 'Do not treat this report as a complete recommendation. Resolve the failure before review.', href: `${base}/triage`, action: 'Return to analysis', blocked: true };
  else if (report.status === 'needs_information') next = { title: 'More information needed', detail: 'The unanswered questions below need confirmation before further decisions.', href: `${base}/edit`, action: 'Add case information', blocked: true };
  else if (['out_of_scope', 'knowledge_gap'].includes(report.status) || report.coverage?.expertHandlingRequired) next = { title: 'Specialist judgement required', detail: 'Available knowledge does not fully cover this case. A person must decide the escalation and record the actual outcome.', href: `${base}/review`, action: 'Open human review', blocked: true };
  else next = { title: 'AI recommendation, not execution approval', detail: 'Verify the evidence and operating limits in Human Review. This report does not authorize equipment operation.', href: `${base}/review`, action: 'Check review status' };
  return nextStepMarkup(next);
}

export function workQueueMarkup(incidents, reviews, records) {
  const needs = new Map(incidents.filter(i => i.status === 'needs_info').map(i => [i.id, i]));
  reviews.filter(r => r.state === 'request_information').forEach(r => needs.set(r.id, r));
  const groups = [
    ['Human review', reviews.filter(r => r.state === 'pending'), i => `/cases/${encodeURIComponent(i.id)}/review`, 'Review analysis'],
    ['Information requested', [...needs.values()], i => `/cases/${encodeURIComponent(i.id)}/edit`, 'Continue intake'],
    ['Analysis refresh', reviews.filter(r => ['outdated', 'reanalyze'].includes(r.state)), i => `/cases/${encodeURIComponent(i.id)}/triage`, 'Revisit analysis'],
    ['Pill publication review', records.filter(r => r.state === 'in_review').map(r => ({ id: r.id, title: r.content.pill.name, asset: r.content.pill.owner })), i => `/studio/${encodeURIComponent(i.id)}?view=publication`, 'Review release']
  ];
  return `<section class="work-queue"><header class="workspace-heading"><h3>Workspace work queue</h3><span class="muted-label">Shared queues · actions depend on your role</span></header>${groups.map(([label, items, href, action]) => `<details class="queue-group" ${items.length ? 'open' : ''}><summary>${e(label)} <span class="badge">${items.length}</span></summary>${items.length ? `<ul class="overview-list">${items.slice(0, 5).map(item => `<li><div><strong>${e(item.title || item.id)}</strong><small>${e(item.asset || 'Asset not recorded')}</small></div><a href="${e(href(item))}">${e(action)}</a></li>`).join('')}</ul>${items.length > 5 ? `<p class="queue-empty">Showing 5 of ${items.length}. <a href="${label === 'Pill publication review' ? '/studio' : label === 'Information requested' ? '/cases' : '/cases/review'}">Open full queue</a></p>` : ''}` : '<p class="queue-empty">No items in this queue.</p>'}</details>`).join('')}</section>`;
}

export function learningTrailMarkup(incident) {
  const runs = incident.learningRuns || [], proposals = runs.flatMap(run => run.proposals || []);
  const receipts = proposals.filter(p => p.importReceipt?.pillId);
  const accepted = proposals.filter(p => p.decision?.status === 'accepted').length;
  return `<section class="learning-trail"><h3>Case-to-knowledge trace</h3><dl><div><dt>Saved operational records</dt><dd>${incident.handlingRecords?.length || 0}</dd></div><div><dt>Learning analyses</dt><dd>${runs.length}</dd></div><div><dt>Accepted proposals</dt><dd>${accepted}</dd></div></dl>${receipts.length ? `<ul>${receipts.map(p => `<li><a href="/studio/${e(p.importReceipt.pillId)}?view=sources">Open linked Pill draft</a> <span class="badge">Draft receipt recorded</span></li>`).join('')}</ul>` : ''}<a href="/studio">Review proposals and publication progress</a><p class="muted-label">Accepted feedback and draft receipts are not proof of a published version.</p></section>`;
}
