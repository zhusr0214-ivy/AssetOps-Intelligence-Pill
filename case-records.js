import { randomUUID } from 'node:crypto';
import { createCaseAnswer } from './case-conversation-agent.js';
import { feedbackEvidence, feedbackKey, validateCaseFeedback } from './case-feedback.js';

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const actor = body => { if (!body.authenticatedActor?.id || !text(body.authenticatedActor.name, 120)) throw fail('An authenticated account is required.', 403); return body.authenticatedActor; };
const check = (incident, revision) => { if (!Number.isInteger(revision) || revision !== (incident.revision || 0)) throw fail('Case changed. Reload before saving.', 409); };

export function createCaseRecords(store, studio, { answer = createCaseAnswer(), improvements } = {}) {
  const get = async id => { const incident = (await store.list()).find(i => i.id === id); if (!incident) throw fail('Case not found.', 404); return incident; };
  return {
    async confirmExperience(id, body) {
      if(improvements)return improvements.create(id,body);
      const who = actor(body);
      if (body.confirmed !== true || !text(body.solutionId, 100)) throw fail('Confirm the expert experience to save it as a Pill draft.');
      const save = async () => {
        let incident = await get(id);
        const saved = incident.expertSolutions?.find(s => s.id === body.solutionId);
        if (!saved) throw fail('Expert experience not found.', 404);
        if (saved.pillDraftId) return incident;
        check(incident, body.revision);
        const draft = await studio.importExpertSolution({ caseId: id, solutionId: saved.id, messageId: saved.messageId, actor: { id: saved.actorId, name: saved.expert }, solution: saved.solution, applicability: saved.applicability, limitations: saved.limitations, targetPill: saved.targetPill, facts: saved.facts });
        incident = await get(id);
        return store.update(id, { expertSolutions: incident.expertSolutions.map(s => s.id === saved.id ? { ...s, pillDraftId: draft.id, status: 'pending_incorporation', experienceConfirmation: { actorId: who.id, name: who.name, at: new Date().toISOString() } } : s) }, incident.revision || 0);
      };
      return store.withLease(`case-expert:${id}`, () => store.transaction ? store.transaction(save) : save());
    },
    async confirm(id, body) {
      const who = actor(body), incident = await get(id); check(incident, body.revision);
      if (body.messageId !== undefined) {
        const message = incident.messages?.find(m => m.id === body.messageId && m.role === 'assistant' && m.supervision?.required);
        if (!message || !['review', 'escalation'].includes(message.supervision.mode)) throw fail('This message has no reviewable request.', 404);
        const allowed = message.supervision.mode === 'escalation' ? ['escalated'] : ['approved', 'rejected', 'escalated'];
        if (!allowed.includes(body.decision) || !text(body.subject, 3000) || body.confirmed !== true) throw fail('Select a valid decision and record its rationale.');
        if (incident.humanConfirmations?.some(c => c.sourceMessageId === message.id && c.decision)) throw fail('This request already has a recorded decision.', 409);
        if (body.decision === 'approved') {
          if (Object.entries(message.supervision.caseFacts || {}).some(([key, value]) => (incident[key] || '') !== value)) throw fail('Case facts changed. Ask for a fresh assessment before approval.', 409);
          const current = await studio.runtimePills();
          if ((message.supervision.pillVersions || []).some(p => !current.some(c => c.id === p.id && c.version === p.version))) throw fail('Referenced Pill versions changed. Ask for a fresh assessment before approval.', 409);
        }
        if ((incident.humanConfirmations || []).length >= 100) throw fail('Confirmation record limit reached.');
        const record = { id: `CONF-${randomUUID()}`, subject: body.subject.trim(), decision: body.decision, requestSubject: message.supervision.subject, reason: message.supervision.reason, kind: message.supervision.kind, pillVersions: message.supervision.pillVersions, actorId: who.id, confirmedBy: who.name, identityVerified: true, createdAt: new Date().toISOString(), sourceMessageId: message.id, scope: 'case_recommendation_only_not_execution_or_pill_release' };
        return store.update(id, { humanConfirmations: [...(incident.humanConfirmations || []), record] }, body.revision);
      }
      if (!text(body.subject, 3000) || body.confirmed !== true) throw fail('Enter what you confirmed and explicitly confirm the record.');
      const records = incident.humanConfirmations || [];
      if (records.length >= 100) throw fail('Confirmation record limit reached.');
      const confirmation = { id: `CONF-${randomUUID()}`, subject: body.subject.trim(), actorId: who.id, confirmedBy: who.name, identityVerified: true, createdAt: new Date().toISOString(), sourceMessageId: incident.messages?.at(-1)?.id || null, scope: 'record_only_not_operational_authorization' };
      return store.update(id, { humanConfirmations: [...records, confirmation] }, body.revision);
    },
    async summarize(id) {
      const incident = await get(id), sourceKey = feedbackKey(incident);
      if (incident.resultFeedback?.sourceKey === sourceKey) {
        if (incident.resultFeedback.caseRevision === incident.revision) return incident;
        return store.update(id, { resultFeedback: { ...incident.resultFeedback, caseRevision: (incident.revision || 0) + 1 } }, incident.revision || 0);
      }
      const evidence = feedbackEvidence(incident);
      const payload = { task: 'summary_only', resultEvidence: evidence, sources: [], conversation: [], facts: { title: incident.title, asset: incident.asset, description: incident.description }, knowledgeGap: true };
      if (JSON.stringify(payload).length > 180000) throw fail('Case evidence is too large to summarize without omission.');
      const proposed = await answer(payload);
      const resultFeedback = { ...validateCaseFeedback(proposed.resultFeedback, evidence), sourceKey, caseRevision: (incident.revision || 0) + 1 };
      return store.update(id, { resultFeedback }, incident.revision || 0);
    },
    async expertSolution(id, body) {
      const who = actor(body);
      if (!text(body.requestId, 80) || !/^[a-zA-Z0-9-]{8,80}$/.test(body.requestId) || !text(body.solution, 4000) || (body.applicability !== undefined && !text(body.applicability, 1000)) || (body.limitations !== undefined && !text(body.limitations, 1000)) || body.confirmed !== true) throw fail('Enter the expert solution and confirm the submission.');
      const save = async () => {
        let incident = await get(id);
        let saved = (incident.expertSolutions || []).find(s => s.requestId === body.requestId);
        if (saved) {
          if (saved.actorId !== who.id || saved.solution !== body.solution.trim() || saved.messageId !== body.messageId || (body.applicability !== undefined && saved.applicability !== body.applicability.trim()) || (body.limitations !== undefined && saved.limitations !== body.limitations.trim()) || (saved.targetPill?.id || '') !== (body.targetPillId || '')) throw fail('This request ID belongs to a different submission.', 409);
          if (saved.pillDraftId || saved.improvementBatchId || body.deferDraft === true) return incident;
        } else {
          check(incident, body.revision);
          const message = incident.messages?.find(m => m.id === body.messageId && m.role === 'assistant' && m.expertRequest?.required);
          if (!message) throw fail('The expert request is unavailable.', 404);
          if (incident.expertSolutions?.some(s => s.messageId === message.id)) throw fail('This request already has an expert solution.', 409);
          const targetPill = body.targetPillId ? message.matchedPills?.find(p => p.id === body.targetPillId) : null;
          if (body.targetPillId && !targetPill) throw fail('Select a Pill associated with this expert request.');
          saved = { id: `EXP-${randomUUID()}`, requestId: body.requestId, messageId: message.id, solution: body.solution.trim(), applicability: body.applicability?.trim() || `Case-specific: ${incident.title || id}; asset: ${incident.asset || 'not specified'}. Broader applicability is pending expert validation.`.slice(0, 1000), limitations: body.limitations?.trim() || 'Proposed solution only. Execution, outcome, safety boundaries and broader applicability must be verified before release.', expert: who.name, actorId: who.id, targetPill: targetPill || null, createdAt: new Date().toISOString(), status: 'pending_draft', facts: { title: incident.title, category: incident.category, asset: incident.asset } };
          if (body.deferDraft === true) saved.status = 'pending_confirmation';
          incident = await store.update(id, { expertSolutions: [...(incident.expertSolutions || []), saved] }, body.revision);
        }
        if (body.deferDraft === true) {
          if (improvements) return improvements.create(id, { solutionId: saved.id, revision: incident.revision || 0, confirmed: true, authenticatedActor: who, authenticatedRoles: body.authenticatedRoles });
          return incident;
        }
        // A staged Case record and idempotent import permit recovery in legacy JSON mode.
        const draft = await studio.importExpertSolution({ caseId: id, solutionId: saved.id, messageId: saved.messageId, actor: who, solution: saved.solution, applicability: saved.applicability, limitations: saved.limitations, targetPill: saved.targetPill, facts: saved.facts });
        incident = await get(id);
        return store.update(id, { expertSolutions: incident.expertSolutions.map(s => s.id === saved.id ? { ...s, pillDraftId: draft.id, status: 'pending_incorporation' } : s) }, incident.revision || 0);
      };
      return store.withLease(`case-expert:${id}`, () => store.transaction ? store.transaction(save) : save());
    }
  };
}
