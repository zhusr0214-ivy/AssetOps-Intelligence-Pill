import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationReply } from '../conversation.js';
import { assessIntake } from '../intake.js';
import { assertLiveIntakeResult } from '../scripts/check-llm.js';

const base = { description: 'Meeting room is warm', location: 'Level 18', category: 'hvac_local_comfort', affectedScope: 'Meeting room only', occurredAt: 'Unknown', impact: 'Occupants uncomfortable', priority: 'high' };

test('airflow short answers advance only when responding to the airflow question', () => {
  const question = conversationReply(base, base.description);
  assert.match(question, /VAV response/);
  for (const content of ['50%, 120 m3/h', '120 m\u00b3/h', '50%\uFF0C120 m3/h', '120 cfm', '80 L/s']) {
    const messages = [{ role: 'assistant', content: question }, { role: 'user', content }];
    assert.doesNotMatch(conversationReply({ ...base, observations: content, messages }, content), /VAV response/);
    const unrelated = [{ role: 'assistant', content: 'What is the room number?' }, { role: 'user', content }];
    assert.match(conversationReply({ ...base, observations: content, messages: unrelated }, content), /VAV response/);
  }
});

test('unrelated and ambiguous short replies do not mark airflow as answered', () => {
  const question = conversationReply(base, base.description);
  for (const content of ['120', '50%', 'Please change the title', 'Yes']) {
    const messages = [{ role: 'assistant', content: question }, { role: 'user', content }];
    assert.match(conversationReply({ ...base, messages }, content), /VAV response/);
  }
});

test('short scope answers advance even before field extraction', () => {
  const incident = { ...base, affectedScope: '' };
  const question = conversationReply(incident, incident.description);
  for (const content of ['One room', 'Only one zone', 'Multiple areas', '\u53ea\u6709\u4e00\u4e2a\u623f\u95f4']) {
    const messages = [{ role: 'assistant', content: question }, { role: 'user', content }];
    const result = assessIntake({ ...incident, messages });
    assert.ok(!result.followUpQuestions.some(item => item.id === 'hvac_scope'));
    assert.ok(result.followUpQuestions.some(item => item.id === 'hvac_local_airflow'));
  }
});

test('live check accepts specific cooling category and rejects invalid results', () => {
  const result = { mode: 'llm', fields: { category: 'hvac_cooling', priority: 'high', asset: 'AHU-18-01' }, readyForTriage: true };
  assert.doesNotThrow(() => assertLiveIntakeResult(result));
  assert.doesNotThrow(() => assertLiveIntakeResult({ ...result, fields: { ...result.fields, category: 'hvac' } }));
  for (const category of ['other', 'lift_fault', 'water_leak']) assert.throws(() => assertLiveIntakeResult({ ...result, fields: { ...result.fields, category } }));
  assert.throws(() => assertLiveIntakeResult({ ...result, mode: 'local-rules' }));
  assert.throws(() => assertLiveIntakeResult({ ...result, readyForTriage: false }));
});
