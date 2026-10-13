import { api, escapeHtml as e } from './incidents.js';

const labels = { assigned: 'Assigned', in_progress: 'In progress', blocked: 'Blocked', awaiting_verification: 'Awaiting verification', completed: 'Completed', cancelled: 'Cancelled' };
const options = entries => entries.map(([id, title]) => `<option value="${e(id)}">${e(title)}</option>`).join('');
const field = (name, label, type = 'text') => `<label>${label}<input name="${name}" type="${type}" ${type === 'text' ? 'maxlength="120"' : ''} required></label>`;
const audit = task => `<details><summary>History (${task.events.length})</summary><ul>${[...task.events].reverse().map(v => `<li>${e(v.at)} / ${e(v.actor)} / ${e(v.operation)}: ${e(v.notes)}</li>`).join('')}</ul></details>`;

export async function renderTasks(root, id) {
  const view = document.createElement('section'); view.className = 'task-workspace'; root.replaceChildren(view);
  try {
    const data = await api(id ? `/api/cases/${encodeURIComponent(id)}/tasks` : '/api/tasks');
    if (!view.isConnected) return;
    view.innerHTML = `<header class="workspace-heading"><h2 class="case-page-title">${id ? 'Case tasks' : 'Task queue'}</h2>${id ? `<a href="/cases/${e(id)}/handling">Actual actions and outcomes</a>` : ''}</header><div class="list-toolbar"><label>Assignee / task<input type="search" id="task-search"></label><label>Status<select id="task-status"><option value="">All statuses</option>${options(Object.entries(labels))}</select></label><label>Reminder<select id="task-reminder"><option value="">All tasks</option>${options(['overdue', 'due_soon', 'blocked', 'verification_due', 'evidence_corrected', 'escalation_pending'].map(v => [v, v.replaceAll('_', ' ')]))}</select></label></div><div class="table-scroll"><table class="incident-table"><thead><tr><th>Task / Case</th><th>Assignee</th><th>Due</th><th>Status / Progress</th><th>Reminder</th></tr></thead><tbody></tbody></table></div><div class="task-detail"></div><div class="task-create"></div>`;
    const paint = () => {
      const query = view.querySelector('#task-search').value.toLowerCase(), status = view.querySelector('#task-status').value, reminder = view.querySelector('#task-reminder').value;
      const rows = data.tasks.filter(t => (!status || t.status === status) && (!reminder || t.reminder === reminder) && [t.title, t.assignee, t.escalation?.owner, t.caseTitle].join(' ').toLowerCase().includes(query));
      view.querySelector('tbody').innerHTML = rows.map(t => `<tr><td>${id ? `<button type="button" data-task="${e(t.id)}">${e(t.title)}</button>` : `<a href="/cases/${e(t.incidentId)}/tasks">${e(t.title)}</a><small>${e(t.caseTitle)}</small>`}${!t.authorizationCurrent && !['completed', 'cancelled'].includes(t.status) ? '<small>Approval needs refresh</small>' : ''}</td><td>${e(t.assignee)}</td><td>${e(new Date(t.dueAt).toLocaleString())}</td><td>${e(labels[t.status])}<small>${t.progress ?? (t.status === 'completed' ? 100 : 0)}%</small>${t.escalation ? `<small>Escalated: ${e(t.escalation.owner)} / ${t.escalation.acknowledgedAt ? 'Acknowledged' : 'Pending'}</small>` : ''}</td><td>${e(t.reminder?.replaceAll('_', ' ') || 'None')}${t.overdueHours ? `<small>${t.overdueHours} hours overdue</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No matching tasks.</td></tr>';
    };
    view.querySelectorAll('.list-toolbar input,.list-toolbar select').forEach(el => el.oninput = paint); paint();
    if (!id) return;
    const endpoint = `/api/cases/${encodeURIComponent(id)}/tasks`;
    const bind = (form, path, extra) => form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
      const values = Object.fromEntries(new FormData(form));
      if (values.operation === 'progress') values.progress = Number(values.progress);
      if (values.dueAt && Number.isFinite(Date.parse(values.dueAt))) values.dueAt = new Date(values.dueAt).toISOString();
      button.disabled = true; const error = form.querySelector('[role="alert"]'); error.textContent = '';
      try {
        await api(path, { method: 'POST', body: JSON.stringify({ ...values, ...extra, revision: data.revision, confirmed: form.elements.confirmed?.checked === true }) });
        if (view.isConnected) await renderTasks(root, id);
      } catch (failure) { error.textContent = failure.message; button.disabled = false; }
    });
    const eligible = data.reviews.flatMap(r => r.eligible ? (r.decision === 'escalate' ? [{ reviewId: r.id, actionId: '', title: 'Specialist escalation' }] : r.actions.map(a => ({ reviewId: r.id, actionId: a.id, title: a.title }))) : []).filter(a => !data.tasks.some(t => t.reviewId === a.reviewId && (t.actionId || '') === a.actionId));
    if (eligible.length) {
      view.querySelector('.task-create').innerHTML = `<form class="triage-section"><h3>Assign reviewed action</h3><label>Approved action<select name="selection">${options(eligible.map((a, n) => [String(n), a.title]))}</select></label><div class="review-grid">${field('actor', 'Dispatcher (signed-in)')}${field('assignee', 'Assignee')}${field('dueAt', 'Due date', 'datetime-local')}</div><p role="alert" class="form-error"></p><button type="submit" class="primary">Assign task</button></form>`;
      const form = view.querySelector('.task-create form');
      const chosen = {}; const choose = () => Object.assign(chosen, eligible[Number(form.elements.selection.value)]); choose(); form.elements.selection.onchange = choose;
      bind(form, endpoint, chosen);
    } else view.querySelector('.task-create').innerHTML = `<p class="empty-state">No unassigned approved actions. <a href="/cases/${e(id)}/review">Human review</a></p>`;
    view.addEventListener('click', event => {
      const button = event.target.closest('[data-task]'); if (!button) return;
      const task = data.tasks.find(t => t.id === button.dataset.task), open = !['completed', 'cancelled'].includes(task.status);
      const ops = [...(open ? [['assign', 'Reassign / reschedule'], ['cancel', 'Cancel']] : []), ...(task.authorizationCurrent && ['assigned', 'blocked'].includes(task.status) ? [['start', 'Start']] : []), ...(['assigned', 'in_progress'].includes(task.status) ? [['block', 'Mark blocked']] : []), ...(task.status === 'in_progress' ? [['submit', 'Submit execution evidence']] : []), ...(task.status === 'awaiting_verification' ? [['verify', 'Verify result']] : []), ...(['completed', 'awaiting_verification', 'cancelled'].includes(task.status) ? [['reopen', 'Reopen']] : []), ...(open ? [['escalate', 'Escalate to owner']] : []), ...(open && task.escalation && !task.escalation.acknowledgedAt ? [['acknowledge', 'Acknowledge escalation']] : []), ...(['in_progress', 'blocked'].includes(task.status) ? [['progress', 'Record progress']] : []), ['link', 'Link external work order']];
      const pane = view.querySelector('.task-detail');
      pane.innerHTML = `<section class="triage-section"><h3>${e(task.title)}</h3><p>${e(task.instruction)}</p>${task.external ? `<a href="${e(task.external.url)}" target="_blank" rel="noopener noreferrer">Work order ${e(task.external.id)}</a>` : ''}${audit(task)}<form><label>Update<select name="operation">${options(ops)}</select></label>${field('actor', 'Operator (signed-in)')}<label>Update notes<textarea name="notes" maxlength="2000" required></textarea></label><div class="operation-fields"></div><p role="alert" class="form-error"></p><button type="submit" class="primary">Save update</button><button type="button" data-reload>Reload tasks</button></form></section>`;
      const form = pane.querySelector('form'), superseded = new Set(data.handlingRecords.map(r => r.corrects).filter(Boolean));
      const recordsFor = kind => data.handlingRecords.filter(r => r.kind === kind && !superseded.has(r.id) && (kind !== 'outcome' || r.verified));
      const recordText = r => r.summary || r.notes || r.description || r.status || r.occurredAt || '';
      const evidence = kind => recordsFor(kind).map((r, index) => {
        const full = recordText(r), compact = full.replace(/\s+/g, ' ').trim();
        const label = `${index + 1}. ${compact.length > 90 ? compact.slice(0, 87) + '…' : compact}`;
        return `<option value="${e(r.id)}" title="${e(full)}">${e(label)}</option>`;
      }).join('');
      const fields = () => {
        const op = form.elements.operation.value;
        form.querySelector('.operation-fields').innerHTML = op === 'progress' ? `<label>Progress (0-99%)<input name="progress" type="number" min="0" max="99" step="1" value="${task.progress ?? 0}" required></label>` : op === 'escalate' ? field('escalationOwner', 'Escalation owner') : op === 'assign' ? `${field('assignee', 'Assignee')}${field('dueAt', 'Due date', 'datetime-local')}` : op === 'submit' ? `<label>Actual action<select name="actionRecordId" required><option value="">Select recorded action</option>${evidence('action')}</select></label>` : op === 'verify' ? `<label>Verified outcome<select name="outcomeRecordId" required><option value="">Select recorded outcome</option>${evidence('outcome')}</select></label><label class="review-check"><input type="checkbox" name="confirmed" required>I verified this task against the recorded outcome.</label>` : op === 'link' ? `${field('externalId', 'Work order ID')}${field('externalUrl', 'HTTPS work order URL', 'url')}` : '';
        const picker = form.querySelector('[name="actionRecordId"], [name="outcomeRecordId"]');
        if (picker) {
          const preview = document.createElement('p'); preview.className = 'evidence-preview';
          preview.setAttribute('aria-live', 'polite'); picker.closest('label').after(preview);
          const showEvidence = () => {
            const record = data.handlingRecords.find(r => r.id === picker.value);
            preview.textContent = record ? `${recordText(record)}${record.occurredAt ? ` — ${new Date(record.occurredAt).toLocaleString()}` : ''}` : 'Select a record to read its full evidence.';
          };
          picker.onchange = showEvidence; showEvidence();
        }
        if (op === 'assign') { form.elements.assignee.value = task.assignee; const date = new Date(task.dueAt); form.elements.dueAt.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      };
      form.elements.operation.onchange = fields; fields(); form.querySelector('[data-reload]').onclick = () => renderTasks(root, id);
      bind(form, `${endpoint}/${encodeURIComponent(task.id)}`, {});
    });
  } catch (error) { if (view.isConnected) view.innerHTML = `<p role="alert" class="form-error">${e(error.message)}</p>`; }
}
