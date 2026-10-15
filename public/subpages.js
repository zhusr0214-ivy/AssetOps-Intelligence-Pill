import { escapeHtml as e } from './incidents.js';
import { canonicalPath } from './routes.js';

export function workspaceLinks(path, admin = false) {
  if (path === '/settings') return [];
  if (path.startsWith('/cases')) {
    return [];
  }
  if (path.startsWith('/studio')) {
    const links = [['/studio', 'Knowledge & drafts'], ['/studio/new', 'Create Pill'], ['/studio/improvements', 'Improvement queue'], ['/studio/analytics', 'Operational analytics']];
    if (/^\/studio\/[^/]+$/.test(path) && !['/studio/improvements', '/studio/new', '/studio/analytics'].includes(path)) links.push(...[['draft', 'Draft content'], ['sources', 'Sources & learning'], ['evaluation', 'Model evaluation'], ['publication', 'Review & publish'], ['history', 'Change history']].map(([key, label]) => [`${path}?view=${key}`, label]));
    return links;
  }
  if (path.startsWith('/library')) {
    const match = path.match(/^\/library\/([^/]+)/);
    const base = path.includes('/versions/') ? path : match ? `/library/${match[1]}` : '/library';
    return [['/library', 'Approved Pills'], ...(match ? [[base, 'Pill content'], [`${base}?view=versions`, 'Versions & management'], [`${base}?view=evidence`, 'Sources & evaluation'], [`/library/${match[1]}/compare`, 'Compare versions']] : [])];
  }
  return [['/settings', 'My account'], ...(admin ? [['/settings?view=users', 'Users & roles']] : [])];
}

export function navigationMarkup(modules, path) {
  const active = path.split('/')[1];
  const icons = { overview: 'chart-no-axes-combined', cases: 'clipboard-list', studio: 'flask-conical', library: 'library', settings: 'settings' };
  const visible = modules.filter(module => module.id !== 'overview');
  visible.sort((a, b) => ['studio', 'library', 'cases'].indexOf(a.id) - ['studio', 'library', 'cases'].indexOf(b.id));
  return [...visible, { id: 'settings', title: 'Settings' }].map(module =>
    `<a href="/${e(module.id)}" class="nav-item${module.id === active ? ' active' : ''}"${module.id === active ? ' aria-current="page"' : ''}><img class="nav-icon" src="/icons/${icons[module.id] || 'library'}.svg" width="24" height="24" alt="" aria-hidden="true"><span class="nav-label">${e(module.title)}</span></a>`
  ).join('');
}

export function pageTabsMarkup(path, search = '', admin = false) {
  let links = workspaceLinks(path, admin);
  if (/^\/studio\/[^/]+$/.test(path) && !['/studio/improvements', '/studio/new', '/studio/analytics'].includes(path)) links = links.filter(([href]) => href.includes('?view='));
  if (path.startsWith('/library/')) links = links.filter(([href]) => href !== '/library');
  const fallback = path.startsWith('/studio') ? 'draft' : path.startsWith('/library') ? 'content' : 'account';
  const value = new URLSearchParams(search).get('view');
  const requested = path === '/settings' && (!admin || value !== 'users') ? 'account' : value || fallback;
  const current = path.startsWith('/cases/') ? path.replace(/\/(edit|triage)$/, '').replace(/\/tasks$/, '/handling') : path;
  if (!links.length) return '';
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
  if (!template.content.firstElementChild) {
    root.querySelectorAll('[data-page-tabs]').forEach(el => el.remove());
    return;
  }
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
    const canonical = canonicalPath(url.pathname);
    const path = /^\/cases\/[^/]+\/(triage|tasks)$/.test(canonical) ? canonical.replace(/\/triage$/, '').replace(/\/tasks$/, '/handling') : canonical;
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
