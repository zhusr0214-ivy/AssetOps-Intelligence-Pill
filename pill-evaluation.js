import { createHash, randomUUID } from 'node:crypto';
import { matchPill } from './pill-routing.js';
import { validateTriageResult } from './triage.js';
import { triagePromptVersion } from './triage-agent.js';
import { categories, fields } from './intake.js';

const fail = message => Object.assign(new Error(message), { status: 422 });
const statuses = ['complete', 'needs_information', 'knowledge_gap', 'out_of_scope'];
const sorted = list => [...new Set(list)].sort();
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
export const evaluationKey = (record, baseline) => createHash('sha256').update(JSON.stringify({ content: record.content, suite: record.evaluationSuite, baseline, prompt: triagePromptVersion, model: process.env.SOCLAAS_MODEL || 'default' })).digest('hex');
export function evaluationGate(record) {
  if (record.state === 'published') { const passed = record.releases.at(-1)?.evaluation?.passed === true; return { required: Boolean(record.evaluationRequired), passed, state: passed ? 'published_with_evaluation' : 'published_without_evaluation' }; }
  if (!record.evaluationRequired) return { required: false, passed: false, state: 'not_enabled' };
  const baseline = record.releases.find(r => r.active && !r.disabled)?.pill || null;
  const latest = record.evaluations?.at(-1);
  const current = latest?.key === evaluationKey(record, baseline);
  return { required: true, passed: Boolean(current && latest.passed), state: !latest ? 'not_run' : !current ? 'outdated' : latest.passed ? 'passed' : 'failed', runId: latest?.id || null };
}
async function runCase(test, pill, agent) {
  if (!pill) return null;
  try {
    let result;
    if (!matchPill(test.facts, pill)) result = { status: 'out_of_scope', hypotheses: [], actions: [], missingFields: [] };
    else {
      const missingFields = ['asset', 'observations'].filter(k => !test.facts[k].trim() || /^(unknown|not sure|n\/a|不知道|不清楚|未知)[.!。]?$/i.test(test.facts[k].trim()));
      if (missingFields.length) result = { status: 'needs_information', hypotheses: [], actions: [], missingFields };
      else {
        result = validateTriageResult(await agent({ id: 'evaluation', revision: 0, fields: test.facts }, pill), { fields: test.facts }, pill);
        result.status = result.missingFields.length ? 'needs_information' : result.hypotheses.length ? 'complete' : 'knowledge_gap';
      }
    }
    const actual = { status: result.status, ruleIds: result.hypotheses.map(h => h.ruleId), actionIds: result.actions.map(a => a.id), missingFields: result.missingFields };
    const checks = { status: actual.status === test.expected.status, rules: same(actual.ruleIds, test.expected.ruleIds), actions: same(actual.actionIds, test.expected.actionIds), missingFields: same(actual.missingFields, test.expected.missingFields) };
    return { passed: Object.values(checks).every(Boolean), actual, checks, report: result };
  } catch { return { passed: false, error: 'Model call or evidence validation failed. No successful result was substituted.' }; }
}
export async function evaluatePill(record, agent) {
  const suite = validateSuite(record.evaluationSuite), baseline = record.releases.find(r => r.active && !r.disabled)?.pill || null;
  const run = { id: `EVAL-${randomUUID()}`, startedAt: new Date().toISOString(), key: evaluationKey(record, baseline), promptVersion: triagePromptVersion, model: process.env.SOCLAAS_MODEL || 'default', content: structuredClone(record.content), suite, baseline: structuredClone(baseline), results: [] };
  for (const item of suite) {
    const candidate = await runCase(item, record.content.pill, agent), previous = await runCase(item, baseline, agent);
    run.results.push({ name: item.name, expected: item.expected, candidate, baseline: previous, regression: previous?.passed === true && !candidate.passed });
  }
  run.passed = run.results.every(r => r.candidate.passed);
  run.completedAt = new Date().toISOString();
  return run;
}
