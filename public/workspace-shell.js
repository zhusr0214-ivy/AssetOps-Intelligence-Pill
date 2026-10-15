const titles = { overview: 'Operations Overview', cases: 'Case Workspace', studio: 'Pill Studio', library: 'Pill Library', settings: 'Settings' };
const roles = { admin: 'Administrator', operator: 'Operator', expert: 'Expert', reviewer: 'Reviewer', viewer: 'Viewer' };

export function syncWorkspaceHeader(root, path, user) {
  const doc = root.ownerDocument;
  const title = doc.querySelector('#page-title');
  if (!title) return;
  const newCase = doc.querySelector('[data-new-case]');
  if (newCase) newCase.hidden = !user || !(path === '/cases' || path.startsWith('/cases/')) || path === '/cases/new';
  const newPill = doc.querySelector('[data-new-pill]');
  if (newPill) newPill.hidden = path !== '/studio' || !user?.roles?.some(role => ['admin', 'expert'].includes(role));
  const heading = root.querySelector('.workspace-heading');
  const source = heading?.querySelector('h2');
  const text = source?.textContent || (['/overview/analytics', '/studio/analytics'].includes(path) ? 'Operational analytics' : titles[path.split('/')[1]]) || 'Workspace';
  if (title.textContent !== text) title.textContent = text;
  if (source) {
    source.hidden = true;
    heading.classList.add('page-heading-source');
  }
  const context = doc.querySelector('.context');
  if (!context) return;
  context.hidden = !user;
  const values = {
    '[data-account-role]': user?.roles?.includes('admin') ? 'Administrator' : (user?.roles || []).map(role => roles[role] || role).join(', '),
    '[data-account-username]': user?.username || user?.name || ''
  };
  for (const [selector, value] of Object.entries(values)) {
    const element = context.querySelector(selector);
    if (element && element.textContent !== value) element.textContent = value;
  }
}
