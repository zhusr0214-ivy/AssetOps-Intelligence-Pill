import { renderConversation } from './conversation.js';

export const labels = {
  title: 'Title', description: 'Description', location: 'Location', asset: 'Asset',
  category: 'Category', occurredAt: 'Started at', impact: 'Impact',
  observations: 'Readings / observations', actionsTaken: 'Actions already taken', affectedScope: 'Affected scope', priority: 'Priority'
};
export const priorities = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const categories = {
  hvac: 'HVAC / General', water_leak: 'Plumbing / Water Leak', energy: 'Energy Anomaly', other: 'Other',
  hvac_cooling: 'HVAC / Cooling Performance', hvac_local_comfort: 'HVAC / Local Thermal Comfort',
  electrical_distribution: 'Electrical / Distribution', lift_fault: 'Vertical Transportation / Lift Fault'
};
const statuses = { draft: 'Draft', needs_info: 'Needs information', ready_for_triage: 'Ready for triage' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const e = escapeHtml;

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to complete request.');
  return data;
}
export const options = (values, selected, placeholder) => `<option value="">${placeholder}</option>` + Object.entries(values).map(([key, label]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${label}</option>`).join('');
const badge = (kind, value, text) => `<span class="badge ${kind}-${e(value)}">${e(text || 'Not set')}</span>`;

export async function renderIncidents(root, pathname, navigate) {
  const view = document.createElement('section');
  view.className = 'incident-workspace';
  root.replaceChildren(view);
  view.innerHTML = '<p class="empty-state" role="status">Loading incidents...</p>';
  try {
    if (pathname === '/incidents' || pathname === '/incidents/') {
      const { incidents } = await api('/api/incidents');
      if (view.isConnected) renderList(view, incidents);
    } else if (pathname === '/incidents/new') {
      renderConversation(view, {}, navigate);
    } else {
      const match = pathname.match(/^\/incidents\/([^/]+)(\/edit)?$/);
      if (!match) throw new Error('Page not found.');
      const { incident } = await api(`/api/incidents/${encodeURIComponent(match[1])}`);
      if (!view.isConnected) return;
      if (match[2]) renderConversation(view, incident, navigate);
      else renderDetail(view, incident);
    }
  } catch (error) {
    if (view.isConnected) view.innerHTML = `<a class="back-link" href="/incidents"><span class="back-arrow" aria-hidden="true">&larr;</span>Back to incidents</a><p class="form-error" role="alert">${e(error.message)}</p>`;
  }
}

function renderList(view, incidents) {
  view.innerHTML = `
    <header class="workspace-heading"><div><p class="eyebrow">Asset Operations</p><h2>Incident Workspace</h2></div><a class="button primary" href="/incidents/new">New incident</a></header>
    <div class="list-toolbar">
      <label class="search-field">Search<input type="search" id="incident-search" placeholder="ID, title, asset or location"></label>
      <label>Status<select id="status-filter">${options(statuses, '', 'All statuses')}</select></label>
      <label>Priority<select id="priority-filter">${options(priorities, '', 'All priorities')}</select></label>
      <label>Sort by<select id="sort-order"><option value="updated">Recently updated</option><option value="priority">Highest priority</option></select></label>
    </div>
    <p id="result-count" class="result-count" role="status"></p>
    <div class="table-scroll"><table class="incident-table"><thead><tr><th scope="col">ID</th><th scope="col">Title</th><th scope="col">Asset / Location</th><th scope="col">Priority</th><th scope="col">Status</th></tr></thead><tbody></tbody></table></div>
    <div class="list-footer"><span id="page-count"></span><div class="actions"><button id="previous-page" type="button">Previous</button><button id="next-page" type="button">Next</button></div></div>`;
  let page = 0;
  function update() {
    const query = view.querySelector('#incident-search').value.trim().toLowerCase();
    const status = view.querySelector('#status-filter').value;
    const priority = view.querySelector('#priority-filter').value;
    const rows = incidents.filter(item => (!status || item.status === status) && (!priority || item.priority === priority) && [item.id, item.title, item.asset, item.location].join(' ').toLowerCase().includes(query));
    if (view.querySelector('#sort-order').value === 'priority') {
      const rank = { urgent: 4, high: 3, medium: 2, low: 1 };
      rows.sort((a, b) => (rank[b.priority] || 0) - (rank[a.priority] || 0));
    }
    const pages = Math.max(1, Math.ceil(rows.length / 10));
    page = Math.min(page, pages - 1);
    view.querySelector('#result-count').textContent = `${rows.length} incident${rows.length === 1 ? '' : 's'}`;
    view.querySelector('tbody').innerHTML = rows.slice(page * 10, page * 10 + 10).map(item => `<tr>
      <td><a class="incident-id" href="/incidents/${e(item.id)}">${e(item.id)}</a></td>
      <td><a class="incident-title" href="/incidents/${e(item.id)}">${e(item.title || 'Untitled incident')}</a></td>
      <td>${e(item.asset || 'Unconfirmed asset')}<small>${e(item.location || 'Location not provided')}</small></td>
      <td>${badge('priority', item.priority, priorities[item.priority])}</td>
      <td>${badge('status', item.status, statuses[item.status])}</td></tr>`).join('') || `<tr><td colspan="5" class="empty-state">${incidents.length ? 'No incidents match your filters.' : 'No incidents yet.'}</td></tr>`;
    view.querySelector('#page-count').textContent = `Page ${page + 1} of ${pages}`;
    view.querySelector('#previous-page').disabled = page === 0;
    view.querySelector('#next-page').disabled = page >= pages - 1;
  }
  view.querySelectorAll('input, select').forEach(input => input.addEventListener('input', () => { page = 0; update(); }));
  view.querySelector('#previous-page').onclick = () => { page--; update(); };
  view.querySelector('#next-page').onclick = () => { page++; update(); };
  view.querySelector('tbody').addEventListener('click', event => {
    if (event.target.closest('a') || window.getSelection()?.toString()) return;
    event.target.closest('tr')?.querySelector('a')?.click();
  });
  update();
}


export function details(incident) {
  return `<dl class="case-details">${Object.entries(labels).map(([key, label]) => `<div class="${key === 'description' ? 'wide-field' : ''}"><dt>${label}</dt><dd>${e((key === 'priority' ? priorities[incident[key]] : key === 'category' ? categories[incident[key]] : incident[key]) || 'Not provided')}</dd></div>`).join('')}</dl>`;
}

function renderDetail(view, incident) {
  view.innerHTML = `<a href="/incidents" class="back-link"><span class="back-arrow" aria-hidden="true">&larr;</span>Back to incidents</a>
    <header class="workspace-heading"><div><p class="eyebrow">${e(incident.id)}</p><h2>${e(incident.title)}</h2></div><a href="/incidents/${e(incident.id)}/edit" class="button">Edit incident</a></header>
    <div class="detail-meta">${badge('status', incident.status, statuses[incident.status])}${badge('priority', incident.priority, priorities[incident.priority])}<span>Updated ${e(new Date(incident.updatedAt).toLocaleString())}</span></div>
    ${details(incident)}
    ${incident.messages?.length ? `<details class="conversation-history"><summary>Conversation history (${incident.messages.length})</summary>${incident.messages.map(message => `<article class="message ${message.role === 'user' ? 'user' : 'assistant'}"><strong>${message.role === 'user' ? 'You' : 'Intake assistant'}</strong><p>${e(message.content)}</p></article>`).join('')}</details>` : ''}
    ${incident.status === 'ready_for_triage' ? `<div class="form-actions"><a class="button primary" href="/triage/${e(incident.id)}">Open AI Triage</a></div>` : `<div class="form-actions"><a class="button primary" href="/incidents/${e(incident.id)}/edit">Continue intake</a>${incident.triageReports?.length ? `<a class="button" href="/triage/${e(incident.id)}">View previous analyses</a>` : ''}</div>`}`;
}
