import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMarkup } from '../public/triage.js';
import { createTriageService, caseFingerprint } from '../triage.js';

test('outdated and unsuccessful reports disable both controls and explain why', () => {
  for (const report of [{ status: 'complete', stale: true }, { status: 'failed' }, { status: 'out_of_scope' }]) {
    const html = chatMarkup(report);
    assert.match(html, /id="chat-unavailable"/);
    assert.match(html, /<textarea[^>]*disabled/);
    assert.match(html, /<button[^>]*disabled/);
  }
});

test('current complete and needs-information reports allow questions', () => {
  for (const status of ['complete', 'needs_information']) {
    const html = chatMarkup({ status });
    assert.doesNotMatch(html, /disabled/);
  }
});

test('chat failure is inline, escaped, and retains the draft; pending disables resubmission', () => {
  const html = chatMarkup({ status: 'complete' }, { draft: '<question>', error: '<failure>' });
  assert.match(html, /id="chat-error" class="form-error" role="alert">&lt;failure&gt;/);
  assert.match(html, />&lt;question&gt;<\/textarea>/);
  const pending = chatMarkup({ status: 'complete' }, { pending: true });
  assert.match(pending, /Asking\.\.\./);
  assert.match(pending, /<button[^>]*disabled/);
});

test('backend rejects stale, failed and out-of-scope chats before calling the model', async () => {
  for (const [status, stale] of [['failed', false], ['out_of_scope', false], ['complete', true]]) {
    const incident = { id: 'case', status: 'ready_for_triage' };
    incident.triageReports = [{ id: 'report', status, caseFingerprint: stale ? 'old' : caseFingerprint(incident) }];
    let called = false;
    const service = createTriageService({ list: async () => [incident] }, undefined, 'test', async () => { called = true; });
    await assert.rejects(service.chat('case', 'report', 'Why?'), { status: 409 });
    assert.equal(called, false);
  }
});
