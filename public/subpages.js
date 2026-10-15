import { escapeHtml as e } from './incidents.js';
import { caseRoute, canonicalPath } from './routes.js';

export function workspaceLinks(path, admin = false) {
  path=canonicalPath(path);
  if (path.startsWith('/overview')) return [['/overview', 'Summary'], ['/overview/analytics', 'Operational analytics']];
  if (path.startsWith('/cases')) {
    const route = caseRoute(path), base = route?.id ? `/cases/${route.id}` : '/cases';
    return [[base, route?.id ? 'Case information' : 'All cases'], ...(!route?.id ? [['/cases/new', 'New case']] : []), [`${base}/triage`, 'AI analysis'], [`${base}/review`, 'Human review'], [`${base}/tasks`, 'Tasks'], ...(route?.id ? [[`${base}/handling`, 'Handling & outcome']] : [])];
  }
  if (path.startsWith('/studio')) {
    const links = [['/studio', 'Knowledge & drafts'], ['/studio/new', 'Create Pill'], ['/studio/improvements', 'Improvement queue']];
    if (/^\/studio\/[^/]+$/.test(path) && !['/studio/improvements', '/studio/new'].includes(path)) links.push(...[['draft', '1 · Prepare knowledge'], ['evaluation', '2 · Validate recommendations'], ['publication', '3 · Review & release']].map(([key, label]) => [`${path}?view=${key}`, label]));
    return links;
  }
  if (path.startsWith('/library')) {
    const match = path.match(/^\/library\/([^/]+)/);
    const base = path.includes('/versions/') ? path : match ? `/library/${match[1]}` : '/library';
    return [['/library', 'Approved Pills'], ...(match ? [[base, 'Pill content'], [`${base}?view=versions`, 'Versions & management'], [`${base}?view=evidence`, 'Sources & evaluation'], [`/library/${match[1]}/compare`, 'Compare versions']] : [])];
  }
  return [['/settings', 'My account'], ...(admin ? [['/settings?view=users', 'Users & roles'], ['/settings?view=runtime', 'Runtime & backups'], ['/settings?view=audit', 'Audit history']] : [])];
}

export function navigationMarkup(modules, path) {
  const active = path.split('/')[1];
  const icons = { overview: 'chart-no-axes-combined', cases: 'clipboard-list', studio: 'flask-conical', library: 'library', settings: 'settings' };
  return [...modules, { id: 'settings', title: 'Account & System' }].map(module =>
    `<a href="/${e(module.id)}" class="nav-item${module.id === active ? ' active' : ''}"${module.id === active ? ' aria-current="page"' : ''}><img class="nav-icon" src="/icons/${icons[module.id] || 'library'}.svg" width="24" height="24" alt="" aria-hidden="true"><span class="nav-label">${e(module.title)}</span></a>`
  ).join('');
}

export function pageTabsMarkup(path, search = '', admin = false) {
  path=canonicalPath(path);
  let links = workspaceLinks(path, admin);
  if (/^\/studio\/[^/]+$/.test(path) && !['/studio/improvements', '/studio/new'].includes(path)) links = links.filter(([href]) => href.includes('?view='));
  if (path.startsWith('/library/')) links = links.filter(([href]) => href !== '/library');
  const fallback = path.startsWith('/studio') ? 'draft' : path.startsWith('/library') ? 'content' : 'account';
  const rawView = new URLSearchParams(search).get('view') || fallback;
  const requested = path.startsWith('/studio/') && rawView === 'sources' ? 'draft' : rawView;
  const current = path.endsWith('/edit') && path.startsWith('/cases/') ? path.slice(0, -5) : path;
  return `<nav class="workspace-tabs" data-page-tabs aria-label="Workspace views">${links.map(([href, label]) => {
    const [target, query] = href.split('?');
    const selected = target === current && (new URLSearchParams(query).get('view') || fallback) === requested;
    return `<a href="${e(href)}"${selected ? ' aria-current="page"' : ''}>${e(label)}</a>`;
  }).join('')}</nav>`;
}

export function syncPageTabs(root, path, search, admin) {
  const heading = root.querySelector('.workspace-heading');
  if (!heading) return;
  root.querySelectorAll('.workspace-tabs:not([data-page-tabs])').forEach(el => el.remove());
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = pageTabsMarkup(path, search, admin);
  const markup = template.content.firstElementChild.outerHTML;
  removeDuplicateNavigation(root, template.content.firstElementChild);
  const existing = root.querySelector('[data-page-tabs]');
  // Renderers can repaint their contents after a save; keep exactly one tab bar.
  if (existing?.outerHTML === markup) return;
  if (existing) existing.outerHTML = markup;
  else heading.insertAdjacentHTML('afterend', markup);
}

export function removeDuplicateNavigation(root, tabs) {
  const key = href => {
    const url = new URL(href, 'http://workspace.local');
    const path = canonicalPath(url.pathname);
    const defaultView = path.startsWith('/studio/') ? 'draft' : path.startsWith('/library/') ? 'content' : path === '/settings' ? 'account' : null;
    if (url.searchParams.get('view') === defaultView) url.searchParams.delete('view');
    url.searchParams.sort();
    return path + (url.searchParams.size ? `?${url.searchParams}` : '') + url.hash;
  };
  const destinations = new Set([...tabs.querySelectorAll('a')].map(a => key(a.getAttribute('href'))));
  // Only navigation chrome is deduplicated; record links, citations and commands remain intact.
  const selector = '.workspace-heading a, .detail-meta a, .form-actions > a, .actions > a, .next-step > a, a.back-link, .triage-report > a, [data-page-panel="publication"] > a';
  root.querySelectorAll(selector).forEach(link => {
    if (!link.hasAttribute('download') && destinations.has(key(link.getAttribute('href')))) link.remove();
  });
  const backTargets = new Set([...root.querySelectorAll('a.back-link')].map(a => key(a.getAttribute('href'))));
  root.querySelectorAll('.workspace-view > .workspace-heading a').forEach(a => { if (backTargets.has(key(a.getAttribute('href')))) a.remove(); });
  const headerTargets = new Set([...root.querySelectorAll('.workspace-heading a')].map(a => key(a.getAttribute('href'))));
  root.querySelectorAll('.pill-footer a').forEach(a => { if (headerTargets.has(key(a.getAttribute('href')))) a.remove(); });
}

// Panels stay mounted so moving between views never discards unsaved form values.
export function selectSubview(root, search = '', fallback = 'draft') {
  const panels = [...root.querySelectorAll('[data-page-panel]')];
  const requested = new URLSearchParams(search).get('view') || fallback;
  const selected = panels.some(p => p.dataset.pagePanel.split(' ').includes(requested)) ? requested : fallback;
  for (const panel of panels) panel.hidden = !panel.dataset.pagePanel.split(' ').includes(selected);
  const first = panels.find(panel => !panel.hidden);
  for (const panel of panels) panel.classList.toggle('subpage-first', panel === first);
  return selected;
}
