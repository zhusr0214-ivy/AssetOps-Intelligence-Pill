import { api, escapeHtml as e, priorities, labels, details } from './incidents.js';

const states = { complete: 'Analysis complete', needs_information: 'Needs information', out_of_scope: 'No matching Pill', knowledge_gap: 'Knowledge gap', failed: 'Analysis failed', partial_failure: 'Specialist analysis incomplete' };
const state = report => report ? (report.stale ? 'Outdated report' : states[report.status]) : 'Not analyzed';
const back = '<a class="back-link" href="/triage"><span class="back-arrow" aria-hidden="true">&larr;</span>Back to triage</a>';

export async function renderTriage(root, pathname) {
  const view = document.createElement('section');
  view.className = 'incident-workspace triage-workspace';
  root.replaceChildren(view);
  view.innerHTML = '<p class="empty-state" role="status">Loading triage...</p>';
  try {
    if (pathname === '/triage' || pathname === '/triage/') {
      const data = await api('/api/triage');
      if (view.isConnected) renderQueue(view, data.cases);
      return;
    }
    const match = pathname.match(/^\/triage\/([^/]+)$/);
    if (!match) throw new Error('Page not found.');
    await renderCase(view, match[1]);
  } catch (error) {
    if (view.isConnected) view.innerHTML = `${back}<p class="form-error" role="alert">${e(error.message)}</p>`;
  }
}

function renderQueue(view, cases) {
  view.innerHTML = `<header class="workspace-heading"><div><p class="eyebrow">Asset Operations</p><h2>Analysis queue</h2></div><a class="button" href="/incidents">All cases</a></header>
    <div class="list-toolbar triage-filters"><label>Search<input id="triage-search" type="search" placeholder="Case, asset or location"></label><label>Report status<select id="triage-filter"><option value="">All cases</option><option value="pending">Not analyzed</option><option value="complete">Analysis complete</option><option value="needs_information">Needs information</option><option value="out_of_scope">No matching Pill</option><option value="failed">Analysis failed</option><option value="stale">Outdated report</option></select></label></div>
    <p class="result-count" role="status"></p><div class="table-scroll"><table class="incident-table"><thead><tr><th scope="col">Case</th><th scope="col">Asset / Location</th><th scope="col">User priority</th><th scope="col">Report</th><th scope="col">Pill</th></tr></thead><tbody></tbody></table></div>`;
  view.querySelector('#triage-filter').insertAdjacentHTML('beforeend', '<option value="knowledge_gap">Knowledge gap</option>');
  const update = () => {
    const query = view.querySelector('#triage-search').value.trim().toLowerCase();
    const filter = view.querySelector('#triage-filter').value;
    const rows = cases.filter(item => [item.id, item.title, item.asset, item.location].join(' ').toLowerCase().includes(query) && (!filter || (item.latest?.stale ? 'stale' : item.latest?.status || 'pending') === filter));
    view.querySelector('.result-count').textContent = `${rows.length} cases`;
    view.querySelector('tbody').innerHTML = rows.map(item => `<tr><td><a class="incident-title" href="/triage/${e(item.id)}">${e(item.title)}</a><small>${e(item.id)}</small></td><td>${e(item.asset || 'Unconfirmed')}<small>${e(item.location)}</small></td><td>${e(priorities[item.priority] || 'Not set')}</td><td><span class="badge">${e(item.running ? 'Analyzing...' : state(item.latest))}</span></td><td>${item.supported ? 'Available' : 'Not available'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No matching cases. Confirm an incident in Incident Workspace to begin.</td></tr>';
  };
  view.querySelectorAll('input, select').forEach(element => element.addEventListener('input', update));
  update();
}

async function renderCase(view, id) {
  const path = `/api/triage/${encodeURIComponent(id)}`;
  let data = await api(path);
  let selectedId = data.reports.at(-1)?.id;
  let busy = false;
  let error = '';
  const chatStates = new Map();
  let timer;
  function paint() {
    if (!view.isConnected) return;
    const incident = data.incident;
    const report = data.reports.find(item => item.id === selectedId) || data.reports.at(-1);
    const running = busy || data.running;
    view.innerHTML = `${back}<header class="workspace-heading"><div><p class="eyebrow">${e(incident.id)}</p><h2>${e(incident.title)}</h2></div><button id="run-triage" class="primary" ${running || !data.eligible ? 'disabled' : ''}>${running ? 'Analyzing...' : !data.supported ? 'Check scope' : data.reports.length ? 'Run new analysis' : 'Analyze case'}</button></header>
      <div class="detail-meta"><span>User priority: <strong>${e(priorities[incident.priority])}</strong></span><a href="/incidents/${e(id)}">View incident</a><a href="/incidents/${e(id)}/edit">Add or correct information</a>${data.reports.length ? `<a class="button" href="/review/${e(id)}">Review latest analysis</a>` : ''}</div>
      ${!data.eligible ? '<p class="triage-notice">Confirm intake and resolve outstanding information before running a new analysis.</p>' : ''}
      ${data.matches?.length ? `<details class="triage-section"><summary>Applicable capabilities for a new analysis (${data.matches.length})</summary><ul>${data.matches.map(p => `<li>${e(p.name)} / v${e(p.version)}: ${e(p.reasons.join('; '))}</li>`).join('')}</ul></details>` : ''}
      ${running ? '<p class="triage-notice" role="status">Analysis in progress...</p>' : ''}
      <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${e(error)}</p>
      <div class="triage-history"><label>Report history<select id="report-history" ${!data.reports.length ? 'disabled' : ''}>${data.reports.length ? [...data.reports].reverse().map((item, index) => `<option value="${e(item.id)}" ${item.id === report?.id ? 'selected' : ''}>${e(new Date(item.createdAt).toLocaleString())} - ${e(state(item))}${index === 0 ? ' (latest)' : ''}</option>`).join('') : '<option>No reports yet</option>'}</select></label></div>
      ${report ? reportMarkup(report, id, chatStates.get(report.id)) : '<div class="empty-state">No analysis has been saved for this case.</div>'}
      <details class="triage-section"><summary>Current case information</summary>${details(incident)}</details>`;
    view.querySelector('#report-history').onchange = event => { selectedId = event.target.value; paint(); };
    view.querySelector('#run-triage').onclick = async () => {
      if (busy || data.running) return;
      const revision = incident.revision || 0;
      busy = true; error = ''; clearTimeout(timer); paint();
      try {
        const result = await api(`${path}/runs`, { method: 'POST', body: JSON.stringify({ revision }) });
        selectedId = result.report.id;
      } catch (failure) { error = failure.message; }
      try { data = await api(path); } catch (failure) { error = failure.message; }
      busy = false; paint(); schedule();
    };
    const chatInput = view.querySelector('#triage-question');
    if (chatInput && report) chatInput.oninput = () => {
      chatStates.set(report.id, { ...chatStates.get(report.id), draft: chatInput.value });
    };
    view.querySelector('#triage-chat-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const input = event.target.elements.question;
      const question = input.value.trim();
      if (!question || !report || chatBlockedReason(report) || chatStates.get(report.id)?.pending) return;
      chatStates.set(report.id, { draft: input.value, pending: true, error: '' });
      paint();
      try {
        const result = await api(`/api/triage/${encodeURIComponent(id)}/reports/${encodeURIComponent(report.id)}/chat`, { method: 'POST', body: JSON.stringify({ question }) });
        data.reports = data.reports.map(item => item.id === result.report.id ? result.report : item);
        chatStates.set(report.id, { draft: '', pending: false, error: '' });
      } catch (failure) {
        chatStates.set(report.id, { draft: question, pending: false, error: failure.message });
        try { data = await api(path); } catch { /* Keep the question and local error if refresh also fails. */ }
      }
      paint();
    });
  }
  function schedule() {
    clearTimeout(timer);
    if (!view.isConnected || !data.running || busy) return;
    timer = setTimeout(async () => {
      if (!view.isConnected) return;
      try {
        data = await api(path);
        if (!data.running) selectedId = data.reports.at(-1)?.id;
      } catch (failure) { error = failure.message; data.running = null; }
      paint(); schedule();
    }, 2000);
  }
  paint(); schedule();
}

export function chatBlockedReason(report) {
  if (report.stale) return 'This report is outdated. Confirm the latest case information and run a new analysis before asking questions.';
  if (report.status === 'failed') return 'Analysis failed. Run a new analysis before asking questions.';
  if (!['complete', 'needs_information'].includes(report.status)) return 'Questions are unavailable for this report. Review the case information and available analysis scope.';
  return '';
}

export function chatTextMarkup(text) {
  // Escape first; support only inline emphasis/code, never raw HTML or links.
  return e(text).replace(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g, token => {
    if (token.startsWith('`')) return `<code>${token.slice(1, -1)}</code>`;
    if (token.startsWith('**')) return `<strong>${token.slice(2, -2)}</strong>`;
    return `<em>${token.slice(1, -1)}</em>`;
  }).replace(/\r?\n/g, '<br>');
}


export function chatHistoryMarkup(messages = []) {
  const render = items => items.map(message => `<article class="message ${message.role === 'user' ? 'user' : 'assistant'}"><strong>${message.role === 'user' ? 'You' : 'Triage Agent'}</strong><p>${message.role === 'user' ? e(message.content) : chatTextMarkup(message.content)}</p></article>`).join('');
  return `${messages.length > 4 ? `<details class="conversation-history"><summary>Earlier questions and answers (${messages.length - 4})</summary>${render(messages.slice(0, -4))}</details>` : ''}${render(messages.slice(-4))}`;
}

export function chatMarkup(report, { draft = '', error = '', pending = false } = {}) {
  const reason = chatBlockedReason(report);
  const disabled = reason || pending;
  return `<section id="report-questions" class="triage-section triage-chat"><h3>Ask about this analysis</h3>
    <p class="muted-label">Ask about the evidence or rules in this report. Answers cannot change the case or execute actions.</p>
    <div class="triage-chat-log">${chatHistoryMarkup(report.chat)}</div>
    ${reason ? `<p id="chat-unavailable" class="triage-notice" role="status">${e(reason)}</p>` : ''}
    ${error ? `<p id="chat-error" class="form-error" role="alert">${e(error)}</p>` : ''}
    <form id="triage-chat-form" class="message-composer">
      <label for="triage-question">Question<textarea id="triage-question" name="question" rows="2" maxlength="2000" required ${disabled ? 'disabled' : ''} ${reason || error ? `aria-describedby="${reason ? 'chat-unavailable ' : ''}${error ? 'chat-error' : ''}"` : ''} placeholder="Ask about the evidence, rule or recommendation">${e(draft)}</textarea></label>
      <div class="actions"><button class="primary" type="submit" ${disabled ? 'disabled' : ''}>${pending ? 'Asking...' : 'Ask Triage Agent'}</button></div>
    </form></section>`;
}

export function reportMarkup(report, id, chatState) {
  const pill = report.pill;
  const rules = new Map((pill?.rules || []).map(rule => [rule.id, rule]));
  return `<article class="triage-report"><nav class="section-jumps" aria-label="Report sections"><a href="#report-questions">Ask about this analysis</a>${report.actions?.length ? '<a href="#report-checks">Recommended checks</a>' : ''}</nav>
    <header class="report-heading"><h3>${e(state(report))}</h3><span class="badge">${pill ? e(`${pill.name} / ${pill.version}`) : 'Outside available scope'}</span></header>
    ${report.stale ? '<p class="triage-notice warning">This report refers to an older case snapshot. Confirm the latest intake and run a new analysis.</p>' : ''}
    ${pill ? `<p class="triage-notice ${pill.status === 'approved' ? '' : 'warning'}"><strong>${pill.status === 'approved' ? 'Published knowledge.' : 'Demo knowledge.'}</strong> ${e(pill.source)}</p>` : ''}
    ${report.status === 'failed' ? `<p class="form-error" role="alert">${e(report.error)}</p>` : `<p class="report-summary">${e(report.summary)}</p>`}
    ${report.coverage ? `<p>Knowledge coverage: ${e(report.coverage.status.replaceAll('_', ' '))}</p>` : ''}
    ${report.routing?.length ? `<section class="triage-section"><h3>Selected capabilities</h3><ul>${report.routing.map(p => `<li>${e(p.id)} / v${e(p.version)}: ${e(p.reasons.join('; '))}</li>`).join('')}</ul>${report.specialists ? `<ul>${report.specialists.map(s => `<li>${e(s.name)}: ${e(states[s.status] || s.status)}${s.error ? ` / ${e(s.error)}` : ''}</li>`).join('')}</ul>` : ''}${report.coordination?.required ? `<p class="triage-notice">Cross-domain review required. No automatic execution.</p><ul>${report.coordination.conflicts.map(c => `<li>Conflict: ${e(c.key)} / ${e(c.values.join(' vs '))}</li>`).join('')}</ul>` : ''}</section>` : ''}
    <a href="/cases/${e(id)}/handling">${report.coverage?.expertHandlingRequired ? 'Record specialist handling and outcome' : 'Actual handling and outcome'}</a>
    ${report.coordination?.agent ? `<section class="triage-section"><h3>Cross-Pill coordination</h3><p>${e(report.coordination.agent.summary || report.coordination.agent.error)}</p><ul>${(report.coordination.agent.conflicts || []).map(c => `<li>Potential conflict: ${e(c.actionIds.join(' / '))}: ${e(c.reason)}</li>`).join('')}${(report.coordination.agent.dependencies || []).map(d => `<li>${e(d.before)} before ${e(d.after)}: ${e(d.reason)}</li>`).join('')}${(report.coordination.agent.questions || []).map(q => `<li>${e(q)}</li>`).join('')}</ul>${report.coordination.agent.suggestedOrder?.length ? `<details><summary>Proposed order</summary><ol>${report.coordination.agent.suggestedOrder.map(id => `<li>${e(id)}</li>`).join('')}</ol></details>` : ''}<small>${e(report.coordination.agent.promptVersion)} / ${e(report.coordination.agent.status)}</small></section>` : ''}
    ${report.questions?.length ? `<section class="triage-section"><h3>Information to confirm</h3><ul>${report.questions.map(item => `<li>${e(item.question)}</li>`).join('')}</ul><a class="button" href="/incidents/${e(id)}/edit">Add information to case</a></section>` : ''}
    ${report.hypotheses?.length ? `<section class="triage-section"><h3>Possible causes and evidence</h3><div class="hypothesis-list">${report.hypotheses.map(item => `<article class="hypothesis"><h4>${e(rules.get(item.ruleId)?.title || item.ruleId)}</h4>${item.reasoningSource === 'pill' ? '<p class="muted-label">Rule explanation</p>' : ''}<p>${e(item.reasoning)}</p>${item.reasoningSource === 'pill' ? '<p class="muted-label">Case evidence</p>' : ''}<dl>${item.evidence.map(evidence => `<div><dt>${e(labels[evidence.field])}</dt><dd>${e(evidence.quote)}</dd></div>`).join('')}</dl>${item.uncertainties.length ? `<p class="muted-label">Still unverified</p><ul>${item.uncertainties.map(value => `<li>${e(value)}</li>`).join('')}</ul>` : ''}<a href="#rule-${e(item.ruleId)}">${e(item.ruleId)}</a></article>`).join('')}</div></section>` : ''}
    ${report.actions?.length ? `<section id="report-checks" class="triage-section"><h3>Recommended checks</h3><ol class="triage-actions">${report.actions.map(action => `<li><strong>${e(action.title)}</strong> <span class="badge">${action.requiresApproval ? 'Requires human approval' : 'Read-only check'}</span><p>${e(action.instruction)}</p><small>${e(action.owner)} / ${action.ruleIds.map(e).join(', ')}</small></li>`).join('')}</ol></section>` : ''}
    ${report.prioritySuggestion ? `<section class="triage-section"><h3>Priority suggestion: ${e(priorities[report.prioritySuggestion.value])}</h3><p>${e(report.prioritySuggestion.reason)}</p><p class="muted-label">The saved user priority has not been changed.</p></section>` : ''}
    ${chatMarkup(report, chatState)}
    <section class="triage-section"><h3>Boundaries and escalation</h3><p class="muted-label">${report.governance?.evidenceChecked ? 'Rule references, quoted evidence and action IDs passed automated validation. This does not confirm the diagnosis.' : 'No model analysis has passed evidence validation.'}</p><ul>${(report.governance?.boundaries || []).map(value => `<li>${e(value)}</li>`).join('')}</ul><ul>${(report.governance?.escalationConditions || []).map(value => `<li>${e(value)}</li>`).join('')}</ul></section>
    ${pill ? `<section class="triage-section"><h3>Pill references</h3><p>${e(pill.owner)} / ${e(pill.version)} / ${e(pill.status)}</p>${pill.rules.map(rule => `<div class="rule-reference" id="rule-${e(rule.id)}"><strong>${e(rule.id)}: ${e(rule.title)}</strong><p>${e(rule.guidance)}</p></div>`).join('')}</section>` : ''}
    <details class="triage-section"><summary>Case snapshot used for this report</summary>${details(report.snapshot.fields)}</details>
    <footer class="report-footer">${e(report.id)}<br>Created ${e(new Date(report.createdAt).toLocaleString())} / Model: ${e(report.model || 'Not called')} / Prompt: ${e(report.promptVersion)}</footer>
  </article>`;
}
