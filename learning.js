import { randomUUID } from 'node:crypto';
import { createLearningAgent, validateLearning, learningPromptVersion } from './learning-agent.js';
import { caseFingerprint } from './triage.js';

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const str = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const now = () => new Date().toISOString();
export function learningSnapshot(incident) {
  const report = incident.triageReports?.at(-1);
  const records = incident.handlingRecords || [];
  const outcome = records.filter(r => r.kind === 'outcome').at(-1);
  const latestAction = records.filter(r => r.kind === 'action').at(-1);
  const verifiedOutcome = Boolean(outcome?.verified && ['resolved', 'unresolved'].includes(outcome.status) && latestAction && records.indexOf(outcome) > records.indexOf(latestAction) && outcome.occurredAt >= latestAction.occurredAt);
  const blocks = [];
  const superseded = new Set(records.map(r => r.corrects).filter(Boolean));
  const add = (id, kind, value) => blocks.push({ id, kind, superseded: superseded.has(id), text: JSON.stringify(value) });
  const facts = Object.fromEntries(['id', 'title', 'description', 'asset', 'category', 'location', 'occurredAt', 'impact', 'observations', 'affectedScope', 'actionsTaken', 'priority', 'status', 'conflicts'].map(k => [k, incident[k] ?? '']));
  add('case', 'facts', facts);
  if (report) add('triage', 'analysis', { ...report, chat: undefined, stale: report.caseFingerprint !== caseFingerprint(incident) });
  for (const r of incident.reviews || []) add(r.id, 'review', r);
  for (const m of incident.messages || []) if (m.role === 'user' && m.state === 'complete') add(`chat:${m.id}`, 'user_report_unverified', { content: m.content });
  for (const r of incident.humanConfirmations || []) add(`confirmation:${r.id}`, 'human_decision_not_execution', r);
  for (const s of incident.expertSolutions || []) add(`expert:${s.id}`, 'expert_proposal_not_execution', s);
  if (incident.resultFeedback) add('case-summary', 'ai_summary_unverified', incident.resultFeedback);
  for (const r of records) add(r.id, r.kind, r);
  for (const task of incident.tasks || []) add(task.id, 'task', task);
  return { caseId: incident.id, revision: incident.revision || 0, capturedAt: now(), pill: report?.pill || null, verifiedOutcome, currentOutcomeId: outcome?.id || null, currentActionId: latestAction?.id || null, blocks };
}

export function learningEvidenceCurrent(incident, run, proposal) {
  if (!['update_pill', 'new_pill'].includes(proposal.disposition)) return true;
  const current = learningSnapshot(incident), saved = run.snapshot;
  if (!saved || !current.verifiedOutcome || current.currentActionId !== saved.currentActionId || current.currentOutcomeId !== saved.currentOutcomeId) return false;
  if (current.blocks.find(b => b.id === 'case')?.text !== saved.blocks.find(b => b.id === 'case')?.text) return false;
  const reportId = snapshot => { const block = snapshot.blocks.find(b => b.id === 'triage'); return block ? JSON.parse(block.text).id : null; };
  if (reportId(current) !== reportId(saved)) return false;
  return proposal.evidence.every(ref => {
    const block = current.blocks.find(b => b.id === ref.blockId), original = saved.blocks.find(b => b.id === ref.blockId);
    return block && !block.superseded && original && block.text === original.text;
  });
}

export function createLearningService(store, studio, agent = createLearningAgent()) {
  const running = new Set();
  const get = async id => { const i = (await store.list()).find(i => i.id === id); if (!i) throw fail('Case not found.', 404); return i; };
  const check = (i, revision) => { if (!Number.isInteger(revision) || revision !== (i.revision || 0)) throw fail('Case changed. Reload before continuing.', 409); };
  const find = (i, runId, proposalId) => {
    const run = i.learningRuns?.find(r => r.id === runId), proposal = run?.proposals.find(p => p.id === proposalId);
    if (!proposal) throw fail('Proposal not found.', 404);
    return { run, proposal };
  };
  return {
    async get(id) { return { incident: await get(id), running: running.has(id) }; },
    async list() {
      const imports = (await studio.list()).flatMap(r => (r.learningImports || []).map(v => ({ ...v, pillId: r.id, pillState: r.state })));
      return (await store.list()).flatMap(i => (i.learningRuns || []).map(run => ({ ...run, snapshot: undefined, incidentId: i.id, title: i.title, revision: i.revision || 0, proposals: run.proposals.map(p => ({ ...p, staleEvidence: !learningEvidenceCurrent(i, run, p), imported: imports.find(v => v.proposalId === p.id) || null })) })));
    },
    async record(id, body) {
      const i = await get(id); check(i, body?.revision);
      if (!['action', 'outcome'].includes(body.kind) || !str(body.author, 120) || !str(body.notes) || !str(body.occurredAt, 40) || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > Date.now()) throw fail('Enter record type, author, notes and a valid past/current time.');
      const records = i.handlingRecords || [];
      if (body.corrects && !records.some(r => r.id === body.corrects && r.kind === body.kind)) throw fail('Correction must reference an existing record of the same type.');
      const record = { id: `OPS-${randomUUID()}`, kind: body.kind, author: body.author.trim(), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null, notes: body.notes.trim(), occurredAt: new Date(body.occurredAt).toISOString(), recordedAt: now(), corrects: body.corrects || null };
      if (body.kind === 'action') {
        if (!str(body.rationale) || !str(body.deviation)) throw fail('Record the action rationale and any deviation from approved advice (or explicitly state none/no plan).');
        Object.assign(record, { rationale: body.rationale.trim(), deviation: body.deviation.trim() });
      } else {
        if (!['in_progress', 'pending_verification', 'resolved', 'unresolved'].includes(body.status) || !str(body.verification) || !str(body.remaining)) throw fail('Record outcome status, verification evidence and remaining issues.');
        if (body.status === 'resolved' && (body.verified !== true || !records.some(r => r.kind === 'action'))) throw fail('Resolution requires recorded action and explicit outcome verification.');
        const action = records.filter(r => r.kind === 'action').at(-1);
        if (body.verified === true && (!action || record.occurredAt < action.occurredAt || !['resolved', 'unresolved'].includes(body.status))) throw fail('Verified outcomes must follow a recorded action and have resolved or unresolved status.');
        Object.assign(record, { status: body.status, verified: body.verified === true, verification: body.verification.trim(), remaining: body.remaining.trim() });
      }
      return store.update(id, { handlingRecords: [...records, record], handlingStatus: body.kind === 'action' ? 'in_progress' : record.status }, body.revision);
    },
    async analyze(id, body) {
      const i = await get(id); check(i, body?.revision);
      if (running.has(id)) throw fail('Learning analysis is already running.', 409);
      if (!i.handlingRecords?.length && !i.reviews?.length && !i.expertSolutions?.length && !i.messages?.some(m => m.role === 'user' && m.state === 'complete')) throw fail('Add Case conversation evidence, operational records or expert corrections before learning.');
      const snapshot = learningSnapshot(i);
      if (!i.triageReports?.length) {
        const references = [...(i.messages || [])].reverse().find(m => m.role === 'assistant' && m.matchedPills?.length)?.matchedPills || [];
        if (references.length) {
          const reference = body.targetPillId ? references.find(p => p.id === body.targetPillId) : references.length === 1 ? references[0] : null;
          if (!reference) throw fail('Choose the referenced Pill to improve.');
          const runtime = await studio.runtimePills();
          const pill = runtime.find(p => p.id === reference.id && p.version === reference.version);
          if (!pill) throw fail('The referenced Pill changed. Obtain a fresh Case assessment before proposing an update.', 409);
          snapshot.pill = structuredClone(pill);
        }
      }
      if (i.triageReports?.at(-1)?.sourcePills?.length > 1) {
        const target = i.triageReports.at(-1).sourcePills.find(p => p.id === body.targetPillId);
        if (!target) throw fail('Choose the original specialist Pill to improve.');
        snapshot.pill = structuredClone(target);
      }
      if (JSON.stringify(snapshot).length > 65000) throw fail('Case evidence exceeds the MVP learning limit. No evidence was silently omitted.');
      running.add(id);
      try {
        const result = validateLearning(await agent(snapshot), snapshot);
        const run = { id: `LRN-${randomUUID()}`, createdAt: now(), snapshot, model: process.env.SOCLAAS_MODEL || 'default', promptVersion: learningPromptVersion, ...result, proposals: result.proposals.map(p => ({ ...p, id: `IMP-${randomUUID()}`, decision: null })) };
        await store.update(id, { learningRuns: [...(i.learningRuns || []), run] }, body.revision);
        return run;
      } finally { running.delete(id); }
    },
    async decide(id, runId, proposalId, body) {
      const i = await get(id); check(i, body?.revision);
      const { run, proposal } = find(i, runId, proposalId);
      if (proposal.decision) throw fail('This proposal already has a decision. Re-analyze updated evidence for a new proposal.', 409);
      if (!['accepted', 'rejected', 'needs_information'].includes(body.decision) || !str(body.reviewer, 120) || !str(body.notes)) throw fail('Reviewer, decision and rationale are required.');
      if (body.decision === 'accepted' && (body.confirmed !== true || !str(body.reviewedAfter))) throw fail('Confirm the evidence and provide the reviewed proposal text.');
      if (body.decision === 'accepted' && !learningEvidenceCurrent(i, run, proposal)) throw fail('Learning evidence changed. Analyze the latest facts and outcomes before accepting this knowledge.', 409);
      proposal.decision = { status: body.decision, reviewer: body.reviewer.trim(), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null, notes: body.notes.trim(), reviewedAfter: body.decision === 'accepted' ? body.reviewedAfter.trim() : null, at: now() };
      await store.update(id, { learningRuns: i.learningRuns }, body.revision);
      return proposal;
    },
    async apply(id, runId, proposalId, body) {
      const apply = async () => {
      const i = await get(id), { run, proposal } = find(i, runId, proposalId);
      if (proposal.decision?.status !== 'accepted' || !['update_pill', 'new_pill'].includes(proposal.disposition)) throw fail('Only accepted knowledge proposals can enter Pill drafts.');
      if (!learningEvidenceCurrent(i, run, proposal)) throw fail('Learning evidence changed. Re-analyze before importing knowledge.', 409);
      // SQLite adds an atomic Case receipt; legacy JSON retains the Pill-owned receipt only.
      const record = await studio.importLearning({ caseId: id, runId, proposal, snapshot: run.snapshot }, body);
      if (store.transaction && !proposal.importReceipt) {
        proposal.importReceipt = { pillId: record.id, at: now(), actorId: body.authenticatedActor?.id || null };
        await store.update(id, { learningRuns: i.learningRuns }, i.revision || 0);
      }
      return record;
      };
      return store.transaction ? store.transaction(apply) : apply();
    }
  };
}
