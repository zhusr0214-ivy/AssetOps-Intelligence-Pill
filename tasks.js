import { randomUUID } from 'node:crypto';
import { governancePackage } from './review.js';

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const text = (v, max = 2000) => typeof v === 'string' && v.trim() && v.length <= max;
const terminal = new Set(['completed', 'cancelled']);
export function taskEvidenceCurrent(incident, task) {
  if (task.status !== 'completed') return null;
  const records = incident.handlingRecords || [], replaced = new Set(records.map(r => r.corrects).filter(Boolean));
  return Boolean(records.some(r => r.id === task.actionRecordId && r.kind === 'action') && records.some(r => r.id === task.outcomeRecordId && r.kind === 'outcome' && r.verified === true) && !replaced.has(task.actionRecordId) && !replaced.has(task.outcomeRecordId));
}
export function taskReminder(task, time = Date.now()) {
  if (terminal.has(task.status)) return null;
  if (Date.parse(task.dueAt) < time) return 'overdue';
  if (task.escalation && !task.escalation.acknowledgedAt) return 'escalation_pending';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'awaiting_verification') return 'verification_due';
  if (Date.parse(task.dueAt) - time <= 86400000) return 'due_soon';
  return null;
}
export function taskAuthorization(incident, task, pills) {
  const review = incident.reviews?.find(r => r.id === task.reviewId), report = incident.triageReports?.find(r => r.id === review?.reportId);
  if (!review || !report || report.id !== incident.triageReports.at(-1)?.id) return false;
  const pack = governancePackage(incident, report, pills);
  if (task.kind === 'escalation') return review.decision === 'escalate' && !pack.stale;
  return ['approve', 'approve_with_changes'].includes(review.decision) && pack.canApprove && review.actions.some(a => a.id === task.actionId && a.choice === 'accept') && report.pill.status === 'approved';
}

export function createTaskService(store, currentPills, clock = () => Date.now()) {
  const read = async id => { const i = (await store.list()).find(i => i.id === id); if (!i) throw fail('Case not found.', 404); return i; };
  const check = (i, body) => { if (!Number.isInteger(body?.revision) || body.revision !== (i.revision || 0)) throw fail('Case changed. Reload tasks before continuing.', 409); };
  const due = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('A valid due date is required.'); return new Date(value).toISOString(); };
  const view = (i, pills) => ({ incidentId: i.id, title: i.title, revision: i.revision || 0, tasks: (i.tasks || []).map(t => ({ ...t, authorizationCurrent: taskAuthorization(i, t, pills), evidenceCurrent: taskEvidenceCurrent(i, t), progress: t.progress ?? (t.status === 'completed' ? 100 : 0), overdueHours: !terminal.has(t.status) ? Math.max(0, Math.floor((clock() - Date.parse(t.dueAt)) / 3600000)) : 0, reminder: taskEvidenceCurrent(i, t) === false ? 'evidence_corrected' : taskReminder(t, clock()) })), reviews: (i.reviews || []).filter(r => r.reportId === i.triageReports?.at(-1)?.id).map(r => ({ id: r.id, decision: r.decision, owner: r.owner, actions: r.actions.filter(a => a.choice === 'accept').map(a => ({ id: a.id, title: a.title })), eligible: taskAuthorization(i, { reviewId: r.id, kind: r.decision === 'escalate' ? 'escalation' : 'action', actionId: r.actions.find(a => a.choice === 'accept')?.id }, pills) })), handlingRecords: i.handlingRecords || [] });
  return {
    async list() { const pills = await currentPills(); return (await store.list()).flatMap(i => view(i, pills).tasks.map(t => ({ ...t, incidentId: i.id, caseTitle: i.title }))); },
    async get(id) { return view(await read(id), await currentPills()); },
    async create(id, body) {
      const i = await read(id); check(i, body);
      if (!text(body.actor, 120) || !text(body.assignee, 120)) throw fail('Dispatcher and assignee are required.');
      const review = i.reviews?.find(r => r.id === body.reviewId);
      const kind = review?.decision === 'escalate' ? 'escalation' : 'action';
      const action = review?.actions.find(a => a.id === body.actionId && a.choice === 'accept');
      const task = { id: `TASK-${randomUUID()}`, kind, reviewId: review?.id, actionId: kind === 'action' ? action?.id : null };
      if (!taskAuthorization(i, task, await currentPills())) throw fail('A current approved published plan or specialist escalation is required.', 409);
      if (i.tasks?.some(t => t.reviewId === task.reviewId && t.actionId === task.actionId)) throw fail('This reviewed action already has a task.', 409);
      const at = new Date(clock()).toISOString();
      Object.assign(task, { title: kind === 'escalation' ? 'Specialist escalation' : action.title, instruction: kind === 'escalation' ? review.notes : action.instruction, sourceAction: action ? structuredClone(action) : null, assignee: body.assignee.trim(), dueAt: due(body.dueAt), status: 'assigned', createdAt: at, updatedAt: at, identityVerified: false, events: [{ operation: 'assign', actor: body.actor.trim(), at, assignee: body.assignee.trim(), notes: 'Task created from reviewed plan.' }] });
      await store.update(id, { tasks: [...(i.tasks || []), task] }, body.revision); return task;
    },
    async update(id, taskId, body) {
      const i = await read(id); check(i, body); const task = i.tasks?.find(t => t.id === taskId);
      if (!task) throw fail('Task not found.', 404);
      if (!text(body.actor, 120) || !text(body.notes)) throw fail('Actor and update notes are required.');
      const op = body.operation, before = { status: task.status, assignee: task.assignee, dueAt: task.dueAt, progress: task.progress ?? 0 };
      const live = taskAuthorization(i, task, await currentPills());
      const records = i.handlingRecords || [], superseded = new Set(records.map(r => r.corrects).filter(Boolean));
      if (op === 'assign') {
        if (terminal.has(task.status) || !text(body.assignee, 120)) throw fail('Only open tasks can be assigned.');
        task.assignee = body.assignee.trim(); task.dueAt = due(body.dueAt);
      } else if (op === 'progress') {
        if (!['in_progress', 'blocked'].includes(task.status) || !Number.isInteger(body.progress) || body.progress < 0 || body.progress > 99) throw fail('Progress must be an integer from 0 to 99 on an active task. Completion requires verification.');
        task.progress = body.progress;
      } else if (op === 'escalate') {
        if (terminal.has(task.status) || !text(body.escalationOwner, 120)) throw fail('An open task and escalation owner are required.');
        if (task.escalation && !task.escalation.acknowledgedAt) throw fail('An escalation is already awaiting acknowledgement.', 409);
        task.escalation = { owner: body.escalationOwner.trim(), reason: body.notes.trim(), at: new Date(clock()).toISOString(), acknowledgedAt: null };
      } else if (op === 'acknowledge') {
        if (terminal.has(task.status) || !task.escalation || task.escalation.acknowledgedAt) throw fail('No open escalation awaits acknowledgement.');
        task.escalation.acknowledgedAt = new Date(clock()).toISOString(); task.escalation.acknowledgedBy = body.actor.trim();
      } else if (op === 'start') {
        if (!live || !['assigned', 'blocked'].includes(task.status)) throw fail('Refresh approval before starting an assigned or blocked task.', 409);
        task.status = 'in_progress';
      } else if (op === 'block') {
        if (!['assigned', 'in_progress'].includes(task.status)) throw fail('Only assigned or in-progress tasks can be blocked.');
        task.status = 'blocked';
      } else if (op === 'submit') {
        if (task.status !== 'in_progress') throw fail('Start the task before submitting execution evidence.');
        const record = records.find(r => r.id === body.actionRecordId && r.kind === 'action' && !superseded.has(r.id));
        if (!record) throw fail('Select a current actual-action record from this case.');
        task.actionRecordId = record.id; task.actionEvidence = structuredClone(record); task.status = 'awaiting_verification';
      } else if (op === 'verify') {
        if (task.status !== 'awaiting_verification' || body.confirmed !== true) throw fail('Confirm verification of the submitted action.');
        if (superseded.has(task.actionRecordId)) throw fail('Execution evidence was corrected. Reopen and submit the current action record.');
        const outcome = records.find(r => r.id === body.outcomeRecordId && r.kind === 'outcome' && r.verified === true && ['resolved', 'unresolved'].includes(r.status) && !superseded.has(r.id));
        if (!outcome || Date.parse(outcome.occurredAt) < Date.parse(task.actionEvidence.occurredAt)) throw fail('Select a verified outcome following the actual action.');
        task.outcomeRecordId = outcome.id; task.outcomeEvidence = structuredClone(outcome); task.status = 'completed'; task.progress = 100; task.completedAt = new Date(clock()).toISOString();
      } else if (op === 'reopen') {
        if (!['completed', 'awaiting_verification', 'cancelled'].includes(task.status)) throw fail('Only closed or submitted tasks can be reopened.');
        task.status = 'assigned'; task.progress = 0; task.completedAt = null;
      } else if (op === 'cancel') {
        if (terminal.has(task.status)) throw fail('This task is already closed.');
        task.status = 'cancelled';
      } else if (op === 'link') {
        let url;
        try { url = new URL(body.externalUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); } catch { throw fail('Use a plain HTTPS work-order URL without credentials.'); }
        if (!text(body.externalId, 120) || url.href.length > 2000) throw fail('A work-order ID and bounded URL are required.');
        task.external = { id: body.externalId.trim(), url: url.href, linkedBy: body.actor.trim() };
      } else throw fail('Unknown task operation.');
      task.updatedAt = new Date(clock()).toISOString();
      task.events.push({ operation: op, actor: body.actor.trim(), notes: body.notes.trim(), at: task.updatedAt, before, after: { status: task.status, assignee: task.assignee, dueAt: task.dueAt, progress: task.progress ?? 0 }, escalation: task.escalation ? structuredClone(task.escalation) : null, actionRecordId: task.actionRecordId || null, outcomeRecordId: task.outcomeRecordId || null, external: task.external || null });
      await store.update(id, { tasks: i.tasks }, body.revision); return task;
    }
  };
}
