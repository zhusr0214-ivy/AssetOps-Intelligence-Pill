import { createHash } from 'node:crypto';

export function feedbackEvidence(incident) {
  return [
    ...(incident.messages || []).filter(m => m.role === 'user' && m.state !== 'failed').map(m => ({ id: m.id, kind: 'user_report', text: m.content })),
    ...(incident.humanConfirmations || []).map(c => ({ id: c.id, kind: 'human_confirmation', text: c.decision ? `Decision: ${c.decision}\nSubject: ${c.requestSubject}\nRationale: ${c.subject}\nThis is not evidence of execution.` : c.subject })),
    ...(incident.expertSolutions || []).map(s => ({ id: s.id, kind: 'proposed_expert_solution_not_execution', text: s.solution })),
    ...(incident.handlingRecords || []).map(r => ({ id: r.id, kind: `legacy_${r.kind}`, text: r.notes }))
  ].filter(b => b.id && b.text);
}

export function feedbackKey(incident) {
  return createHash('sha256').update(JSON.stringify({ evidence: feedbackEvidence(incident), description: incident.description, observations: incident.observations, actionsTaken: incident.actionsTaken })).digest('hex');
}

export function validateCaseFeedback(value, evidence) {
  const fail = () => { throw Object.assign(new Error('Invalid result summary or unsupported evidence. Retry the reply.'), { status: 502 }); };
  if (!value || !['summary', 'actions', 'remaining', 'feedback'].every(k => typeof value[k] === 'string' && value[k].length <= 3000) || !value.summary.trim() || !['not_reported', 'in_progress', 'reported_resolved', 'reported_unresolved'].includes(value.outcome) || !Array.isArray(value.evidence) || value.evidence.length > 12) fail();
  const refs = value.evidence.map(ref => {
    const block = evidence.find(b => b.id === ref?.id);
    if (!block || typeof ref.quote !== 'string' || !ref.quote.trim() || ref.quote.length > 1600 || !block.text.includes(ref.quote)) fail();
    return { id: block.id, kind: block.kind, quote: ref.quote };
  });
  if (value.outcome !== 'not_reported' && !refs.some(r => ['user_report', 'legacy_outcome'].includes(r.kind))) fail();
  return { summary: value.summary.trim(), actions: value.actions.trim(), remaining: value.remaining.trim(), feedback: value.feedback.trim(), outcome: value.outcome, evidence: refs, verified: false, generatedAt: new Date().toISOString() };
}
