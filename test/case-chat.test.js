import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderCaseChat, renderCaseConversations } from '../public/case-chat.js';
import { sessionRequest } from '../public/session.js';
import { readFileSync } from 'node:fs';
import { confirmationMarkup } from '../public/case-records.js';

const incident = () => ({ id: 'C1', title: 'Cooling issue', asset: 'AHU-1', createdAt: '2026-10-14T08:00:00Z', occurredAt: 'Yesterday', status: 'ready_for_triage', revision: 3, description: 'Too warm', location: 'Level 2', impact: 'Comfort', messages: [], reviews: [] });
const summary = () => ({ summary: 'Cooling issue under investigation.', actions: 'Not reported', outcome: 'not_reported', remaining: 'Need readings', feedback: '', evidence: [], verified: false, caseRevision: 4 });
async function browser(t, responder, roles = ['admin']) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/cases/C1' });
  const old = Object.fromEntries(['document', 'window', 'fetch', 'FormData'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, FormData: dom.window.FormData, fetch: async (url, options = {}) => {
    const value = url === '/api/auth/session' ? { user: { id: 'U1', name: 'Signed-in expert', roles }, csrf: 'test' } : await responder(url, options);
    return { ok: !value.error, json: async () => value };
  } });
  await sessionRequest('/api/auth/session');
  t.after(() => { dom.window.close(); Object.assign(globalThis, old); });
  return { root: document.querySelector('main'), window: dom.window };
}
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Expected UI update'); }
function enter(root, window, text) { const input = root.querySelector('#case-message'); input.value = text; input.dispatchEvent(new window.Event('input')); root.querySelector('#message-form').dispatchEvent(new window.Event('submit', { cancelable: true })); }

test('list shows only title, asset and immutable creation time; search and escaping work', async t => {
  const { root, window } = await browser(t, () => ({ incidents: [incident(), { ...incident(), id: 'C2', title: '<script>Leak</script>', asset: '', createdAt: '2026-10-13T00:00:00Z' }] }));
  await renderCaseConversations(root);
  assert.equal(root.querySelector('script'), null);
  const row = root.querySelector('a[href="/cases/C1"]');
  assert.equal(row.children.length, 3);
  assert.equal(row.querySelector('time').dateTime, incident().createdAt);
  assert.ok(!root.textContent.includes('Yesterday'));
  assert.ok(!root.textContent.includes('ready_for_triage'));
  root.querySelector('input').value = '2026-10-13'; root.querySelector('input').dispatchEvent(new window.Event('input'));
  assert.equal(root.querySelectorAll('li a').length, 1);
  assert.equal(root.querySelector('li a').getAttribute('href'), '/cases/C2');
});

test('all cases use one conversation with exactly two follow-up panels and no report controls', async t => {
  const { root } = await browser(t, () => ({ incident: incident() }));
  await renderCaseChat(root, { id: 'C1' }, () => {});
  assert.ok(root.querySelector('#message-form'));
  assert.deepEqual([...root.querySelectorAll('[data-chat-tools] > details > summary')].map(e => e.textContent), ['Expert experience confirmation', 'Summary']);
  for (const selector of ['#case-priority', '#case-summary', '#confirm-case', '[data-analyze-case]', '[data-record="outcome"]']) assert.equal(root.querySelector(selector), null);
});

test('new case retains attachments and Enter composer without fetching reports', async t => {
  const { root } = await browser(t, () => assert.fail('Unexpected request'));
  await renderCaseChat(root, {}, () => {});
  assert.ok(root.querySelector('.chat-input-bar .attachment-menu'));
  assert.equal(root.querySelector('#confirm-case'), null);
  assert.equal(root.querySelectorAll('[data-tool]').length, 2);
});

test('contextual replies, citations and automatic result summary update without navigating', async t => {
  const current = incident(), posts = [];
  const { root, window } = await browser(t, (url, options) => {
    if (options.method === 'POST') {
      posts.push(url); current.revision = 4; current.resultFeedback = summary();
      current.messages = [{ id: 'U2', role: 'user', state: 'complete', content: 'Why?' }, { id: 'A2', role: 'assistant', content: 'More readings are needed.', matchedPills: [{ id: 'P1', name: 'Cooling', version: '2' }], citations: [{ kind: 'pill', name: 'Cooling', version: '2', quote: 'Verify readings.' }] }];
    }
    return { incident: current };
  });
  await renderCaseChat(root, { id: 'C1' }, () => assert.fail('Unexpected navigation'));
  enter(root, window, 'Why?');
  await until(() => root.textContent.includes('More readings are needed.'));
  assert.deepEqual(posts, ['/api/incidents/C1/messages']);
  assert.match(root.querySelector('[data-feedback-body]').textContent, /Cooling issue under investigation/);
  assert.match(root.querySelector('.pill-citations').textContent, /Cooling.*2/);
});

test('failed message preserves retry controls and uses saved request ID', async t => {
  const current = incident(); let attempts = 0, savedId;
  const { root, window } = await browser(t, (url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (!attempts++) { savedId = body.requestId; current.messages = [{ role: 'user', state: 'failed', requestId: savedId, content: body.content }]; return { error: 'Provider unavailable' }; }
      assert.equal(body.retry, true); assert.equal(body.requestId, savedId);
      current.messages = [{ ...current.messages[0], state: 'complete' }, { role: 'assistant', content: 'Recovered reply' }];
    }
    return { incident: current };
  });
  await renderCaseChat(root, { id: 'C1' }, () => {});
  enter(root, window, 'Why?'); await until(() => root.querySelector('#retry-message'));
  assert.match(root.textContent, /Provider unavailable/);
  root.querySelector('#retry-message').click(); await until(() => root.textContent.includes('Recovered reply'));
  assert.equal(attempts, 2);
});

test('experience panel does not duplicate pending requests or legacy confirmation history', async t => {
  const current = incident();
  current.messages = [{ id: 'A1', role: 'assistant', content: 'Need expert input', expertRequest: { required: true, reason: 'Solution needs judgment' } }];
  current.humanConfirmations = [{ subject: 'Checked asset identity', confirmedBy: 'Previous reviewer', createdAt: current.createdAt }];
  const { root } = await browser(t, (url, options) => { assert.notEqual(options.method, 'POST'); return { incident: current }; });
  await renderCaseChat(root, { id: 'C1', stage: 'review' }, () => {});
  const panel = root.querySelector('[data-confirmation-body]');
  assert.equal(panel.querySelector('form, textarea, input, button'), null);
  assert.match(panel.textContent, /No expert experience recorded/);
  assert.doesNotMatch(panel.textContent, /Checked asset identity|Previous reviewer/);
});

test('confirmation log does not infer triggers or treat an expert reply as approval', () => {
  assert.match(confirmationMarkup({ messages: [{ role: 'user', content: 'Please confirm this' }] }), /No human-confirmation requests or records/);
  const html = confirmationMarkup({ messages: [{ id: 'A1', role: 'assistant', expertRequest: { required: true, reason: '<script>Need judgment</script>' } }], expertSolutions: [{ messageId: 'A1', expert: 'Expert', solution: 'Inspect readings' }] });
  assert.match(html, /Expert response recorded/);
  assert.ok(!html.includes('Confirmation recorded'));
  assert.ok(!html.includes('<script>'));
});

test('reviewer records a message-bound decision in chat while the history panel stays read-only', async t => {
  const current = incident(); let submitted;
  current.messages = [{ id: 'A1', role: 'assistant', content: 'Review this recommendation.', supervision: { required: true, mode: 'review', subject: 'Specific action', reason: 'Requires approval', pillVersions: [{ id: 'P1', version: '1' }] } }];
  const { root, window } = await browser(t, (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, '/api/cases/C1/confirmations'); submitted = JSON.parse(options.body);
      current.revision++; current.humanConfirmations = [{ ...submitted, sourceMessageId: submitted.messageId, confirmedBy: 'Signed-in reviewer' }];
    }
    return { incident: current };
  }, ['reviewer']);
  await renderCaseChat(root, { id: 'C1' }, () => {});
  const form = root.querySelector('.message-log [data-supervision-message]');
  assert.ok(form); assert.equal(form.closest('section').previousElementSibling.className, 'message assistant');
  form.elements.decision.value = 'rejected'; form.elements.subject.value = 'Does not fit current conditions'; form.elements.confirmed.checked = true;
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => !root.querySelector('[data-supervision-message]'));
  assert.equal(submitted.messageId, 'A1'); assert.equal(submitted.revision, 3);
  const history = root.querySelector('[data-confirmation-body]');
  assert.match(root.querySelector('.message-log').textContent, /rejected/);
  assert.match(root.querySelector('.message-log').textContent, /Signed-in reviewer/);
  assert.doesNotMatch(history.textContent, /rejected/);
  assert.equal(history.querySelector('form'), null);
});

test('safety request exposes escalation only and experts cannot approve recommendations', async t => {
  const current = incident();
  current.messages = [{ id: 'A1', role: 'assistant', content: 'Escalate.', supervision: { required: true, mode: 'escalation', subject: 'Restricted action', reason: 'Safety boundary' } }];
  const { root } = await browser(t, () => ({ incident: current }), ['reviewer']);
  await renderCaseChat(root, { id: 'C1' }, () => {});
  assert.deepEqual([...root.querySelectorAll('[data-supervision-message] option')].map(o => o.value), ['', 'escalated']);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ user: { roles: ['expert'] }, csrf: 'test' }) });
  await sessionRequest('/api/auth/session');
  const { supervisionMarkup } = await import('../public/case-records.js');
  assert.doesNotMatch(supervisionMarkup(current), /<form/);
});

test('case list shares the heading left edge instead of a centered fixed-width column', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.case-conversations\s*\{[^}]*max-width:\s*none;[^}]*margin-inline:\s*0;/);
});

test('opening results generates a missing summary automatically and does not offer outcome editing', async t => {
  const current = incident(), posts = [];
  const { root } = await browser(t, (url, options) => {
    if (options.method === 'POST') { posts.push(url); current.revision = 4; current.resultFeedback = summary(); }
    return { incident: current };
  });
  await renderCaseChat(root, { id: 'C1', stage: 'handling' }, () => {});
  await until(() => root.textContent.includes('Cooling issue under investigation'));
  assert.deepEqual(posts, ['/api/cases/C1/result-summary']);
  assert.equal(root.querySelector('[data-feedback-body] textarea'), null);
  const panel = root.querySelector('[data-feedback-body]');
  assert.equal(panel.querySelectorAll('p').length, 1);
  assert.equal(panel.querySelector('dl, details, small, textarea'), null);
  assert.equal(panel.textContent.trim(), summary().summary);
});

test('expert input is in the conversation and saves a traceable draft, not an approval', async t => {
  const current = incident(); current.messages = [{ id: 'A1', role: 'assistant', content: 'Expert judgment is needed.', expertRequest: { required: true, reason: 'No supported solution' }, matchedPills: [] }]; let saved;
  const { root, window } = await browser(t, (url, options) => {
    if (options.method === 'POST') { saved = JSON.parse(options.body); current.expertSolutions = [{ id: 'E1', messageId: 'A1', expert: 'Signed-in expert', solution: saved.solution, pillDraftId: 'P1', createdAt: new Date().toISOString() }]; }
    return { incident: current };
  });
  await renderCaseChat(root, { id: 'C1' }, () => {});
  const form = root.querySelector('.message-log [data-expert-solution]');
  assert.equal(form.querySelectorAll('textarea').length, 1);
  assert.ok(form.parentElement.classList.contains('expert-entry'));
  assert.equal(form.previousElementSibling.textContent, 'Expert solution required');
  assert.equal(form.firstElementChild.tagName, 'TEXTAREA');
  assert.equal(form.firstElementChild.getAttribute('aria-labelledby'), 'expert-solution-heading');
  assert.equal(form.parentElement.querySelector(':scope > p'), null);
  assert.equal(form.querySelector('input[type="checkbox"]'), null);
  assert.doesNotMatch(form.textContent, /I submit this as expert knowledge/);
  form.elements.solution.value = 'Review onsite readings with an engineer.';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => root.querySelector('a[href="/studio/P1"]'));
  assert.equal(saved.messageId, 'A1'); assert.equal(saved.confirmed, true);
  assert.equal(root.querySelector('[data-expert-solution]'), null);
});

test('submitting expert experience clears chat form and confirmation saves a Pill from the lower panel', async t => {
  const current = incident();
  current.messages = [{ id: 'A1', role: 'assistant', content: 'Expert input needed.', knowledgeGap: true, advisoryOnly: true, expertRequest: { required: true, reason: 'Knowledge gap' } }];
  const calls = [];
  const { root, window } = await browser(t, (url, options) => {
    if (options.method === 'POST') {
      calls.push(url); current.revision++;
      if (url.endsWith('/expert-solutions')) current.expertSolutions = [{ id: 'E1', messageId: 'A1', expert: 'Expert', solution: JSON.parse(options.body).solution, status: 'pending_confirmation' }];
      else { assert.equal(JSON.parse(options.body).solutionId, 'E1'); current.expertSolutions[0].pillDraftId = 'P1'; }
    }
    return { incident: current };
  });
  await renderCaseChat(root, { id: 'C1' }, () => {});
  assert.doesNotMatch(root.textContent, /No applicable approved Pill|Advisory only/);
  const form = root.querySelector('[data-expert-solution]');
  form.elements.solution.value = 'Expert proposal';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => root.querySelector('[data-confirm-experience]'));
  assert.equal(root.querySelector('.message-log [data-expert-solution], .message-log .expert-saved'), null);
  assert.doesNotMatch(root.querySelector('.message-log').textContent, /Expert proposal/);
  assert.ok(root.querySelector('[data-tool="review"]').open);
  root.querySelector('[data-confirm-experience]').click();
  await until(() => root.querySelector('[data-confirmation-body] a[href="/studio/P1"]'));
  assert.deepEqual(calls, ['/api/cases/C1/expert-solutions', '/api/cases/C1/expert-experience-confirmation']);
  assert.equal(root.querySelector('[data-confirm-experience]'), null);
});

test('viewer cannot submit confirmation, expert solution or trigger model summary', async t => {
  const current = incident(); current.messages = [{ id: 'A1', role: 'assistant', expertRequest: { required: true, reason: 'Knowledge gap' }, content: 'Need expert' }];
  const { root } = await browser(t, (url, options) => { assert.notEqual(options.method, 'POST'); return { incident: current }; }, ['viewer']);
  await renderCaseChat(root, { id: 'C1', stage: 'handling' }, () => {});
  assert.equal(root.querySelector('[data-expert-solution]'), null);
  assert.equal(root.querySelector('[data-confirmation]'), null);
});

test('selected attachment question shares the Case message endpoint', async t => {
  const current = incident(), posts = [];
  const { root, window } = await browser(t, (url, options) => {
    if (url.endsWith('/documents')) { current.caseDocuments = [{ id: 'D1', filename: 'notes.txt', warnings: [], blocks: [{ id: 'B1', location: 'Paragraph 1', text: '24 C' }] }]; }
    if (url.endsWith('/messages')) { const body = JSON.parse(options.body); assert.deepEqual(body.documentIds, ['D1']); current.messages = [{ role: 'assistant', content: 'The file says 24 C.' }]; }
    if (options.method === 'POST') posts.push(url);
    return { incident: current };
  });
  await renderCaseChat(root, { id: 'C1' }, () => {});
  const file = root.querySelector('[data-case-file]'); Object.defineProperty(file, 'files', { value: [new window.File(['24 C'], 'notes.txt')] }); file.dispatchEvent(new window.Event('change'));
  await until(() => root.querySelector('[data-document-id]'));
  enter(root, window, 'What reading?'); await until(() => root.textContent.includes('The file says 24 C.'));
  assert.deepEqual(posts, ['/api/incidents/C1/documents', '/api/incidents/C1/messages']);
});
