import { escapeHtml as e } from './incidents.js';

function depthMarkup(record) {
  const run = record.evaluations?.at(-1), policy = record.evaluationOptions;
  const stats = run?.statistics, review = run?.expertReview;
  return `<section class="triage-section"><h3>Evaluation policy & expert review</h3>${record.state !== 'published' ? `<fieldset id="evaluation-options"><legend>Release criteria</legend><label>Repetitions per case<input name="repetitions" type="number" min="1" max="5" step="1" value="${e(policy?.repetitions ?? 3)}"></label><label>Minimum pass rate (%)<input name="minimumPassRate" type="number" min="80" max="100" step="1" value="${e((policy?.minimumPassRate ?? 1) * 100)}"></label><label><input type="checkbox" name="expertReviewRequired" ${policy?.expertReviewRequired !== false ? 'checked' : ''}>Require independent expert review</label></fieldset>` : ''}${stats ? `<dl><dt>Passed / total trials</dt><dd>${e(stats.passed)} / ${e(stats.samples)}</dd><dt>Pass rate</dt><dd>${e((stats.passRate * 100).toFixed(1))}%</dd><dt>Failed model or validation trials</dt><dd>${e(stats.errors)}</dd><dt>Unique cases</dt><dd>${e(run.coverage?.uniqueCases)}</dd><dt>Scope</dt><dd>${e(run.coverage?.categories.join(', '))}</dd></dl><p class="triage-notice">Observed results for these cases only. Repeated model outputs may be dependent; this is not engineering certification or a safety proof.</p><ul>${run.results.map(r => `<li>${e(r.name)}: ${e(r.candidate.statistics?.passed ?? (r.candidate.passed ? 1 : 0))}/${e(r.candidate.statistics?.samples || 1)} passed${r.candidate.statistics?.unstable ? ' / variable structured outputs' : ''}${r.baseline?.statistics ? ` / baseline ${(r.baseline.statistics.passRate * 100).toFixed(1)}%` : ''}${r.comparisonReliable === false ? ' / baseline unavailable' : ''}</li>`).join('')}</ul>` : ''}${review ? `<h4>Expert decision: ${e(review.decision)}</h4><p>${e(review.reviewer)} / ${e(review.at)}</p><p>${e(review.scope)}</p><p>${e(review.limitations)}</p><p>${e(review.qualification)} / ${e(review.reference)}</p><p>${e(review.notes)}</p>` : run && record.state !== 'published' ? `<form id="evaluation-review"><h4>Independent review</h4><label>Decision<select name="decision"><option value="accepted">Accept</option><option value="rejected">Reject</option></select></label>${[['scope', 'Reviewed operating scope'], ['limitations', 'Limitations and exclusions'], ['qualification', 'Relevant expertise / qualification'], ['reference', 'Review evidence reference'], ['notes', 'Review rationale']].map(([key, label]) => `<label>${label}<textarea name="${key}" maxlength="2000" required></textarea></label>`).join('')}<label><input type="checkbox" name="confirmed" required>I reviewed the sources, trial failures and operating limits.</label><button type="submit">Record expert decision</button></form>` : ''}</section>`;
}

const fields = ['title', 'description', 'location', 'asset', 'observations', 'occurredAt', 'affectedScope', 'impact', 'actionsTaken', 'priority'];
const categories = ['hvac_cooling', 'hvac', 'hvac_local_comfort', 'energy', 'water_leak', 'electrical_distribution', 'lift_fault', 'other'];
function row(item = { facts: {}, expected: {} }) {
  return `<fieldset data-evaluation-case class="studio-row"><legend>Test case</legend><label>Name<input name="testName" maxlength="120" value="${e(item.name || '')}" required></label><label>Category<select name="category">${categories.map(c => `<option ${item.facts.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><div class="studio-fields">${fields.map(k => `<label>${e(k)}<textarea name="${k}" maxlength="4000">${e(item.facts[k] || '')}</textarea></label>`).join('')}</div><label>Expected status<select name="expectedStatus">${['complete', 'knowledge_gap', 'out_of_scope', 'needs_information'].map(s => `<option ${item.expected.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>${['ruleIds', 'actionIds', 'missingFields'].map(k => `<label>Expected ${e(k)} (comma separated)<input name="${k}" value="${e((item.expected[k] || []).join(', '))}"></label>`).join('')}<button type="button" data-remove-test>Remove test</button></fieldset>`;
}
export function evaluationMarkup(record) {
  const latest = record.evaluations?.at(-1), gate = record.evaluationGate;
  const model = latest?.modelStatistics;
  const modelSummary = model ? `<p>Model-only trials: ${e(model.passed)}/${e(model.samples)} passed. Descriptive 95% Wilson interval: ${e((model.interval95.lower * 100).toFixed(1))}% to ${e((model.interval95.upper * 100).toFixed(1))}%. Rule-only checks excluded; repeated samples are not independent safety evidence.</p>` : '';
  return depthMarkup(record) + modelSummary + `<section class="triage-section evaluation-panel"><h3>Model evaluation</h3><p role="status">${e(record.evaluationRunning ? 'Running' : gate?.state || 'not_enabled')}</p>${record.state !== 'published' ? `<details><summary>Test suite (${record.evaluationSuite?.length || 0})</summary><form id="evaluation-suite"><div data-test-rows>${(record.evaluationSuite || []).map(row).join('')}</div><div class="actions"><button type="button" data-add-test>Add test case</button><button type="submit">Save suite and enable release gate</button></div></form></details><div class="actions"><button type="button" data-run-evaluation ${!record.evaluationRequired || record.evaluationRunning ? 'disabled' : ''}>Run model evaluation (uses API quota)</button><button type="button" data-refresh-evaluation>Reload evaluation</button></div>` : ''}${latest ? `<p>${e(latest.completedAt)} / ${e(latest.model)} / ${e(latest.promptVersion)}</p><div class="table-scroll"><table class="incident-table"><thead><tr><th>Case</th><th>Expected</th><th>Draft</th><th>Active baseline</th><th>Regression</th></tr></thead><tbody>${latest.results.map(r => `<tr><td>${e(r.name)}</td><td>${e(r.expected.status)}</td><td>${r.candidate.passed ? 'Pass' : 'Fail'}${r.candidate.error ? `<small>${e(r.candidate.error)}</small>` : `<small>${e(JSON.stringify(r.candidate.actual))}</small>`}</td><td>${r.baseline ? r.baseline.passed ? 'Pass' : 'Fail' : 'No baseline'}</td><td>${r.regression ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No model evaluation recorded.</p>'}<details><summary>Evaluation history (${record.evaluations?.length || 0})</summary>${[...(record.evaluations || [])].reverse().map(r => `<details><summary>${e(r.completedAt)} / ${r.passed ? 'Passed' : 'Failed'}</summary><pre class="version-evidence">${e(JSON.stringify(r, null, 2))}</pre></details>`).join('')}</details></section>`;
}
export function bindEvaluation(view, record, operate, refresh) {
  const form = view.querySelector('#evaluation-suite');
  let dirty = false;
  const error = message => { const el = view.querySelector('#studio-error'); el.textContent = message; el.hidden = false; };
  const mark = () => { dirty = true; form.dataset.dirty = 'true'; };
  form?.addEventListener('input', mark);
  view.querySelector('#evaluation-options')?.addEventListener('input', mark);
  view.querySelector('#evaluation-review')?.addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    operate('review-evaluation', { ...Object.fromEntries(new FormData(form)), runId: record.evaluations.at(-1).id, confirmed: form.elements.confirmed.checked });
  });
  form?.querySelector('[data-add-test]').addEventListener('click', () => {
    if (form.querySelectorAll('[data-evaluation-case]').length >= 8) return error('Maximum eight cases.');
    form.querySelector('[data-test-rows]').insertAdjacentHTML('beforeend', row()); mark();
  });
  form?.addEventListener('click', event => { if (event.target.closest('[data-remove-test]')) { event.target.closest('[data-evaluation-case]').remove(); mark(); } });
  form?.addEventListener('submit', event => {
    event.preventDefault();
    const suite = [...form.querySelectorAll('[data-evaluation-case]')].map(el => {
      const value = k => el.querySelector(`[name="${k}"]`).value;
      return { name: value('testName'), facts: { ...Object.fromEntries(fields.map(k => [k, value(k)])), category: value('category') }, expected: { status: value('expectedStatus'), ...Object.fromEntries(['ruleIds', 'actionIds', 'missingFields'].map(k => [k, value(k).split(',').map(s => s.trim()).filter(Boolean)])) } };
    });
    const options = view.querySelector('#evaluation-options');
    operate('save-evaluations', { suite, options: options ? { repetitions: Number(options.querySelector('[name=repetitions]').value), minimumPassRate: Number(options.querySelector('[name=minimumPassRate]').value) / 100, expertReviewRequired: options.querySelector('[name=expertReviewRequired]').checked } : record.evaluationOptions });
  });
  view.querySelector('[data-run-evaluation]')?.addEventListener('click', () => dirty ? error('Save the test suite before evaluating.') : operate('evaluate', {}));
  view.querySelector('[data-refresh-evaluation]')?.addEventListener('click', () => dirty ? error('Save the test suite before reloading.') : refresh());
}
