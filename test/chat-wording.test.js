import test from 'node:test';
import assert from 'node:assert/strict';
import { createTriageChat } from '../triage-agent.js';
import { ahuPill } from '../triage.js';
import { chatTextMarkup } from '../public/triage.js';

const action = ahuPill.actions.find(item => item.id === 'request-inspection');
const invoke = (content, actions = [action]) => createTriageChat({
  env: { SOCLAAS_API_KEY: 'test', SOCLAAS_BASE_URL: 'https://example.test/v1' },
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
})({ question: 'Does the command prove physical position?', incident: {}, report: { actions }, history: [] });

test('screenshot mandatory inspection wording becomes the saved conditional action', async () => {
  const result = await invoke('No. The command is 89%. Human verification by a qualified engineer is required via action request-inspection.');
  assert.equal(result, `No. The command is 89%. ${action.instruction} Human approval is required for this request.`);
  assert.ok(result.includes('whether an onsite inspection is appropriate'));
});

test('answers without an action reference are preserved; unlisted actions are not recommended', async () => {
  assert.equal(await invoke('No. Actual position is unverified [HVAC-03].'), 'No. Actual position is unverified [HVAC-03].');
  assert.equal(await invoke('Use request-inspection.', []), 'This report does not list an inspection request action.');
});

test('assistant inline formatting is rendered without enabling HTML', () => {
  assert.equal(chatTextMarkup('A *command* is **not** a `position`.'), 'A <em>command</em> is <strong>not</strong> a <code>position</code>.');
  const malicious = chatTextMarkup('*<img src=x onerror=alert(1)>*\n<script>alert(1)</script>');
  assert.ok(!malicious.includes('<img'));
  assert.ok(!malicious.includes('<script'));
  assert.ok(malicious.includes('&lt;img'));
  assert.ok(malicious.includes('<br>'));
  assert.equal(chatTextMarkup('28.4°C and 89%; 2 * 3'), '28.4°C and 89%; 2 * 3');
});
