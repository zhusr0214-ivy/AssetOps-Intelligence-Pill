import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { compactComposer, attachmentMarkup } from '../public/case-attachments.js';

for (const id of ['message-form', 'triage-chat-form']) {
  test(`${id}: Enter submits, Shift+Enter and IME preserve typing`, t => {
    const dom = new JSDOM(`<main>${attachmentMarkup({})}<form id="${id}"><textarea required></textarea><button type="submit">Send</button></form></main>`);
    t.after(() => dom.window.close());
    const root = dom.window.document.querySelector('main');
    compactComposer(root);
    const form = root.querySelector('form');
    const textarea = form.querySelector('textarea');
    const button = form.querySelector('[type="submit"]');
    let submissions = 0;
    form.addEventListener('submit', event => { event.preventDefault(); submissions++; assert.equal(event.submitter, button); });
    const press = (options = {}) => {
      const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
      textarea.dispatchEvent(event);
      return event.defaultPrevented;
    };
    textarea.value = 'Question about the case';
    assert.equal(press(), true);
    assert.equal(submissions, 1);
    assert.equal(press({ shiftKey: true }), false);
    assert.equal(press({ isComposing: true }), false);
    assert.equal(press({ keyCode: 229 }), false);
    textarea.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
    assert.equal(press(), false);
    textarea.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
    assert.equal(submissions, 1);
    assert.equal(press(), true);
    assert.equal(submissions, 2);
    press({ repeat: true });
    button.disabled = true; press(); button.disabled = false;
    textarea.disabled = true; press(); textarea.disabled = false;
    textarea.value = '   '; press();
    assert.equal(submissions, 2);
  });
}
