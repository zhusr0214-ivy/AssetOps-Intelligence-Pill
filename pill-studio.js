import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ahuPill } from './triage.js';
import { extractDocument } from './document-parser.js';
import { createKnowledgeCaptureAgent } from './knowledge-agent.js';
import { mergeKnowledge } from './knowledge-merge.js';
import { libraryToken, releaseHash, compareReleases } from './pill-versions.js';
import { routingErrors } from './pill-routing.js';
import { validateSuite, evaluatePill, evaluationGate, evaluationOptions, evaluationKey } from './pill-evaluation.js';
import { createTriageAgent } from './triage-agent.js';

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const str = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const array = (value, max = 30) => Array.isArray(value) && value.length > 0 && value.length <= max;
const ids = values => new Set(values.map(v => v?.id));
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const invalidateLearning = record => {
  for (const item of record.learningImports || []) if (item.status === 'incorporated' && !item.releasedVersion) item.status = 'pending_incorporation';
};

export function validateDraft(content) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  const pill = content?.pill || {};
  for (const key of ['name', 'owner', 'source', 'scope']) check(str(pill[key]), `${key} is required (maximum 4000 characters).`);
  errors.push(...routingErrors(pill));
  check(array(content?.sources, 20), 'Add at least one expert knowledge source.');
  for (const source of content?.sources || []) {
    check(str(source?.expert, 120) && str(source?.reference, 1000) && str(source?.knowledge, 8000), 'Each source needs an expert, reference and captured knowledge.');
  }
  for (const key of ['boundaries', 'escalationConditions']) check(array(pill[key]) && pill[key].every(v => str(v, 2000)), `${key} must contain 1-30 nonempty entries.`);
  check(array(pill.rules, 20), 'Add 1-20 decision rules.');
  check(array(pill.actions, 20), 'Add 1-20 actions.');
  const rules = Array.isArray(pill.rules) ? pill.rules : [];
  const actions = Array.isArray(pill.actions) ? pill.actions : [];
  const ruleIds = ids(rules), actionIds = ids(actions);
  check(ruleIds.size === rules.length, 'Rule IDs must be unique.');
  check(actionIds.size === actions.length, 'Action IDs must be unique.');
  for (const rule of rules) {
    check(identifier(rule?.id) && str(rule?.title, 200) && str(rule?.guidance, 2000) && str(rule?.cardExplanation, 2000), 'Each rule needs an ID, title, explanation and guidance.');
    check(array(rule?.actionIds, 20) && rule.actionIds.every(id => actionIds.has(id)), `Rule ${rule?.id || '?'} has missing or invalid action references.`);
  }
  for (const action of actions) {
    if (action.coordinationKey || action.coordinationValue) check(str(action.coordinationKey, 120) && str(action.coordinationValue, 120), 'Coordination key and value must both be present (maximum 120 characters).');
    check(identifier(action?.id) && str(action?.title, 200) && str(action?.instruction, 2000) && str(action?.owner, 120) && typeof action?.requiresApproval === 'boolean', 'Each action needs an ID, title, instruction, owner and approval flag.');
    check(array(action?.ruleIds, 20) && action.ruleIds.every(id => ruleIds.has(id)), `Action ${action?.id || '?'} has missing or invalid rule references.`);
    for (const ruleId of action?.ruleIds || []) check(rules.find(r => r.id === ruleId)?.actionIds?.includes(action.id), `Action ${action.id} and rule ${ruleId} must reference each other.`);
  }
  for (const rule of rules) for (const actionId of rule?.actionIds || []) check(actions.find(a => a.id === actionId)?.ruleIds?.includes(rule.id), `Rule ${rule.id} and action ${actionId} must reference each other.`);
  check(array(content?.examples, 20), 'Add at least one example with expected rules and actions.');
  for (const example of content?.examples || []) {
    check(str(example?.scenario, 4000) && str(example?.rationale, 4000), 'Each example needs a scenario and expert rationale.');
    check(array(example?.ruleIds, 20) && example.ruleIds.every(id => ruleIds.has(id)), 'Example references an unknown rule.');
    check(array(example?.actionIds, 20) && example.actionIds.every(id => actionIds.has(id) && actions.find(a => a.id === id)?.ruleIds?.some(r => example.ruleIds?.includes(r))), 'Example actions must link to its expected rules.');
  }
  return { passed: errors.length === 0, errors: [...new Set(errors)], checkedAt: new Date().toISOString(), scope: 'Structure, references and example consistency. Expert review is required for engineering correctness.' };
}

function contentFrom(body, id) {
  if (!body || typeof body !== 'object' || !body.pill || typeof body.pill !== 'object') throw fail('Pill content is required.');
  for (const key of ['sources', 'examples']) if (!Array.isArray(body[key]) || body[key].length > 20 || body[key].some(v => !v || typeof v !== 'object' || Array.isArray(v))) throw fail(`Invalid ${key}.`);
  for (const key of ['rules', 'actions', 'boundaries', 'escalationConditions']) if (!Array.isArray(body.pill[key]) || body.pill[key].length > 30) throw fail(`Invalid ${key}.`);
  for (const rule of body.pill.rules) if (!rule || !Array.isArray(rule.actionIds)) throw fail('Invalid rule.');
  for (const action of body.pill.actions) if (!action || !Array.isArray(action.ruleIds)) throw fail('Invalid action.');
  for (const example of body.examples) if (!Array.isArray(example.ruleIds) || !Array.isArray(example.actionIds)) throw fail('Invalid example.');
  if (JSON.stringify(body).length > 80000) throw fail('Draft is too large.');
  // Only authorable fields enter a draft; publication metadata is server-owned.
  const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key] ?? '']));
  const applicability = body.pill.applicability;
  if (applicability !== undefined && routingErrors({ ...body.pill, domain: body.pill.domain || 'ahu_cooling' }).length) throw fail('Invalid routing criteria. Select categories and valid asset prefixes/keywords.');
  return { pill: { id, ...pick(body.pill, ['name', 'owner', 'source', 'scope', 'domain']), ...(applicability ? { applicability: structuredClone(applicability) } : {}), rules: body.pill.rules.map(r => pick(r, ['id', 'title', 'guidance', 'cardExplanation', 'actionIds'])), actions: body.pill.actions.map(a => ({ ...pick(a, ['id', 'title', 'instruction', 'owner', 'requiresApproval', 'ruleIds']), ...(a.coordinationKey || a.coordinationValue ? pick(a, ['coordinationKey', 'coordinationValue']) : {}) })), boundaries: body.pill.boundaries, escalationConditions: body.pill.escalationConditions }, sources: body.sources.map(s => pick(s, ['expert', 'reference', 'knowledge'])), examples: body.examples.map(s => pick(s, ['scenario', 'rationale', 'ruleIds', 'actionIds'])) };
}

export function createPillStudio(file, { captureAgent = createKnowledgeCaptureAgent(), parser = extractDocument, evaluationAgent = createTriageAgent(), persistence } = {}) {
  let queue = Promise.resolve();
  const running = new Set();
  const evaluating = new Set();
  const seed = () => [{ id: ahuPill.id, revision: 0, state: 'draft', content: { pill: { ...structuredClone(ahuPill), domain: 'ahu_cooling' }, sources: [], examples: [] }, releases: [], events: [], validation: null }];
  async function read() { try { const records = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(records)) throw new Error('Invalid Pill storage.'); return records; } catch (error) { if (error.code === 'ENOENT') return seed(); throw error; } }
  function mutate(operation) {
    if (persistence) return persistence.mutate('pills', seed, operation);
    const task = queue.then(async () => { const records = await read(); const result = await operation(records); await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(records, null, 2), { mode: 0o600 }); await rename(`${file}.tmp`, file); return result; });
    queue = task.catch(() => {}); return task;
  }
  async function list() { if (persistence) return persistence.read('pills', seed); await queue; return read(); }
  const find = (records, id, revision) => {
    const record = records.find(r => r.id === id); if (!record) throw fail('Pill not found.', 404);
    if (!Number.isInteger(revision) || revision !== record.revision) throw fail('Pill changed. Reload before continuing.', 409);
    if (record.state === 'published') throw fail('Create a new draft before adding knowledge.', 409);
    return record;
  };
  const service = {
    list,
    reviewEvaluation(id, body) {
      return mutate(records => {
        const record = find(records, id, body?.revision), run = record.evaluations?.at(-1);
        const baseline = record.releases.find(r => r.active && !r.disabled)?.pill || null;
        if (!run || run.id !== body.runId || run.key !== evaluationKey(record, baseline)) throw fail('Evaluate the current draft and configuration before expert review.', 409);
        if (run.expertReview) throw fail('This run has already been reviewed. Run another evaluation for a new review.', 409);
        if (!body.authenticatedActor?.id) throw fail('Authenticated expert review is required.', 403);
        if (record.contributorIds?.includes(body.authenticatedActor.id) || run.requestedBy === body.authenticatedActor.id) throw fail('A different reviewer must assess this evaluation.', 403);
        if (!['accepted', 'rejected'].includes(body.decision) || !['scope', 'limitations', 'qualification', 'reference', 'notes'].every(k => str(body[k], 2000)) || body.confirmed !== true) throw fail('Decision, scope, limitations, expertise, evidence reference and confirmation are required.');
        if (body.decision === 'accepted' && !run.passed) throw fail('Failed evaluations cannot be accepted as a release gate.');
        run.expertReview = { decision: body.decision, scope: body.scope.trim(), limitations: body.limitations.trim(), qualification: body.qualification.trim(), reference: body.reference.trim(), notes: body.notes.trim(), actorId: body.authenticatedActor.id, reviewer: body.authenticatedActor.name, identityVerified: true, credentialsIndependentlyVerified: false, certification: false, at: new Date().toISOString(), key: run.key };
        record.revision++; record.events.push({ action: 'evaluation_review', runId: run.id, actorId: body.authenticatedActor.id, decision: body.decision, at: run.expertReview.at });
        return record;
      });
    },
    async evaluate(id, body) {
      if (evaluating.has(id)) throw fail('Evaluation is already running.', 409);
      evaluating.add(id);
      try {
        const record = find(await list(), id, body?.revision);
        if (!validateDraft(record.content).passed) throw fail('Complete structural validation before model evaluation.');
        const result = await evaluatePill(record, evaluationAgent);
        result.requestedBy = body?.authenticatedActor?.id || null;
        await mutate(records => {
          const current = records.find(r => r.id === id);
          current.evaluations = [...(current.evaluations || []), result];
          current.revision++; current.updatedAt = result.completedAt;
          current.events.push({ action: 'evaluate', at: result.completedAt, runId: result.id, passed: result.passed });
        });
        return service.get(id);
      } finally { evaluating.delete(id); }
    },
    async active(id) { const pills = await service.runtimePills(); return (id ? pills.find(p => p.id === id) : pills.at(-1)) || (id ? null : structuredClone(ahuPill)); },
    async runtimePills() { const records = await list(), releases = records.flatMap(r => r.releases); return releases.length ? releases.filter(r => r.active && !r.disabled).map(r => r.pill) : [structuredClone(ahuPill)]; },
    async library() { return (await list()).flatMap(r => r.releases.map(v => ({ ...v.pill, active: v.active, disabled: Boolean(v.disabled), publishedAt: v.publishedAt, approvedBy: v.reviewer }))); },
    async versionHistory(id) {
      const records = await list(), record = records.find(r => r.id === id && r.releases.length);
      if (!record) throw fail('Published Pill not found.', 404);
      return {
        id, revision: record.revision, libraryToken: libraryToken(records), draftState: record.state,
        active: record.releases.filter(v => v.active).map(v => ({ id: v.pill.id, version: v.pill.version }))[0] || null,
        releases: record.releases.map(v => ({ ...v, disabled: Boolean(v.disabled), contentHash: v.contentHash || releaseHash(v), checksumState: !v.contentHash ? 'legacy_calculated' : v.contentHash === releaseHash(v) ? 'verified' : 'mismatch' })),
        events: records.flatMap(r => r.events.filter(e => (e.action === 'publish' && r.id === id) || e.target?.id === id || (['publish', 'activate'].includes(e.action) && e.previous?.id === id)).map(e => ({ ...e, pillId: r.id }))).sort((a, b) => b.at.localeCompare(a.at))
      };
    },
    async compareVersions(id, from, to) {
      const record = await service.get(id), a = record.releases.find(v => v.pill.version === from), b = record.releases.find(v => v.pill.version === to);
      if (!a || !b) throw fail('Published version not found.', 404);
      return compareReleases(a, b);
    },
    manageVersion(id, version, operation, body) {
      return mutate(records => {
        const record = records.find(r => r.id === id), release = record?.releases.find(v => v.pill.version === version);
        if (!release) throw fail('Published version not found.', 404);
        if (body?.revision !== record.revision || body?.libraryToken !== libraryToken(records)) throw fail('Library changed. Reload before continuing.', 409);
        if (!str(body.reviewer, 120) || !str(body.notes, 3000) || body.confirmed !== true) throw fail('Operator, reason and explicit confirmation are required.');
        const previous = record.releases.find(v => v.active);
        if (operation === 'activate') {
          if (release.disabled || release.active) throw fail('Select an available, inactive published version.', 409);
          if (release.pill.status !== 'approved' || release.contentHash && release.contentHash !== releaseHash(release)) throw fail('This release failed its publication integrity check.', 409);
          for (const v of record.releases) v.active = false;
          release.active = true;
        } else if (operation === 'disable') {
          if (release.active || release.disabled) throw fail('Switch the active version before disabling; already disabled versions cannot be disabled again.', 409);
          release.disabled = true;
        } else if (operation === 'restore') {
          if (!release.disabled) throw fail('This version is already available.', 409);
          release.disabled = false;
        } else throw fail('Unknown version operation.', 404);
        record.revision++; record.updatedAt = new Date().toISOString();
        record.events.push({ action: operation, target: { id, version }, previous: previous ? { id: previous.pill.id, version: previous.pill.version } : null, at: record.updatedAt, revision: record.revision, reviewer: body.reviewer.trim(), notes: body.notes.trim(), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null });
        return { id, version, operation };
      });
    },
    async get(id) { const record = (await list()).find(r => r.id === id); if (!record) throw fail('Pill not found.', 404); return { ...record, evaluationGate: evaluationGate(record), evaluationRunning: evaluating.has(id), documents: (record.documents || []).map(d => ({ ...d, isRunning: running.has(`${id}/${d.id}`) })) }; },
    importExpertSolution(input) {
      return mutate(records => {
        const existing = records.find(r => r.learningImports?.some(v => v.proposalId === input.solutionId));
        if (existing) return existing;
        if (!input.actor?.id || !str(input.actor.name, 120) || !str(input.solution, 4000)) throw fail('Authenticated expert and solution are required.', 403);
        let record;
        if (input.targetPill) {
          record = records.find(r => r.id === input.targetPill.id);
          if (!record?.releases.some(r => r.active && !r.disabled && r.pill.version === input.targetPill.version)) throw fail('The target Pill version changed. Reload the Case before saving.', 409);
          if (record.state === 'in_review') throw fail('The target Pill is under review. Return its draft before adding expert knowledge.', 409);
          if (record.state === 'published') record.contributorIds = [];
        } else {
          const id = `pill-${randomUUID().slice(0, 8)}`;
          const category = input.facts.category || 'other';
          const domain = ['hvac', 'hvac_cooling'].includes(category) ? 'ahu_cooling' : category === 'other' ? 'asset_operations' : category;
          record = { id, revision: 0, state: 'draft', content: { pill: { id, name: `${input.facts.title || 'Case'} - expert knowledge`.slice(0, 200), owner: input.actor.name, source: input.caseId, scope: input.applicability, domain, applicability: { categories: [category], assetPrefixes: [], keywords: [] }, rules: [], actions: [], boundaries: ['Advisory only. Expert proposals are not evidence of execution.'], escalationConditions: [] }, sources: [], examples: [] }, releases: [], events: [], validation: null };
          records.push(record);
        }
        if (record.content.sources.length >= 20) throw fail('The target draft has reached its knowledge source limit.');
        const proposal = { id: input.solutionId, title: 'Expert Case solution', disposition: input.targetPill ? 'update_pill' : 'new_pill', applicability: input.applicability, limitations: input.limitations, validationCases: [], decision: { status: 'expert_submitted', reviewer: input.actor.name, reviewedAfter: input.solution } };
        record.content.sources.push({ expert: input.actor.name, reference: `${input.caseId} / ${input.messageId} / ${input.solutionId}`, knowledge: `${input.solution}\nApplicability: ${input.applicability}\nLimitations: ${input.limitations}\nProposed expert knowledge; outcome is not independently verified.` });
        invalidateLearning(record);
        record.learningImports = [...(record.learningImports || []), { kind: 'expert_case_solution', caseId: input.caseId, sourceMessageId: input.messageId, proposalId: input.solutionId, proposal, importedAt: new Date().toISOString(), status: 'pending_incorporation', actorId: input.actor.id }];
        record.contributorIds = [...new Set([...(record.contributorIds || []), input.actor.id])];
        record.state = 'draft'; record.validation = null; record.revision++;
        record.events.push({ action: 'expert_case_solution_imported', caseId: input.caseId, solutionId: input.solutionId, actorId: input.actor.id, revision: record.revision, at: new Date().toISOString() });
        return record;
      });
    },
    importLearning(input, body) {
      return mutate(records => {
        const { proposal: p, snapshot } = input;
        const existing = records.find(r => r.learningImports?.some(v => v.proposalId === p.id));
        if (existing) return existing;
        if (p.decision?.status !== 'accepted' || !['update_pill', 'new_pill'].includes(p.disposition)) throw fail('Only reviewed knowledge proposals can enter a draft.');
        let record;
        if (p.disposition === 'update_pill') {
          record = records.find(r => r.id === snapshot.pill?.id);
          if (!record) throw fail('Original Pill is unavailable.', 409);
          const baseVersion = record.releases.at(-1)?.pill.version || (record.id === ahuPill.id ? ahuPill.version : record.content.pill.version);
          if (baseVersion !== snapshot.pill.version) throw fail('The Pill version changed. Re-analyze against current knowledge before importing.', 409);
          record = find(records, record.id, body?.revision);
        } else {
          const facts = JSON.parse(snapshot.blocks.find(b => b.id === 'case').text);
          const domain = facts.category === 'hvac' || facts.category === 'hvac_cooling' ? 'ahu_cooling' : facts.category === 'other' ? 'asset_operations' : facts.category;
          if (!str(body?.name, 200) || !str(body?.owner, 120)) throw fail('New Pill name and owner are required.');
          const id = `pill-${randomUUID().slice(0, 8)}`;
          record = { id, revision: 0, state: 'draft', content: { pill: { id, name: body.name.trim(), owner: body.owner.trim(), source: '', scope: '', domain, applicability: { categories: [facts.category], assetPrefixes: [], keywords: [] }, rules: [], actions: [], boundaries: ['Advisory only. No automatic equipment commands.'], escalationConditions: [] }, sources: [], examples: [] }, releases: [], events: [], validation: null };
          records.push(record);
        }
        if (record.content.sources.length >= 20) throw fail('This draft has reached its source limit.');
        const knowledge = `${p.decision.reviewedAfter}\nApplicability: ${p.applicability}\nLimitations: ${p.limitations}`;
        if (knowledge.length > 8000) throw fail('Reviewed knowledge exceeds the source size limit.');
        record.content.sources.push({ expert: p.decision.reviewer, reference: `${input.caseId} / ${input.runId} / ${p.id}`, knowledge });
        if (body.authenticatedActor) record.contributorIds = [...new Set([...(record.contributorIds || []), body.authenticatedActor.id])];
        invalidateLearning(record);
        record.learningImports = [...(record.learningImports || []), { ...structuredClone(input), proposalId: p.id, importedAt: new Date().toISOString(), status: 'pending_incorporation' }];
        record.state = 'draft'; record.validation = null; record.revision++;
        record.events.push({ action: 'learning_imported', proposalId: p.id, revision: record.revision, at: new Date().toISOString() });
        return record;
      });
    },
    async upload(id, revision, filename, bytes, actor) {
      if (!str(filename, 180) || /[\\/\u0000-\u001f]/.test(filename)) throw fail('Invalid filename.');
      find(await list(), id, revision);
      const parsed = await parser(filename, bytes);
      const document = { id: `DOC-${randomUUID()}`, name: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), uploadedAt: new Date().toISOString(), blocks: parsed.blocks, warnings: parsed.warnings, status: 'ready', candidates: [] };
      return mutate(async records => {
        const record = find(records, id, revision);
        if ((record.documents || []).length >= 10) throw fail('A Pill can retain at most 10 source files.');
        if (record.documents?.some(d => d.sha256 === document.sha256)) throw fail('This file has already been uploaded to this Pill.', 409);
        await mkdir(`${file}.uploads`, { recursive: true });
        await writeFile(`${file}.uploads/${document.id}`, bytes, { mode: 0o600 });
        record.documents = [...(record.documents || []), document];
        if (actor) record.contributorIds = [...new Set([...(record.contributorIds || []), actor.id])];
        record.state = 'draft'; record.validation = null; record.revision++;
        record.events.push({ action: 'source_uploaded', documentId: document.id, revision: record.revision, at: document.uploadedAt });
        return record;
      });
    },
    async original(id, documentId) {
      const document = (await service.get(id)).documents.find(d => d.id === documentId);
      if (!document) throw fail('Source not found.', 404);
      return { document, bytes: await readFile(`${file}.uploads/${document.id}`) };
    },
    async analyze(id, documentId, revision) {
      const key = `${id}/${documentId}`;
      if (running.has(key)) throw fail('Knowledge extraction is already running.', 409);
      running.add(key);
      let started = false;
      try {
        const document = await mutate(records => {
          const record = find(records, id, revision);
          const doc = record.documents?.find(d => d.id === documentId); if (!doc) throw fail('Source not found.', 404);
          if (['extracted', 'reviewed'].includes(doc.status)) throw fail('This source has already been extracted. Review the saved candidates.', 409);
          doc.status = 'analyzing'; doc.error = null; record.revision++; record.state = 'draft'; record.validation = null;
          return { ...structuredClone(doc), domain: record.content.pill.domain };
        });
        started = true;
        const result = await captureAgent(document);
        return await mutate(records => {
          const record = records.find(r => r.id === id), doc = record.documents.find(d => d.id === documentId);
          Object.assign(doc, result, { status: 'extracted', analyzedAt: new Date().toISOString() }); record.revision++;
          record.state = 'draft'; record.validation = null;
          record.events.push({ action: 'source_extracted', documentId, revision: record.revision, at: doc.analyzedAt });
          return record;
        });
      } catch (error) {
        if (started) await mutate(records => {
          const record = records.find(r => r.id === id), doc = record.documents.find(d => d.id === documentId);
          doc.status = 'failed'; doc.error = error.status ? error.message : 'Knowledge extraction failed. Retry the source.'; record.revision++;
        });
        throw error.status ? error : fail('Knowledge extraction failed. Retry the source.');
      } finally { running.delete(key); }
    },
    merge(id, documentId, body) {
      return mutate(records => {
        const record = find(records, id, body?.revision);
        const doc = record.documents?.find(d => d.id === documentId); if (!doc) throw fail('Source not found.', 404);
        if (doc.status !== 'extracted') throw fail('Only extracted, unreviewed sources can be merged.', 409);
        const merged = mergeKnowledge(record, doc, body);
        if (body.authenticatedActor) record.contributorIds = [...new Set([...(record.contributorIds || []), body.authenticatedActor.id])];
        record.content = contentFrom(merged.content, id);
        invalidateLearning(record);
        record.captureHistory = [...(record.captureHistory || []), merged.review];
        doc.status = 'reviewed'; doc.review = merged.review;
        record.state = 'draft'; record.validation = null; record.revision++;
        record.events.push({ action: 'source_reviewed', documentId, revision: record.revision, at: merged.review.reviewedAt, reviewer: merged.review.reviewer });
        return record;
      });
    },
    create(body) {
      return mutate(records => {
        if (!str(body?.name, 200) || !str(body?.owner, 120)) throw fail('Name and owner are required.');
        const id = `pill-${randomUUID().slice(0, 8)}`;
        const record = { id, revision: 0, state: 'draft', content: { pill: { id, name: body.name.trim(), owner: body.owner.trim(), source: '', scope: '', domain: 'ahu_cooling', rules: [], actions: [], boundaries: ['Advisory only. No equipment commands or work orders.'], escalationConditions: [] }, sources: [], examples: [] }, releases: [], events: [{ action: 'created', at: new Date().toISOString() }], validation: null };
        record.contributorIds = body.authenticatedActor ? [body.authenticatedActor.id] : [];
        records.push(record); return record;
      });
    },
    change(id, operation, body) {
      return mutate(records => {
        const record = records.find(r => r.id === id); if (!record) throw fail('Pill not found.', 404);
        if (!Number.isInteger(body?.revision) || body.revision !== record.revision) throw fail('Pill changed. Reload before continuing.', 409);
        const now = new Date().toISOString();
        let activation;
        if (operation === 'fork') {
          if (record.state !== 'published') throw fail('An editable draft already exists.', 409);
          record.state = 'draft'; record.validation = null;
          record.contributorIds = [];
        } else {
          if (record.state === 'published') throw fail('Create a new draft before editing a published Pill.', 409);
          if (['validate', 'submit', 'publish'].includes(operation) && record.documents?.some(d => running.has(`${id}/${d.id}`))) throw fail('Wait for knowledge extraction to finish before validating or publishing.', 409);
          if (['validate', 'submit', 'publish'].includes(operation) && persistence?.isLeased(`studio:analyze:${id}`)) throw fail('Knowledge extraction is running on another instance.', 409);
          if (operation === 'save-evaluations') {
            if (body.content) { record.content = contentFrom(body.content, id); invalidateLearning(record); }
            record.evaluationSuite = validateSuite(body.suite); record.evaluationRequired = true;
            record.evaluationOptions = evaluationOptions(body.options || record.evaluationOptions);
            record.state = 'draft'; record.validation = null;
          } else if (operation === 'incorporate-learning') {
            const item = record.learningImports?.find(v => v.proposalId === body.proposalId);
            if (!item || item.status !== 'pending_incorporation') throw fail('Pending learning import not found.', 409);
            if (!str(body.reviewer, 120) || !str(body.notes, 3000) || body.expertConfirmed !== true) throw fail('Expert confirmation and implementation notes are required.');
            if (!validateDraft(record.content).passed) throw fail('Complete the rules and validation examples before confirming incorporation.');
            item.status = 'incorporated'; item.incorporation = { reviewer: body.reviewer.trim(), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null, notes: body.notes.trim(), at: now, content: structuredClone(record.content) };
            record.state = 'draft'; record.validation = null;
          }
          else if (operation === 'save') { record.content = contentFrom(body.content, id); record.state = 'draft'; record.validation = null;
            invalidateLearning(record);
          }
          else if (operation === 'validate') { record.validation = validateDraft(record.content); record.state = record.validation.passed ? 'validated' : 'draft'; }
          else if (operation === 'submit') {
            if (record.state !== 'validated' || !record.validation?.passed) throw fail('Validate the current draft before submitting.');
            record.state = 'in_review';
          } else if (operation === 'return') {
            if (record.state !== 'in_review' || !str(body.notes, 3000) || !str(body.reviewer, 120)) throw fail('Reviewer and return reason are required for a draft in review.');
            record.state = 'draft'; record.validation = null;
          } else if (operation === 'publish') {
            if (body.authenticatedActor && record.contributorIds?.includes(body.authenticatedActor.id)) throw fail('A different reviewer must publish this draft. Authors cannot approve their own changes.', 403);
            if (evaluating.has(id)) throw fail('Wait for evaluation to finish before publishing.', 409);
            if (persistence?.isLeased(`studio:evaluate:${id}`)) throw fail('Evaluation is running on another instance.', 409);
            if (evaluationGate(record).required && !evaluationGate(record).passed) throw fail('The current draft must pass its configured model evaluation before publication.');
            if (record.learningImports?.some(v => v.status === 'pending_incorporation')) throw fail('Confirm how imported learning was incorporated into rules and validation cases before publishing.');
            if (record.state !== 'in_review' || !validateDraft(record.content).passed) throw fail('Submit a valid draft for review before publishing.');
            if (!str(body.reviewer, 120) || !str(body.notes, 3000) || body.expertConfirmed !== true) throw fail('Reviewer, approval notes and expert confirmation are required.');
            const pill = { ...structuredClone(record.content.pill), status: 'approved', version: `${record.releases.length + 1}.0.0` };
            const previous = record.releases.find(v => v.active);
            activation = { target: { id, version: pill.version }, previous: previous ? { id: previous.pill.id, version: previous.pill.version } : null };
            for (const release of record.releases) release.active = false;
            for (const item of record.learningImports || []) if (!item.releasedVersion) item.releasedVersion = pill.version;
            record.releases.push({ pill, sources: structuredClone(record.content.sources), examples: structuredClone(record.content.examples), learningImports: structuredClone(record.learningImports || []), captureHistory: structuredClone(record.captureHistory || []), validation: structuredClone(record.validation), reviewer: body.reviewer.trim(), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null, notes: body.notes.trim(), publishedAt: now, active: true });
            record.releases.at(-1).evaluation = record.evaluationRequired ? structuredClone(record.evaluations.at(-1)) : { state: 'not_enabled' };
            record.releases.at(-1).contentHash = releaseHash(record.releases.at(-1));
            record.state = 'published';
          } else throw fail('Unknown Studio operation.', 404);
        }
        record.revision++; record.updatedAt = now;
        if (body.authenticatedActor && !['publish', 'return'].includes(operation)) record.contributorIds = [...new Set([...(record.contributorIds || []), body.authenticatedActor.id])];
        record.events.push({ action: operation, revision: record.revision, at: now, ...activation, ...(typeof body.reviewer === 'string' ? { reviewer: body.reviewer.trim().slice(0, 120) } : {}), ...(typeof body.notes === 'string' ? { notes: body.notes.trim().slice(0, 3000) } : {}) });
        return record;
      });
    }
  };
  if (persistence) for (const name of ['evaluate', 'analyze']) {
    const original = service[name]; service[name] = (...args) => persistence.withLease(`studio:${name}:${args[0]}`, () => original(...args));
  }
  return service;
}
