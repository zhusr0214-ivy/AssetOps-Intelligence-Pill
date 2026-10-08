import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterPills, pillMarkup } from '../public/library.js';
import { recentMessages } from '../public/conversation.js';
import { chatHistoryMarkup } from '../public/triage.js';
const pill = JSON.parse(await readFile(new URL('../pills/ahu-cooling.json', import.meta.url)));
test('library filters rules, version and scope and links every catalog action', () => {
  assert.equal(filterPills([pill], 'HVAC-03').length, 1);
  assert.equal(filterPills([pill], 'absentword').length, 0);
  const html = pillMarkup(pill);
  for (const action of pill.actions) assert.ok(html.includes(`id="${pill.id}-${action.id}"`));
  assert.ok(html.includes(pill.version));
  assert.ok(pillMarkup({...pill, name:'<script>alert(1)</script>'}).includes('&lt;script&gt;'));
});
test('collapsed history retains all messages and escapes user content', () => {
  const messages = Array.from({length:8}, (_, i) => ({role:'user',content:`Message ${i} <img>`}));
  for (const html of [recentMessages({messages}),chatHistoryMarkup(messages)]) {
    assert.ok(html.includes('<details')); assert.ok(!html.includes('<img>'));
    for(let i=0;i<8;i++) assert.ok(html.includes(`Message ${i}`));
    assert.ok(html.indexOf('</details>') < html.indexOf('Message 7'));
  }
});
