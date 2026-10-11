import { randomUUID } from 'node:crypto';
import { ahuPill, caseFingerprint, validateTriageResult } from './triage.js';
import { matchedPills, bundlePills, actionConflicts } from './pill-routing.js';

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const decisions = ['approve', 'approve_with_changes', 'request_information', 'reanalyze', 'escalate', 'reject'];
export function governancePackage(incident, report = incident.triageReports?.at(-1), activePill = ahuPill) {
  if (!report) return null;
  const findings = [];
  const add = (code, severity, message) => findings.push({ code, severity, message });
  const stale = report.caseFingerprint !== caseFingerprint(incident) || incident.status !== 'ready_for_triage';
  const matches = matchedPills(incident, activePill);
  activePill = bundlePills(matches.map(m => m.pill));
  if (stale) add('case_version', 'block', 'Case changed or intake is unconfirmed. Confirm intake and run a new analysis.');
  if (!matches.length || !report.pill) add('scope', 'block', 'No applicable Pill. Refer to a domain specialist.');
  if (report.pill && (!activePill || report.pill.id !== activePill.id || report.pill.version !== activePill.version || JSON.stringify(report.pill) !== JSON.stringify(activePill))) add('pill_version', 'block', 'The report uses a different Pill definition or routing selection. Run a new analysis.');
  if (report.coordination?.required) add('coordination', 'warning', 'Multiple specialist analyses require explicit reconciliation and a responsible owner.');
  for (const conflict of report.coordination?.conflicts || []) add('action_conflict', 'warning', `Conflicting proposals for ${conflict.key}: ${conflict.values.join(' / ')}. Omit incompatible actions or escalate.`);
  if (report.pill?.status !== 'approved') add('knowledge_status', 'warning', 'Demo knowledge: review decisions are advisory only; operational release is not authorized.');
  if (report.status !== 'complete') add('report_status', 'block', `Report is ${report.status}. Resolve it before approving a plan.`);
  if (incident.conflicts?.length) add('conflicts', 'block', 'Unresolved case facts require confirmation.');
  if (incident.messages?.some(m => m.role === 'user' && m.state !== 'complete')) add('pending_message', 'block', 'An intake message is unresolved.');
  let evidenceChecked = false;
  if (report.pill && ['complete', 'needs_information'].includes(report.status) && report.hypotheses?.length) {
    try {
      validateTriageResult(structuredClone({ summary: report.summary, hypotheses: report.hypotheses, actionIds: (report.actions || []).map(a => a.id), missingFields: report.missingFields || [], prioritySuggestion: report.prioritySuggestion ?? null }), report.snapshot, report.pill);
      evidenceChecked = true;
    } catch { add('evidence', 'block', 'Evidence, reasoning or rule references failed validation. Run a new analysis.'); }
  } else add('evidence', 'block', 'No supported hypotheses are available for approval.');
  if (report.missingFields?.length) add('missing_information', 'block', `Information required: ${report.missingFields.join(', ')}.`);
  if (report.hypotheses?.some(h => h.uncertainties?.length)) add('uncertainty', 'warning', 'Uncertainties remain. Verify the assumptions and suitability of the proposed checks.');
  const actions = (report.actions || []).map(action => {
    const canonical = report.pill?.actions.find(a => a.id === action.id);
    const valid = canonical && JSON.stringify(action) === JSON.stringify(canonical);
    return { ...action, classification: !valid ? 'prohibited' : action.requiresApproval ? 'approval_required' : 'advisory_check', reason: !valid ? 'Action differs from the Pill catalog.' : action.requiresApproval ? 'Responsible engineer approval is required.' : 'Read-only advisory check; no automated execution is authorized.' };
  });
  if (actions.some(a => a.classification === 'prohibited')) add('action_boundary', 'block', 'One or more actions are outside the approved catalog.');
  return { reportId: report.id, caseFingerprint: report.caseFingerprint, pillId: report.pill?.id || null, pillVersion: report.pill?.version || null, checkedAt: new Date().toISOString(), policyVersion: 'review-1', stale, evidenceChecked, executionAllowed: false, findings, actions, canApprove: !findings.some(f => f.severity === 'block'), boundaries: report.pill?.boundaries || [], escalationConditions: report.pill?.escalationConditions || [] };
}

export function reviewState(incident, pack) {
  if (pack?.findings.some(f => f.code === 'pill_version')) return 'outdated';
  const previous = incident.reviews?.at(-1);
  if (previous?.reportId === pack?.reportId && previous.caseFingerprint === caseFingerprint(incident) && (!pack?.stale || (previous.decision === 'request_information' && incident.status === 'needs_info'))) return previous.decision;
  if (pack?.stale) return 'outdated';
  return 'pending';
}

export function createReviewService(store, currentPill = async () => ahuPill) {
  async function get(id) {
    const incident = (await store.list()).find(i => i.id === id);
    if (!incident) throw fail('Incident not found.', 404);
    const report = incident.triageReports?.at(-1);
    if (!report) throw fail('Run triage before reviewing this case.', 409);
    const pack = governancePackage(incident, report, await currentPill());
    return { incident, report, package: pack, state: reviewState(incident, pack) };
  }
  return {
    get,
    async list() {
      const activePill = await currentPill();
      return (await store.list()).filter(i => i.triageReports?.length).map(i => {
        const pack = governancePackage(i, i.triageReports.at(-1), activePill);
        return { id: i.id, title: i.title, asset: i.asset, location: i.location, priority: i.priority, reportStatus: i.triageReports.at(-1).status, state: reviewState(i, pack), submittedAt: i.triageReports.at(-1).createdAt, findings: pack.findings.length };
      }).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    },
    async submit(id, body) {
      if (!body || typeof body !== 'object') throw fail('Invalid review.');
      const { incident, report, package: pack } = await get(id);
      if (!Number.isInteger(body.revision) || body.revision !== (incident.revision || 0) || body.reportId !== report.id) throw fail('The case or report changed. Reload before submitting.', 409);
      if (incident.reviews?.some(r => r.reportId === report.id)) throw fail('This report has already been reviewed. Run a new analysis for another review.', 409);
      if (pack.stale) throw fail('Confirm intake and run a new analysis before reviewing.', 409);
      if (!decisions.includes(body.decision)) throw fail('Select a review decision.');
      const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
      if (!text(body.reviewer, 100) || !text(body.notes, 3000)) throw fail('Reviewer and decision notes are required.');
      if (!['accepted', 'partly_supported', 'unsupported'].includes(body.assessment)) throw fail('Record your assessment of the AI analysis.');
      const approving = ['approve', 'approve_with_changes'].includes(body.decision);
      if (approving && (!pack.canApprove || body.factsVerified !== true || body.assessment === 'unsupported')) throw fail('Resolve governance blockers and verify facts before approving.');
      if (body.decision === 'approve' && body.assessment !== 'accepted') throw fail('Use approval with changes for a partly supported analysis.');
      if (!Array.isArray(body.actions) || body.actions.some(a => !a || typeof a !== 'object') || body.actions.length !== pack.actions.length || new Set(body.actions.map(a => a.id)).size !== pack.actions.length) throw fail('Record a decision for each proposed action.');
      const actions = body.actions.map(a => {
        const original = pack.actions.find(item => item.id === a?.id);
        if (!original || !['accept', 'omit'].includes(a.choice)) throw fail('Invalid action decision.');
        if (a.choice === 'omit' && !text(a.reason, 1000)) throw fail('Explain omitted actions.');
        if (approving && a.choice === 'accept' && original.classification === 'prohibited') throw fail('Prohibited actions cannot be approved.');
        return { ...original, choice: a.choice, reason: a.choice === 'omit' ? a.reason.trim() : '' };
      });
      const proposals = body.proposals ?? '';
      if (approving && report.coordination?.required && (body.coordinationConfirmed !== true || !text(body.coordinationNotes, 2000) || !text(body.owner, 100))) throw fail('Confirm cross-Pill review, record reconciliation and assign an owner.');
      if (approving && actionConflicts(actions.filter(a => a.choice === 'accept')).length) throw fail('Conflicting actions cannot be approved together. Omit incompatible actions or escalate.');
      if (typeof proposals !== 'string' || proposals.length > 3000) throw fail('Action proposals must be at most 3000 characters.');
      if (body.decision === 'approve' && (proposals.trim() || actions.some(a => a.choice === 'omit'))) throw fail('Use approval with changes when changing the plan.');
      if (approving && !actions.some(a => a.choice === 'accept')) throw fail('Select at least one catalog action to approve.');
      if ((approving || body.decision === 'escalate') && !text(body.owner, 100)) throw fail('A responsible owner is required.');
      if (body.decision === 'request_information' && !text(body.questions, 2000)) throw fail('Specify the information required.');
      const review = { id: `REV-${randomUUID()}`, reportId: report.id, caseFingerprint: report.caseFingerprint, createdAt: new Date().toISOString(), reviewer: body.reviewer.trim(), identityVerified: false, assessment: body.assessment, factsVerified: body.factsVerified === true, decision: body.decision, notes: body.notes.trim(), owner: typeof body.owner === 'string' ? body.owner.trim().slice(0, 100) : '', questions: body.decision === 'request_information' ? body.questions.trim() : '', actions, proposals: proposals.trim(), proposalStatus: proposals.trim() ? 'pending_expert_validation' : null, governance: pack, executionAllowed: false, handoffStatus: approving ? 'advisory_plan_approved' : body.decision };
      if (report.coordination?.required) review.coordination = { confirmed: body.coordinationConfirmed === true, notes: typeof body.coordinationNotes === 'string' ? body.coordinationNotes.trim().slice(0, 2000) : '', conflicts: structuredClone(report.coordination.conflicts) };
      const candidate = { id: `FDB-${randomUUID()}`, reviewId: review.id, incidentId: id, reportId: report.id, pillId: pack.pillId, pillVersion: pack.pillVersion, createdAt: review.createdAt, status: 'pending_validation', notes: review.notes, assessment: review.assessment, proposals: review.proposals, omittedActions: actions.filter(a => a.choice === 'omit'), decision: review.decision };
      await store.update(id, { reviews: [...(incident.reviews || []), review], learningCandidates: [...(incident.learningCandidates || []), candidate], ...(body.decision === 'request_information' ? { status: 'needs_info' } : {}) }, body.revision);
      return review;
    }
  };
}
