const fail = message => Object.assign(new Error(message), { status: 422 });

export function mergeKnowledge(record, document, body) {
  if (body.confirmed !== true || typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.length > 120) throw fail('Confirm the source review and enter a reviewer name.');
  if (!Array.isArray(body.selections) || body.selections.length > document.candidates.length || new Set(body.selections.map(v => v?.id)).size !== body.selections.length) throw fail('Invalid candidate selection.');
  const content = structuredClone(record.content);
  const selected = new Map();
  for (const value of body.selections) {
    const candidate = document.candidates.find(c => c.id === value?.id);
    if (!candidate || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000) throw fail('Selected candidates must contain text up to 2000 characters.');
    selected.set(candidate.id, { ...candidate, text: value.text.trim() });
  }
  const targets = new Map([...selected.values()].map(c => [c.id, `CAP-${c.id.slice(2)}`]));
  for (const c of selected.values()) {
    if (['action', 'example'].includes(c.type) && c.relatedRuleIds.some(id => !selected.has(id))) throw fail(`Select the related rule candidates for "${c.title}" or omit this candidate.`);
    if (c.type === 'example' && c.relatedActionIds.some(id => !selected.has(id))) throw fail(`Select the related action candidates for "${c.title}" or omit this example.`);
    if (c.type === 'scope') content.pill.scope = [content.pill.scope, c.text].filter(Boolean).join('\n');
    if (c.type === 'boundary') content.pill.boundaries.push(c.text);
    if (c.type === 'escalation') content.pill.escalationConditions.push(c.text);
    if (c.type === 'rule') content.pill.rules.push({ id: targets.get(c.id), title: c.title, guidance: c.text, cardExplanation: c.text, actionIds: c.relatedActionIds.filter(id => selected.has(id)).map(id => targets.get(id)) });
    if (c.type === 'action') content.pill.actions.push({ id: targets.get(c.id), title: c.title, instruction: c.text, owner: '', requiresApproval: true, ruleIds: c.relatedRuleIds.map(id => targets.get(id)) });
    if (c.type === 'example') content.examples.push({ scenario: c.text, rationale: '', ruleIds: c.relatedRuleIds.map(id => targets.get(id)), actionIds: c.relatedActionIds.map(id => targets.get(id)) });
  }
  if (selected.size) {
    const knowledge = [...selected.values()].map(c => `${c.title}: ${c.text}\n${c.evidence.map(ref => `${ref.location}: ${ref.quote}`).join('\n')}`).join('\n\n');
    if (knowledge.length > 8000) throw fail('Selected knowledge exceeds one source entry (8000 characters). Select fewer candidates or split the source.');
    content.sources.push({ expert: `Reviewed by ${body.reviewer.trim()}`, reference: `${document.name} / ${document.id} / SHA256 ${document.sha256}`, knowledge });
    if (!content.pill.source) content.pill.source = `Extracted from ${document.name}; reviewed by ${body.reviewer.trim()}.`;
  }
  if (content.pill.scope.length > 4000) throw fail('The combined scope exceeds 4000 characters. Select fewer scope entries.');
  for (const values of [content.pill.rules, content.pill.actions, content.sources, content.examples]) if (values.length > 20) throw fail('This merge exceeds the draft limit of 20 entries per section. Select fewer candidates.');
  for (const values of [content.pill.boundaries, content.pill.escalationConditions]) if (values.length > 30) throw fail('This merge exceeds the boundary or escalation limit.');
  const decisions = document.candidates.map(candidate => ({ id: candidate.id, type: candidate.type, decision: selected.has(candidate.id) ? 'accepted' : 'rejected', originalText: candidate.text, reviewedText: selected.get(candidate.id)?.text || '', targetId: selected.has(candidate.id) ? targets.get(candidate.id) : null, evidence: candidate.evidence }));
  return { content, review: { documentId: document.id, filename: document.name, sha256: document.sha256, reviewer: body.reviewer.trim(), identityVerified: false, reviewedAt: new Date().toISOString(), decisions, questions: document.questions, conflicts: document.conflicts, promptVersion: document.promptVersion, model: document.model } };
}
