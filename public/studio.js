import { api, escapeHtml as e } from './incidents.js';
import { pillMarkup } from './library.js';
import { renderLearning } from './learning.js';
import { renderCaptureEntry, captureMarkup, bindCapture } from './knowledge.js';

const layouts = {
  sources: [['expert', 'Expert / contributor'], ['reference', 'Source / interview reference'], ['knowledge', 'Captured experience', 'text']],
  rules: [['id', 'Rule ID'], ['title', 'Title'], ['guidance', 'Decision guidance', 'text'], ['cardExplanation', 'Explanation', 'text'], ['actionIds', 'Related action IDs (comma separated)', 'list']],
  actions: [['id', 'Action ID'], ['title', 'Title'], ['instruction', 'Action instruction', 'text'], ['owner', 'Responsible role'], ['ruleIds', 'Related rule IDs (comma separated)', 'list'], ['requiresApproval', 'Requires human approval', 'check']],
  examples: [['scenario', 'Example case and observations', 'text'], ['rationale', 'Expert rationale', 'text'], ['ruleIds', 'Expected rule IDs (comma separated)', 'list'], ['actionIds', 'Expected action IDs (comma separated)', 'list']]
};
const names = { sources: 'Expert knowledge', rules: 'Decision rules', actions: 'Action catalog', examples: 'Validation examples' };
function field(name, label, value, type = '') {
  const val = type === 'list' ? (Array.isArray(value) ? value.join(', ') : '') : value || '';
  if (type === 'check') return `<label class="studio-check"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
  return `<label>${label}${type === 'text' ? `<textarea name="${name}" rows="3" maxlength="8000">${e(val)}</textarea>` : `<input name="${name}" value="${e(val)}" maxlength="4000">`}</label>`;
}
function row(kind, item = {}) {
  return `<fieldset class="studio-row" data-kind="${kind}"><legend>${names[kind]}</legend><div class="studio-fields">${layouts[kind].map(([key, label, type]) => field(key, label, item[key], type)).join('')}</div><button type="button" data-remove>Remove entry</button></fieldset>`;
}
export function editorMarkup(record) {
  const c = record.content, p = c.pill;
  const published = record.state === 'published';
  return `<a class="back-link" href="/studio">&larr; All Pills</a><header class="workspace-heading"><div><h2>${e(p.name)}</h2><p>${e(p.owner)}</p></div><span class="badge">${e(record.state.replaceAll('_', ' '))}</span></header>
  ${record.validation ? `<section class="triage-section"><h3>${record.validation.passed ? 'Structural validation passed' : 'Validation needs attention'}</h3><p>${e(record.validation.scope)}</p><ul>${record.validation.errors.map(error => `<li>${e(error)}</li>`).join('')}</ul></section>` : ''}
  <p id="studio-error" class="form-error" role="alert" hidden></p><p id="studio-status" role="status"></p>
  ${published ? `${pillMarkup(record.releases.at(-1).pill)}<button type="button" class="primary" data-operation="fork">Create next draft</button>` : `<form id="pill-editor"><section class="triage-section"><h3>Capability</h3><p class="muted-label">AHU cooling / advisory use</p><div class="studio-fields">${[['name', 'Pill name'], ['owner', 'Knowledge owner'], ['source', 'Knowledge provenance'], ['scope', 'Applicable assets, conditions and exclusions']].map(([key, label]) => field(key, label, p[key], key === 'scope' || key === 'source' ? 'text' : '')).join('')}</div></section>
  ${Object.keys(layouts).map(kind => `<section class="triage-section"><h3>${names[kind]}</h3><div data-rows="${kind}">${(c[kind] || p[kind] || []).map(item => row(kind, item)).join('')}</div><button type="button" data-add="${kind}">Add ${kind === 'sources' ? 'source' : kind === 'rules' ? 'rule' : kind === 'actions' ? 'action' : 'example'}</button></section>`).join('')}
  <section class="triage-section"><h3>Boundaries and escalation</h3>${field('boundaries', 'Boundaries (one per line)', p.boundaries.join('\n'), 'text')}${field('escalationConditions', 'Escalation conditions (one per line)', p.escalationConditions.join('\n'), 'text')}</section><div class="actions"><button type="submit" class="primary">Save draft</button><button type="button" data-operation="validate">Validate saved draft</button>${record.state === 'validated' ? '<button type="button" data-operation="submit">Submit for expert review</button>' : ''}</div></form>`}
  ${record.state === 'in_review' ? `<form id="pill-approval" class="triage-section"><h3>Expert review</h3>${field('reviewer', 'Reviewer name (self-declared)', '')}${field('notes', 'Review rationale', '', 'text')}<label class="studio-check"><input type="checkbox" name="expertConfirmed">I reviewed the sources, decision rules, boundaries and example cases for this version.</label><p>Publishing makes this the active AHU capability for new analyses. Equipment execution remains disabled.</p><div class="actions"><button class="primary" type="submit" value="publish">Approve and publish</button><button type="submit" value="return">Return for changes</button></div></form>` : ''}
  <details class="triage-section"><summary>Published versions (${record.releases.length})</summary>${[...record.releases].reverse().map(release => `<article class="studio-version"><h3>${e(release.pill.version)} ${release.active ? '/ Active' : ''}</h3><p>${e(release.publishedAt)} / ${e(release.reviewer)}</p><p>${e(release.notes)}</p><details><summary>Version content and sources</summary>${pillMarkup(release.pill)}${release.sources.map(s => `<p><strong>${e(s.expert)}</strong> / ${e(s.reference)}</p><p>${e(s.knowledge)}</p>`).join('')}</details></article>`).join('') || '<p>No published versions.</p>'}</details>
  <details class="triage-section"><summary>Change history</summary>${[...record.events].reverse().map(event => `<p>${e(event.at)} / ${e(event.action)} ${e(event.reviewer || '')}${event.notes ? `<br>${e(event.notes)}` : ''}</p>`).join('') || '<p>No changes yet.</p>'}</details>`;
}

function readContent(form) {
  const pill = Object.fromEntries(['name', 'owner', 'source', 'scope'].map(key => [key, form.querySelector(`[name="${key}"]`).value.trim()]));
  pill.domain = 'ahu_cooling';
  for (const key of ['boundaries', 'escalationConditions']) pill[key] = form.elements[key].value.split('\n').map(v => v.trim()).filter(Boolean);
  const content = { pill };
  for (const [kind, layout] of Object.entries(layouts)) {
    const rows = [...form.querySelectorAll(`[data-kind="${kind}"]`)].map(el => Object.fromEntries(layout.map(([key, , type]) => {
      const input = el.querySelector(`[name="${key}"]`);
      return [key, type === 'check' ? input.checked : type === 'list' ? input.value.split(',').map(v => v.trim()).filter(Boolean) : input.value.trim()];
    })));
    if (kind === 'rules' || kind === 'actions') pill[kind] = rows; else content[kind] = rows;
  }
  return content;
}

export function addReferenceHelpers(form) {
  const targets = { rules: { actionIds: 'actions' }, actions: { ruleIds: 'rules' }, examples: { ruleIds: 'rules', actionIds: 'actions' } };
  const rows = kind => [...form.querySelectorAll(`fieldset[data-kind="${kind}"]`)];
  const appendId = (input, id) => {
    const ids = input.value.split(',').map(value => value.trim()).filter(Boolean);
    if (!ids.includes(id)) input.value = [...ids, id].join(', ');
  };
  for (const [kind, fields] of Object.entries(targets)) for (const row of rows(kind)) {
    for (const [fieldName, targetKind] of Object.entries(fields)) {
      const input = row.querySelector(`[name="${fieldName}"]`);
      let helper = row.querySelector(`[data-reference-for="${fieldName}"]`);
      if (!helper) {
        helper = document.createElement('div');
        helper.className = 'studio-reference-helper';
        helper.dataset.referenceFor = fieldName;
        input.closest('label').classList.add('studio-reference-field');
        const select = document.createElement('select');
        select.setAttribute('aria-label', `Choose ${targetKind === 'rules' ? 'rule' : 'action'} for ${kind.slice(0, -1)}`);
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Add selected';
        button.addEventListener('click', () => {
          if (!select.value) return;
          appendId(input, select.value);
          if (kind !== 'examples') {
            const ownId = row.querySelector('[name="id"]').value.trim();
            const other = rows(targetKind).find(item => item.querySelector('[name="id"]').value.trim() === select.value);
            if (ownId && other) appendId(other.querySelector(`[name="${kind === 'rules' ? 'ruleIds' : 'actionIds'}"]`), ownId);
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        helper.append(select, button);
        input.closest('label').after(helper);
      }
      const select = helper.querySelector('select');
      const previous = select.value;
      const placeholder = document.createElement('option');
      placeholder.textContent = `Choose ${targetKind === 'rules' ? 'rule' : 'action'}`;
      placeholder.value = '';
      select.replaceChildren(placeholder);
      for (const item of rows(targetKind)) {
        const id = item.querySelector('[name="id"]').value.trim();
        if (!id) continue;
        const title = item.querySelector('[name="title"]').value.trim();
        const option = document.createElement('option');
        option.textContent = title || id;
        option.title = `${title || id} (${id})`;
        option.value = id;
        select.add(option);
      }
      select.value = previous && [...select.options].some(option => option.value === previous) ? previous : '';
      helper.querySelector('button').disabled = select.options.length < 2;
    }
  }
}

export async function renderStudio(root, path, navigate) {
  const view = document.createElement('section'); root.replaceChildren(view);
  view.innerHTML = '<p role="status">Loading Pill Studio...</p>';
  try {
    if (path === '/studio/new/upload' || path === '/studio/new/expert') { await renderCaptureEntry(view, path.endsWith('/upload') ? 'upload' : 'expert', navigate); return; }
    if (path === '/studio/improvements') {
      view.innerHTML = '<header class="workspace-heading"><h2>Pill Studio</h2><a href="/studio">Knowledge and drafts</a></header><div class="studio-candidates"></div>';
      await renderLearning(view.querySelector('.studio-candidates')); return;
    }
    if (path === '/studio') {
      const { records } = await api('/api/studio'); if (!view.isConnected) return;
      view.innerHTML = `<header class="workspace-heading"><h2>Pill Studio</h2><a href="/studio/improvements">Improvement queue</a></header><div class="studio-entry-actions"><a class="button primary" href="/studio/new/upload">Upload documents</a><a class="button" href="/studio/new/expert">Capture expert experience</a></div><div class="table-scroll"><table class="incident-table"><thead><tr><th>Pill</th><th>Owner</th><th>Draft status</th><th>Latest release</th></tr></thead><tbody>${records.map(r => `<tr><td><a href="/studio/${e(r.id)}">${e(r.content.pill.name)}</a></td><td>${e(r.content.pill.owner)}</td><td>${e(r.state.replaceAll('_', ' '))}</td><td>${e(r.releases.at(-1)?.pill.version || 'Unpublished')}</td></tr>`).join('')}</tbody></table></div>`;
      return;
    }
    const match = path.match(/^\/studio\/([^/]+)$/); if (!match) throw new Error('Pill page not found.');
    let { record } = await api(`/api/studio/${encodeURIComponent(match[1])}`);
    const { candidates: allCandidates } = await api('/api/learning');
    const candidates = allCandidates.filter(c => c.pillId === record.id);
    let dirty = false, busy = false;
    function paint() {
      if (!view.isConnected) return;
      view.innerHTML = editorMarkup(record); dirty = false;
      view.querySelector('#studio-status').insertAdjacentHTML('afterend', captureMarkup(record));
      bindCapture(view, record, performCapture);
      if (record.learningImports?.length) {
        const section = document.createElement('section'); section.className = 'triage-section';
        section.innerHTML = `<h3>Imported learning</h3>${record.learningImports.map(item => `<article class="studio-version"><a href="/cases/${e(item.caseId)}/handling">${e(item.caseId)}</a><h4>${e(item.proposal.title)}</h4><p>${e(item.proposal.decision.reviewedAfter)}</p><p>Applicability: ${e(item.proposal.applicability)}</p><p>Limitations: ${e(item.proposal.limitations)}</p><ul>${item.proposal.validationCases.map(v => `<li>${e(v)}</li>`).join('')}</ul><span class="badge">${e(item.releasedVersion || item.status.replaceAll('_', ' '))}</span>${item.status === 'pending_incorporation' ? `<form data-incorporate="${e(item.proposalId)}"><label>Expert name<input name="reviewer" maxlength="120" required></label><label>Changed rule IDs, validation cases and rationale<textarea name="notes" maxlength="3000" required></textarea></label><label class="studio-check"><input name="expertConfirmed" type="checkbox" required>I incorporated the reviewed change into the saved rules and validation cases.</label><button type="submit">Confirm incorporation</button></form>` : ''}</article>`).join('')}`;
        view.querySelector('#studio-status').after(section);
        section.querySelectorAll('[data-incorporate]').forEach(form => form.onsubmit = event => { event.preventDefault(); operate('incorporate-learning', { proposalId: form.dataset.incorporate, ...Object.fromEntries(new FormData(form)), expertConfirmed: form.elements.expertConfirmed.checked }); });
      }
      const form = view.querySelector('#pill-editor');
      if (form) addReferenceHelpers(form);
      if (candidates.length) {
        const section = document.createElement('details'); section.className = 'triage-section';
        section.innerHTML = `<summary>Related improvement candidates (${candidates.length})</summary>${candidates.map((c, index) => `<article class="studio-version"><a href="/cases/${e(c.incidentId)}/review">${e(c.incidentId)}</a><p>${e(c.notes)}</p>${c.proposals ? `<p>${e(c.proposals)}</p>` : ''}${form ? `<button type="button" data-source="${index}">Add to expert sources</button>` : ''}</article>`).join('')}`;
        view.append(section);
      }
      const markDirty = () => { dirty = true; view.querySelector('#studio-status').textContent = 'Unsaved changes'; };
      view.querySelectorAll('[data-source]').forEach(button => button.onclick = () => {
        const candidate = candidates[Number(button.dataset.source)];
        form.querySelector('[data-rows="sources"]').insertAdjacentHTML('beforeend', row('sources', { expert: '', reference: `${candidate.incidentId} / ${candidate.reviewId} / ${candidate.id}`, knowledge: [candidate.notes, candidate.proposals, ...(candidate.omittedActions || []).map(a => `${a.title}: ${a.reason}`)].filter(Boolean).join('\n') }));
        button.disabled = true; markDirty();
      });
      form?.addEventListener('input', event => {
        markDirty();
        if (event.target.name === 'id' || event.target.name === 'title') addReferenceHelpers(form);
      });
      form?.addEventListener('click', event => {
        const add = event.target.closest('[data-add]');
        if (add) { const kind = add.dataset.add; form.querySelector(`[data-rows="${kind}"]`).insertAdjacentHTML('beforeend', row(kind)); markDirty(); addReferenceHelpers(form); }
        if (event.target.closest('[data-remove]')) { event.target.closest('.studio-row').remove(); markDirty(); addReferenceHelpers(form); }
      });
      form?.addEventListener('submit', event => { event.preventDefault(); operate('save', { content: readContent(form) }); });
      view.querySelectorAll('[data-operation]').forEach(button => button.onclick = () => operate(button.dataset.operation));
      view.querySelector('#pill-approval')?.addEventListener('submit', event => {
        event.preventDefault(); const approval = event.target;
        operate(event.submitter.value, { ...Object.fromEntries(new FormData(approval)), expertConfirmed: approval.elements.expertConfirmed.checked });
      });
    }
    async function performCapture(task, message) {
      if (busy) return;
      let errorEl = view.querySelector('#studio-error'); errorEl.hidden = true;
      if (dirty) { errorEl.textContent = 'Save your draft edits before changing knowledge sources.'; errorEl.hidden = false; return; }
      busy = true;
      const controls = [...view.querySelectorAll('button, input, textarea')].map(el => [el, el.disabled]);
      controls.forEach(([el]) => { el.disabled = true; });
      view.querySelector('#studio-status').textContent = message;
      try {
        record = await task(); paint();
        if (view.isConnected) view.querySelector('#studio-status').textContent = 'Knowledge source updated.';
      } catch (error) {
        if (view.isConnected) {
          // Failed model calls update source status and revision; reload those without losing draft edits.
          try { const result = await api(`/api/studio/${encodeURIComponent(record.id)}`); if (result.record.revision !== record.revision) { record = result.record; paint(); } } catch { /* Keep the original error if refresh also fails. */ }
          errorEl = view.querySelector('#studio-error'); errorEl.textContent = error.message; errorEl.hidden = false;
          view.querySelector('#studio-status').textContent = '';
          controls.forEach(([el, disabled]) => { el.disabled = disabled; });
        }
      } finally { busy = false; }
    }
    async function operate(operation, data = {}) {
      if (busy) return;
      const errorEl = view.querySelector('#studio-error'); errorEl.hidden = true;
      if (dirty && operation !== 'save') { errorEl.textContent = 'Save your changes before continuing.'; errorEl.hidden = false; return; }
      busy = true; view.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = true; });
      try {
        const result = await api(`/api/studio/${encodeURIComponent(record.id)}/${operation}`, { method: 'POST', body: JSON.stringify({ ...data, revision: record.revision }) });
        record = result.record; paint();
        if (view.isConnected) view.querySelector('#studio-status').textContent = operation === 'save' ? 'Draft saved.' : 'Pill updated.';
      } catch (error) { if (view.isConnected) { errorEl.textContent = error.message; errorEl.hidden = false; view.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = false; }); } }
      finally { busy = false; }
    }
    paint();
  } catch (error) { if (view.isConnected) view.innerHTML = `<a href="/studio">All Pills</a><p class="form-error" role="alert">${e(error.message)}</p>`; }
}
