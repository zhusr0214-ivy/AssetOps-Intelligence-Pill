import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { addReferenceHelpers, editorMarkup } from '../public/studio.js';

test('reference picker links rules and actions both ways without copying IDs', () => {
  const record = { state: 'draft', validation: null, releases: [], events: [], content: {
    pill: { name: 'Demo', owner: 'Team', source: 'Demo source', scope: 'AHU', boundaries: ['Advisory only'], escalationConditions: ['Escalate safety concerns'],
      rules: [{ id: 'R1', title: 'Check readings', guidance: 'Check.', cardExplanation: 'Check.', actionIds: [] }],
      actions: [{ id: 'A1', title: 'Review readings', instruction: 'Review.', owner: 'Engineer', requiresApproval: true, ruleIds: [] }] },
    sources: [], examples: [{ scenario: 'Warm room', rationale: 'Review readings', ruleIds: [], actionIds: [] }]
  } };
  const dom = new JSDOM(`<body>${editorMarkup(record)}</body>`);
  const old = { document: global.document, Event: global.Event, Option: global.Option };
  Object.assign(global, { document: dom.window.document, Event: dom.window.Event, Option: dom.window.Option });
  try {
    const form = document.querySelector('#pill-editor');
    addReferenceHelpers(form);
    const rule = form.querySelector('fieldset[data-kind="rules"]');
    const action = form.querySelector('fieldset[data-kind="actions"]');
    const ruleHelper = rule.querySelector('[data-reference-for="actionIds"]');
    assert.match(ruleHelper.querySelector('select').textContent, /Review readings/);
    assert.ok(rule.querySelector('[name="actionIds"]').closest('label').classList.contains('studio-reference-field'));
    assert.equal(ruleHelper.querySelector('select option[value="A1"]').textContent, 'Review readings');
    ruleHelper.querySelector('select').value = 'A1';
    ruleHelper.querySelector('button').click();
    ruleHelper.querySelector('button').click();
    assert.equal(rule.querySelector('[name="actionIds"]').value, 'A1');
    assert.equal(action.querySelector('[name="ruleIds"]').value, 'R1');
    const example = form.querySelector('fieldset[data-kind="examples"]');
    const exampleHelper = example.querySelector('[data-reference-for="ruleIds"]');
    exampleHelper.querySelector('select').value = 'R1';
    exampleHelper.querySelector('button').click();
    assert.equal(example.querySelector('[name="ruleIds"]').value, 'R1');
  } finally {
    Object.assign(global, old);
    dom.window.close();
  }
});
