import { detectCaseOperations } from './case-operation-policy.js';
const fail = message => Object.assign(new Error(message), { status: 502 });
const kinds = ['knowledge_gap', 'scope', 'conflict', 'approval', 'safety', 'expert_requested'];

// Model judgments supplement, but cannot clear, server-owned action restrictions.
export function assessCaseSupervision(proposed, { sources, pills, latestText = '' }) {
  let request = null;
  if (proposed.supervision != null) {
    const value = proposed.supervision;
    if (typeof value.required !== 'boolean') throw fail('Invalid supervision request.');
    if (value.required) {
      if (!kinds.includes(value.kind) || typeof value.subject !== 'string' || !value.subject.trim() || value.subject.length > 2000 || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) throw fail('Invalid supervision details.');
      request = { required: true, kind: value.kind, subject: value.subject.trim(), reason: value.reason.trim() };
    }
  }
  const cited = new Set(proposed.citations.map(c => c.sourceId));
  const approvalSources = sources.filter(s => cited.has(s.sourceId) && s.requiresApproval);
  if (approvalSources.length && (!request || request.kind === 'approval')) request = { required: true, kind: 'approval', subject: approvalSources.map(s => s.actionTitle).join('; ').slice(0, 2000), reason: 'The cited Pill action requires human review before use.' };
  if (request?.kind === 'approval' && !approvalSources.length) request = { ...request, kind: 'scope', reason: `${request.reason}\nNo validated Pill approval action is cited; expert judgment is required first.`.slice(0, 2000) };
  if (!request && /(?:请|需要|找).{0,8}(?:专家|人工).{0,8}(?:确认|介入|判断)|(?:ask|need|request).{0,20}(?:an?\s+)?(?:expert|human)\s+(?:review|confirmation|help)/i.test(latestText)) request = { required: true, kind: 'expert_requested', subject: 'Requested expert review', reason: 'The user explicitly requested human expertise.' };
  if (!request && proposed.expertRequest.required) request = { required: true, kind: 'knowledge_gap', subject: proposed.expertRequest.reason, reason: proposed.expertRequest.reason };
  const operations = detectCaseOperations(latestText);
  // Inspect direct operational advice as well as the user request: model output
  // cannot introduce an unreviewed high-impact operation into an ordinary query.
  const advised = detectCaseOperations(proposed.answer || '');
  const risks = [...operations, ...advised];
  if (request?.kind === 'approval' && risks.some(r => !approvalSources.some(s => detectCaseOperations(s.actionTitle || '').some(a => a.kind === r.kind)))) request = { required: true, kind: 'scope', subject: [...new Set(risks.map(r => r.label))].join('; '), reason: 'The cited approval action does not cover all proposed operation categories. Expert assessment is required before reviewing an operational recommendation.' };
  if (risks.some(r => r.kind === 'safety')) request = { required: true, kind: 'safety', subject: 'Safety protection changes', reason: 'Changing safety protection requires escalation to the responsible qualified team. Chat approval cannot authorize this operation.' };
  else if (risks.length && !request) request = { required: true, kind: pills.length ? 'scope' : 'knowledge_gap', subject: [...new Set(risks.map(r => r.label))].join('; '), reason: pills.length ? 'This high-impact operation needs expert verification of the Pill coverage, equipment conditions and authority. A matching Pill alone does not authorize the operation.' : 'No applicable approved Pill supports this high-impact operation. An expert must assess the conditions and provide a suitable proposal before proceeding.' };
  if (!request) return null;
  return { ...request, operationCategories: [...new Set(risks.map(r => r.kind))], mode: ['knowledge_gap', 'scope', 'conflict', 'expert_requested'].includes(request.kind) ? 'expert' : request.kind === 'safety' ? 'escalation' : 'review', pillVersions: pills.map(p => ({ id: p.id, version: p.version })), advisoryOnly: true };
}
