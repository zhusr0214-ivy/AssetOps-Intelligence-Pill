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
import {createExpertInterviewAgent,relatedKnowledge} from './expert-interview.js';
import {createExpertMethods} from './expert-workflow.js';

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
  check(array(pill.boundaries)&&pill.boundaries.every(v=>str(v,2000)),'boundaries must contain 1-30 nonempty entries.');
  check(Array.isArray(pill.escalationConditions)&&pill.escalationConditions.length<=30&&pill.escalationConditions.every(v=>str(v,2000)),'escalationConditions must contain 0-30 source-supported nonempty entries.');
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

export function createPillStudio(file, { captureAgent = createKnowledgeCaptureAgent(), parser = extractDocument, evaluationAgent = createTriageAgent(), interviewAgent = createExpertInterviewAgent(), persistence } = {}) {
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
        if (record.independentReviewRequired && (record.contributorIds?.includes(body.authenticatedActor.id) || run.requestedBy === body.authenticatedActor.id)) throw fail('A different reviewer must assess this evaluation.', 403);
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
    async get(id) { const record = (await list()).find(r => r.id === id); if (!record) throw fail('Pill not found.', 404); return { ...record, relatedPills:relatedKnowledge(await list(),record), evaluationGate: evaluationGate(record), evaluationRunning: evaluating.has(id), documents: (record.documents || []).map(d => ({ ...d, isRunning: running.has(`${id}/${d.id}`) })) }; },
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
    async upload(id, revision, filename, bytes, actor, context = {}) {
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
        if(context.dialogueId){
          if(record.expertDialogue?.id!==context.dialogueId||record.expertDialogue.documentId)throw fail('The discussion changed. Reload before confirming.',409);
          record.expertDialogue.documentId=document.id;record.expertDialogue.status='confirmed';
          document.expertFeedbackIds=[...(record.expertDialogue.feedbackIds||[])];
          const p=record.content.pill;
          document.repairTargets=[...p.rules.map(v=>({id:v.id,type:'rule',title:v.title,text:v.guidance})),...p.actions.map(v=>({id:v.id,type:'action',title:v.title,text:v.instruction,owner:v.owner,requiresApproval:v.requiresApproval})),...(p.scope?[{id:'existing-scope',type:'scope',title:'Current scope',text:p.scope}]:[]),...p.boundaries.map((text,i)=>({id:`existing-boundary-${i}`,type:'boundary',title:'Existing limit',text})),...p.escalationConditions.map((text,i)=>({id:`existing-escalation-${i}`,type:'escalation',title:'Existing escalation',text}))];
        }
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
    async analyze(id, documentId, revision, reextract = false) {
      const key = `${id}/${documentId}`;
      if (running.has(key)) throw fail('Knowledge extraction is already running.', 409);
      running.add(key);
      let started = false;
      try {
        const document = await mutate(records => {
          const record = find(records, id, revision);
          const doc = record.documents?.find(d => d.id === documentId); if (!doc) throw fail('Source not found.', 404);
          if (['reviewed','extracted'].includes(doc.status) && reextract !== true) throw fail('This source has already been extracted. Review the saved candidates.', 409);
          if (doc.status === 'reviewed') {
            doc.repairReview = structuredClone(doc.review);
            doc.repairTargets = [...(doc.extractionHistory||[]).flatMap(h=>h.review?.decisions||[]),...doc.review.decisions].filter(d=>d.decision==='accepted' && ['scope','rule','action','boundary','escalation'].includes(d.type)).flatMap(d=>{
              const oldText=d.reviewedText||d.originalText;
              const field=d.type==='boundary'?'boundaries':'escalationConditions';
              const previous=[...(doc.extractionHistory||[]).flatMap(h=>h.candidates||[]),...(doc.candidates||[])].find(c=>c.id===d.id);
              const item=['rule','action'].includes(d.type) ? record.content.pill[d.type==='rule'?'rules':'actions'].find(v=>v.id===d.targetId) : d.type==='scope' ? (record.content.pill.scope.split(oldText).length===2 ? {id:d.targetId,title:d.title||previous?.title||'Scope',guidance:oldText} : null) : (record.content.pill[field].filter(t=>t===oldText).length===1 ? {id:d.targetId,title:d.title||previous?.title||d.type,guidance:oldText} : null);
              return item ? [{id:item.id,type:d.type,title:item.title,text:item.guidance||item.instruction,evidence:d.evidence}] : [];
            });
            doc.repairTargets=[...new Map(doc.repairTargets.map(t=>[t.id,t])).values()];
            record.events.push({action:'source_completeness_check_requested',documentId,at:new Date().toISOString()});
          }
          if (['reviewed','extracted'].includes(doc.status)) {
            doc.extractionHistory = [...(doc.extractionHistory || []), { analyzedAt: doc.analyzedAt, promptVersion: doc.promptVersion, candidates: structuredClone(doc.candidates || []), questions: structuredClone(doc.questions || []), conflicts: structuredClone(doc.conflicts || []), review: structuredClone(doc.review || null) }];
            record.events.push({ action:'source_reextraction_requested',documentId,at:new Date().toISOString() });
          }
          const comparisonCandidates=((doc.status==='failed'&&/^Knowledge comparison/.test(doc.error||''))||doc.comparisonStatus==='partial')&&doc.candidates?.length?structuredClone(doc.candidates):null;
          delete doc.reviewDraft; doc.status = 'analyzing'; doc.error = null; record.revision++; record.state = 'draft'; record.validation = null;
          if(record.expertDialogue?.documentId===doc.id||doc.expertFeedbackIds){
            const p=record.content.pill;
            doc.repairTargets=[...p.rules.map(v=>({id:v.id,type:'rule',title:v.title,text:v.guidance})),...p.actions.map(v=>({id:v.id,type:'action',title:v.title,text:v.instruction,owner:v.owner,requiresApproval:v.requiresApproval})),...(p.scope?[{id:'existing-scope',type:'scope',title:'Current scope',text:p.scope}]:[]),...p.boundaries.map((text,i)=>({id:`existing-boundary-${i}`,type:'boundary',title:'Existing limit',text})),...p.escalationConditions.map((text,i)=>({id:`existing-escalation-${i}`,type:'escalation',title:'Existing escalation',text}))];
          }
          return { ...structuredClone(doc), comparisonCandidates, domain: record.content.pill.domain };
        });
        started = true;
        const result = await captureAgent(document);
        return await mutate(records => {
          const record = records.find(r => r.id === id), doc = record.documents.find(d => d.id === documentId);
          if(!result.unchangedKnowledge&&doc.repairTargets?.length) for(const c of result.candidates) {
            const matches=doc.repairTargets.filter(t=>t.type===c.type && t.evidence?.length && c.evidence?.length && t.evidence.every(ref=>c.evidence.some(v=>v.blockId===ref.blockId && v.quote===ref.quote)) && c.evidence.every(ref=>t.evidence.some(v=>v.blockId===ref.blockId && v.quote===ref.quote)));
            if(matches.length===1)c.replacementTargetId=matches[0].id;
          }
          delete doc.captureDiagnostic; delete doc.captureProgress; delete doc.partialCandidates;
          Object.assign(doc, result, { status: 'extracted', analyzedAt: new Date().toISOString() }); record.revision++;
          record.state = 'draft'; record.validation = null;
          record.events.push({ action: 'source_extracted', documentId, revision: record.revision, at: doc.analyzedAt });
          return record;
        });
      } catch (error) {
        if (started) await mutate(records => {
          const record = records.find(r => r.id === id), doc = record.documents.find(d => d.id === documentId);
          if(error.captureProgress)doc.captureProgress=error.captureProgress;if(error.partialCandidates)doc.partialCandidates=error.partialCandidates;
          doc.status = 'failed'; doc.error = error.status ? error.message : 'Knowledge extraction failed. Retry the source.';doc.captureDiagnostic=error.captureDiagnostic||null; record.revision++;
        });
        throw error.status ? error : fail('Knowledge extraction failed. Retry the source.');
      } finally { running.delete(key); }
    },
    saveCaptureDraft(id, documentId, body) {
      return mutate(records => {
        const record=find(records,id,body?.revision),doc=record.documents?.find(d=>d.id===documentId);
        if (!doc || doc.status !== 'extracted' || record.state === 'published') throw fail('Only unconfirmed extracted knowledge can be saved.',409);
        if(!Array.isArray(body.items) || body.items.length !== doc.candidates.length || new Set(body.items.map(i=>i?.id)).size !== body.items.length || body.items.some(i=>!doc.candidates.some(c=>c.id===i?.id) || typeof i.text !== 'string' || i.text.length>2000 || typeof i.selected !== 'boolean' || (i.replaceId && !doc.repairTargets?.some(t=>t.id===i.replaceId && t.type===doc.candidates.find(c=>c.id===i.id)?.type))) || typeof body.actionOwner !== 'string' || body.actionOwner.length>120) throw fail('Invalid candidate draft.');
        doc.reviewDraft={items:structuredClone(body.items),actionOwner:body.actionOwner,savedAt:new Date().toISOString()};
        if(body.authenticatedActor)record.contributorIds=[...new Set([...(record.contributorIds||[]),body.authenticatedActor.id])];
        record.revision++;return record;
      });
    },
    merge(id, documentId, body) {
      return mutate(records => {
        const record = find(records, id, body?.revision);
        const doc = record.documents?.find(d => d.id === documentId); if (!doc) throw fail('Source not found.', 404);
        if (doc.status !== 'extracted') throw fail('Only extracted, unreviewed sources can be merged.', 409);
        if(doc.captureCompleteness==='partial')throw fail('Save extraction draft edits and complete the pending extraction before confirming it as knowledge.',409);
        if(doc.expertFeedbackIds?.length&&(body.feedbackConfirmed!==true||!body.selections?.length))throw fail('Confirm how the example correction is reflected in the selected knowledge.');
        const merged = mergeKnowledge(record, doc, body);
        for(const feedback of record.expertFeedback||[])if(doc.expertFeedbackIds?.includes(feedback.trialId)){feedback.status='reviewed_in_knowledge';feedback.documentId=doc.id;feedback.reviewedBy=body.authenticatedActor?.id||body.reviewer;feedback.reviewedAt=new Date().toISOString();}
        if (body.authenticatedActor) record.contributorIds = [...new Set([...(record.contributorIds || []), body.authenticatedActor.id])];
        record.content = contentFrom(merged.content, id);
        invalidateLearning(record);
        record.captureHistory = [...(record.captureHistory || []), merged.review];
        doc.status = 'reviewed'; doc.review = merged.review; delete doc.reviewDraft;
        record.state = 'draft'; record.validation = null; record.revision++;
        record.events.push({ action: 'source_reviewed', documentId, revision: record.revision, at: merged.review.reviewedAt, reviewer: merged.review.reviewer });
        return record;
      });
    },
    create(body) {
      return mutate(records => {
        if (!str(body?.name, 200) || !str(body?.owner, 120)) throw fail('Name and owner are required.');
        const id = `pill-${randomUUID().slice(0, 8)}`;
        const domains = {ahu_cooling:'hvac_cooling',hvac_local_comfort:'hvac_local_comfort',energy:'energy',electrical_distribution:'electrical_distribution',water_leak:'water_leak',lift_fault:'lift_fault',asset_operations:'other'};
        const domain = body.domain || 'ahu_cooling'; if (!domains[domain]) throw fail('Choose a supported domain.');
        const record = { id, revision: 0, state: 'draft', content: { pill: { id, name: body.name.trim(), owner: body.owner.trim(), source: '', scope: '', domain, ...(body.domain ? {applicability:{categories:[domains[domain]],assetPrefixes:[],keywords:[]}} : {}), rules: [], actions: [], boundaries: ['Advisory only. No equipment commands or work orders.'], escalationConditions: [] }, sources: [], examples: [] }, releases: [], events: [{ action: 'created', at: new Date().toISOString() }], validation: null };
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
          if(['submit','publish'].includes(operation)&&record.expertDialogue?.messages.some(m=>m.text)&&!record.expertDialogue.documentId)throw fail('Confirm the pending expert discussion as a source and review its knowledge before release.',409);
          if(['submit','publish'].includes(operation)&&record.expertAttempt)throw fail('Re-run the saved example before release; its analysis has not completed.',409);
          if(['submit','publish'].includes(operation)&&record.documents?.some(d=>d.captureCompleteness==='partial'))throw fail('Complete the pending source extraction before release. Retained drafts are not completed knowledge.',409);
          if(['submit','publish'].includes(operation)&&record.expertFeedback?.some(f=>f.status==='pending_report_fix'))throw fail('Re-run and confirm examples with pending report-only corrections before release.',409);
          if(['submit','publish'].includes(operation)&&record.expertFeedback?.some(f=>f.status==='pending_knowledge_review'))throw fail('Review the pending expert corrections in Prepare knowledge before release.',409);
          if (['validate', 'submit', 'publish'].includes(operation) && record.documents?.some(d => running.has(`${id}/${d.id}`))) throw fail('Wait for knowledge extraction to finish before validating or publishing.', 409);
          if (['validate', 'submit', 'publish'].includes(operation) && persistence?.isLeased(`studio:analyze:${id}`)) throw fail('Knowledge extraction is running on another instance.', 409);
          if (operation === 'save-evaluations') {
            if (body.content) { record.content = contentFrom(body.content, id); invalidateLearning(record); }
            record.evaluationSuite = validateSuite(body.suite, {allowIncomplete:body.draftOnly === true}); record.evaluationRequired = true;
            if (body.sharedExamples === true) record.content.examples = record.evaluationSuite.filter(t=>t.expected.status==='complete' && t.name && t.expected.ruleIds.length).map(t=>({scenario:[t.facts.description,t.facts.observations].filter(Boolean).join('\n'),rationale:t.expected.workflow?.steps || `User-defined test expectation: ${t.name}; expected rules ${t.expected.ruleIds.join(', ')} and actions ${t.expected.actionIds.join(', ')}.`,ruleIds:t.expected.ruleIds,actionIds:t.expected.actionIds}));
            if(body.options?.independentReviewRequired!==undefined){if(typeof body.options.independentReviewRequired!=='boolean')throw fail('Independent review must be enabled or disabled.');record.independentReviewRequired=body.options.independentReviewRequired;}
            record.evaluationOptions = evaluationOptions(body.options || record.evaluationOptions);
            record.validation = body.autoValidate ? validateDraft(record.content) : null; record.state = record.validation?.passed ? 'validated' : 'draft';
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
            if(body.autoValidate) {record.validation=validateDraft(record.content);record.state=record.validation.passed?'validated':'draft';}
          }
          else if (operation === 'validate') { record.validation = validateDraft(record.content); record.state = record.validation.passed ? 'validated' : 'draft'; }
          else if (operation === 'submit') {
            if(record.documents?.some(d=>d.status!=='reviewed'))throw fail('Review the pending source proposals before submitting the knowledge.',409);
            if(body.autoValidate) {record.validation=validateDraft(record.content);if(record.validation.passed) record.state='validated';}
            if(record.evaluationRequired) {
              const gate=evaluationGate(record);
              if(!record.evaluations?.at(-1)?.passed || ['not_run','outdated','failed','not_enabled'].includes(gate.state)) throw fail('Run a successful evaluation of the current knowledge before submitting for review.',409);
            }
            if (record.state !== 'validated' || !record.validation?.passed) throw fail('Complete the draft and test examples before submitting.');
            record.state = 'in_review';
          } else if (operation === 'return') {
            if (record.state !== 'in_review' || !str(body.notes, 3000) || !str(body.reviewer, 120)) throw fail('Reviewer and return reason are required for a draft in review.');
            record.state = 'draft'; record.validation = null;
          } else if (operation === 'publish') {
            if (record.independentReviewRequired && body.authenticatedActor && record.contributorIds?.includes(body.authenticatedActor.id)) throw fail('A different reviewer must publish this draft. Authors cannot approve their own changes.', 403);
            if (evaluating.has(id)) throw fail('Wait for evaluation to finish before publishing.', 409);
            if (persistence?.isLeased(`studio:evaluate:${id}`)) throw fail('Evaluation is running on another instance.', 409);
            if(body.evaluationReview && record.evaluationRequired) {
              const run=record.evaluations?.at(-1), review=body.evaluationReview;
              const baseline=record.releases.find(r=>r.active&&!r.disabled)?.pill||null;
              if(!run || run.id!==review.runId || run.key!==evaluationKey(record,baseline) || !run.passed) throw fail('Current successful evaluation is required for combined approval.',409);
              if(!body.authenticatedActor?.id || record.independentReviewRequired && run.requestedBy===body.authenticatedActor.id) throw fail('A different reviewer must assess this evaluation.',403);
              if(!run.expertReview) {
                if(!['scope','limitations','qualification','reference','notes'].every(k=>str(review[k],2000)) || review.confirmed!==true) throw fail('Complete the evaluation review and confirm the operating limits.');
                run.expertReview={decision:'accepted',...Object.fromEntries(['scope','limitations','qualification','reference','notes'].map(k=>[k,review[k].trim()])),actorId:body.authenticatedActor.id,reviewer:body.authenticatedActor.name,identityVerified:true,credentialsIndependentlyVerified:false,certification:false,at:now,key:run.key};
                record.events.push({action:'evaluation_review',runId:run.id,actorId:body.authenticatedActor.id,decision:'accepted',at:now});
              }
            }
            if (evaluationGate(record).required && !evaluationGate(record).passed) throw fail('The current draft must pass its configured model evaluation before publication.');
            if (record.learningImports?.some(v => v.status === 'pending_incorporation')) throw fail('Confirm how imported learning was incorporated into rules and validation cases before publishing.');
            if (record.state !== 'in_review' || !validateDraft(record.content).passed) throw fail('Submit a valid draft for review before publishing.');
            if (!str(body.reviewer, 120) || !str(body.notes, 3000) || body.expertConfirmed !== true) throw fail('Reviewer, approval notes and expert confirmation are required.');
            const pill = { ...structuredClone(record.content.pill), status: 'approved', version: `${record.releases.length + 1}.0.0` };
            const previous = record.releases.find(v => v.active);
            activation = { target: { id, version: pill.version }, previous: previous ? { id: previous.pill.id, version: previous.pill.version } : null };
            for (const release of record.releases) release.active = false;
            for (const item of record.learningImports || []) if (!item.releasedVersion) item.releasedVersion = pill.version;
            record.releases.push({ pill, sources: structuredClone(record.content.sources), examples: structuredClone(record.content.examples), learningImports: structuredClone(record.learningImports || []), captureHistory: structuredClone(record.captureHistory || []), ...(record.expertFeedback?.length?{expertFeedback:structuredClone(record.expertFeedback),expertTrials:structuredClone(record.expertTrials||[])}:{}), validation: structuredClone(record.validation), reviewer: body.reviewer.trim(), independentReviewRequired:Boolean(record.independentReviewRequired), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null, notes: body.notes.trim(), publishedAt: now, active: true });
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
  Object.assign(service,createExpertMethods({list,mutate,find,service,interviewAgent,evaluationAgent,validateDraft}));
  const expertBusy=new Set();
  for(const name of ['expertTurn','expertConfirm','expertTrial','expertFeedback','expertValidate']){
    const original=service[name];service[name]=async (...args)=>{
      const id=args[0];if(expertBusy.has(id))throw fail('An expert interaction is already running. Wait before continuing.',409);
      expertBusy.add(id);try{return persistence?await persistence.withLease(`studio:expert:${id}`,()=>original(...args)):await original(...args);}finally{expertBusy.delete(id);}
    };
  }
  if (persistence) for (const name of ['evaluate', 'analyze']) {
    const original = service[name]; service[name] = (...args) => persistence.withLease(`studio:${name}:${args[0]}`, () => original(...args));
  }
  return service;
}
