import { escapeHtml as e, api } from './incidents.js';
import {currentUser} from './session.js';

export function pillMarkup(pill, {captureHistory=[]}={}) {
  const anchor=value=>encodeURIComponent(`${pill.id}${pill.status==='approved'?`-${pill.version}`:''}-${value}`);
  const shown=new Set();
  const evidence=id=>{
    const decision=captureHistory.flatMap(r=>r.decisions||[]).reverse().find(d=>d.targetId===id && d.decision==='accepted');
    return decision?.evidence?.length ? `<details class="knowledge-evidence"><summary>Source evidence</summary>${decision.evidence.map(ref=>`<blockquote><strong>${e(ref.location)}</strong><p>${e(ref.quote)}</p></blockquote>`).join('')}</details>` : '';
  };
  const actionMarkup=action=>{
    if(shown.has(action.id))return `<p class="knowledge-shared-action">Recommended response: <a href="#${anchor(action.id)}">${e(action.title)}</a></p>`;
    shown.add(action.id);
    return `<div class="pill-action" id="${anchor(action.id)}"><div class="knowledge-item-heading"><strong>${e(action.title)}</strong><span class="badge">${action.requiresApproval?'Human approval required':'Read-only check'}</span></div><p>${e(action.instruction)}</p><small>Responsible role: ${e(action.owner||'Not assigned')}</small>${evidence(action.id)}</div>`;
  };
  const decisions=pill.rules.map(rule=>`<article class="pill-rule" id="${anchor(rule.id)}"><h5>${e(rule.title)}</h5><p class="knowledge-label">Decision guidance</p><p>${e(rule.guidance||rule.cardExplanation)}</p>${rule.cardExplanation && rule.cardExplanation!==rule.guidance?`<details><summary>Explanation</summary><p>${e(rule.cardExplanation)}</p></details>`:''}${evidence(rule.id)}<p class="knowledge-label">Recommended response</p>${rule.actionIds.map(id=>pill.actions.find(a=>a.id===id)).filter(Boolean).map(actionMarkup).join('')||'<p class="triage-notice">No response linked yet. Review the source relationships before validation.</p>'}</article>`).join('');
  const remaining=pill.actions.filter(a=>!shown.has(a.id));
  return `<article class="pill-record"><header class="pill-header"><div><p class="eyebrow">Governed domain knowledge</p><h3>${e(pill.name)}</h3></div><span class="badge">${pill.status==='approved'?`Approved · v${e(pill.version)}`:'Draft · not released'}</span></header>
    <section class="knowledge-context"><h4>When to use this knowledge</h4><p>${e(pill.scope)}</p><small>Knowledge owner: ${e(pill.owner)} · Domain: ${e((pill.domain||'ahu_cooling').replaceAll('_',' '))}</small></section>
    <section class="pill-section"><h4>Decisions & recommended responses</h4>${decisions||'<p>No decision guidance confirmed yet.</p>'}</section>
    ${remaining.length?`<section class="pill-section"><h4>Responses awaiting a decision link</h4><p class="triage-notice">Confirm when these responses apply.</p>${remaining.map(actionMarkup).join('')}</section>`:''}
    <div class="pill-columns"><section class="pill-section knowledge-limits"><h4>Operating limits</h4><ul>${pill.boundaries.map(t=>`<li>${e(t)}</li>`).join('')}</ul></section><section class="pill-section knowledge-escalation"><h4>When human escalation is needed</h4><ul>${pill.escalationConditions.map(t=>`<li>${e(t)}</li>`).join('')}</ul>${!pill.escalationConditions.length?'<p>No escalation conditions confirmed.</p>':''}</section></div>
    <details class="pill-technical"><summary>Source & matching details</summary><p>${e(pill.source)}</p><p>Pill ID: ${e(pill.id)}</p>${pill.applicability?`<p>Categories: ${e(pill.applicability.categories.join(', '))}</p><p>Asset prefixes: ${e(pill.applicability.assetPrefixes.join(', ')||'Any')}</p><p>Issue keywords: ${e(pill.applicability.keywords.join(', ')||'Any')}</p>`:''}</details>
    <footer class="pill-footer">${pill.status==='approved'?'Published knowledge for matching cases.':'Draft knowledge awaiting validation and approval.'} Reports retain the version used. <a href="/studio/${e(pill.id)}">Open in Pill Studio</a></footer></article>`;
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
    root.querySelector('.pill-library').innerHTML = matches.length ? `<div class="table-scroll"><table class="incident-table"><thead><tr><th>Pill</th><th>Active version</th><th>Latest release</th><th>Owner</th><th>Published</th></tr></thead><tbody>${matches.map(versions => { const latest = versions.at(-1), active = versions.find(p => p.active); return `<tr><td><a href="/library/${e(latest.id)}">${e(latest.name)}</a><small>${e(latest.id)}</small></td><td>${e(active?.version || 'Not active')}</td><td>${e(latest.version)}${latest.disabled ? ' / Disabled' : ''}</td><td>${e(latest.owner)}</td><td>${e(latest.publishedAt)}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty-state">No approved Pills match this view. Drafts and improvement candidates are in Pill Studio.</p>';
  };
  input.addEventListener('input', update); update();
}

const versionState = v => v.disabled ? 'Disabled' : v.active ? 'Active' : 'Historical';
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function comparisonMarkup(result) {
  return `<h3>v${e(result.from)} to v${e(result.to)}</h3><p>${result.counts.added} added / ${result.counts.removed} removed / ${result.counts.modified} modified</p>${result.changes.map(c => `<section class="version-change"><h4>${e(c.section)} / ${e(c.key)} <span class="badge">${e(c.type)}</span></h4><div class="version-diff"><div><strong>Before</strong><pre>${e(c.before === null ? '(absent)' : pretty(c.before))}</pre></div><div><strong>After</strong><pre>${e(c.after === null ? '(absent)' : pretty(c.after))}</pre></div></div></section>`).join('') || '<p>No knowledge content changes.</p>'}`;
}

export function knowledgePackage(release) {
  return {format:'assetops-intelligence-pill',schemaVersion:1,pill:release.pill,sources:release.sources||[],examples:release.examples||[],captureHistory:release.captureHistory||[],learningImports:release.learningImports||[],validation:release.validation,evaluation:release.evaluation,approval:{reviewer:release.reviewer,notes:release.notes,publishedAt:release.publishedAt},contentHash:release.contentHash};
}

export function historyMarkup(data) {
  return `<section class="triage-section" data-page-panel="versions"><h3>Published versions</h3><div class="table-scroll"><table class="incident-table"><thead><tr><th>Version</th><th>Status</th><th>Published</th><th>Approved by</th><th>Release notes</th></tr></thead><tbody>${[...data.releases].reverse().map(v => `<tr><td><a href="/library/${e(data.id)}/versions/${e(v.pill.version)}">${e(v.pill.version)}</a></td><td>${versionState(v)}</td><td>${e(v.publishedAt)}</td><td>${e(v.reviewer)}</td><td>${e(v.notes)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

export async function renderLibraryPage(root, path, search = '') {
  if (path === '/library') { const { pills } = await api('/api/library'); if (root.isConnected) renderLibrary(root, pills); return; }
  const match = path.match(/^\/library\/([^/]+)(?:\/(compare|versions)(?:\/([^/]+))?)?$/);
  if (!match || match[2] === 'versions' && !match[3] || match[2] === 'compare' && match[3]) throw new Error('Library page not found.');
  const [, id, section, version] = match, data = await api(`/api/library/${encodeURIComponent(id)}`);
  if (!root.isConnected) return;
  const selected = version ? data.releases.find(v => v.pill.version === version) : data.releases.find(v => v.active) || data.releases.at(-1);
  if (!selected) throw new Error('Published version not found.');
  root.innerHTML = `<a class="back-link" href="/library">&larr; Pill Library</a><header class="workspace-heading"><div><h2>${e(selected.pill.name)}</h2><p>Published knowledge · version ${e(selected.pill.version)}</p></div>${currentUser()?.roles?.some(r=>['admin','expert'].includes(r)) ? `<a class="button" href="/studio/${e(id)}?edit=1">Edit</a>` : ''}</header><nav class="workspace-tabs" aria-label="Pill views"><a href="/library/${e(id)}" ${section !== 'compare' ? 'aria-current="page"' : ''}>Versions and content</a><a href="/library/${e(id)}/compare" ${section === 'compare' ? 'aria-current="page"' : ''}>Compare versions</a></nav><p data-page-panel="versions">Active version: ${data.active ? `v${e(data.active.version)}` : 'None'}</p><p class="form-error" role="alert" hidden></p><div class="library-detail"></div>`;
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
  detail.innerHTML = `${historyMarkup(data)}<section class="triage-section" data-page-panel="versions"><header class="workspace-heading"><h3>Version ${e(selected.pill.version)}</h3><span class="badge">${versionState(selected)}</span></header><p>Published ${e(selected.publishedAt)} / ${e(selected.reviewer)}</p><p>${e(selected.notes)}</p><details><summary>Snapshot checksum (SHA-256)</summary><code class="version-hash">${e(selected.contentHash)}</code></details></section>${pillMarkup({ ...selected.pill, active: selected.active }, {captureHistory:selected.captureHistory||[]})}
  <details class="triage-section" data-page-panel="evidence"><summary>Sources and validation</summary>${(selected.sources || []).map(s => `<article class="studio-version"><strong>${e(s.expert)}</strong><p>${e(s.reference)}</p><p>${e(s.knowledge)}</p></article>`).join('')}<h4>Validation cases</h4><pre class="version-evidence">${e(pretty(selected.examples || []))}</pre><p>${e(selected.validation?.scope || 'No saved validation detail.')}</p></details>
  <details class="triage-section" data-page-panel="evidence"><summary>Capture and learning provenance</summary><button type="button" data-export-knowledge>Download knowledge package (JSON)</button><p>Includes the approved knowledge, evidence, validation and feedback history for this version.</p><pre class="version-evidence">${e(pretty({ captureHistory: selected.captureHistory || [], learningImports: selected.learningImports || [] }))}</pre></details>
  ${!selected.active ? `<form id="version-operation" class="triage-section" data-page-panel="versions"><h3>Version management</h3><label>Operation<select name="operation">${selected.disabled ? '<option value="restore">Restore availability (keep inactive)</option>' : '<option value="activate">Activate this version / roll back</option><option value="disable">Disable historical version</option>'}</select></label><label>Operator (signed-in)<input name="reviewer" maxlength="120" required></label><label>Reason<textarea name="notes" maxlength="3000" required></textarea></label><label class="studio-check"><input name="confirmed" type="checkbox" required>I confirm this operation on v${e(selected.pill.version)}. Activation replaces this Pill's current version for new analyses; drafts and saved reports remain unchanged.</label><button type="submit">Confirm version operation</button><button type="button" data-reload>Reload version state</button></form>` : '<p class="triage-notice" data-page-panel="versions">This version is active. Activate another available version before disabling it.</p>'}
  <details class="triage-section" data-page-panel="versions"><summary>Publication and activation history</summary>${data.events.map(event => `<article class="studio-version"><strong>${e(event.action)}</strong><p>${e(event.at)} / ${e(event.reviewer || '')}</p>${event.target ? `<p>${['publish', 'activate'].includes(event.action) ? `${e(event.previous ? `${event.previous.id} / ${event.previous.version}` : 'None')} &rarr; ` : ''}${e(event.target.id)} / ${e(event.target.version)}</p>` : ''}<p>${e(event.notes || '')}</p></article>`).join('')}</details>`;
  if (selected.checksumState === 'mismatch') detail.insertAdjacentHTML('afterbegin', '<p class="form-error" role="alert">Snapshot checksum mismatch. Reactivation is blocked; investigate the stored release.</p>');
  detail.insertAdjacentHTML('afterbegin', `<details class="triage-section" data-page-panel="evidence"><summary>Release model evaluation: ${selected.evaluation?.passed ? 'Passed' : 'Not evaluated'}</summary><pre class="version-evidence">${e(pretty(selected.evaluation || { state: 'legacy_not_evaluated' }))}</pre></details>`);
  detail.querySelector('[data-export-knowledge]').onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(knowledgePackage(selected),null,2)],{type:'application/json'}));
    const link=root.ownerDocument.createElement('a');link.href=url;link.download=`${id}-${selected.pill.version}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  detail.querySelector('.pill-record').dataset.pagePanel = 'content';
  detail.querySelector('.pill-header')?.remove();
  const form = detail.querySelector('#version-operation');
  if (form) {
    let busy = false;
    form.querySelector('[data-reload]').onclick = async () => { if (busy) return; try { await renderLibraryPage(root, path, search); } catch (err) { const error = root.querySelector('[role="alert"]'); error.textContent = err.message; error.hidden = false; } };
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return; busy = true;
      const body = { ...Object.fromEntries(new FormData(form)), confirmed: form.elements.confirmed.checked, revision: data.revision, libraryToken: data.libraryToken };
      const error = root.querySelector('[role="alert"]'); error.hidden = true;
      const controls = [...form.querySelectorAll('input, textarea, select, button')]; controls.forEach(el => el.disabled = true);
      try {
        await api(`/api/library/${encodeURIComponent(id)}/versions/${encodeURIComponent(selected.pill.version)}/${body.operation}`, { method: 'POST', body: JSON.stringify(body) });
        if (root.isConnected) await renderLibraryPage(root, path, search);
      } catch (err) { if (root.isConnected) { error.textContent = err.message; error.hidden = false; controls.forEach(el => el.disabled = false); } }
      finally { busy = false; }
    };
  }
}
