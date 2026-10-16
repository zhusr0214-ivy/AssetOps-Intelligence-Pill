import { escapeHtml as e, api } from './incidents.js';
import {currentUser} from './session.js';
import {pillContentMarkup} from './pill-preview.js';

export function pillMarkup(pill, {captureHistory=[],library=false}={}) {
  if(library)return pillContentMarkup(pill,{hideEmptyOptional:true,anchors:true,showEscalation:false});
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
    <footer class="pill-footer">${pill.status==='approved'?'Published knowledge for matching cases.':'Draft knowledge awaiting validation and approval.'} Reports retain the version used. ${!library?`<a href="/studio/${e(pill.id)}">Open in Pill Studio</a>`:''}</footer></article>`;
}

export function filterPills(pills, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return pills.filter(pill => terms.every(term => JSON.stringify(pill).toLowerCase().includes(term)));
}

const publicationDate = value => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'Not specified';
  return date.toLocaleString(undefined, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
};

export function renderLibrary(root, pills) {
  root.innerHTML = `<section class="incident-workspace library-conversations case-conversations"><header class="workspace-heading"><h2>Pill Library</h2></header><label>Search Pills<input type="search" placeholder="Pill, version or date" aria-label="Search Pills"></label><div class="case-list-heading" aria-hidden="true"><span>Pill</span><span>Active version</span><span>Updated</span></div><ul class="case-conversation-list pill-library-list"></ul><p class="result-count library-search-status" role="status"></p></section>`;
  const input = root.querySelector('input');
  const update = () => {
    const groups = [...new Set(pills.map(p => p.id))].map(id => pills.filter(p => p.id === id))
      .sort((a,b) => String(b.at(-1).publishedAt || '').localeCompare(String(a.at(-1).publishedAt || '')));
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = groups.filter(versions => terms.every(term => versions.some(p =>
      [JSON.stringify(p),publicationDate(p.publishedAt)].join(' ').toLowerCase().includes(term))));
    root.querySelector('.result-count').textContent = `${matches.length} of ${groups.length} Pills`;
    root.querySelector('ul').innerHTML = matches.map(versions => {
      const latest=versions.at(-1),active=versions.find(p=>p.active && !p.disabled);
      return `<li><a href="/library/${e(latest.id)}"><strong>${e(latest.name)}</strong><span aria-label="Active version">${active ? `v${e(active.version)}` : 'Not active'}</span><time aria-label="Updated" datetime="${e(latest.publishedAt || '')}" title="Latest publication">${e(publicationDate(latest.publishedAt))}</time></a></li>`;
    }).join('') || '<li class="empty-state">No approved Pills match this view. Drafts are in Pill Studio.</li>';
  };
  input.addEventListener('input', update); update();
}

const versionState = v => v.disabled ? 'Unavailable' : v.active ? 'In use' : 'Previous version';
const versionLabel = value => `Version ${String(value).replace(/^(\d+)\.0\.0$/, '$1')}`;
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function comparisonMarkup(result) {
  return `<h3>v${e(result.from)} to v${e(result.to)}</h3><p>${result.counts.added} added / ${result.counts.removed} removed / ${result.counts.modified} modified</p>${result.changes.map(c => `<section class="version-change"><h4>${e(c.section)} / ${e(c.key)} <span class="badge">${e(c.type)}</span></h4><div class="version-diff"><div><strong>Before</strong><pre>${e(c.before === null ? '(absent)' : pretty(c.before))}</pre></div><div><strong>After</strong><pre>${e(c.after === null ? '(absent)' : pretty(c.after))}</pre></div></div></section>`).join('') || '<p>No knowledge content changes.</p>'}`;
}

export function knowledgePackage(release) {
  return {format:'assetops-intelligence-pill',schemaVersion:1,pill:release.pill,sources:release.sources||[],examples:release.examples||[],captureHistory:release.captureHistory||[],learningImports:release.learningImports||[],validation:release.validation,evaluation:release.evaluation,approval:{reviewer:release.reviewer,notes:release.notes,publishedAt:release.publishedAt},contentHash:release.contentHash};
}

export function historyMarkup(data) {
  return `<section class="triage-section library-version-list" data-page-panel="versions"><h3>Versions</h3><div class="table-scroll"><table class="incident-table"><thead><tr><th>Version</th><th>Status</th><th>Released</th><th>Approved by</th></tr></thead><tbody>${[...data.releases].reverse().map(v => `<tr><td><a href="/library/${e(data.id)}/versions/${e(v.pill.version)}?view=versions">${e(versionLabel(v.pill.version))}</a></td><td>${versionState(v)}</td><td><time datetime="${e(v.publishedAt || '')}">${e(publicationDate(v.publishedAt))}</time></td><td>${e(v.reviewer || 'Not specified')}</td></tr>`).join('')}</tbody></table></div>${data.releases.length > 1 ? `<p><a href="/library/${e(data.id)}/compare?view=versions">Compare versions</a></p>` : ''}</section>`;
}

export function releaseMetadataMarkup(release) {
  const user=currentUser();
  const accountName=(name,id)=>id&&id===user?.id ? user.username||name : name;
  const names=[...(release.captureHistory||[]).map(item=>accountName(item.reviewer,item.actorId)),...(release.learningImports||[]).map(item=>item.proposal?.decision?.reviewer),...(release.sources||[]).map(item=>item.expert).filter(name=>name&&!/^Reviewed by /i.test(name))];
  const contributors=[...new Set(names.filter(name=>typeof name==='string'&&name.trim()).map(name=>name.trim()))];
  const contributor=contributors.length ? contributors.join(', ') : 'Not recorded';
  const publishedDate=new Date(release.publishedAt);
  const published=release.publishedAt&&!Number.isNaN(publishedDate.getTime()) ? publishedDate.toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : 'Not recorded';
  return `<div class="library-release-meta" data-page-panel="content"><dl class="library-release-facts"><div><dt>Contributed by</dt><dd>${e(contributor)}</dd></div><div><dt>Approved by</dt><dd>${e(accountName(release.reviewer,release.actorId)||'Not recorded')}</dd></div><div><dt>Published</dt><dd>${e(published)}</dd></div></dl></div>`;
}

export async function renderLibraryPage(root, path, search = '') {
  if (path === '/library') { const { pills } = await api('/api/library'); if (root.isConnected) renderLibrary(root, pills); return; }
  const match = path.match(/^\/library\/([^/]+)(?:\/(compare|versions)(?:\/([^/]+))?)?$/);
  if (!match || match[2] === 'versions' && !match[3] || match[2] === 'compare' && match[3]) throw new Error('Library page not found.');
  const [, id, section, version] = match, data = await api(`/api/library/${encodeURIComponent(id)}`);
  if (!root.isConnected) return;
  const selected = version ? data.releases.find(v => v.pill.version === version) : data.releases.find(v => v.active) || data.releases.at(-1);
  if (!selected) throw new Error('Published version not found.');
  root.innerHTML = `<a class="back-link" href="/library">&larr; Pill Library</a><header class="workspace-heading"><div><h2>${e(selected.pill.name)}</h2><span data-version-note hidden>${e(versionLabel(selected.pill.version))} · ${versionState(selected)}</span></div>${currentUser()?.roles?.includes('admin') ? `<a class="button" href="/studio/${e(id)}?edit=1">Edit</a>` : ''}</header><p class="form-error" role="alert" hidden></p><div class="library-detail"></div>`;
  const detail = root.querySelector('.library-detail');
  if (section === 'compare') {
    detail.dataset.pagePanel = 'versions';
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
  detail.innerHTML = `${historyMarkup(data)}${pillMarkup({ ...selected.pill, active: selected.active }, {captureHistory:selected.captureHistory||[],library:true})}${releaseMetadataMarkup(selected)}
  ${!selected.active && currentUser()?.roles?.includes('admin') ? `<form id="version-operation" class="triage-section" data-page-panel="versions"><h3>Change ${e(versionLabel(selected.pill.version).toLowerCase())}</h3><label>Change<select name="operation">${selected.disabled ? '<option value="restore">Make available again</option>' : '<option value="activate">Use this version for new cases</option><option value="disable">Make this version unavailable</option>'}</select></label><label>Administrator<input name="reviewer" value="${e(currentUser()?.name || currentUser()?.username || '')}" maxlength="120" readonly required></label><label>Reason<textarea name="notes" maxlength="3000" required></textarea></label><label class="studio-check"><input name="confirmed" type="checkbox" required>Apply this change to ${e(versionLabel(selected.pill.version).toLowerCase())}. Existing case reports will keep their original version.</label><button type="submit">Confirm change</button><button type="button" data-reload>Refresh</button></form>` : ''}`;
  if (selected.checksumState === 'mismatch') detail.insertAdjacentHTML('afterbegin', '<p class="form-error" role="alert">This saved version could not be verified. An administrator must check it before it can be used again.</p>');
  detail.querySelector('.pill-content-preview').dataset.pagePanel = 'content';
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
