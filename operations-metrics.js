const rate = (n, d) => ({ numerator: n, denominator: d, percent: d ? Math.round(n / d * 1000) / 10 : null });
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const sources = r => r.sourcePills?.length ? r.sourcePills : r.pill ? [r.pill] : [];
const duration = i => {
  const outcome = (i.handlingRecords || []).filter(r => r.kind === 'outcome').at(-1);
  if (i.handlingStatus !== 'resolved' || outcome?.status !== 'resolved' || !outcome.verified) return null;
  const ms = Date.parse(outcome.occurredAt) - Date.parse(i.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms / 3600000 : null;
};
export function operationsMetrics(incidents, filters = {}) {
  const date = (value, key) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw Object.assign(new Error(`Invalid ${key} date.`), { status: 422 });
    return Date.parse(value);
  };
  const start = date(filters.from, 'from'), end = date(filters.to, 'to');
  if (start !== null && end !== null && start > end) throw Object.assign(new Error('Start date must precede end date.'), { status: 422 });
  const asset = String(filters.asset || '').trim().toLowerCase(), category = String(filters.category || '');
  incidents = incidents.filter(i => (start === null || Date.parse(i.createdAt) >= start) && (end === null || Date.parse(i.createdAt) < end + 86400000) && (!asset || (i.asset || '').toLowerCase().includes(asset)) && (!category || i.category === category));
  const reviewedCases = incidents.filter(i => i.reviews?.length);
  const corrected = r => r.assessment === 'partly_supported' || r.assessment === 'unsupported' || Boolean(r.proposals?.trim()) || r.actions?.some(a => a.choice === 'omit');
  const analyzed = incidents.filter(i => i.triageReports?.length);
  const groups = new Map();
  for (const i of incidents) for (const r of i.triageReports || []) for (const p of sources(r).filter(p => p.status === 'approved')) {
    const key = `${p.id}@${p.version}`;
    if (!groups.has(key)) groups.set(key, { pillId: p.id, name: p.name, version: p.version, cases: new Set(), reports: 0, complete: 0, reviewed: 0, corrected: 0, resolvedCases: new Set(), durations: [] });
    const g = groups.get(key); g.cases.add(i.id); g.reports++; if ((r.specialists?.find(s => s.pillId === p.id)?.status || r.status) === 'complete') g.complete++;
    const review = i.reviews?.find(v => v.reportId === r.id); if (review) { g.reviewed++; if (corrected(review)) g.corrected++; }
    if (i.triageReports.at(-1)?.id === r.id && duration(i) !== null) { g.resolvedCases.add(i.id); g.durations.push(duration(i)); }
  }
  const durations = incidents.map(duration).filter(v => v !== null).sort((a, b) => a - b);
  const reusedCases = new Set();
  const byPill = new Map();
  for (const g of groups.values()) for (const id of g.cases) byPill.set(g.pillId, new Set([...(byPill.get(g.pillId) || []), id]));
  const publishedCases = new Set(); for (const cases of byPill.values()) for (const id of cases) { publishedCases.add(id); if (cases.size >= 2) reusedCases.add(id); }
  const latestGaps = analyzed.filter(i => ['out_of_scope', 'knowledge_gap', 'needs_information', 'partial_failure', 'failed'].includes(i.triageReports.at(-1).status));
  const cohorts = new Map();
  for (const i of incidents) {
    if (!Number.isFinite(Date.parse(i.createdAt))) continue;
    const month = new Date(i.createdAt).toISOString().slice(0, 7);
    if (!cohorts.has(month)) cohorts.set(month, []);
    cohorts.get(month).push(i);
  }
  const trends = [...cohorts].sort(([a], [b]) => a.localeCompare(b)).map(([month, cases]) => ({ month, created: cases.length, resolved: cases.filter(i => duration(i) !== null).length, reviewed: cases.filter(i => i.reviews?.length).length, corrected: cases.filter(i => i.reviews?.length && corrected(i.reviews.at(-1))).length, gaps: cases.filter(i => ['out_of_scope', 'knowledge_gap'].includes(i.triageReports?.at(-1)?.status)).length }));
  return {
    filters: { from: filters.from || '', to: filters.to || '', asset: filters.asset || '', category }, caseCount: incidents.length, caseIds: incidents.map(i => i.id), trends,
    generatedAt: new Date().toISOString(),
    reuse: rate(reusedCases.size, publishedCases.size), correction: rate(reviewedCases.filter(i => corrected(i.reviews.at(-1))).length, reviewedCases.length),
    gapRate: rate(analyzed.filter(i => ['out_of_scope', 'knowledge_gap'].includes(i.triageReports.at(-1).status)).length, analyzed.length),
    resolution: { sampleSize: durations.length, medianHours: median(durations) },
    gaps: latestGaps.map(i => ({ id: i.id, title: i.title, status: i.triageReports.at(-1).status, summary: i.triageReports.at(-1).summary || i.triageReports.at(-1).error })),
    versions: [...groups.values()].map(g => ({ pillId: g.pillId, name: g.name, version: g.version, caseCount: g.cases.size, reports: g.reports, completion: rate(g.complete, g.reports), correction: rate(g.corrected, g.reviewed), resolvedCases: g.resolvedCases.size, resolution: { sampleSize: g.durations.length, medianHours: median(g.durations) } })),
    definitions: {
      cohort: 'Filters use case creation date (UTC), not activity date. Monthly rows describe the current outcomes of cases created in that month, not historical snapshots. Metrics are recalculated within the selected cohort.',
      reuse: 'Cases using an approved Pill also used by at least one other case / cases using any approved Pill. Repeated runs of one case do not count as reuse.',
      correction: 'Cases whose latest human review is partly supported, unsupported, omits actions or proposes corrections / cases with a review.',
      gapRate: 'Cases whose latest report has no applicable Pill or no matching rule / analyzed cases. Missing information and model failures are listed separately.',
      resolution: 'Median hours from case creation to latest verified resolved observation, only for cases currently resolved. Earlier-than-creation and missing timestamps are excluded.',
      versions: 'Observational comparison only. Case mix and small samples prevent causal claims about version improvement; multi-Pill outcomes are shared, not attributed to one specialist.'
    }
  };
}

export function operationsCSV(data) {
  const cell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  const rows = [['section', 'name', 'value', 'numerator', 'denominator', 'definition'], ['cohort', 'case_count', data.caseCount, '', '', data.definitions.cohort], ['filters', 'selection', JSON.stringify(data.filters)]];
  for (const key of ['reuse', 'correction', 'gapRate']) rows.push(['metric', key, data[key].percent ?? 'No data', data[key].numerator, data[key].denominator, data.definitions[key]]);
  rows.push(['metric', 'median_resolution_hours', data.resolution.medianHours ?? 'No data', '', data.resolution.sampleSize, data.definitions.resolution]);
  for (const t of data.trends) for (const key of ['created', 'resolved', 'reviewed', 'corrected', 'gaps']) rows.push(['monthly_cohort', `${t.month} ${key}`, t[key]]);
  for (const v of data.versions) {
    for (const key of ['completion', 'correction']) rows.push(['version', `${v.pillId} / ${v.version} / ${key}`, v[key].percent ?? 'No data', v[key].numerator, v[key].denominator, data.definitions.versions]);
    rows.push(['version', `${v.pillId} / ${v.version} / median_resolution_hours`, v.resolution.medianHours ?? 'No data', '', v.resolution.sampleSize]);
  }
  for (const g of data.gaps) rows.push(['gap', g.title, g.status, g.id]);
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
