import { createHash } from 'node:crypto';
import { categories } from './intake.js';

export function routingErrors(pill) {
  const errors = [];
  if (typeof pill.domain !== 'string' || !/^[a-z][a-z0-9_]{1,49}$/.test(pill.domain)) errors.push('Domain must be a lowercase identifier.');
  const r = pill.applicability;
  if (!r) return pill.domain === 'ahu_cooling' ? errors : [...errors, 'Non-AHU Pills require explicit applicability criteria.'];
  for (const key of ['categories', 'assetPrefixes', 'keywords']) {
    if (!Array.isArray(r[key]) || r[key].length > 20 || !r[key].every(v => typeof v === 'string' && v.trim() && v.length <= 120)) errors.push(`Invalid applicability ${key}.`);
  }
  if (!Array.isArray(r.categories) || !r.categories.length || !r.categories.every(v => categories.includes(v))) errors.push('Select at least one valid incident category.');
  return errors;
}

export function matchPill(incident, pill) {
  if (!pill) return null;
  const r = pill.applicability;
  if (!r) return (!pill.domain || pill.domain === 'ahu_cooling') && (incident.category === 'hvac_cooling' || incident.category === 'hvac' && /\bAHU\b/i.test(incident.asset || '')) ? ['Legacy AHU category/asset scope'] : null;
  if (routingErrors(pill).length || !r.categories.includes(incident.category)) return null;
  const prefix = r.assetPrefixes.find(v => (incident.asset || '').toLowerCase().startsWith(v.toLowerCase()));
  if (r.assetPrefixes.length && !prefix) return null;
  const text = [incident.description, incident.observations, incident.impact].join('\n').toLowerCase();
  const keyword = r.keywords.find(v => text.includes(v.toLowerCase()));
  if (r.keywords.length && !keyword) return null;
  return [`Category: ${incident.category}`, ...(prefix ? [`Asset prefix: ${prefix}`] : []), ...(keyword ? [`Keyword: ${keyword}`] : [])];
}

export function matchedPills(incident, value) {
  return (Array.isArray(value) ? value : value ? [value] : []).map(pill => ({ pill, reasons: matchPill(incident, pill) })).filter(v => v.reasons).sort((a, b) => a.pill.id.localeCompare(b.pill.id));
}

export const scopedId = (pill, id) => `${pill.id}::${id}`;
export function bundlePills(values) {
  const pills = [...values].sort((a, b) => a.id.localeCompare(b.id));
  if (!pills.length) return null;
  if (pills.length === 1) return structuredClone(pills[0]);
  const members = pills.map(p => ({ id: p.id, version: p.version, domain: p.domain || 'ahu_cooling' }));
  return {
    id: 'multi-pill-bundle', version: createHash('sha256').update(JSON.stringify(pills)).digest('hex').slice(0, 16),
    name: 'Coordinated domain analysis', domain: 'multi_domain', status: pills.every(p => p.status === 'approved') ? 'approved' : 'demo', members,
    owner: [...new Set(pills.map(p => p.owner))].join(' / '), source: 'Runtime bundle of individually published capabilities; not a separately published Pill.',
    scope: pills.map(p => `${p.name}: ${p.scope}`).join('\n'),
    rules: pills.flatMap(p => p.rules.map(r => ({ ...r, id: scopedId(p, r.id), actionIds: r.actionIds.map(id => scopedId(p, id)), sourcePillId: p.id, sourceVersion: p.version }))),
    actions: pills.flatMap(p => p.actions.map(a => ({ ...a, id: scopedId(p, a.id), ruleIds: a.ruleIds.map(id => scopedId(p, id)), sourcePillId: p.id, sourceVersion: p.version }))),
    boundaries: pills.flatMap(p => p.boundaries.map(v => `${p.name}: ${v}`)), escalationConditions: pills.flatMap(p => p.escalationConditions.map(v => `${p.name}: ${v}`))
  };
}

export function actionConflicts(actions) {
  const groups = new Map();
  for (const a of actions) if (a.coordinationKey && a.coordinationValue) groups.set(a.coordinationKey, [...(groups.get(a.coordinationKey) || []), a]);
  return [...groups].filter(([, group]) => new Set(group.map(a => a.coordinationValue)).size > 1).map(([key, group]) => ({ key, actionIds: group.map(a => a.id), values: [...new Set(group.map(a => a.coordinationValue))] }));
}
