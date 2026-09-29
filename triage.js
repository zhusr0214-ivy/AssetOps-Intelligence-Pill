import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { assessIntake, fields, priorities } from './intake.js';
import { createTriageAgent, createTriageChat, triagePromptVersion } from './triage-agent.js';

export const ahuPill = JSON.parse(readFileSync(new URL('./pills/ahu-cooling.json', import.meta.url), 'utf8'));
const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const requestedFields = ['asset', 'observations', 'affectedScope', 'occurredAt', 'impact'];
const unknown = value => !value || /^(?:unknown|not sure|n\/a|\u4e0d\u77e5\u9053|\u4e0d\u6e05\u695a|\u672a\u77e5)[.!\u3002]?$/i.test(value.trim());
const questions = {
  asset: 'Confirm the affected AHU identifier with the site team before running an AHU-specific analysis.',
  observations: 'Provide available temperature readings, setpoint, alarms or other observed equipment conditions.',
  affectedScope: 'Confirm the affected areas and any nearby areas that are operating normally.',
  occurredAt: 'Confirm when the issue started, if known.',
  impact: 'Confirm the effect on occupants or services.'
};

export function caseFingerprint(incident) {
  return createHash('sha256').update(JSON.stringify({ fields: Object.fromEntries(fields.map(key => [key, incident[key] || ''])), messages: (incident.messages || []).map(({ role, content, state }) => ({ role, content, state })), conflicts: incident.conflicts || [] })).digest('hex');
}

export function canAnalyze(incident) {
  return incident.status === 'ready_for_triage' && assessIntake(incident).readyForTriage && !incident.conflicts?.length && !(incident.messages || []).some(message => message.role === 'user' && message.state !== 'complete');
}

export function selectPill(incident) {
  return incident.category === 'hvac_cooling' || (incident.category === 'hvac' && /\bAHU\b/i.test(incident.asset || '')) ? structuredClone(ahuPill) : null;
}

export function validateTriageResult(value, snapshot, pill) {
  const invalid = () => { throw fail('The model report failed evidence or rule validation. Retry the analysis.', 502); };
  const text = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const list = (v, max) => Array.isArray(v) && v.length <= max;
  if (!value || typeof value !== 'object' || !text(value.summary) || !list(value.hypotheses, 3) || !list(value.actionIds, 5) || !list(value.missingFields, 5)) invalid();
  const rules = new Set(pill.rules.map(rule => rule.id));
  for (const hypothesis of value.hypotheses) {
    if (!hypothesis || !rules.has(hypothesis.ruleId) || !text(hypothesis.reasoning) || !list(hypothesis.evidence, 6) || !hypothesis.evidence.length || !list(hypothesis.uncertainties, 5) || !hypothesis.uncertainties.every(item => text(item, 1000))) invalid();
    for (const evidence of hypothesis.evidence) {
      if (!evidence || !fields.includes(evidence.field) || ['title', 'category', 'priority'].includes(evidence.field) || !text(evidence.quote, 1000) || !snapshot.fields[evidence.field]?.includes(evidence.quote)) invalid();
    }
  }
  const cited = new Set(value.hypotheses.map(item => item.ruleId));
  for (const id of value.actionIds) {
    const action = pill.actions.find(item => item.id === id);
    if (!action || !action.ruleIds.some(rule => cited.has(rule))) invalid();
  }
  if (!value.missingFields.every(field => requestedFields.includes(field))) invalid();
  const suggestion = value.prioritySuggestion;
  if (suggestion !== null && (!suggestion || !priorities.includes(suggestion.value) || !text(suggestion.reason, 1000))) invalid();
  // Copy only validated fields; model-supplied action text and approval flags are discarded.
  return {
    summary: value.summary.trim(),
    hypotheses: value.hypotheses.map(item => ({ ruleId: item.ruleId, reasoning: item.reasoning.trim(), evidence: item.evidence.map(({ field, quote }) => ({ field, quote })), uncertainties: item.uncertainties })),
    actions: [...new Set(value.actionIds)].map(id => structuredClone(pill.actions.find(item => item.id === id))),
    missingFields: [...new Set(value.missingFields)],
    prioritySuggestion: suggestion === null ? null : { value: suggestion.value, reason: suggestion.reason }
  };
}

function reportView(report, incident) {
  return { ...report, stale: report.caseFingerprint !== caseFingerprint(incident) || incident.status !== 'ready_for_triage' };
}

export function createTriageService(store, agent = createTriageAgent(), model = process.env.SOCLAAS_MODEL || 'default', chatAgent = createTriageChat()) {
  const running = new Map();
  return {
    async list() {
      return (await store.list()).filter(item => item.status === 'ready_for_triage' || item.triageReports?.length || running.has(item.id)).map(item => ({
        id: item.id, title: item.title, asset: item.asset, location: item.location, priority: item.priority, category: item.category,
        eligible: canAnalyze(item), supported: Boolean(selectPill(item)), running: running.get(item.id) || null,
        latest: item.triageReports?.length ? reportView(item.triageReports.at(-1), item) : null
      }));
    },
    async get(id) {
      const incident = (await store.list()).find(item => item.id === id);
      if (!incident) throw fail('Incident not found.', 404);
      const { triageReports = [], ...caseData } = incident;
      return { incident: caseData, eligible: canAnalyze(incident), supported: Boolean(selectPill(incident)), running: running.get(id) || null, reports: triageReports.map(report => reportView(report, incident)) };
    },
    async run(id, revision) {
      const incident = (await store.list()).find(item => item.id === id);
      if (!incident) throw fail('Incident not found.', 404);
      if (running.has(id)) throw fail('An analysis is already running for this case.', 409);
      if (!Number.isInteger(revision) || revision !== (incident.revision || 0)) throw fail('The case changed. Reload before analyzing.', 409);
      if (!canAnalyze(incident)) throw fail('Confirm intake and resolve pending information before analyzing.', 409);
      const snapshot = { id, revision, fields: Object.fromEntries(fields.map(key => [key, incident[key] || ''])) };
      const report = { id: `TRI-${randomUUID()}`, createdAt: new Date().toISOString(), snapshot, caseFingerprint: caseFingerprint(incident), pill: selectPill(incident), model: null, promptVersion: triagePromptVersion };
      running.set(id, { id: report.id, startedAt: report.createdAt });
      try {
        const missing = ['asset', 'observations'].filter(field => unknown(incident[field]));
        if (!report.pill) {
          Object.assign(report, { status: 'out_of_scope', summary: 'No applicable Pill is available for this incident category. Refer the case to the responsible domain specialist.', hypotheses: [], actions: [], missingFields: [], prioritySuggestion: null });
        } else if (missing.length) {
          Object.assign(report, { status: 'needs_information', summary: 'Additional case information is needed before an AHU analysis can be grounded in evidence.', hypotheses: [], actions: [], missingFields: missing, prioritySuggestion: null });
        } else {
          report.model = model;
          try {
            const result = validateTriageResult(await agent(snapshot, report.pill), snapshot, report.pill);
            Object.assign(report, result, { status: result.missingFields.length || !result.hypotheses.length ? 'needs_information' : 'complete' });
            if (!result.hypotheses.length && !report.missingFields.length) report.missingFields = ['observations'];
          } catch (error) {
            Object.assign(report, { status: 'failed', error: error.status ? error.message : 'Analysis failed. Retry the request.', summary: '', hypotheses: [], actions: [], missingFields: [], prioritySuggestion: null });
          }
        }
        report.questions = report.missingFields.map(field => ({ field, question: questions[field] }));
        report.governance = {
          mode: 'rules', demoOnly: true, executionAllowed: false,
          evidenceChecked: report.status === 'complete' || (report.model !== null && report.status === 'needs_information'),
          approvalRequired: report.actions.some(action => action.requiresApproval),
          boundaries: report.pill?.boundaries || ['No matching Pill. No operational actions are authorized.'],
          escalationConditions: report.pill?.escalationConditions || ['Refer to the responsible domain specialist.']
        };
        report.completedAt = new Date().toISOString();
        const updated = await store.appendTriageReport(id, report);
        return reportView(report, updated);
      } finally { running.delete(id); }
    },
    async chat(id, reportId, question) {
      if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw fail('Enter a question up to 2000 characters.', 400);
      const incident = (await store.list()).find(item => item.id === id); if (!incident) throw fail('Incident not found.', 404);
      const report = incident.triageReports?.find(item => item.id === reportId); if (!report) throw fail('Triage report not found.', 404);
      if (report.stale) throw fail('This report is outdated. Run a new analysis before asking questions.', 409);
      const chat = report.chat || [];
      const response = await chatAgent({ question: question.trim(), incident: { fields: Object.fromEntries(fields.map(key => [key, incident[key] || ''])) }, report, history: chat.map(item => ({ role: item.role, content: item.content })) });
      await store.appendTriageMessage(id, reportId, { role: 'user', content: question.trim(), createdAt: new Date().toISOString() });
      const updated = await store.appendTriageMessage(id, reportId, { role: 'assistant', content: response, createdAt: new Date().toISOString() });
      return updated.triageReports.find(item => item.id === reportId);
    }
  };
}
