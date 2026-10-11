import { escapeHtml as e } from './incidents.js';

const fields = ['title', 'description', 'location', 'asset', 'observations', 'occurredAt', 'affectedScope', 'impact', 'actionsTaken', 'priority'];
const categories = ['hvac_cooling', 'hvac', 'hvac_local_comfort', 'energy', 'water_leak', 'electrical_distribution', 'lift_fault', 'other'];
function row(item = { facts: {}, expected: {} }) {
  return `<fieldset data-evaluation-case class="studio-row"><legend>Test case</legend><label>Name<input name="testName" maxlength="120" value="${e(item.name || '')}" required></label><label>Category<select name="category">${categories.map(c => `<option ${item.facts.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><div class="studio-fields">${fields.map(k => `<label>${e(k)}<textarea name="${k}" maxlength="4000">${e(item.facts[k] || '')}</textarea></label>`).join('')}</div><label>Expected status<select name="expectedStatus">${['complete', 'knowledge_gap', 'out_of_scope', 'needs_information'].map(s => `<option ${item.expected.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>${['ruleIds', 'actionIds', 'missingFields'].map(k => `<label>Expected ${e(k)} (comma separated)<input name="${k}" value="${e((item.expected[k] || []).join(', '))}"></label>`).join('')}<button type="button" data-remove-test>Remove test</button></fieldset>`;
}
export function evaluationMarkup(record) {
  const latest = record.evaluations?.at(-1), gate = record.evaluationGate;
  return `<section class="triage-section evaluation-panel"><h3>Model evaluation</h3><p role="status">${e(record.evaluationRunning ? 'Running' : gate?.state || 'not_enabled')}</p>${record.state !== 'published' ? `<details><summary>Test suite (${record.evaluationSuite?.length || 0})</summary><form id="evaluation-suite"><div data-test-rows>${(record.evaluationSuite || []).map(row).join('')}</div><div class="actions"><button type="button" data-add-test>Add test case</button><button type="submit">Save suite and enable release gate</button></div></form></details><div class="actions"><button type="button" data-run-evaluation ${!record.evaluationRequired || record.evaluationRunning ? 'disabled' : ''}>Run model evaluation (uses API quota)</button><button type="button" data-refresh-evaluation>Reload evaluation</button></div>` : ''}${latest ? `<p>${e(latest.completedAt)} / ${e(latest.model)} / ${e(latest.promptVersion)}</p><div class="table-scroll"><table class="incident-table"><thead><tr><th>Case</th><th>Expected</th><th>Draft</th><th>Active baseline</th><th>Regression</th></tr></thead><tbody>${latest.results.map(r => `<tr><td>${e(r.name)}</td><td>${e(r.expected.status)}</td><td>${r.candidate.passed ? 'Pass' : 'Fail'}${r.candidate.error ? `<small>${e(r.candidate.error)}</small>` : `<small>${e(JSON.stringify(r.candidate.actual))}</small>`}</td><td>${r.baseline ? r.baseline.passed ? 'Pass' : 'Fail' : 'No baseline'}</td><td>${r.regression ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No model evaluation recorded.</p>'}<details><summary>Evaluation history (${record.evaluations?.length || 0})</summary>${[...(record.evaluations || [])].reverse().map(r => `<details><summary>${e(r.completedAt)} / ${r.passed ? 'Passed' : 'Failed'}</summary><pre class="version-evidence">${e(JSON.stringify(r, null, 2))}</pre></details>`).join('')}</details></section>`;
}
export function bindEvaluation(view, record, operate, refresh) {
  const form = view.querySelector('#evaluation-suite');
  let dirty = false;
  const error = message => { const el = view.querySelector('#studio-error'); el.textContent = message; el.hidden = false; };
  const mark = () => { dirty = true; form.dataset.dirty = 'true'; };
  form?.addEventListener('input', mark);
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
    operate('save-evaluations', { suite });
  });
  view.querySelector('[data-run-evaluation]')?.addEventListener('click', () => dirty ? error('Save the test suite before evaluating.') : operate('evaluate', {}));
  view.querySelector('[data-refresh-evaluation]')?.addEventListener('click', () => dirty ? error('Save the test suite before reloading.') : refresh());
}
