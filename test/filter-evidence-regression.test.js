import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderTasks } from '../public/tasks.js';
import { validateTriageResult } from '../triage.js';

const pill = { id: 'filter-test', rules: [{ id: 'R1', actionIds: ['A1'] }], actions: [{ id: 'A1', ruleIds: ['R1'], title: 'Check filter', instruction: 'Check filter' }] };
const snapshot = { fields: { description: 'Low airflow; filter pressure is high.', observations: 'Filter pressure is high.' } };
const report = () => ({ summary: 'Possible filter blockage.', hypotheses: [{ ruleId: 'R1', reasoning: 'Check the filter.', evidence: [{field:'observations', quote:'Filter pressure is high.'}], uncertainties: ['Inspect the filter.'] }], actionIds: ['A1'], missingFields: [], prioritySuggestion: null });
test('filter-only reports reject unrelated valve caveats in all narrative sections', () => {
  for (const area of ['summary', 'reasoning', 'uncertainty', 'priority']) {
    const value = report(), unrelated = 'Actual valve position and water flow are unverified.';
    if (area === 'summary') value.summary = unrelated;
    if (area === 'reasoning') value.hypotheses[0].reasoning = unrelated;
    if (area === 'uncertainty') value.hypotheses[0].uncertainties = [unrelated];
    if (area === 'priority') value.prioritySuggestion = {value:'medium', reason:unrelated};
    assert.throws(() => validateTriageResult(value, snapshot, pill), /unrelated to the supplied case and Pill/);
  }
});
test('evidence picker shows short readable labels, previews full text, and submits original IDs', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const old = {document:global.document, fetch:global.fetch, FormData:global.FormData};
  const notes = 'SIMULATED: Filter inspection ' + 'details '.repeat(40) + '<unsafe>';
  const data = {revision:1, reviews:[], tasks:[{id:'T1',title:'Inspect filter',instruction:'Inspect',events:[],status:'in_progress',authorizationCurrent:true,assignee:'Test',dueAt:'2026-10-12T10:00:00Z'}], handlingRecords:[{id:'OPS-long-original-id',kind:'action',notes,occurredAt:'2026-10-12T06:00:00Z'}]};
  let submitted;
  Object.assign(global,{document:dom.window.document,FormData:dom.window.FormData,fetch:async (url, opts) => {if(opts.method === 'POST') submitted=JSON.parse(opts.body); return {ok:true,json:async()=>data};}});
  try {
    const root=document.querySelector('#root'); await renderTasks(root,'CASE'); root.querySelector('[data-task]').click();
    const form=root.querySelector('.task-detail form'); form.elements.operation.value='submit'; form.elements.operation.onchange();
    const picker=form.elements.actionRecordId, option=picker.options[1];
    assert.ok(option.textContent.length < 100); assert.ok(!option.textContent.includes('OPS-')); assert.equal(option.value,'OPS-long-original-id');
    picker.value=option.value; picker.onchange(); assert.ok(root.querySelector('.evidence-preview').textContent.includes(notes)); assert.equal(root.querySelector('.evidence-preview unsafe'),null);
    form.elements.notes.value='Simulated evidence'; form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await new Promise(resolve=>setImmediate(resolve)); assert.equal(submitted.actionRecordId,'OPS-long-original-id');
  } finally {Object.assign(global,old);dom.window.close();}
});
