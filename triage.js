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

// A narrow guard for known affirmative valve-state wording, not a general
// semantic validator. Source quotes and the generation rules remain necessary.
function valveStateClaims(text) {
  const pattern = /\bvalve\s+(?:is|being|remains|stands|has been)\s+(?:(?:fully|partially|physically|actually)\s+)?(?:\d+(?:\.\d+)?\s*%\s+)?(?:open|closed)\b/gi;
  return [...text.matchAll(pattern)].filter(match => {
    const prefix = text.slice(0, match.index);
    // Do not interpret questions or explicit uncertainty as observed states.
    return !/(?:whether|if)\s+(?:the\s+)?$/i.test(prefix) &&
      !/(?:does not|cannot|can't|doesn't)\s+(?:prove|confirm|establish|mean|show)\s+(?:that\s+)?(?:the\s+)?$/i.test(prefix);
  }).map(match => match[0].toLowerCase().replace(/\s+/g, ' '));
}

function validateValveStates(value, snapshot, invalid) {
  const source = ['description', 'observations', 'actionsTaken']
    .map(field => snapshot.fields[field] || '').join('\n');
  const grounded = new Set(valveStateClaims(source));
  const sections = [
    ['summary', value.summary],
    ...value.hypotheses.flatMap((item, i) => [
      [`Hypothesis ${i + 1} reasoning`, item.reasoning],
      ...item.uncertainties.map(text => [`Hypothesis ${i + 1} uncertainty`, text])
    ]),
    ['priority reason', value.prioritySuggestion?.reason || '']
  ];
  for (const [label, text] of sections) {
    if (valveStateClaims(text).some(claim => !grounded.has(claim))) {
      invalid(`${label}: an actual valve state is not supported by matching reported evidence. A valve command does not prove actual position or water flow. Run a new analysis.`);
    }
  }
}

const explicitlyUnknownTime = value => typeof value === 'string' &&
  /^(?:unknown|not sure|not known|(?:i )?don['’]?t know|未知|不清楚|不知道)[.!。]?$/i.test(value.trim());

function hasResolvedRoomCorrection(snapshot) {
  const source = ['description', 'observations'].map(key => snapshot.fields[key] || '').join('\n');
  const temperature = String.raw`([-+]?\d+(?:\.\d+)?\s*°?\s*[CF])`;
  const corrected = [...source.matchAll(new RegExp(String.raw`\broom temperature is ${temperature}, not ${temperature}`, 'gi'))];
  if (corrected.length !== 1) return false;
  const normalize = value => value.replace(/\s/g, '').toUpperCase();
  const readings = [...source.matchAll(new RegExp(String.raw`\broom temperature (?:is|at|of) ${temperature}`, 'gi'))];
  return readings.every(match => normalize(match[1]) === normalize(corrected[0][1]));
}

// Correct known English formulations without changing quotes or inventing times.
function distinguishUnknownStart(text) {
  return text
    .replace(/(Timestamps? for [^.\n]+?) and the start of the incident are (?:missing|not provided)\.?/gi,
      '$1 are not provided. The incident start time is explicitly reported as unknown.')
    .replace(/\b(?:the )?(?:incident start time|start time(?: of (?:the )?(?:incident|condition))?|start of the incident) (?:is|was) (?:missing|not provided|not reported)\.?/gi,
      'The incident start time is explicitly reported as unknown.');
}

export function validateTriageResult(value, snapshot, pill) {
  const invalid = reason => {
    throw fail(`Report validation failed: ${reason}`, 502);
  };
  const text = (v, max = 2000) =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const list = (v, max) => Array.isArray(v) && v.length <= max;

  if (!value || typeof value !== 'object') {
    invalid('The report must be an object.');
  }
  if (!text(value.summary)) {
    invalid('summary must be nonempty text, up to 2000 characters.');
  }
  if (!list(value.hypotheses, 3)) {
    invalid('hypotheses must be an array with at most 3 items.');
  }
  if (!list(value.actionIds, 5)) {
    invalid('actionIds must be an array with at most 5 items.');
  }
  if (!list(value.missingFields, 5)) {
    invalid('missingFields must be an array with at most 5 items.');
  }

  const rules = new Set(pill.rules.map(rule => rule.id));

  for (const [index, hypothesis] of value.hypotheses.entries()) {
    const label = `Hypothesis ${index + 1}`;

    if (!hypothesis || !rules.has(hypothesis.ruleId)) {
      invalid(`${label}: ruleId does not match a Pill rule.`);
    }
    if (!text(hypothesis.reasoning)) {
      invalid(`${label}: reasoning is missing or exceeds 2000 characters.`);
    }
    if (!list(hypothesis.evidence, 6) || !hypothesis.evidence.length) {
      invalid(`${label}: evidence must contain 1 to 6 items.`);
    }
    if (
      !list(hypothesis.uncertainties, 5) ||
      !hypothesis.uncertainties.every(item => text(item, 1000))
    ) {
      invalid(`${label}: uncertainties must be an array of at most 5 nonempty strings, each up to 1000 characters.`);
    }

    for (const [evidenceIndex, evidence] of hypothesis.evidence.entries()) {
      const evidenceLabel = `${label}, evidence ${evidenceIndex + 1}`;

      if (
        !evidence ||
        !fields.includes(evidence.field) ||
        ['title', 'category', 'priority'].includes(evidence.field)
      ) {
        invalid(`${evidenceLabel}: invalid source field.`);
      }
      if (!text(evidence.quote, 1000)) {
        invalid(`${evidenceLabel}: quote is missing or exceeds 1000 characters.`);
      }
                  const quote = evidence.quote;
      const foldCase = text =>
        text.replace(/[A-Z]/g, letter => letter.toLowerCase());

      const findQuote = field => {
        const source = snapshot.fields[field];
        if (typeof source !== 'string') return null;

        const position = source.includes(quote)
          ? source.indexOf(quote)
          : foldCase(source).indexOf(foldCase(quote));

        return position === -1 ? null : {
          field,
          quote: source.slice(position, position + quote.length)
        };
      };

      // Check the named field first.
      let match = findQuote(evidence.field);

      // Correct a mislabeled source only when one other field matches.
      if (!match) {
        const matches = fields
          .filter(field =>
            !['title', 'category', 'priority'].includes(field) &&
            field !== evidence.field
          )
          .map(findQuote)
          .filter(Boolean);

        if (matches.length === 1) {
          match = matches[0];
        }
      }

      if (!match) {
        console.error('Evidence mismatch:', JSON.stringify({
          hypothesis: index + 1,
          evidence: evidenceIndex + 1,
          field: evidence.field,
          modelQuote: quote,
          originalText: snapshot.fields[evidence.field]
        }, null, 2));

        invalid(`${evidenceLabel}: quote has no unambiguous matching source.`);
      }

      evidence.field = match.field;
      evidence.quote = match.quote;
    }
  }

  const cited = new Set(value.hypotheses.map(item => item.ruleId));

  for (const [index, id] of value.actionIds.entries()) {
    const action = pill.actions.find(item => item.id === id);
    if (!action) {
      invalid(`Action ${index + 1}: ID does not match the Pill action catalog.`);
    }
    if (!action.ruleIds.some(rule => cited.has(rule))) {
      invalid(`Action ${index + 1}: no linked rule is cited by a hypothesis.`);
    }
  }

  if (!value.missingFields.every(field => requestedFields.includes(field))) {
    invalid('missingFields contains an unsupported field name.');
  }

  const suggestion = value.prioritySuggestion;
  if (suggestion !== null) {
    if (!suggestion || !priorities.includes(suggestion.value)) {
      invalid('prioritySuggestion must be null or contain a valid priority value.');
    }
    if (!text(suggestion.reason, 1000)) {
      invalid('prioritySuggestion.reason is missing or exceeds 1000 characters.');
    }
  }

  // Save the catalog explanation in the report, so history and chat use the
  // same text as the cards. Never trust a model-provided explanation source.
  const startReportedUnknown = explicitlyUnknownTime(snapshot.fields.occurredAt);
  const resolvedRoomCorrection = hasResolvedRoomCorrection(snapshot);
  const hypotheses = value.hypotheses.map(item => {
    const explanation = pill.rules.find(rule => rule.id === item.ruleId)?.cardExplanation;
    if (explanation !== undefined && !text(explanation)) invalid('Pill cardExplanation must be nonempty text, up to 2000 characters.');
    return {
      ...item,
      uncertainties: item.uncertainties
        .filter(value => !(resolvedRoomCorrection && /^Room temperature discrepancy context is unclear\.?$/i.test(value.trim())))
        .map(value => startReportedUnknown ? distinguishUnknownStart(value) : value),
      reasoning: explanation || item.reasoning.trim(),
      reasoningSource: explanation ? 'pill' : 'model'
    };
  });
  validateValveStates({ ...value, hypotheses }, snapshot, invalid);
  // Copy only validated fields; keep action text from the Pill catalog.
  return {
    summary: startReportedUnknown ? distinguishUnknownStart(value.summary.trim()) : value.summary.trim(),
    hypotheses: hypotheses.map(item => ({
      ruleId: item.ruleId,
      reasoning: item.reasoning.trim(),
      reasoningSource: item.reasoningSource,
      evidence: item.evidence.map(({ field, quote }) => ({ field, quote })),
      uncertainties: item.uncertainties
    })),
    actions: [...new Set(value.actionIds)].map(id =>
      structuredClone(pill.actions.find(item => item.id === id))
    ),
    missingFields: [...new Set(value.missingFields)].filter(field => !(field === 'occurredAt' && startReportedUnknown)),
    prioritySuggestion: suggestion === null
      ? null
      : { value: suggestion.value, reason: suggestion.reason }
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
      if (reportView(report, incident).stale) {
  throw fail('This report is outdated. Confirm the latest intake and run a new analysis before asking questions.', 409);
}
      const chat = report.chat || [];
      if (!['complete', 'needs_information'].includes(report.status)) {
        throw fail('Questions are unavailable for this report. Run a successful analysis first.', 409);
      }
      const response = await chatAgent({ question: question.trim(), incident: { fields: Object.fromEntries(fields.map(key => [key, incident[key] || ''])) }, report, history: chat.map(item => ({ role: item.role, content: item.content })) });
      await store.appendTriageMessage(id, reportId, { role: 'user', content: question.trim(), createdAt: new Date().toISOString() });
      const updated = await store.appendTriageMessage(id, reportId, { role: 'assistant', content: response, createdAt: new Date().toISOString() });
      return updated.triageReports.find(item => item.id === reportId);
    }
  };
}
