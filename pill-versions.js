import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const libraryToken = records => createHash('sha256').update(JSON.stringify(records.map(r => [r.id, r.revision, r.releases.map(v => [v.pill.version, v.active, Boolean(v.disabled)])]))).digest('hex');
export const releaseContent = release => ({ ...(release.evaluation ? { evaluation: release.evaluation } : {}), pill: release.pill, sources: release.sources || [], examples: release.examples || [], captureHistory: release.captureHistory || [], learningImports: release.learningImports || [], validation: release.validation, reviewer: release.reviewer, identityVerified: release.identityVerified, notes: release.notes, publishedAt: release.publishedAt });
export const releaseHash = release => createHash('sha256').update(JSON.stringify(canonical(releaseContent(release)))).digest('hex');

export function compareReleases(before, after) {
  const changes = [];
  const add = (section, key, a, b) => { if (!equal(a, b)) changes.push({ section, key, type: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified', before: a ?? null, after: b ?? null }); };
  for (const key of ['name', 'owner', 'source', 'scope', 'domain', 'applicability']) add('Capability', key, before.pill[key], after.pill[key]);
  for (const section of ['rules', 'actions']) {
    const a = new Map((before.pill[section] || []).map(v => [v.id, v])), b = new Map((after.pill[section] || []).map(v => [v.id, v]));
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      if (!a.has(id) || !b.has(id)) add(section, id, a.get(id), b.get(id));
      else for (const key of new Set([...Object.keys(a.get(id)), ...Object.keys(b.get(id))])) add(section, `${id}.${key}`, a.get(id)[key], b.get(id)[key]);
    }
  }
  for (const key of ['boundaries', 'escalationConditions']) add('Safety', key, before.pill[key], after.pill[key]);
  for (const key of ['sources', 'examples', 'captureHistory', 'learningImports']) add('Evidence', key, before[key] || [], after[key] || []);
  add('Evidence', 'evaluation', before.evaluation, after.evaluation);
  return { from: before.pill.version, to: after.pill.version, changes, counts: Object.fromEntries(['added', 'removed', 'modified'].map(type => [type, changes.filter(c => c.type === type).length])) };
}
