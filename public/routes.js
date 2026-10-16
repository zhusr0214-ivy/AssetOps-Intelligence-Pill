export function canonicalPath(path) {
  const clean = path.length > 1 ? path.replace(/\/$/, '') : path;
  if (['/', '/dashboard', '/overview'].includes(clean)) return '/studio';
  if (clean === '/overview/analytics' || clean === '/learning') return '/studio';
  if (clean === '/governance') return '/studio';
  if (clean === '/studio/new/upload' || clean === '/studio/new/expert') return '/studio/new';
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
  if (canonical === '/cases/tasks') return { stage: 'tasks' };
  const match = canonical.match(/^\/cases\/([^/]+)(?:\/(edit|triage|review|handling|tasks))?$/);
  if (!match) return null;
  const [, id, stage] = match;
  return { id, stage: ['triage', 'review', 'handling', 'tasks'].includes(stage) ? stage : 'intake', legacy: stage === 'triage' || stage === 'review' ? `/${stage}/${id}` : `/incidents/${id}${stage === 'edit' ? '/edit' : ''}` };
}
