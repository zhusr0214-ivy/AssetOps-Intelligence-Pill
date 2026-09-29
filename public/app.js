import { renderIncidents, escapeHtml } from './incidents.js';
import { renderTriage } from './triage.js';

const nav = document.querySelector("#nav");
const pageRoot = document.querySelector("#page");

const iconMap = {
  dashboard: "01",
  incidents: "02",
  triage: "03",
  review: "04",
  learning: "05",
  governance: "06"
};

const routeMap = {
  "/": "dashboard",
  "/dashboard": "dashboard",
  "/incidents": "incidents",
  "/triage": "triage",
  "/review": "review",
  "/learning": "learning",
  "/governance": "governance"
};

async function loadModules() {
  const response = await fetch("/api/modules");
  if (!response.ok) {
    throw new Error("Unable to load module skeleton");
  }
  return response.json();
}

async function renderGovernance() {
  const response = await fetch('/api/governance');
  if (!response.ok) throw new Error('Unable to load Pill library');
  const { pills } = await response.json();
  pageRoot.innerHTML = `<section class="governance-page"><header class="workspace-heading"><div><p class="eyebrow">Knowledge governance</p><h2>Pill Governance Library</h2></div><span class="badge status-draft">${pills.length} Pill${pills.length === 1 ? '' : 's'}</span></header>
    <div class="pill-library">${pills.map(pill => `<article class="pill-record"><header class="pill-header"><div><p class="eyebrow">${escapeHtml(pill.id)}</p><h3>${escapeHtml(pill.name)}</h3></div><span class="badge">${escapeHtml(pill.status)} · v${escapeHtml(pill.version)}</span></header><p class="pill-source">${escapeHtml(pill.source)}</p><dl class="pill-meta"><div><dt>Owner</dt><dd>${escapeHtml(pill.owner)}</dd></div><div><dt>Scope</dt><dd>${escapeHtml(pill.scope)}</dd></div></dl><section class="pill-section"><h4>Decision rules</h4>${pill.rules.map(rule => `<div class="pill-rule"><strong>${escapeHtml(rule.id)} · ${escapeHtml(rule.title)}</strong><p>${escapeHtml(rule.guidance)}</p><small>Actions: ${rule.actionIds.map(escapeHtml).join(', ')}</small></div>`).join('')}</section><section class="pill-section"><h4>Action catalog</h4><div class="pill-actions">${pill.actions.map(action => `<div class="pill-action"><strong>${escapeHtml(action.title)}</strong><span class="badge">${action.requiresApproval ? 'Human approval required' : 'Read-only check'}</span><p>${escapeHtml(action.instruction)}</p><small>${escapeHtml(action.owner)} · ${action.ruleIds.map(escapeHtml).join(', ')}</small></div>`).join('')}</div></section><div class="pill-columns"><section class="pill-section"><h4>Boundaries</h4><ul>${pill.boundaries.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section><section class="pill-section"><h4>Escalation</h4><ul>${pill.escalationConditions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section></div><footer class="pill-footer">Demo status: this Pill is project-authored and requires domain validation before operational use.</footer></article>`).join('')}</div></section>`;
}

function renderNav(modules) {
  nav.innerHTML = modules
    .map(
      (module) => `
        <a href="/${module.id === "dashboard" ? "dashboard" : module.id}" class="nav-item" data-route="${module.id}">
          <span>${iconMap[module.id]}</span>
          ${module.title}
        </a>
      `
    )
    .join("");
}

function renderDashboard(modules) {
  pageRoot.innerHTML = `
    <section class="hero-panel">
      <div>
        <p class="eyebrow">MVP Frame</p>
        <h2>Six core product sections</h2>
      </div>
      <p>
        This skeleton defines the website structure only. Each section has its own
        page, while detailed business functions can be designed later.
      </p>
    </section>

    <section class="module-grid">
      ${modules
        .map(
          (module) => `
            <a href="/${module.id === "dashboard" ? "dashboard" : module.id}" class="module-card">
              <div class="module-number">${iconMap[module.id]}</div>
              <div>
                <h3>${module.title}</h3>
                <p>${module.summary}</p>
              </div>
              <div class="placeholder">Open section page</div>
            </a>
          `
        )
        .join("")}
    </section>
  `;
}

function renderSectionPage(module) {
  pageRoot.innerHTML = `
    <section class="section-page">
      <div class="section-heading">
        <div class="module-number">${iconMap[module.id]}</div>
        <div>
          <p class="eyebrow">Section Page</p>
          <h2>${module.title}</h2>
          <p>${module.summary}</p>
        </div>
      </div>

      <div class="page-placeholder">
        <strong>${module.title}</strong>
        <span>Page framework only. Detailed functions will be added later.</span>
      </div>
    </section>
  `;
}

function setActiveNav(activeId) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.route === activeId);
  });
}

function renderRoute(modules) {
  const pathname = window.location.pathname;
  const activeId = pathname.startsWith('/triage/') ? 'triage' : pathname.startsWith('/incidents/') ? 'incidents' : routeMap[pathname] || "dashboard";
  const activeModule = modules.find((module) => module.id === activeId) || modules[0];

  setActiveNav(activeModule.id);

  if (activeId === 'triage') {
    renderTriage(pageRoot, pathname);
    return;
  }

  if (activeId === 'incidents') {
    renderIncidents(pageRoot, pathname, path => {
      window.history.pushState({}, '', path);
      renderRoute(modules);
    });
    return;
  }

  if (activeId === 'dashboard') {
    renderDashboard(modules);
    return;
  }

  if (activeId === 'governance') {
    renderGovernance().catch(error => renderError(error.message));
    return;
  }

  renderSectionPage(activeModule);
}

function bindNavigation(modules) {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='/']");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.download) return;

    event.preventDefault();
    window.history.pushState({}, "", link.getAttribute("href"));
    renderRoute(modules);
  });

  window.addEventListener("popstate", () => renderRoute(modules));
}

function renderError(message) {
  pageRoot.innerHTML = `
    <article class="module-card">
      <h3>Unable to load framework</h3>
      <p>${escapeHtml(message)}</p>
    </article>
  `;
}

function renderSite(modules) {
  renderNav(modules);
  bindNavigation(modules);
  renderRoute(modules);
}

try {
  const { modules } = await loadModules();
  renderSite(modules);
} catch (error) {
  renderError(error.message);
}
