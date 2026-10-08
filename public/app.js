import { jumpToSection } from './navigation.js';
import { renderLibrary } from './library.js';
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
  renderLibrary(pageRoot, pills);
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
  window.scrollTo({ top: 0, behavior: 'instant' });
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
    if (jumpToSection(event, document)) return;
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
  const top = document.createElement('button');
  top.className = 'page-top'; top.textContent = '↑ Back to top'; top.hidden = true;
  top.onclick = () => window.scrollTo({ top: 0, behavior: 'instant' });
  document.body.append(top);
  window.addEventListener('scroll', () => { top.hidden = window.scrollY < 500; }, { passive: true });
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
