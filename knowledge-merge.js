const fail = message => Object.assign(new Error(message), { status: 422 });

export function mergeKnowledge(record, document, body) {
  if (body.confirmed !== true || typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.length > 120) throw fail('Confirm the source review and enter a reviewer name.');
  if (!Array.isArray(body.selections) || body.selections.length > document.candidates.length || new Set(body.selections.map(v => v?.id)).size !== body.selections.length) throw fail('Invalid candidate selection.');
  if(body.actionOwner !== undefined && (typeof body.actionOwner!=='string'||body.actionOwner.length>120)) throw fail('Responsible role must contain up to 120 characters.');
  const content = structuredClone(record.content);
  const selected = new Map();
  for (const value of body.selections) {
    const candidate = document.candidates.find(c => c.id === value?.id);
    if (!candidate || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000) throw fail('Selected candidates must contain text up to 2000 characters.');
    if(value.replaceId && !document.repairTargets?.some(t=>t.id===value.replaceId && t.type===candidate.type)) throw fail('Choose a valid existing item from this source to update.');
    for(const [field,type,items] of [['existingRuleIds','rule',content.pill.rules],['existingActionIds','action',content.pill.actions]])for(const id of candidate[field]||[])if(!document.repairTargets?.some(t=>t.id===id&&t.type===type)||!items.some(v=>v.id===id))throw fail('Referenced reviewed knowledge changed. Re-extract before merging.');
    selected.set(candidate.id, { ...candidate, text: value.text.trim(), replaceId:value.replaceId||null });
  }
  const targets = new Map([...selected.values()].map(c=>[c.id,c.replaceId || `CAP-${c.id.slice(2)}`]));
  if(new Set(targets.values()).size!==targets.size) throw fail('Two selected proposals update the same item. Keep one proposal or add it as new knowledge.');
  // Replace only explicitly selected items; remove obsolete reciprocal edges first.
  for(const c of selected.values()) if(c.replaceId && ['rule','action'].includes(c.type)) {
    const list=c.type==='rule'?content.pill.rules:content.pill.actions;
    if(!list.some(item=>item.id===c.replaceId)) throw fail('The item to update no longer exists. Reload the source review.');
    const other=c.type==='rule'?content.pill.actions:content.pill.rules,key=c.type==='rule'?'ruleIds':'actionIds';
    for(const item of other)item[key]=item[key].filter(id=>id!==c.replaceId);
  }
  const upsert = (list,item) => {const at=list.findIndex(v=>v.id===item.id);if(at<0)list.push(item);else list[at]={...list[at],...item};};
  for (const c of selected.values()) {
    if (['action', 'example'].includes(c.type) && c.relatedRuleIds.some(id => !selected.has(id))) throw fail(`Select the related rule candidates for "${c.title}" or omit this candidate.`);
    if (c.type === 'example' && c.relatedActionIds.some(id => !selected.has(id))) throw fail(`Select the related action candidates for "${c.title}" or omit this example.`);
    const previous=c.replaceId ? document.repairTargets.find(t=>t.id===c.replaceId) : null;
    if(c.type==='scope') {
      if(previous){if(content.pill.scope.split(previous.text).length!==2)throw fail('The scope changed. Reload before applying this correction.');content.pill.scope=content.pill.scope.replace(previous.text,c.text);}
      else if(!content.pill.scope.includes(c.text))content.pill.scope=[content.pill.scope,c.text].filter(Boolean).join('\n');
    }
    if(['boundary','escalation'].includes(c.type)) {
      const values=content.pill[c.type==='boundary'?'boundaries':'escalationConditions'];
      if(previous){const at=values.indexOf(previous.text);if(at<0)throw fail('The operating limit changed. Reload before applying this correction.');values[at]=c.text;}
      else if(!values.includes(c.text))values.push(c.text);
    }
    if (c.type === 'rule') upsert(content.pill.rules, { id: targets.get(c.id), title: c.title, guidance: c.text, cardExplanation: c.text, actionIds: [...c.relatedActionIds.filter(id => selected.has(id)).map(id => targets.get(id)),...(c.existingActionIds||[])] });
    if (c.type === 'action') upsert(content.pill.actions, { id: targets.get(c.id), title: c.title, instruction: c.text, owner: c.owner?.trim() || body.actionOwner?.trim() || '待确认', requiresApproval: true, ruleIds: [...c.relatedRuleIds.map(id => targets.get(id)),...(c.existingRuleIds||[])] });
    if (c.type === 'example') content.examples.push({ scenario: c.text, rationale: '', ruleIds: [...c.relatedRuleIds.map(id => targets.get(id)),...(c.existingRuleIds||[])], actionIds: [...c.relatedActionIds.map(id => targets.get(id)),...(c.existingActionIds||[])] });
  }
  // Canonical links describe the reviewed result, including unchanged items.
  for(const rule of content.pill.rules) for(const id of rule.actionIds) {const action=content.pill.actions.find(a=>a.id===id);if(action&&!action.ruleIds.includes(rule.id))action.ruleIds.push(rule.id);}
  for(const action of content.pill.actions) for(const id of action.ruleIds) {const rule=content.pill.rules.find(r=>r.id===id);if(rule&&!rule.actionIds.includes(action.id))rule.actionIds.push(action.id);}
  if (selected.size) {
    const knowledge = [...selected.values()].map(c => `${c.title}: ${c.text}\n${c.evidence.map(ref => `${ref.location}: ${ref.quote}`).join('\n')}`).join('\n\n');
    if (knowledge.length > 8000) throw fail('Selected knowledge exceeds one source entry (8000 characters). Select fewer candidates or split the source.');
    content.sources.push({ expert: `Reviewed by ${body.reviewer.trim()}`, reference: `${document.name} / ${document.id} / SHA256 ${document.sha256}`, knowledge });
    if (!content.pill.source) content.pill.source = `Extracted from ${document.name}; reviewed by ${body.reviewer.trim()}.`;
  }
  if (content.pill.scope.length > 4000) throw fail('The combined scope exceeds 4000 characters. Select fewer scope entries.');
  for (const values of [content.pill.rules, content.pill.actions, content.sources, content.examples]) if (values.length > 20) throw fail('This merge exceeds the draft limit of 20 entries per section. Select fewer candidates.');
  for (const values of [content.pill.boundaries, content.pill.escalationConditions]) if (values.length > 30) throw fail('This merge exceeds the boundary or escalation limit.');
  const decisions = document.candidates.map(candidate => ({ id: candidate.id, title:candidate.title, type: candidate.type, decision: selected.has(candidate.id) ? 'accepted' : 'rejected', originalText: candidate.text, reviewedText: selected.get(candidate.id)?.text || '', targetId: selected.has(candidate.id) ? targets.get(candidate.id) : null, evidence: candidate.evidence, change:selected.get(candidate.id)?.replaceId ? 'updated' : 'added' }));
  return { content, review: { documentId: document.id, filename: document.name, sha256: document.sha256, reviewer: body.reviewer.trim(), identityVerified: Boolean(body.authenticatedActor), actorId: body.authenticatedActor?.id || null, reviewedAt: new Date().toISOString(), decisions, questions: document.questions, conflicts: document.conflicts, promptVersion: document.promptVersion, model: document.model } };
}
