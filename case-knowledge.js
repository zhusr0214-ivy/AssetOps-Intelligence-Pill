import { matchedPills } from './pill-routing.js';

const stop = new Set('a an the is are was were i we you it to of for in on at do does should can could would please what how why need more'.split(' '));
const groups = [['restart','reboot','reset'],['light','lights','lighting','lamp'],['cool','cooling','aircon','hvac'],['outage','blackout','power'],['flicker','flickering'],['leak','leaking','dripping']];
function terms(text) {
  const words = new Set(String(text || '').toLowerCase().match(/[a-z0-9_-]+/g)?.filter(w => !stop.has(w)) || []);
  for (const group of groups) if (group.some(w => words.has(w))) group.forEach(w => words.add(w));
  return words;
}
function relevance(query, text) {
  const words = terms(text);
  return [...query].reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
}

// Category/asset restrictions remain hard gates; lexical scores only rank candidates.
export function retrieveCaseKnowledge(facts, pills, question) {
  const query = terms(question), context = terms([facts.asset, facts.description, facts.observations].join(' '));
  return matchedPills(facts, pills).map(match => {
    const p = match.pill;
    const entries = [
      ...(p.rules || []).map(rule => ({ kind: 'rule', id: rule.id, text: [rule.title, rule.guidance].join(' ') })),
      ...(p.actions || []).map(action => ({ kind: 'action', id: action.id, text: [action.title, action.instruction].join(' ') }))
    ].map(entry => ({ ...entry, score: 4 * relevance(query, entry.text) + relevance(context, entry.text) })).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
    const selected = entries.slice(0, 6);
    const ruleIds = new Set(selected.filter(e => e.kind === 'rule').map(e => e.id));
    const actionIds = new Set(selected.filter(e => e.kind === 'action').map(e => e.id));
    // Keep linked conditions/actions so ranking never strips an action's prerequisites.
    let changed;
    do {
      const before = ruleIds.size + actionIds.size;
      for (const r of p.rules || []) if (ruleIds.has(r.id) || (r.actionIds || []).some(id => actionIds.has(id))) {
        ruleIds.add(r.id); (r.actionIds || []).forEach(id => actionIds.add(id));
      }
      for (const a of p.actions || []) if (actionIds.has(a.id) || (a.ruleIds || []).some(id => ruleIds.has(id))) {
        actionIds.add(a.id); (a.ruleIds || []).forEach(id => ruleIds.add(id));
      }
      changed = before !== ruleIds.size + actionIds.size;
    } while (changed);
    return { ...match, score: (entries[0]?.score || 0) + 2 * relevance(query, `${p.name} ${p.scope}`),
      entries: entries.filter(e => e.kind === 'rule' ? ruleIds.has(e.id) : actionIds.has(e.id)) };
  }).sort((a,b) => b.score-a.score || a.pill.id.localeCompare(b.pill.id));
}

export function assessKnowledgeCoverage(value, sources, citations) {
  if (value == null) return { status: 'unassessed', intent: 'unknown', reason: 'Question-level coverage was not assessed.', evidence: [], missingFacts: [] };
  const fail = () => { throw Object.assign(new Error('Invalid question-level Pill coverage. Retry the message.'), {status:502}); };
  if (!['supported','partial','unsupported'].includes(value.status) || !['general','clarification','operation'].includes(value.intent) || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000 || !Array.isArray(value.evidence) || value.evidence.length > 16 || !Array.isArray(value.missingFacts) || value.missingFacts.length > 12 || value.missingFacts.some(s => typeof s !== 'string' || !s.trim() || s.length > 300)) fail();
  const evidence = value.evidence.map(ref => {
    const source = sources.find(s => s.sourceId === ref?.sourceId && s.kind === 'pill' && ['rule','action'].includes(s.entryKind));
    if (!source || typeof ref.quote !== 'string' || !ref.quote.trim() || ref.quote.length > 1600 || !source.text.includes(ref.quote)) fail();
    return {sourceId:source.sourceId,quote:ref.quote,pillId:source.pillId,version:source.version,entryKind:source.entryKind};
  });
  if (value.status !== 'unsupported' && !evidence.length) fail();
  if (value.status === 'supported' && (value.missingFacts.length || !evidence.some(e => citations.some(c => c.sourceId === e.sourceId)))) fail();
  if (value.status === 'supported' && value.intent === 'operation' && !evidence.some(e => e.entryKind === 'action')) fail();
  return {status:value.status,intent:value.intent,reason:value.reason.trim(),evidence,missingFacts:value.missingFacts};
}
