import { randomUUID } from 'node:crypto';
import { assessIntake, fields } from './intake.js';

export function manualFieldsFor(incident) {
  return incident.manualFields || fields.filter(key => incident[key]);
}

export function conversationReply(incident, latest) {
  const analysis = assessIntake(incident);
  const domain = analysis.followUpQuestions.find(item => item.domain);
  const conflicts = incident.conflicts?.length;
  const lines = [];

  if (analysis.unresolvedSafety.length) {
    lines.push('Safety information previously answered as unknown still needs verification by the responsible onsite team.');
  }
  if (domain && (!conflicts || domain.safety)) {
    // Ask one domain question so brief answers have a clear context.
    lines.push(domain.question);
  }
  if (conflicts) {
    lines.push('Some information differs from the current summary. Please resolve the highlighted items.');
  } else if (!domain) {
    const question = analysis.followUpQuestions.find(item => item.field !== 'priority');
    if (question) lines.push(question.question);
  }
  if (!incident.priority) lines.push('Please choose Priority in the summary.');
  if (!lines.length) return 'The basic intake information is complete. Review the summary and confirm submission for triage.';
  return 'The case summary is updated.\n' + lines.join('\n');
}

export async function sendMessage(store, incident, input, agent) {
  if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) throw Object.assign(new Error('A valid requestId is required.'), { status: 400 });
  const messages = [...(incident.messages || [])];
  const existing = messages.find(message => message.requestId === input.requestId && message.role === 'user');
  if (existing?.state === 'complete') return incident;
  if (existing && input.retry !== true) throw Object.assign(new Error('This message is saved. Retry its analysis.'), { status: 409 });
  if (!existing && messages.some(message => message.role === 'user' && message.state !== 'complete')) throw Object.assign(new Error('Retry the previous message before sending another.'), { status: 409 });
  if (!existing && (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 6000)) throw Object.assign(new Error('Enter a message up to 6000 characters.'), { status: 400 });
  if (!existing && messages.length >= 100) throw Object.assign(new Error('Conversation limit reached. Finish intake using the summary.'), { status: 422 });
  const userMessage = existing || { id: randomUUID(), requestId: input.requestId, role: 'user', content: input.content.trim(), createdAt: new Date().toISOString() };
  userMessage.state = 'pending';
  if (!existing) messages.push(userMessage);
  const manualFields = manualFieldsFor(incident);
  const pending = await store.update(incident.id, { messages, manualFields, status: 'needs_info' }, incident.revision || 0);
  try {
    const analysis = await agent(pending, { messages: messages.map(({ role, content }) => ({ role, content })), manualFields });
    const conflicts = [...(incident.conflicts || []).filter(old => !Object.hasOwn(analysis.extractedFields || {}, old.field) && !(analysis.conflicts || []).some(next => next.field === old.field)), ...(analysis.conflicts || [])];
    const updated = { ...analysis.fields, conflicts };
    userMessage.state = 'complete';
    messages.push({ id: randomUUID(), role: 'assistant', content: conversationReply({ ...updated, messages }, userMessage.content), createdAt: new Date().toISOString() });
    return await store.update(incident.id, { ...updated, messages, status: analysis.readyForTriage && !conflicts.length ? 'draft' : 'needs_info' }, pending.revision);
  } catch (error) {
    userMessage.state = 'failed';
    await store.update(incident.id, { messages }, pending.revision);
    throw error;
  }
}
