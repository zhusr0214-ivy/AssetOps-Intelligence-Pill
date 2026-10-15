import { api, escapeHtml as e } from './incidents.js';
import { renderConversation } from './conversation.js';
import { caseDate, mountCaseRecords } from './case-records.js';

export async function renderCaseConversations(root) {
  const { incidents } = await api('/api/incidents');
  if (!root.isConnected) return;
  root.innerHTML = '<section class="incident-workspace case-conversations"><label>Search conversations<input type="search" data-search placeholder="Case, asset or date"></label><div class="case-list-heading" aria-hidden="true"><span>Case</span><span>Asset</span><span>Date</span></div><ul class="case-conversation-list"></ul></section>';
  const paint = () => {
    const query = root.querySelector('[data-search]').value.trim().toLowerCase();
    const rows = [...incidents].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).filter(i => [i.title, i.asset, i.createdAt, caseDate(i.createdAt)].join(' ').toLowerCase().includes(query));
    root.querySelector('ul').innerHTML = rows.map(i => `<li><a href="/cases/${e(i.id)}"><strong>${e(i.title || 'Untitled case')}</strong><span aria-label="Asset">${e(i.asset || 'Not specified')}</span><time aria-label="Date" datetime="${e(i.createdAt || '')}" title="Case created">${e(caseDate(i.createdAt))}</time></a></li>`).join('') || '<li class="empty-state">No conversations found.</li>';
  };
  root.querySelector('input').oninput = paint; paint();
}

export async function renderCaseChat(root, route, navigate) {
  root.innerHTML = '<section class="case-chat incident-workspace"><div data-chat-main></div><div data-chat-tools></div></section>';
  const main = root.querySelector('[data-chat-main]'), tools = root.querySelector('[data-chat-tools]');
  const incident = route.id ? (await api(`/api/incidents/${encodeURIComponent(route.id)}`)).incident : {};
  if (!main.isConnected) return;
  let conversation;
  const panels = mountCaseRecords(tools, next => { conversation?.update(next); panels.update(next); });
  conversation = renderConversation(main, incident, navigate, { compact: true, onChange: next => panels.update(next) });
  panels.update(incident);
  if (route.stage === 'review') panels.open('review');
  if (['handling', 'tasks'].includes(route.stage)) panels.open('outcome');
}
