import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseConversationAgent, createCaseAnswer, validateCaseAnswer } from '../case-conversation-agent.js';
import { assessIntake } from '../intake.js';
import { sendMessage } from '../conversation.js';

const pill = { id: 'P1', name: 'Cooling', version: '1.0', status: 'approved', domain: 'ahu_cooling', rules: [{ id: 'R1', title: 'Readings', guidance: 'Verify the reported readings.' }], actions: [], boundaries: ['No equipment operation.'], escalationConditions: ['Refer uncertainty to the onsite engineer.'] };
const facts = { description: 'AHU-1 warm today', asset: 'AHU-1', category: 'hvac_cooling', location: 'Level 2', occurredAt: 'today', impact: 'Office comfort' };
const context = { messages: [{ role: 'user', content: 'Why do you need more readings?' }], manualFields: [] };
const extract = async input => assessIntake(input);
const resultFields = { expertRequest: { required: false, reason: '' }, resultFeedback: { summary: 'Facts are being collected.', actions: '', outcome: 'not_reported', remaining: '', feedback: '', evidence: [] } };

test('reply uses freshly extracted facts, matching approved Pills and conversational context', async () => {
  let payload;
  const agent = createCaseConversationAgent({
    extract: async () => assessIntake(facts),
    loadPills: async () => [pill, { ...pill, id: 'DEMO', status: 'demo' }, { ...pill, id: 'DRAFT', status: 'draft' }],
    answer: async value => { payload = value; return { ...resultFields, answer: 'Readings help distinguish possibilities; this is not a diagnosis.', citations: [{ sourceId: value.sources[0].sourceId, quote: 'Verify the reported readings.' }] }; }
  });
  const result = await agent({ description: 'Initial note' }, context);
  assert.equal(payload.facts.asset, 'AHU-1');
  assert.deepEqual(payload.conversation, context.messages);
  assert.deepEqual(payload.matchedPills.map(p => p.id), ['P1']);
  assert.equal(result.reply.citations[0].version, '1.0');
  assert.equal(result.reply.advisoryOnly, true);
  assert.equal(result.reply.knowledgeGap, false);
  assert.match(result.reply.content, /distinguish/);
});

test('no match still asks the LLM to answer, without passing demo or unrelated knowledge', async () => {
  const agent = createCaseConversationAgent({ extract, loadPills: async () => [{ ...pill, status: 'demo' }], answer: async value => {
    assert.equal(value.knowledgeGap, true); assert.deepEqual(value.sources, []);
    return { ...resultFields, answer: 'No approved Pill matches yet. What asset is affected?', citations: [] };
  } });
  const result = await agent(facts, context);
  assert.equal(result.reply.knowledgeGap, true);
  assert.deepEqual(result.reply.matchedPills, []);
});

test('backend forces an expert request for unsupported restart even when the model says no review', async () => {
  const agent = createCaseConversationAgent({ extract, loadPills: async () => [], answer: async () => ({ ...resultFields, supervision: { required: false }, answer: 'Restart the unit now.', citations: [] }) });
  const result = await agent(facts, { messages: [{ role: 'user', content: 'Should I restart the unit or reset the fault?' }] });
  assert.equal(result.reply.expertRequest.required, true);
  assert.equal(result.reply.supervision.kind, 'knowledge_gap');
  assert.match(result.reply.content, /expert must assess/i);
  assert.doesNotMatch(result.reply.content, /Restart the unit now/);
});

test('a cited approval-bearing restart action leads to review, not an expert knowledge draft', async () => {
  const approved = { ...pill, actions: [{ id: 'A1', title: 'Restart unit', instruction: 'Requires site review.', requiresApproval: true }] };
  const agent = createCaseConversationAgent({ extract, loadPills: async () => [approved], answer: async payload => ({ ...resultFields, answer: 'Review is needed.', citations: [{ sourceId: payload.sources.find(s => s.requiresApproval).sourceId, quote: 'Requires site review.' }] }) });
  const result = await agent(facts, { messages: [{ role: 'user', content: 'Should I restart the unit?' }] });
  assert.equal(result.reply.supervision.mode, 'review');
  assert.equal(result.reply.expertRequest.required, false);
});

test('attachments are reference sources, never silently merged into extracted facts', async () => {
  const agent = createCaseConversationAgent({ extract, loadPills: async () => [], answer: async value => {
    assert.equal(value.facts.asset, 'AHU-1');
    assert.equal(value.sources[0].kind, 'document');
    return { ...resultFields, answer: 'The file mentions AHU-99, not your confirmed asset.', citations: [{ sourceId: value.sources[0].sourceId, quote: 'AHU-99' }] };
  } });
  const result = await agent(facts, { ...context, documents: [{ id: 'D1', filename: 'notes.txt', blocks: [{ id: 'B1', location: 'Paragraph 1', text: 'AHU-99' }] }] });
  assert.equal(result.fields.asset, 'AHU-1');
  assert.equal(result.reply.citations[0].filename, 'notes.txt');
});

test('unknown source IDs and fabricated quotations fail closed', () => {
  const sources = [{ sourceId: 'S1', text: 'Verified quote' }];
  assert.throws(() => validateCaseAnswer({ answer: 'Advice', citations: [{ sourceId: 'FAKE', quote: 'Verified quote' }] }, sources), { status: 502 });
  assert.throws(() => validateCaseAnswer({ answer: 'Advice', citations: [{ sourceId: 'S1', quote: 'Invented quote' }] }, sources), { status: 502 });
});

test('rephrased follow-up has a validated target and unknown safety answers are not asked again', async () => {
  const messages = [
    { role: 'assistant', content: 'Can you confirm whether anyone needs rescue?', followUpId: 'lift_entrapment', followUpField: 'observations' },
    { role: 'user', content: 'Unknown' }
  ];
  const agent = createCaseConversationAgent({ extract, loadPills: async () => [], answer: async value => {
    assert.ok(!value.followUpQuestions.some(q => q.id === 'lift_entrapment'));
    assert.ok(value.unresolvedSafety.includes('lift_entrapment'));
    return { ...resultFields, answer: 'The onsite team must verify occupancy. When did the fault start?', citations: [], followUpId: 'occurredAt' };
  } });
  const result = await agent({ description: 'Lift stopped', category: 'lift_fault' }, { messages });
  assert.equal(result.reply.followUpField, 'occurredAt');
  const invalid = createCaseConversationAgent({ extract, loadPills: async () => [], answer: async () => ({ answer: 'What priority?', citations: [], followUpId: 'priority' }) });
  await assert.rejects(invalid(facts, context), { status: 502 });
});

test('Pill revoked during inference cannot be persisted as current knowledge', async () => {
  let calls = 0;
  const agent = createCaseConversationAgent({ extract, loadPills: async () => ++calls === 1 ? [pill] : [], answer: async () => ({ ...resultFields, answer: 'A response', citations: [] }) });
  await assert.rejects(agent(facts, context), { status: 409 });
});

test('adapter calls configured LLM with policy and history; model failure is not a template reply', async () => {
  const env = { SOCLAAS_BASE_URL: 'https://example.test/v1', SOCLAAS_API_KEY: 'test', SOCLAAS_MODEL: 'test-model' };
  const answer = createCaseAnswer({ env, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://example.test/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.match(body.messages[0].content, /untrusted data/);
    assert.match(body.messages[0].content, /Never claim approval/);
    assert.deepEqual(JSON.parse(body.messages[1].content), context);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"answer":"Contextual answer","citations":[]}' } }] }) };
  } });
  assert.equal((await answer(context)).answer, 'Contextual answer');
  await assert.rejects(createCaseAnswer({ env, fetchImpl: async () => ({ ok: false, status: 429 }) })(context), { status: 503 });
});

test('message persistence keeps LLM text and citations, retry reuses attachments without duplicating turns', async () => {
  let record = { ...facts, id: 'C1', revision: 0, messages: [], caseDocuments: [{ id: 'D1', blocks: [] }] };
  const store = { update: async (id, data) => record = { ...record, ...data, revision: record.revision + 1 } };
  const input = { requestId: 'message-001', content: 'Explain this file', documentIds: ['D1'] };
  let attempts = 0;
  const agent = async (incident, ctx) => {
    assert.equal(ctx.documents[0].id, 'D1');
    if (++attempts === 1) throw new Error('Provider offline');
    return { ...assessIntake(incident), reply: { content: 'A contextual answer', citations: [], advisoryOnly: true } };
  };
  await assert.rejects(sendMessage(store, record, input, agent));
  assert.equal(record.messages[0].state, 'failed');
  await sendMessage(store, record, { requestId: input.requestId, retry: true }, agent);
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[1].content, 'A contextual answer');
  assert.equal(record.messages[1].advisoryOnly, true);
  await sendMessage(store, record, input, agent);
  assert.equal(attempts, 2);
  await assert.rejects(sendMessage(store, record, { requestId: 'message-002', content: 'Foreign file', documentIds: ['OTHER'] }, agent), { status: 404 });
});

test('each model reply persists an evidence-linked automatic summary and expert request without closing the case', async () => {
  let record = { ...facts, id: 'C1', revision: 0, messages: [] };
  const store = { update: async (id, data) => record = { ...record, ...data, revision: record.revision + 1 } };
  const agent = createCaseConversationAgent({ extract, loadPills: async () => [], answer: async payload => ({
    answer: 'An expert must assess this proposed fix.', citations: [], expertRequest: { required: true, reason: 'The solution is not supported by an approved Pill.' },
    resultFeedback: { ...resultFields.resultFeedback, evidence: [{ id: payload.resultEvidence.at(-1).id, quote: 'Can we use this fix?' }] }
  }) });
  await sendMessage(store, record, { requestId: 'summary-message-001', content: 'Can we use this fix?' }, agent);
  assert.equal(record.resultFeedback.caseRevision, record.revision);
  assert.equal(record.resultFeedback.evidence[0].id, record.messages[0].id);
  assert.equal(record.resultFeedback.verified, false);
  assert.equal(record.messages.at(-1).expertRequest.required, true);
  assert.notEqual(record.status, 'resolved');
});
