import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { extractDocument, uploadLimit } from '../document-parser.js';
import { createKnowledgeCaptureAgent, validateCapture } from '../knowledge-agent.js';
import { createPillStudio } from '../pill-studio.js';
import { createHandler } from '../server.js';
import { ahuPill } from '../triage.js';
import { captureMarkup } from '../public/knowledge.js';

const source = 'For AHU cooling complaints, verify reported room temperature. Do not change setpoints.';
const blocks = [{ id: 'B1', location: 'Page 1', text: source }];
const proposal = () => ({ candidates: [
  { key: 'r1', type: 'rule', title: 'Verify readings', text: 'Verify reported room temperature.', evidence: [{ blockId: 'B1', quote: 'verify reported room temperature' }], relatedRuleKeys: [], relatedActionKeys: ['a1'], missing: [] },
  { key: 'a1', type: 'action', title: 'Record reading', text: 'Verify reported room temperature.', evidence: [{ blockId: 'B1', quote: 'verify reported room temperature' }], relatedRuleKeys: ['r1'], relatedActionKeys: [], missing: ['Responsible role is not specified.'] },
  { key: 'b1', type: 'boundary', title: 'No setpoint changes', text: 'Do not change setpoints.', evidence: [{ blockId: 'B1', quote: 'Do not change setpoints.' }], relatedRuleKeys: [], relatedActionKeys: [], missing: [] }
], questions: ['Who is responsible for collecting readings?'], conflicts: [] });
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-capture-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pills.json');
  const studio = createPillStudio(file, { parser: async () => ({ blocks, warnings: [] }), captureAgent: async () => ({ ...validateCapture(proposal(), blocks), model: 'test', promptVersion: 'test-v1' }), ...options });
  return { studio, file };
}
async function upload(studio) { return studio.upload(ahuPill.id, 0, 'ahu.txt', Buffer.from(source)); }
test('document extraction receives the saved non-AHU domain without publishing it', async t => {
  let scope;
  const { studio } = await setup(t, { captureAgent: async doc => { scope = doc.domain; return { candidates: [], questions: [], conflicts: [] }; } });
  let record = await studio.get(ahuPill.id); const content = structuredClone(record.content);
  content.pill.domain = 'energy'; content.pill.applicability = { categories: ['energy'], assetPrefixes: [], keywords: [] };
  record = await studio.change(record.id, 'save', { revision: record.revision, content });
  record = await studio.upload(record.id, record.revision, 'energy.txt', Buffer.from('Energy observations'));
  await studio.analyze(record.id, record.documents[0].id, record.revision);
  assert.equal(scope, 'energy'); assert.equal((await studio.library()).length, 0);
});
async function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : JSON.stringify(body)]);
  Object.assign(req, { method, url, headers: { host: 'localhost', ...headers } }); let status, response, responseHeaders;
  await handler(req, { writeHead(code, values) { status = code; responseHeaders = values; }, end(value) { response = Buffer.isBuffer(value) ? value : JSON.parse(value); } });
  return { status, body: response, headers: responseHeaders };
}

test('text parser preserves locations and rejects binary, oversized and unsupported sources', async () => {
  const result = await extractDocument('notes.md', Buffer.from('AHU\n\nRecord readings.'));
  assert.equal(result.blocks[1].location, 'Paragraph 2');
  for (const [name, bytes] of [['script.exe', Buffer.from('abc')], ['fake.pdf', Buffer.from('abc')], ['binary.txt', Buffer.from([0, 1])], ['long.txt', Buffer.from('x'.repeat(60001))], ['empty.txt', Buffer.alloc(0)], ['large.txt', Buffer.alloc(uploadLimit + 1)]]) await assert.rejects(extractDocument(name, bytes), { status: 422 });
});
test('DOCX parser preserves paragraph order', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>AHU checks</w:t></w:r></w:p><w:p><w:r><w:t>Verify room temperature.</w:t></w:r></w:p></w:body></w:document>');
  const result = await extractDocument('ahu.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result.blocks[0].text, 'AHU checks'); assert.equal(result.blocks[1].location, 'Paragraph 2');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Temperature</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>29 C</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  const table = await extractDocument('table.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.match(table.blocks[0].text, /Row 1: Column 1: Temperature \| Column 2: 29 C/);
  assert.ok(table.warnings.some(w => w.includes('merged cells')));
});
test('PDF parser preserves page citations and gives actionable feedback on image-only pages', async () => {
  function pdf(text) {
    const stream = text ? 'BT /F1 12 Tf 20 100 Td (Verify AHU readings.) Tj ET' : '';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let output = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((obj, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${obj}\nendobj\n`; });
    const start = Buffer.byteLength(output); output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(output);
  }
  const result = await extractDocument('ahu.pdf', pdf(true));
  assert.equal(result.blocks[0].location, 'Page 1'); assert.ok(result.blocks[0].text.includes('Verify AHU readings.'));
  await assert.rejects(extractDocument('scan.pdf', pdf(false)), error => error.message.includes('OCR'));
});
test('candidate validation rejects invented citations and invalid links; references remain exact', () => {
  const result = validateCapture(proposal(), blocks);
  assert.equal(result.candidates[0].evidence[0].quote, 'verify reported room temperature');
  assert.equal(result.candidates[0].relatedActionIds[0], result.candidates[1].id);
  for (const edit of [v => { v.candidates[0].evidence[0].quote = 'invented temperature 23'; }, v => { v.candidates[0].evidence[0].blockId = 'B9'; }, v => { v.candidates[0].relatedActionKeys = ['missing']; }, v => { v.candidates[0].relatedActionKeys = ['r1']; }, v => { v.candidates[0].type = 'publish'; }]) { const v = proposal(); edit(v); assert.throws(() => validateCapture(v, blocks), { status: 502 }); }
});
test('capture adapter uses the configured model, batches blocks, validates all results and sanitizes provider errors', async () => {
  const env = { SOCLAAS_BASE_URL: 'https://provider.test/v1', SOCLAAS_API_KEY: 'test-secret', SOCLAAS_MODEL: 'test-model' };
  let calls = 0;
  const agent = createKnowledgeCaptureAgent({ env, fetchImpl: async (url, options) => {
    calls++; assert.equal(String(url), 'https://provider.test/v1/chat/completions'); assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body); assert.equal(request.model, 'test-model');
    assert.ok(request.messages[0].content.includes('untrusted data'));
    const content = calls === 1 ? proposal() : { candidates: [], questions: [], conflicts: [] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }) };
  } });
  const result = await agent({ name: 'ahu.txt', blocks: [...blocks, { id: 'B2', location: 'Paragraph 2', text: 'x'.repeat(12000) }] });
  assert.equal(calls, 2); assert.equal(result.candidates.length, 3);
  const unconfigured=await createKnowledgeCaptureAgent({ env: {} })({ blocks });assert.equal(unconfigured.sourceOnly,true);assert.equal(unconfigured.captureCompleteness,'partial');
  for (const status of [401,429,500]){const partial=await createKnowledgeCaptureAgent({env,fetchImpl:async()=>({ok:false,status})})({blocks});assert.equal(partial.captureCompleteness,'partial');assert.equal(partial.sourceOnly,true);assert.ok(!JSON.stringify(partial).includes('test-secret'));}
});
test('upload, extraction, selective human correction and merge persist citations without publishing', async t => {
  const { studio, file } = await setup(t);
  let record = await upload(studio); const id = record.documents[0].id;
  assert.equal(record.content.sources.length, 0);
  record = await studio.analyze(record.id, id, record.revision);
  assert.equal(record.content.sources.length, 0); assert.equal(record.documents[0].status, 'extracted');
  const selected = record.documents[0].candidates;
  await assert.rejects(studio.merge(record.id, id, { revision: record.revision, reviewer: 'A', confirmed: true, selections: [{ id: selected[1].id, text: selected[1].text }] }), { status: 422 });
  record = await studio.merge(record.id, id, { revision: record.revision, reviewer: 'Engineer', confirmed: true, selections: selected.slice(0, 2).map(c => ({ id: c.id, text: c.text + ' Confirm with the site team.' })) });
  assert.equal(record.state, 'draft'); assert.equal(record.validation, null); assert.equal(record.releases.length, 0);
  const saved = await createPillStudio(file).get(record.id);
  assert.equal(saved.captureHistory[0].decisions[2].decision, 'rejected');
  assert.ok(saved.captureHistory[0].decisions[0].reviewedText.includes('site team'));
  assert.equal(saved.captureHistory[0].decisions[0].evidence[0].location, 'Page 1');
  assert.equal(saved.content.pill.actions.at(-1).requiresApproval, true); assert.equal(saved.content.pill.actions.at(-1).owner, '待确认');
  assert.equal(saved.content.pill.rules.at(-1).actionIds[0], saved.content.pill.actions.at(-1).id);
  assert.ok(saved.content.sources[0].reference.includes(id));
  assert.deepEqual((await studio.original(record.id, id)).bytes, Buffer.from(source));
  await assert.rejects(studio.merge(record.id, id, { revision: record.revision }), { status: 409 });
});
test('failed extraction can retry; duplicate requests and stale merges are rejected', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const { studio } = await setup(t, { captureAgent: async () => { calls++; if (calls === 1) { await gate; throw new Error('secret provider detail'); } return { ...validateCapture(proposal(), blocks), model: 'test', promptVersion: 'v1' }; } });
  let record = await upload(studio); const id = record.documents[0].id;
  const pending = studio.analyze(record.id, id, record.revision);
  await assert.rejects(studio.analyze(record.id, id, record.revision), { status: 409 });
  release(); await assert.rejects(pending, error => !error.message.includes('secret provider'));
  record = await studio.get(record.id); assert.equal(record.documents[0].status, 'failed');
  record = await studio.analyze(record.id, id, record.revision);
  await assert.rejects(studio.merge(record.id, id, { revision: record.revision - 1 }), { status: 409 });
  await assert.rejects(studio.analyze(record.id, id, record.revision), { status: 409 });
});
test('document endpoints enforce upload types, revisions, download ownership and escaping', async t => {
  const { studio } = await setup(t); const handler = createHandler({ list: async () => [] }, undefined, undefined, studio);
  const response = await request(handler, 'POST', `/api/studio/${ahuPill.id}/documents`, Buffer.from(source), { 'x-filename': encodeURIComponent('ahu<test>.txt'), 'x-revision': '0' });
  assert.equal(response.status, 201);
  const record = response.body.record, id = record.documents[0].id;
  assert.equal((await request(handler, 'GET', `/api/studio/other/documents/${id}/file`)).status, 404);
  const original = await request(handler, 'GET', `/api/studio/${record.id}/documents/${id}/file`);
  assert.equal(original.status, 200); assert.equal(original.headers['Content-Type'], 'application/octet-stream');
  const html = captureMarkup(record); assert.ok(!html.includes('ahu<test>')); assert.ok(html.includes('ahu&lt;test&gt;'));
  assert.equal((await request(handler, 'POST', `/api/studio/${record.id}/documents`, Buffer.from('x'), { 'x-filename': '../bad.txt', 'x-revision': '1' })).status, 422);
  assert.equal((await request(handler, 'POST', `/api/studio/${record.id}/documents`, Buffer.from(source), { 'x-filename': 'again.txt', 'x-revision': '1' })).status, 409);
});

test('candidate draft saves edits without confirming knowledge and rejects stale revisions', async t => {
 const {studio}=await setup(t);let record=await upload(studio);const id=record.documents[0].id;record=await studio.analyze(record.id,id,record.revision);const revision=record.revision;const items=record.documents[0].candidates.map(c=>({id:c.id,text:c.text,selected:true}));items[0].text+=' Reviewed.';
 record=await studio.saveCaptureDraft(record.id,id,{revision,items,actionOwner:'Duty manager'});const loaded=await studio.get(record.id);assert.deepEqual(loaded.documents[0].reviewDraft.items,items);assert.equal(loaded.documents[0].status,'extracted');assert.equal(loaded.content.sources.length,0);assert.equal(loaded.state,'draft');assert.equal(loaded.documents[0].review,undefined);await assert.rejects(studio.saveCaptureDraft(record.id,id,{revision,items,actionOwner:'Duty manager'}),{status:409});
});

test('reviewed source can be checked again without changing confirmed knowledge before review', async t => {
 const {studio}=await setup(t);
 let record=await upload(studio);const docId=record.documents[0].id;
 record=await studio.analyze(record.id,docId,record.revision);
 const accept=r=>({revision:r.revision,confirmed:true,reviewer:'QA',actionOwner:'Duty manager',selections:r.documents[0].candidates.map(c=>({id:c.id,text:c.text,replaceId:c.replacementTargetId||''}))});
 record=await studio.merge(record.id,docId,accept(record));
 const before=structuredClone(record.content),review=structuredClone(record.documents[0].review);
 record=await studio.analyze(record.id,docId,record.revision,true);
 assert.deepEqual(record.content,before);
 assert.deepEqual(record.documents[0].repairReview,review);
 assert.deepEqual(record.documents[0].extractionHistory.at(-1).review,review);
 record=await studio.merge(record.id,docId,accept(record));
 assert.equal(record.content.pill.rules.length,before.pill.rules.length);
 assert.equal(record.content.pill.actions.length,before.pill.actions.length);
 assert.equal(record.content.pill.rules.at(-1).id,before.pill.rules.at(-1).id);
 assert.equal(record.content.pill.actions.at(-1).id,before.pill.actions.at(-1).id);
 assert.equal(record.captureHistory.length,2);
});

test('pending source proposals cannot be submitted as reviewed knowledge',async t=>{
 const {studio}=await setup(t);let r=await upload(studio);await assert.rejects(studio.change(r.id,'submit',{revision:r.revision,autoValidate:true}),/pending source proposals/);
});

test('incomplete extraction is persisted as a reviewable draft and cannot be submitted or published',async t=>{
 const partialAgent=createKnowledgeCaptureAgent({env:{},fetchImpl:async()=>assert.fail('No model configured')});const {studio}=await setup(t,{captureAgent:partialAgent});let r=await upload(studio);r=await studio.analyze(r.id,r.documents[0].id,r.revision);const doc=r.documents[0];assert.equal(doc.status,'extracted');assert.equal(doc.captureCompleteness,'partial');assert.ok(doc.candidates.length);assert.equal((await studio.get(r.id)).documents[0].sourceOnly,true);
 await assert.rejects(studio.merge(r.id,doc.id,{revision:r.revision,confirmed:true,reviewer:'Expert',selections:[]}),/complete the pending extraction/);
 for(const operation of ['submit','publish'])await assert.rejects(studio.change(r.id,operation,{revision:r.revision}),/Complete the pending source extraction/);
});
