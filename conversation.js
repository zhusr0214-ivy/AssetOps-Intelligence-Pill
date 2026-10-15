import { randomUUID } from 'node:crypto';
import { assessIntake, fields } from './intake.js';
import { feedbackKey } from './case-feedback.js';

export function manualFieldsFor(incident) {
  return incident.manualFields || fields.filter(key => incident[key]);
}

export function conversationReply(incident, latest) {
  const chinese = /[\u3400-\u9fff]/u.test(latest);
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
    lines.push(chinese ? '新信息与之前的描述不一致，请在对话中确认需要保留的内容。' : 'Some new information conflicts with earlier facts. Confirm which value to keep in the conversation.');
  } else if (!domain) {
    const question = analysis.followUpQuestions.find(item => item.field !== 'priority');
    const questions = {
      description: '请描述一下发生了什么问题。', location: '问题发生在哪栋楼、哪层或哪个区域？',
      occurredAt: '大约什么时候开始的？不清楚可以直接说不知道。', impact: '目前影响了哪些人或区域？不清楚可以直接说不知道。'
    };
    if (question) lines.push(chinese ? questions[question.field] || question.question : question.question);
  }
  if (!lines.length) return chinese ? '已整理你提供的信息，可以确认事件并调用 Pill 分析。' : 'The reported facts are ready. Confirm the case to consult Pill knowledge.';
  return lines.join('\n');
}

export async function sendMessage(store, incident, input, agent) {
  if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) throw Object.assign(new Error('A valid requestId is required.'), { status: 400 });
  const messages = [...(incident.messages || [])];
  const existing = messages.find(message => message.requestId === input.requestId && message.role === 'user');
  if (existing?.state === 'complete') return incident;
  if (existing && input.retry !== true) throw Object.assign(new Error('This message is saved. Retry its analysis.'), { status: 409 });
  if (!existing && messages.some(message => message.role === 'user' && message.state !== 'complete')) throw Object.assign(new Error('Retry the previous message before sending another.'), { status: 409 });
  if (!existing && (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 6000)) throw Object.assign(new Error('Enter a message up to 6000 characters.'), { status: 400 });
  if (!existing && messages.length >= 100) throw Object.assign(new Error('Conversation limit reached. Start a new case for further discussion.'), { status: 422 });
  const documentIds = existing?.documentIds ?? input.documentIds ?? [];
  if (!Array.isArray(documentIds) || documentIds.length > 5 || new Set(documentIds).size !== documentIds.length || documentIds.some(id => typeof id !== 'string')) throw Object.assign(new Error('Invalid attachment selection.'), { status: 400 });
  const documents = documentIds.map(id => (incident.caseDocuments || []).find(d => d.id === id));
  if (documents.some(d => !d)) throw Object.assign(new Error('An attachment does not belong to this case.'), { status: 404 });
  const userMessage = existing || { id: randomUUID(), requestId: input.requestId, role: 'user', content: input.content.trim(), documentIds, createdAt: new Date().toISOString() };
  userMessage.state = 'pending';
  if (!existing) messages.push(userMessage);
  const manualFields = manualFieldsFor(incident);
  const pending = await store.update(incident.id, { messages, manualFields, status: 'needs_info' }, incident.revision || 0);
  try {
    const analysis = await agent(pending, { messages: messages.map(({ role, content, followUpId, followUpField }) => ({ role, content, ...(role === 'assistant' ? { followUpId, followUpField } : {}) })), manualFields, documents });
    const conflicts = [...(incident.conflicts || []).filter(old => !Object.hasOwn(analysis.extractedFields || {}, old.field) && !(analysis.conflicts || []).some(next => next.field === old.field)), ...(analysis.conflicts || [])];
    const updated = { ...analysis.fields, conflicts };
    userMessage.state = 'complete';
    messages.push({ ...(analysis.reply || {}), id: randomUUID(), role: 'assistant', content: analysis.reply?.content || conversationReply({ ...updated, messages }, userMessage.content), createdAt: new Date().toISOString() });
    const resultFeedback = analysis.resultFeedback ? { ...analysis.resultFeedback, sourceKey: feedbackKey({ ...pending, ...updated, messages }), caseRevision: pending.revision + 1 } : null;
    return await store.update(incident.id, { ...updated, messages, ...(resultFeedback ? { resultFeedback } : {}), status: analysis.readyForTriage && !conflicts.length ? 'draft' : 'needs_info' }, pending.revision);
  } catch (error) {
    userMessage.state = 'failed';
    await store.update(incident.id, { messages }, pending.revision);
    throw error;
  }
}
