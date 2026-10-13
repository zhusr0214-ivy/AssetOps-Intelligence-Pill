import { jumpToSection } from './navigation.js';
import { renderLibraryPage } from './library.js';
import { renderIncidents, escapeHtml as e, api } from './incidents.js';
import { renderTriage } from './triage.js';
import { renderReview } from './review.js';
import { renderStudio } from './studio.js';
import { renderHandling } from './learning.js';
import { renderTasks } from './tasks.js';
import { renderOperations } from './operations.js';
import { canonicalPath, caseRoute } from './routes.js';
import { requireSession, bindAccountIdentity, currentUser } from './session.js';
import { renderSettings } from './settings.js';
import { workQueueMarkup } from './workflow.js';
import { navigationMarkup, selectSubview, syncPageTabs } from './subpages.js';
import { syncWorkspaceHeader } from './workspace-shell.js';

const nav = document.querySelector('#nav');
const pageRoot = document.querySelector('#page');
let modules = [];
let renderedPath = '';
function updateNavigation() {
  nav.innerHTML = navigationMarkup(modules, canonicalPath(window.location.pathname), window.location.search, currentUser().roles.includes('admin'));
}
function updateSubview() {
  const path = window.location.pathname;
  syncPageTabs(pageRoot, path, window.location.search, currentUser().roles.includes('admin'));
  selectSubview(pageRoot, window.location.search, path.startsWith('/library') ? 'content' : path === '/settings' ? 'account' : 'draft');
  syncWorkspaceHeader(pageRoot, path, currentUser());
}
function navigate(path) { window.history.pushState({}, '', canonicalPath(path)); renderRoute(); }

async function overview(view) {
  const [incidents, reviews, studio, library] = await Promise.all([api('/api/incidents'), api('/api/review'), api('/api/studio'), api('/api/library')]);
  if (!view.isConnected) return;
  const pending = reviews.cases.filter(c => c.state === 'pending');
  const rows = cases => cases.map(c => `<li><a href="/cases/${e(c.id)}">${e(c.title)}</a><span>${e(c.asset)} / ${e(c.priority)}</span></li>`).join('');
  view.innerHTML = `<header class="workspace-heading"><h2>Operations Overview</h2><a class="button primary" href="/cases/new">New case</a></header>${workQueueMarkup(incidents.incidents, reviews.cases, studio.records || [])}<div class="overview-metrics">${[['/cases', 'Cases', incidents.incidents.length], ['/cases/review', 'Pending review', pending.length], ['/studio/improvements', 'Improvement candidates', studio.candidates.length], ['/library', 'Approved Pills', library.pills.length]].map(([url, label, count]) => `<a href="${url}"><span>${label}</span><strong>${count}</strong></a>`).join('')}</div><section class="triage-section"><h3>Recent cases</h3>${incidents.incidents.length ? `<ul class="overview-list">${rows(incidents.incidents.slice(0, 8))}</ul>` : '<p class="empty-state">No cases yet.</p>'}</section>`;
  view.querySelector('.overview-metrics a[href="/studio/improvements"] strong').textContent = String(studio.candidates.length + (studio.pendingLearningProposals || 0));
  view.querySelector('.overview-metrics a[href="/library"] strong').textContent = String(new Set(library.pills.map(p => p.id)).size);
}

async function renderRoute() {
  window.scrollTo({ top: 0, behavior: 'instant' });
  const path = canonicalPath(window.location.pathname);
  if (path !== window.location.pathname) window.history.replaceState({}, '', path + window.location.search + window.location.hash);
  const active = path.split('/')[1];
  updateNavigation();
  if (renderedPath === path && pageRoot.querySelector('[data-page-panel]')) { updateSubview(); return; }
  renderedPath = path;
  const view = document.createElement('section'); view.className = 'workspace-view'; pageRoot.replaceChildren(view);
  view.innerHTML = '<p role="status">Loading...</p>';
  syncWorkspaceHeader(pageRoot, path, currentUser());
  try {
    if (active === 'cases') {
      const route = caseRoute(path); if (!route) throw new Error('Case page not found.');
      view.innerHTML = `<header class="workspace-heading"><h2>Case Workspace</h2>${route.id ? '<a href="/cases">All cases</a>' : ''}</header><div class="case-stage"></div>`;
      const content = view.querySelector('.case-stage');
      if (route.stage === 'tasks') await renderTasks(content, route.id);
      else if (route.stage === 'handling') await renderHandling(content, route.id);
      else if (route.stage === 'triage') await renderTriage(content, route.legacy);
      else if (route.stage === 'review') await renderReview(content, route.legacy);
      else await renderIncidents(content, route.legacy, navigate);
    } else if (path === '/settings') await renderSettings(view);
    else if (path === '/overview') await overview(view);
    else if (path === '/overview/analytics') { view.innerHTML = '<header class="workspace-heading"><h2>Operational analytics</h2></header><div class="analytics-content"></div>'; await renderOperations(view.querySelector('.analytics-content')); }
    else if (path === '/studio' || path.startsWith('/studio/')) await renderStudio(view, path, navigate);
    else if (path === '/library' || path.startsWith('/library/')) await renderLibraryPage(view, path, window.location.search);
    else throw new Error('Page not found.');
    updateSubview();
  } catch (error) { if (view.isConnected) view.innerHTML = `<p class="form-error" role="alert">${e(error.message)}</p>`; }
}

document.addEventListener('click', event => {
  if (jumpToSection(event, document)) return;
  const link = event.target.closest('a[href^="/"]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.download) return;
  event.preventDefault(); navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', renderRoute);
try {
  if (await requireSession(pageRoot)) {
  new MutationObserver(() => { bindAccountIdentity(pageRoot); updateSubview(); }).observe(pageRoot, { childList: true, subtree: true });
  ({ modules } = await api('/api/modules'));
  const top = document.createElement('button'); top.className = 'page-top'; top.textContent = '↑ Back to top'; top.hidden = true;
  top.onclick = () => window.scrollTo({ top: 0, behavior: 'instant' }); document.body.append(top);
  window.addEventListener('scroll', () => { top.hidden = window.scrollY < 500; }, { passive: true });
  await renderRoute();
  }
} catch (error) { pageRoot.innerHTML = `<p class="form-error" role="alert">${e(error.message)}</p>`; }
