import { api, escapeHtml as e } from './incidents.js';
import { renderLearning as renderLegacyFeedback } from './review.js';

const label = s => e((s || '').replaceAll('_', ' '));
const field = (name, title, value = '', required = true) => `<label>${title}<textarea name="${name}" rows="3" maxlength="4000" ${required ? 'required' : ''}>${e(value)}</textarea></label>`;
const person = name => `<label>${name === 'author' ? 'Recorded by' : 'Reviewer'} (signed-in)<input name="${name}" maxlength="120" required></label>`;
const errorMarkup = '<p class="form-error" role="alert" hidden></p><p class="learning-status" role="status"></p>';
const latestRecord = (records, kind) => {
  const record = records.filter(r => r.kind === kind).at(-1);
  if (!record) return '';
  return `<div class="handling-saved" role="status"><strong>Saved ${kind === 'action' ? 'action' : 'outcome'}</strong><p>${e(record.notes)}</p><p>${e(record.occurredAt)} / ${e(record.author)}${record.status ? ` / ${label(record.status)}` : ''}</p>${kind === 'action' ? `<p>Rationale: ${e(record.rationale)}</p><p>Deviation: ${e(record.deviation)}</p>` : `<p>Verification: ${e(record.verification)} (${record.verified ? 'confirmed by author' : 'unverified'})</p><p>Remaining: ${e(record.remaining)}</p>`}</div>`;
};

export function handlingMarkup(i, running = false) {
  const records = i.handlingRecords || [];
  return `<header class="workspace-heading"><div><p>${e(i.id)}</p><h2>${e(i.title)}</h2></div><span class="badge">${label(i.handlingStatus || 'not_started')}</span></header>${errorMarkup}
  <div class="handling-forms"><section class="triage-section"><h3>Step 1 · Record action</h3><p>Record what was actually done. Saving shows the record here.</p>${latestRecord(records, 'action')}<form data-record="action">${person('author')}<label>Action time<input type="datetime-local" name="occurredAt" required></label>${field('notes', 'Action taken')}${field('rationale', 'Reason / expert judgment')}${field('deviation', 'Deviation from approved advice (or none / no approved plan)')}<label>Corrects earlier action<select name="corrects"><option value="">New record</option>${records.filter(r => r.kind === 'action').map(r => `<option value="${e(r.id)}">${e(r.notes.slice(0, 70))}</option>`).join('')}</select></label><button class="primary" type="submit">Record action</button></form></section>
  <section class="triage-section"><h3>Step 2 · Record outcome</h3><p>Record what was observed, including anything still unknown.</p>${latestRecord(records, 'outcome')}<form data-record="outcome">${person('author')}<label>Observation time<input type="datetime-local" name="occurredAt" required></label><label>Outcome status<select name="status"><option value="pending_verification">Pending verification</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="unresolved">Unresolved</option></select></label>${field('notes', 'Observed result')}${field('verification', 'Verification method and evidence')}${field('remaining', 'Remaining issues / follow-up (or none)')}<label>Corrects earlier outcome<select name="corrects"><option value="">New record</option>${records.filter(r => r.kind === 'outcome').map(r => `<option value="${e(r.id)}">${e(r.notes.slice(0, 70))}</option>`).join('')}</select></label><label class="studio-check"><input name="verified" type="checkbox">I verified this outcome against the recorded evidence.</label><button class="primary" type="submit">Record outcome</button></form></section></div>
  <section class="triage-section"><h3>Handling history</h3>${[...records].reverse().map(r => `<article class="studio-version"><strong>${label(r.kind)}${r.status ? ` / ${label(r.status)}` : ''}</strong><p>${e(r.occurredAt)} / ${e(r.author)}</p><p>${e(r.notes)}</p>${r.kind === 'action' ? `<p>Rationale: ${e(r.rationale)}</p><p>Deviation: ${e(r.deviation)}</p>` : `<p>Verification: ${e(r.verification)} (${r.verified ? 'confirmed by author' : 'unverified'})</p><p>Remaining: ${e(r.remaining)}</p>`}${r.corrects ? `<small>Correction of ${e(r.corrects)}</small>` : ''}</article>`).join('') || '<p>No operational records.</p>'}</section>
  <section class="triage-section"><h3>Learning analyses</h3><div class="actions"><button type="button" data-analyze ${running ? 'disabled' : ''}>${running ? 'Analysis running' : 'Analyze case learning'}</button><button type="button" data-refresh>Refresh</button><a href="/studio/improvements">Improvement queue</a></div>${[...(i.learningRuns || [])].reverse().map(r => `<article class="studio-version"><p>${e(r.createdAt)} / ${e(r.model)} / ${e(r.promptVersion)}</p><p>${e(r.summary)}</p><ul>${r.questions.map(q => `<li>${e(q)}</li>`).join('')}</ul><a href="/studio/improvements#${e(r.id)}">${r.proposals.length} proposals</a><details><summary>Evidence snapshot</summary>${r.snapshot.blocks.map(b => `<p><strong>${e(b.id)}</strong></p><pre class="learning-evidence">${e(b.text)}</pre>`).join('')}</details></article>`).join('') || '<p>No learning analyses.</p>'}</section>`;
}

export async function renderHandling(root, id, drafts = {}) {
  const { incident, running } = await api(`/api/cases/${encodeURIComponent(id)}/handling`);
  if (!root.isConnected) return;
  root.innerHTML = handlingMarkup(incident, running);
  const sourcePills = incident.triageReports?.at(-1)?.sourcePills || [];
  if (sourcePills.length > 1) root.querySelector('[data-analyze]').insertAdjacentHTML('beforebegin', `<label>Learning target<select id="learning-target"><option value="">Select original Pill</option>${sourcePills.map(p => `<option value="${e(p.id)}">${e(p.name)} / ${e(p.version)}</option>`).join('')}</select></label>`);
  for (const [kind, values] of Object.entries(drafts)) {
    const form = root.querySelector(`[data-record="${kind}"]`);
    for (const [name, value] of Object.entries(values)) {
      const input = form.elements[name];
      if (input.type === 'checkbox') input.checked = value === 'on'; else input.value = value;
    }
  }
  let busy = false;
  const pendingDrafts = () => Object.fromEntries([...root.querySelectorAll('[data-record]')].filter(form => form.dataset.dirty === 'true' || drafts[form.dataset.record]).map(form => [form.dataset.record, Object.fromEntries(new FormData(form))]));
  root.querySelectorAll('[data-record]').forEach(form => form.addEventListener('input', () => form.dataset.dirty = 'true'));
  async function perform(task, message, savedKind) {
    if (busy) return; busy = true;
    const error = root.querySelector('[role="alert"]'); error.hidden = true;
    const retained = pendingDrafts();
    const controls = [...root.querySelectorAll('button, input, textarea, select')].map(el => [el, el.disabled]); controls.forEach(([el]) => el.disabled = true);
    root.querySelector('.learning-status').textContent = message;
    try { await task(); if (savedKind) delete retained[savedKind]; if (root.isConnected) await renderHandling(root, id, retained); }
    catch (err) { if (root.isConnected) { error.textContent = err.message; error.hidden = false; root.querySelector('.learning-status').textContent = ''; controls.forEach(([el, disabled]) => el.disabled = disabled); } }
    finally { busy = false; }
  }
  root.querySelectorAll('[data-record]').forEach(form => form.onsubmit = event => {
    event.preventDefault(); const body = { ...Object.fromEntries(new FormData(form)), kind: form.dataset.record, revision: incident.revision || 0, verified: form.elements.verified?.checked || false };
    if (!Number.isFinite(Date.parse(body.occurredAt))) { const error = root.querySelector('[role="alert"]'); error.textContent = 'Enter a valid record time.'; error.hidden = false; return; }
    body.occurredAt = new Date(body.occurredAt).toISOString();
    perform(() => api(`/api/cases/${encodeURIComponent(id)}/handling`, { method: 'POST', body: JSON.stringify(body) }), 'Saving record...', form.dataset.record);
  });
  root.querySelector('[data-analyze]').onclick = () => {
    if (Object.keys(pendingDrafts()).length) { const error = root.querySelector('[role="alert"]'); error.textContent = 'Save pending operational records before analyzing.'; error.hidden = false; return; }
    const targetPillId = root.querySelector('#learning-target')?.value;
    perform(() => api(`/api/cases/${encodeURIComponent(id)}/learning`, { method: 'POST', body: JSON.stringify({ revision: incident.revision || 0, targetPillId }) }), 'Analyzing saved evidence...');
  };
  root.querySelector('[data-refresh]').onclick = () => perform(async () => {}, 'Refreshing...');
}

export function proposalMarkup(run, p) {
  return `<article class="triage-section" data-proposal="${e(p.id)}"><header class="workspace-heading"><h3>${e(p.title)}</h3><span class="badge">${label(p.imported ? p.imported.releasedVersion ? 'released' : p.imported.status : p.decision?.status || 'pending_review')}</span></header><p>${label(p.cause)} / ${label(p.disposition)}</p><p>${e(p.reason)}</p><dl class="learning-comparison"><dt>Before</dt><dd>${e(p.before)}</dd><dt>Proposed change</dt><dd>${e(p.after)}</dd><dt>Applicability</dt><dd>${e(p.applicability)}</dd><dt>Limitations</dt><dd>${e(p.limitations)}</dd></dl><details><summary>Evidence and proposed validation cases</summary>${p.evidence.map(ref => `<blockquote><strong>${e(ref.blockId)}</strong><p>${e(ref.quote)}</p></blockquote>`).join('')}<ul>${p.validationCases.map(v => `<li>${e(v)}</li>`).join('')}</ul></details>
  ${!p.decision ? `<form data-review>${person('reviewer')}<label>Decision<select name="decision"><option value="needs_information">Request more evidence</option><option value="accepted">Accept proposal</option><option value="rejected">Reject proposal</option></select></label>${field('notes', 'Review rationale')}${field('reviewedAfter', 'Reviewed change', p.after, false)}<label class="studio-check"><input type="checkbox" name="confirmed">I reviewed the evidence, applicability and limitations.</label><button type="submit">Save decision</button></form>` : `<p>Reviewed by ${e(p.decision.reviewer)}: ${e(p.decision.notes)}</p>${p.decision.reviewedAfter ? `<p>${e(p.decision.reviewedAfter)}</p>` : ''}`}
  ${p.staleEvidence && !p.imported ? '<p class="triage-notice">Evidence changed. Re-analyze the current case before accepting or importing this knowledge.</p>' : ''}
  ${p.imported ? `<a href="/studio/${e(p.imported.pillId)}">Open Pill draft / versions</a>` : !p.staleEvidence && p.decision?.status === 'accepted' && ['update_pill', 'new_pill'].includes(p.disposition) ? `<form data-apply>${p.disposition === 'new_pill' ? '<label>New Pill name<input name="name" maxlength="200" required></label><label>Knowledge owner<input name="owner" maxlength="120" required></label>' : '<p>Target: original Pill version. An editable draft is required.</p>'}<button type="submit">Add reviewed proposal to draft</button></form>` : ''}</article>`;
}

export async function renderLearning(root) {
  const { runs = [], candidates = [] } = await api('/api/learning');
  if (!root.isConnected) return;
  root.innerHTML = `<h2>Learning &amp; Improvement</h2>${errorMarkup}${[...runs].reverse().map(run => `<section id="${e(run.id)}"><header class="workspace-heading"><h3>${e(run.title)}</h3><a href="/cases/${e(run.incidentId)}/handling">Case records</a></header><p>${e(run.createdAt)}</p><p>${e(run.summary)}</p><ul>${run.questions.map(q => `<li>${e(q)}</li>`).join('')}</ul>${run.proposals.map(p => proposalMarkup(run, p)).join('') || `<div class="handling-saved"><strong>No change proposed by this analysis.</strong><p>The current evidence did not support a Pill update. This does not complete a version-update test. If new verified evidence or expert corrections reveal a gap, add them to the <a href="/cases/${e(run.incidentId)}/handling">case records</a> and analyze again.</p></div>`}</section>`).join('') || '<p>No learning analyses yet.</p>'}${candidates.length ? '<details class="triage-section"><summary>Earlier human-review feedback</summary><div data-legacy></div></details>' : ''}`;
  if (candidates.length) await renderLegacyFeedback(root.querySelector('[data-legacy]'));
  let busy = false;
  for (const run of runs) for (const p of run.proposals) {
    const container = root.querySelector(`[data-proposal="${p.id}"]`);
    for (const kind of ['review', 'apply']) {
      const form = container.querySelector(`[data-${kind}]`);
      if (!form) continue;
      form.onsubmit = async event => {
        event.preventDefault(); if (busy) return; busy = true;
        const error = root.querySelector('[role="alert"]'); error.hidden = true;
        const controls = [...root.querySelectorAll('button')]; controls.forEach(b => b.disabled = true);
        try {
          const body = { ...Object.fromEntries(new FormData(form)), confirmed: form.elements.confirmed?.checked || false, revision: run.revision };
          if (kind === 'apply' && p.disposition === 'update_pill') {
            const data = await api(`/api/cases/${encodeURIComponent(run.incidentId)}/handling`);
            const original = data.incident.learningRuns.find(r => r.id === run.id).snapshot.pill;
            const { record } = await api(`/api/studio/${encodeURIComponent(original.id)}`);
            if (record.state === 'published') throw new Error('Open the original Pill in Studio and create its next draft before importing.');
            body.revision = record.revision;
          }
          await api(`/api/learning/${encodeURIComponent(run.incidentId)}/${encodeURIComponent(run.id)}/${encodeURIComponent(p.id)}/${kind}`, { method: 'POST', body: JSON.stringify(body) });
          if (root.isConnected) await renderLearning(root);
        } catch (err) { if (root.isConnected) { error.textContent = err.message; error.hidden = false; controls.forEach(b => b.disabled = false); } }
        finally { busy = false; }
      };
    }
  }
}
