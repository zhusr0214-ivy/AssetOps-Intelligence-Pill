import { createHash, randomUUID } from 'node:crypto';
import { matchPill } from './pill-routing.js';
import { validateTriageResult } from './triage.js';
import { triagePromptVersion } from './triage-agent.js';
import { categories, fields } from './intake.js';

const fail = message => Object.assign(new Error(message), { status: 422 });
const statuses = ['complete', 'needs_information', 'knowledge_gap', 'out_of_scope'];
const sorted = (list = []) => [...new Set(list)].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
export function validateSuite(suite) {
  if (!Array.isArray(suite) || suite.length < 2 || suite.length > 8) throw fail('Add 2-8 test cases including a supported case and a negative or information-gap case.');
  const result = suite.map((item, n) => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || !item.facts || !categories.includes(item.facts.category) || !statuses.includes(item.expected?.status)) throw fail(`Test ${n + 1}: name, category, facts and expected status are required.`);
    const facts = {};
    for (const key of fields) {
      const value = item.facts[key] ?? '';
      if (typeof value !== 'string' || value.length > 4000) throw fail(`Test ${n + 1}: invalid ${key}.`);
      facts[key] = value;
    }
    const expected = { status: item.expected.status };
    for (const key of ['ruleIds', 'actionIds', 'missingFields']) {
      const values = item.expected[key];
      if (!Array.isArray(values) || values.length > 20 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 120)) throw fail(`Test ${n + 1}: invalid expected ${key}.`);
      expected[key] = sorted(values);
    }
    if (['out_of_scope', 'knowledge_gap'].includes(expected.status) && (expected.ruleIds.length || expected.actionIds.length)) throw fail('Negative cases cannot expect rules or actions.');
    if (expected.status === 'complete' && (!expected.ruleIds.length || expected.missingFields.length)) throw fail('Supported cases need expected rules and no missing fields.');
    if (expected.missingFields.some(v => !['asset', 'observations', 'affectedScope', 'occurredAt', 'impact'].includes(v))) throw fail('Unknown expected missing field.');
    return { name: item.name.trim(), facts, expected };
  });
  if (!result.some(t => t.expected.status === 'complete') || !result.some(t => t.expected.status !== 'complete')) throw fail('Include both a supported case and a negative or information-gap case.');
  if (JSON.stringify(result).length > 60000) throw fail('Test suite is too large.');
  return result;
}
export function evaluationOptions(value = {}) {
  const options = { repetitions: value.repetitions ?? 1, minimumPassRate: value.minimumPassRate ?? 1, expertReviewRequired: value.expertReviewRequired ?? false };
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 5 || typeof options.minimumPassRate !== 'number' || options.minimumPassRate < 0.8 || options.minimumPassRate > 1 || typeof options.expertReviewRequired !== 'boolean') throw fail('Use 1-5 repetitions and a pass threshold between 80% and 100%.');
  if (options.minimumPassRate < 1 && !options.expertReviewRequired) throw fail('A relaxed threshold requires expert evaluation review.');
  return options;
}
export function sampleStatistics(samples) {
  const n = samples.length, passed = samples.filter(s => s.passed).length, rate = n ? passed / n : 0, z = 1.96;
  const center = n ? (rate + z * z / (2 * n)) / (1 + z * z / n) : 0;
  const margin = n ? z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / (1 + z * z / n) : 0;
  const outputs = new Set(samples.map(s => JSON.stringify(s.actual ? { ...s.actual, ruleIds: sorted(s.actual.ruleIds), actionIds: sorted(s.actual.actionIds), missingFields: sorted(s.actual.missingFields) } : { error: s.failureCode })));
  return { samples: n, passed, failed: n - passed, passRate: rate, errors: samples.filter(s => s.error).length, modelCalls: samples.filter(s => s.modelCalled).length, distinctOutputs: outputs.size, unstable: outputs.size > 1, averageMs: n ? Math.round(samples.reduce((sum, s) => sum + s.durationMs, 0) / n) : 0, interval95: { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'Wilson; descriptive only, repeated model outputs may be dependent' } };
}
export const evaluationKey = (record, baseline) => createHash('sha256').update(JSON.stringify({ content: record.content, suite: record.evaluationSuite, options: evaluationOptions(record.evaluationOptions), baseline, prompt: triagePromptVersion, model: process.env.SOCLAAS_MODEL || 'default' })).digest('hex');
export function evaluationGate(record) {
  if (record.state === 'published') { const passed = record.releases.at(-1)?.evaluation?.passed === true; return { required: Boolean(record.evaluationRequired), passed, state: passed ? 'published_with_evaluation' : 'published_without_evaluation' }; }
  if (!record.evaluationRequired) return { required: false, passed: false, state: 'not_enabled' };
  const baseline = record.releases.find(r => r.active && !r.disabled)?.pill || null;
  const latest = record.evaluations?.at(-1);
  const current = latest?.key === evaluationKey(record, baseline);
  const expertRequired = evaluationOptions(record.evaluationOptions).expertReviewRequired;
  const expertPassed = !expertRequired || latest?.expertReview?.decision === 'accepted';
  return { required: true, passed: Boolean(current && latest.passed && expertPassed), state: !latest ? 'not_run' : !current ? 'outdated' : !latest.passed ? 'failed' : !expertPassed ? 'expert_review_required' : 'passed', runId: latest?.id || null, expertRequired };
}
async function runCase(test, pill, agent) {
  if (!pill) return null;
  let modelCalled = false, stage = 'routing'; const started = Date.now();
  try {
    let result;
    if (!matchPill(test.facts, pill)) result = { status: 'out_of_scope', hypotheses: [], actions: [], missingFields: [] };
    else {
      const missingFields = ['asset', 'observations'].filter(k => !test.facts[k].trim() || /^(unknown|not sure|n\/a|不知道|不清楚|未知)[.!。]?$/i.test(test.facts[k].trim()));
      if (missingFields.length) result = { status: 'needs_information', hypotheses: [], actions: [], missingFields };
      else {
        modelCalled = true; stage = 'provider';
        const generated = await agent({ id: 'evaluation', revision: 0, fields: test.facts }, pill); stage = 'validation';
        result = validateTriageResult(generated, { fields: test.facts }, pill);
        result.status = result.missingFields.length ? 'needs_information' : result.hypotheses.length ? 'complete' : 'knowledge_gap';
      }
    }
    const actual = { status: result.status, ruleIds: result.hypotheses.map(h => h.ruleId), actionIds: result.actions.map(a => a.id), missingFields: result.missingFields };
    const checks = { status: actual.status === test.expected.status, rules: same(actual.ruleIds, test.expected.ruleIds), actions: same(actual.actionIds, test.expected.actionIds), missingFields: same(actual.missingFields, test.expected.missingFields) };
    return { passed: Object.values(checks).every(Boolean), actual, checks, report: result, modelCalled, durationMs: Date.now() - started };
  } catch { return { passed: false, error: 'Model call or evidence validation failed. No successful result was substituted.', failureCode: stage, modelCalled, durationMs: Date.now() - started }; }
}
export async function evaluatePill(record, agent) {
  const suite = validateSuite(record.evaluationSuite), baseline = record.releases.find(r => r.active && !r.disabled)?.pill || null;
  const options = evaluationOptions(record.evaluationOptions);
  const run = { id: `EVAL-${randomUUID()}`, startedAt: new Date().toISOString(), key: evaluationKey(record, baseline), promptVersion: triagePromptVersion, model: process.env.SOCLAAS_MODEL || 'default', content: structuredClone(record.content), suite, baseline: structuredClone(baseline), results: [] };
  run.options = options;
  for (const item of suite) {
    const candidates = [], previousSamples = [];
    for (let trial = 0; trial < options.repetitions; trial++) {
      // Alternate order to reduce systematic candidate-first timing bias.
      if (trial % 2 && baseline) previousSamples.push(await runCase(item, baseline, agent));
      candidates.push(await runCase(item, record.content.pill, agent));
      if (!(trial % 2) && baseline) previousSamples.push(await runCase(item, baseline, agent));
    }
    const aggregate = samples => { const stats = sampleStatistics(samples); return { ...(samples.find(s => !s.passed) || samples[0]), samples, statistics: stats, passed: stats.passRate >= options.minimumPassRate && stats.errors === 0 }; };
    const candidate = aggregate(candidates), previous = baseline ? aggregate(previousSamples) : null;
    run.results.push({ name: item.name, expected: item.expected, candidate, baseline: previous, regression: Boolean(previous && candidate.statistics.passRate < previous.statistics.passRate), comparisonReliable: !previous || previous.statistics.errors === 0 });
  }
  run.statistics = sampleStatistics(run.results.flatMap(r => r.candidate.samples));
  const modelSamples = run.results.flatMap(r => r.candidate.samples).filter(s => s.modelCalled);
  run.modelStatistics = modelSamples.length ? sampleStatistics(modelSamples) : null;
  run.passed = run.results.every(r => r.candidate.passed && !r.regression && r.comparisonReliable);
  run.coverage = { categories: [...new Set(suite.map(t => t.facts.category))], expectedStatuses: [...new Set(suite.map(t => t.expected.status))], uniqueCases: suite.length, safetyProof: false };
  run.completedAt = new Date().toISOString();
  return run;
}
