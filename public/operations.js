import { api, escapeHtml as e } from './incidents.js';

export const rateLabel = r => r.percent === null ? 'No data' : `${r.percent}% (${r.numerator}/${r.denominator})`;
export function operationsMarkup(data) {
  const metrics = [['reuse', 'Knowledge reuse', rateLabel(data.reuse)], ['correction', 'Human correction', rateLabel(data.correction)], ['gapRate', 'Knowledge gaps', rateLabel(data.gapRate)], ['resolution', 'Median resolution time', data.resolution.medianHours === null ? 'No data' : `${data.resolution.medianHours.toFixed(1)} h / ${data.resolution.sampleSize} cases`]];
  return `<section class="triage-section"><h3>Operational outcomes</h3><dl class="operational-metrics">${metrics.map(([key, label, value]) => `<div><dt>${label}</dt><dd>${e(value)}</dd><details><summary>Definition</summary><p>${e(data.definitions[key])}</p></details></div>`).join('')}</dl></section><section class="triage-section"><h3>Knowledge and analysis gaps</h3><ul class="overview-list">${data.gaps.map(g => `<li><a href="/cases/${e(g.id)}/triage">${e(g.title)}</a><span>${e(g.status.replaceAll('_', ' '))}</span></li>`).join('') || '<li>No gaps recorded.</li>'}</ul></section><section class="triage-section"><h3>Version performance</h3><p class="muted-label">${e(data.definitions.versions)}</p><div class="table-scroll"><table class="incident-table"><thead><tr><th>Pill / Version</th><th>Cases</th><th>Analysis completion</th><th>Human correction</th><th>Resolved cases</th><th>Median resolution</th></tr></thead><tbody>${data.versions.map(v => `<tr><td><a href="/library/${e(v.pillId)}/compare">${e(v.name)} / ${e(v.version)}</a></td><td>${v.caseCount}</td><td>${e(rateLabel(v.completion))}</td><td>${e(rateLabel(v.correction))}</td><td>${v.resolvedCases}</td><td>${v.resolution.medianHours === null ? 'No data' : `${e(v.resolution.medianHours.toFixed(1))} h (${v.resolution.sampleSize})`}</td></tr>`).join('') || '<tr><td colspan="6">No published Pill usage yet.</td></tr>'}</tbody></table></div></section>`;
}
export async function renderOperations(root) {
  root.innerHTML = `<section class="triage-section"><h3>Reporting period and assets</h3><form class="operations-filters"><div class="review-grid"><label>Created from (UTC)<input type="date" name="from"></label><label>Created through (UTC)<input type="date" name="to"></label><label>Asset contains<input name="asset" maxlength="120"></label><label>Category<select name="category"><option value="">All categories</option>${['hvac', 'hvac_cooling', 'hvac_local_comfort', 'energy', 'water_leak', 'electrical_distribution', 'lift_fault', 'other'].map(c => `<option>${c}</option>`).join('')}</select></label></div><div class="actions"><button type="submit">Apply filters</button><button type="reset">Reset</button><a data-export download="assetops-operations.csv" hidden>Export CSV</a></div></form><p class="form-error" role="alert" hidden></p></section><div class="operations-results"></div>`;
  const form = root.querySelector('form'), results = root.querySelector('.operations-results'), error = root.querySelector('[role=alert]'), exportLink = root.querySelector('[data-export]');
  let busy = false;
  async function load() {
    if (busy) return;
    busy = true; error.hidden = true; const controls = [...form.querySelectorAll('button,input,select')];
    const query = new URLSearchParams([...new FormData(form)].filter(([, value]) => value)).toString(); controls.forEach(el => el.disabled = true); exportLink.hidden = true;
    try {
      const data = await api(`/api/operations${query ? '?' + query : ''}`);
      if (!root.isConnected) return;
      results.innerHTML = `<p>${data.caseCount} cases</p><p class="muted-label">${e(data.definitions.cohort)}</p>` + operationsMarkup(data);
      results.insertAdjacentHTML('beforeend', `<section class="triage-section"><h3>Monthly case cohorts</h3><div class="table-scroll"><table class="incident-table"><thead><tr><th>Created month</th><th>Cases</th><th>Currently resolved</th><th>Reviewed</th><th>Corrected</th><th>Knowledge gaps</th></tr></thead><tbody>${data.trends.map(t => `<tr><td>${e(t.month)}</td><td>${t.created}</td><td>${t.resolved}</td><td>${t.reviewed}</td><td>${t.corrected}</td><td>${t.gaps}</td></tr>`).join('') || '<tr><td colspan="6">No dated cases in this selection.</td></tr>'}</tbody></table></div></section>`);
      exportLink.href = `/api/operations/export${query ? '?' + query : ''}`; exportLink.hidden = false;
    } catch (failure) { error.textContent = failure.message; error.hidden = false; results.innerHTML = ''; }
    finally { busy = false; controls.forEach(el => el.disabled = false); }
  }
  form.onsubmit = event => { event.preventDefault(); load(); };
  form.onreset = event => { event.preventDefault(); for (const el of form.querySelectorAll('input,select')) el.value = ''; load(); };
  await load();
}
