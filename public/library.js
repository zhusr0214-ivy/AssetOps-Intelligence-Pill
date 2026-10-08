import { escapeHtml as e } from './incidents.js';

export function pillMarkup(pill) {
  const anchor = value => encodeURIComponent(`${pill.id}-${value}`);
  return `<article class="pill-record"><header class="pill-header"><div><p class="eyebrow">${e(pill.id)}</p><h3>${e(pill.name)}</h3></div><span class="badge">${e(pill.status)} · v${e(pill.version)}</span></header>
    <p class="pill-source">${e(pill.source)}</p><dl class="pill-meta"><div><dt>Owner</dt><dd>${e(pill.owner)}</dd></div><div><dt>Scope</dt><dd>${e(pill.scope)}</dd></div></dl>
    <section class="pill-section"><h4>Decision rules (${pill.rules.length})</h4>${pill.rules.map(rule => `<details class="pill-rule" id="${anchor(rule.id)}" open><summary><strong>${e(rule.id)} · ${e(rule.title)}</strong></summary><p>${e(rule.cardExplanation || rule.guidance)}</p>${rule.cardExplanation ? `<p><strong>Guidance:</strong> ${e(rule.guidance)}</p>` : ''}<small>Related checks: ${rule.actionIds.map(id => `<a href="#${anchor(id)}">${e(pill.actions.find(action => action.id === id)?.title || id)}</a>`).join(' · ')}</small></details>`).join('')}</section>
    <section class="pill-section"><h4>Action catalog (${pill.actions.length})</h4>${pill.actions.map(action => `<div class="pill-action" id="${anchor(action.id)}"><strong>${e(action.title)}</strong> <span class="badge">${action.requiresApproval ? 'Human approval required' : 'Read-only check'}</span><p>${e(action.instruction)}</p><small>Owner: ${e(action.owner)} · ${action.ruleIds.map(id => `<a href="#${anchor(id)}">${e(id)}</a>`).join(' · ')}</small></div>`).join('')}</section>
    <div class="pill-columns"><section class="pill-section"><h4>Boundaries</h4><ul>${pill.boundaries.map(text => `<li>${e(text)}</li>`).join('')}</ul></section><section class="pill-section"><h4>Escalation</h4><ul>${pill.escalationConditions.map(text => `<li>${e(text)}</li>`).join('')}</ul></section></div>
    <footer class="pill-footer">Project-authored demo knowledge. Domain validation is required before operational use. Reports retain the Pill version used for their analysis.</footer></article>`;
}

export function filterPills(pills, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return pills.filter(pill => terms.every(term => JSON.stringify(pill).toLowerCase().includes(term)));
}

export function renderLibrary(root, pills) {
  root.innerHTML = `<section class="governance-page"><header class="workspace-heading"><div><p class="eyebrow">Knowledge governance</p><h2>Pill Governance Library</h2></div></header><label class="library-search">Search knowledge<input type="search" placeholder="Name, version, rule, action or scope" aria-label="Search knowledge"></label><p class="result-count" role="status"></p><div class="pill-library"></div></section>`;
  const input = root.querySelector('input');
  const update = () => {
    const matches = filterPills(pills, input.value);
    root.querySelector('.result-count').textContent = `${matches.length} of ${pills.length} Pills`;
    root.querySelector('.pill-library').innerHTML = matches.map(pillMarkup).join('') || '<p class="empty-state">No matching Pill. Try a different rule, action or keyword.</p>';
  };
  input.addEventListener('input', update); update();
}
