export function canonicalPath(path) {
  const clean = path.length > 1 ? path.replace(/\/$/, '') : path;
  if (clean === '/' || clean === '/dashboard') return '/overview';
  if (clean === '/governance') return '/studio';
  if (clean === '/learning') return '/studio/improvements';
  if (clean === '/incidents') return '/cases';
  if (clean.startsWith('/incidents/')) return clean.replace('/incidents/', '/cases/');
  for (const stage of ['triage', 'review']) {
    if (clean === `/${stage}`) return `/cases/${stage}`;
    if (clean.startsWith(`/${stage}/`)) return `/cases/${clean.slice(stage.length + 2)}/${stage}`;
  }
  return clean;
}
export function caseRoute(path) {
  const canonical = canonicalPath(path);
  if (canonical === '/cases') return { stage: 'intake', legacy: '/incidents' };
  if (canonical === '/cases/new') return { stage: 'intake', legacy: '/incidents/new' };
  if (canonical === '/cases/triage') return { stage: 'triage', legacy: '/triage' };
  if (canonical === '/cases/review') return { stage: 'review', legacy: '/review' };
  const match = canonical.match(/^\/cases\/([^/]+)(?:\/(edit|triage|review|handling))?$/);
  if (!match) return null;
  const [, id, stage] = match;
  return { id, stage: ['triage', 'review', 'handling'].includes(stage) ? stage : 'intake', legacy: stage === 'triage' || stage === 'review' ? `/${stage}/${id}` : `/incidents/${id}${stage === 'edit' ? '/edit' : ''}` };
}
