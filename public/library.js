import { escapeHtml as e, api } from './incidents.js';

export function pillMarkup(pill) {
  const anchor = value => encodeURIComponent(`${pill.id}${pill.status === 'approved' ? `-${pill.version}` : ''}-${value}`);
  return `<article class="pill-record"><header class="pill-header"><div><p class="eyebrow">${e(pill.id)}</p><h3>${e(pill.name)}</h3></div><span class="badge">${e(pill.status)} · v${e(pill.version)}</span></header>
    <p class="pill-source">${e(pill.source)}</p><dl class="pill-meta"><div><dt>Owner</dt><dd>${e(pill.owner)}</dd></div><div><dt>Scope</dt><dd>${e(pill.scope)}</dd></div></dl>
    <p>Domain: ${e(pill.domain || 'ahu_cooling')}</p>${pill.applicability ? `<dl class="pill-meta"><div><dt>Categories</dt><dd>${e(pill.applicability.categories.join(', '))}</dd></div><div><dt>Asset prefixes</dt><dd>${e(pill.applicability.assetPrefixes.join(', ') || 'Any')}</dd></div><div><dt>Issue keywords</dt><dd>${e(pill.applicability.keywords.join(', ') || 'Any')}</dd></div></dl>` : ''}
    <section class="pill-section"><h4>Decision rules (${pill.rules.length})</h4>${pill.rules.map(rule => `<details class="pill-rule" id="${anchor(rule.id)}" open><summary><strong>${e(rule.id)} · ${e(rule.title)}</strong></summary><p>${e(rule.cardExplanation || rule.guidance)}</p>${rule.cardExplanation ? `<p><strong>Guidance:</strong> ${e(rule.guidance)}</p>` : ''}<small>Related checks: ${rule.actionIds.map(id => `<a href="#${anchor(id)}">${e(pill.actions.find(action => action.id === id)?.title || id)}</a>`).join(' · ')}</small></details>`).join('')}</section>
    <section class="pill-section"><h4>Action catalog (${pill.actions.length})</h4>${pill.actions.map(action => `<div class="pill-action" id="${anchor(action.id)}"><strong>${e(action.title)}</strong> <span class="badge">${action.requiresApproval ? 'Human approval required' : 'Read-only check'}</span><p>${e(action.instruction)}</p><small>Owner: ${e(action.owner)} · ${action.ruleIds.map(id => `<a href="#${anchor(id)}">${e(id)}</a>`).join(' · ')}</small></div>`).join('')}</section>
    <div class="pill-columns"><section class="pill-section"><h4>Boundaries</h4><ul>${pill.boundaries.map(text => `<li>${e(text)}</li>`).join('')}</ul></section><section class="pill-section"><h4>Escalation</h4><ul>${pill.escalationConditions.map(text => `<li>${e(text)}</li>`).join('')}</ul></section></div>
    <footer class="pill-footer">${pill.status === 'approved' ? `Published version${pill.active === undefined ? '' : pill.active ? ' / Active for matching cases' : ' / Historical version'}.` : 'Unpublished demo knowledge. Expert validation is required.'} Reports retain the Pill version used for their analysis. <a href="/studio/${e(pill.id)}">Open in Pill Studio</a></footer></article>`;
}

export function filterPills(pills, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return pills.filter(pill => terms.every(term => JSON.stringify(pill).toLowerCase().includes(term)));
}

export function renderLibrary(root, pills) {
  root.innerHTML = `<section class="governance-page"><header class="workspace-heading"><div><p class="eyebrow">Knowledge governance</p><h2>Pill Library</h2></div></header><label class="library-search">Search knowledge<input type="search" placeholder="Name, version, rule, action or scope" aria-label="Search knowledge"></label><p class="result-count" role="status"></p><div class="pill-library"></div></section>`;
  const input = root.querySelector('input');
  const update = () => {
    const groups = [...new Set(pills.map(p => p.id))].map(id => pills.filter(p => p.id === id));
    const matches = groups.filter(versions => filterPills(versions, input.value).length);
    root.querySelector('.result-count').textContent = `${matches.length} of ${groups.length} Pills`;
    root.querySelector('.pill-library').innerHTML = matches.length ? `<div class="table-scroll"><table class="incident-table"><thead><tr><th>Pill</th><th>Active version</th><th>Latest release</th><th>Owner</th><th>Published</th><th>Versions</th></tr></thead><tbody>${matches.map(versions => { const latest = versions.at(-1), active = versions.find(p => p.active); return `<tr><td><a href="/library/${e(latest.id)}">${e(latest.name)}</a><small>${e(latest.id)}</small></td><td>${e(active?.version || 'Not active')}</td><td>${e(latest.version)}${latest.disabled ? ' / Disabled' : ''}</td><td>${e(latest.owner)}</td><td>${e(latest.publishedAt)}</td><td>${versions.length}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty-state">No approved Pills match this view. Drafts and improvement candidates are in Pill Studio.</p>';
  };
  input.addEventListener('input', update); update();
}

const versionState = v => v.disabled ? 'Disabled' : v.active ? 'Active' : 'Historical';
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function comparisonMarkup(result) {
  return `<h3>v${e(result.from)} to v${e(result.to)}</h3><p>${result.counts.added} added / ${result.counts.removed} removed / ${result.counts.modified} modified</p>${result.changes.map(c => `<section class="version-change"><h4>${e(c.section)} / ${e(c.key)} <span class="badge">${e(c.type)}</span></h4><div class="version-diff"><div><strong>Before</strong><pre>${e(c.before === null ? '(absent)' : pretty(c.before))}</pre></div><div><strong>After</strong><pre>${e(c.after === null ? '(absent)' : pretty(c.after))}</pre></div></div></section>`).join('') || '<p>No knowledge content changes.</p>'}`;
}

export function historyMarkup(data) {
  return `<section class="triage-section"><h3>Published versions</h3><div class="table-scroll"><table class="incident-table"><thead><tr><th>Version</th><th>Status</th><th>Published</th><th>Approved by</th><th>Release notes</th></tr></thead><tbody>${[...data.releases].reverse().map(v => `<tr><td><a href="/library/${e(data.id)}/versions/${e(v.pill.version)}">${e(v.pill.version)}</a></td><td>${versionState(v)}</td><td>${e(v.publishedAt)}</td><td>${e(v.reviewer)}</td><td>${e(v.notes)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

export async function renderLibraryPage(root, path, search = '') {
  if (path === '/library') { const { pills } = await api('/api/library'); if (root.isConnected) renderLibrary(root, pills); return; }
  const match = path.match(/^\/library\/([^/]+)(?:\/(compare|versions)(?:\/([^/]+))?)?$/);
  if (!match || match[2] === 'versions' && !match[3] || match[2] === 'compare' && match[3]) throw new Error('Library page not found.');
  const [, id, section, version] = match, data = await api(`/api/library/${encodeURIComponent(id)}`);
  if (!root.isConnected) return;
  const selected = version ? data.releases.find(v => v.pill.version === version) : data.releases.find(v => v.active) || data.releases.at(-1);
  if (!selected) throw new Error('Published version not found.');
  root.innerHTML = `<a class="back-link" href="/library">&larr; Pill Library</a><header class="workspace-heading"><div><h2>${e(selected.pill.name)}</h2><p>${e(id)}</p></div><a href="/studio/${e(id)}">Open draft / Studio</a></header><nav class="workspace-tabs" aria-label="Pill views"><a href="/library/${e(id)}" ${section !== 'compare' ? 'aria-current="page"' : ''}>Versions and content</a><a href="/library/${e(id)}/compare" ${section === 'compare' ? 'aria-current="page"' : ''}>Compare versions</a></nav><p>Active version of this Pill: ${data.active ? `${e(data.active.id)} / v${e(data.active.version)}` : 'None'}</p><p class="form-error" role="alert" hidden></p><div class="library-detail"></div>`;
  const detail = root.querySelector('.library-detail');
  if (section === 'compare') {
    const params = new URLSearchParams(search), latest = data.releases.at(-1).pill.version;
    const from = params.get('from') || data.releases.at(-2)?.pill.version || latest, to = params.get('to') || latest;
    const options = value => data.releases.map(v => `<option value="${e(v.pill.version)}" ${value === v.pill.version ? 'selected' : ''}>v${e(v.pill.version)} / ${versionState(v)}</option>`).join('');
    detail.innerHTML = `<form class="version-controls" id="version-compare"><label>Before<select name="from">${options(from)}</select></label><label>After<select name="to">${options(to)}</select></label><button type="submit">Compare</button></form><div data-comparison></div>`;
    const form = detail.querySelector('form'); let busy = false;
    async function compare() {
      if (busy) return; busy = true; const controls = [...form.querySelectorAll('button, select')]; controls.forEach(el => el.disabled = true);
      const error = root.querySelector('[role="alert"]'); error.hidden = true;
      try {
        const query = new URLSearchParams({ from: form.elements.from.value, to: form.elements.to.value });
        const result = await api(`/api/library/${encodeURIComponent(id)}/compare?${query}`);
        if (root.isConnected) detail.querySelector('[data-comparison]').innerHTML = comparisonMarkup(result);
      } catch (err) { if (root.isConnected) { error.textContent = err.message; error.hidden = false; } }
      finally { busy = false; controls.forEach(el => el.disabled = false); }
    }
    form.onsubmit = event => { event.preventDefault(); compare(); }; await compare(); return;
  }
  detail.innerHTML = `${historyMarkup(data)}<section class="triage-section"><header class="workspace-heading"><h3>Version ${e(selected.pill.version)}</h3><span class="badge">${versionState(selected)}</span></header><p>Published ${e(selected.publishedAt)} / ${e(selected.reviewer)}</p><p>${e(selected.notes)}</p><details><summary>Snapshot checksum (SHA-256)</summary><code class="version-hash">${e(selected.contentHash)}</code></details></section>${pillMarkup({ ...selected.pill, active: selected.active })}
  <details class="triage-section"><summary>Sources and validation</summary>${(selected.sources || []).map(s => `<article class="studio-version"><strong>${e(s.expert)}</strong><p>${e(s.reference)}</p><p>${e(s.knowledge)}</p></article>`).join('')}<h4>Validation cases</h4><pre class="version-evidence">${e(pretty(selected.examples || []))}</pre><p>${e(selected.validation?.scope || 'No saved validation detail.')}</p></details>
  <details class="triage-section"><summary>Capture and learning provenance</summary><pre class="version-evidence">${e(pretty({ captureHistory: selected.captureHistory || [], learningImports: selected.learningImports || [] }))}</pre></details>
  ${!selected.active ? `<form id="version-operation" class="triage-section"><h3>Version management</h3><label>Operation<select name="operation">${selected.disabled ? '<option value="restore">Restore availability (keep inactive)</option>' : '<option value="activate">Activate this version / roll back</option><option value="disable">Disable historical version</option>'}</select></label><label>Operator (signed-in)<input name="reviewer" maxlength="120" required></label><label>Reason<textarea name="notes" maxlength="3000" required></textarea></label><label class="studio-check"><input name="confirmed" type="checkbox" required>I confirm this operation on v${e(selected.pill.version)}. Activation replaces this Pill's current version for new analyses; drafts and saved reports remain unchanged.</label><button type="submit">Confirm version operation</button><button type="button" data-reload>Reload version state</button></form>` : '<p class="triage-notice">This version is active. Activate another available version before disabling it.</p>'}
  <details class="triage-section"><summary>Publication and activation history</summary>${data.events.map(event => `<article class="studio-version"><strong>${e(event.action)}</strong><p>${e(event.at)} / ${e(event.reviewer || '')}</p>${event.target ? `<p>${['publish', 'activate'].includes(event.action) ? `${e(event.previous ? `${event.previous.id} / ${event.previous.version}` : 'None')} &rarr; ` : ''}${e(event.target.id)} / ${e(event.target.version)}</p>` : ''}<p>${e(event.notes || '')}</p></article>`).join('')}</details>`;
  if (selected.checksumState === 'mismatch') detail.insertAdjacentHTML('afterbegin', '<p class="form-error" role="alert">Snapshot checksum mismatch. Reactivation is blocked; investigate the stored release.</p>');
  detail.insertAdjacentHTML('afterbegin', `<details class="triage-section"><summary>Release model evaluation: ${selected.evaluation?.passed ? 'Passed' : 'Not evaluated'}</summary><pre class="version-evidence">${e(pretty(selected.evaluation || { state: 'legacy_not_evaluated' }))}</pre></details>`);
  const form = detail.querySelector('#version-operation');
  if (form) {
    let busy = false;
    form.querySelector('[data-reload]').onclick = async () => { if (busy) return; try { await renderLibraryPage(root, path); } catch (err) { const error = root.querySelector('[role="alert"]'); error.textContent = err.message; error.hidden = false; } };
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return; busy = true;
      const body = { ...Object.fromEntries(new FormData(form)), confirmed: form.elements.confirmed.checked, revision: data.revision, libraryToken: data.libraryToken };
      const error = root.querySelector('[role="alert"]'); error.hidden = true;
      const controls = [...form.querySelectorAll('input, textarea, select, button')]; controls.forEach(el => el.disabled = true);
      try {
        await api(`/api/library/${encodeURIComponent(id)}/versions/${encodeURIComponent(selected.pill.version)}/${body.operation}`, { method: 'POST', body: JSON.stringify(body) });
        if (root.isConnected) await renderLibraryPage(root, path);
      } catch (err) { if (root.isConnected) { error.textContent = err.message; error.hidden = false; controls.forEach(el => el.disabled = false); } }
      finally { busy = false; }
    };
  }
}
