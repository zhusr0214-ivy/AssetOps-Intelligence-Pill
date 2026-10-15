import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIncidentStore } from '../incident-store.js';
import { createCaseDocuments, validateDocumentAnswer, createDocumentAnswer } from '../case-documents.js';
import { permitted } from '../auth.js';
import { Readable } from 'node:stream';
import { createHandler } from '../server.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'case-docs-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createIncidentStore(join(dir, 'incidents.json'));
  const incident = await store.create({ title: 'Test', description: 'Confirmed description', status: 'ready_for_triage', revision: 0 });
  return { store, incident };
}
test('real TXT extraction persists case attachments and questions without modifying facts or approval', async t => {
  const { store, incident } = await setup(t);
  let supplied;
  const service = createCaseDocuments(store, { answer: async context => { supplied = context; return { answer: 'The note reports 24 C.', insufficient: false, citations: [{ documentId: context.documents[0].id, blockId: 'B1', quote: 'Temperature 24 C' }] }; } });
  const uploaded = await service.upload(incident.id, 'notes.txt', Buffer.from('Temperature 24 C'));
  assert.equal(uploaded.caseDocuments[0].blocks[0].text, 'Temperature 24 C');
  const saved = await service.ask(incident.id, { question: 'What temperature?', documentIds: [uploaded.caseDocuments[0].id] });
  assert.equal(supplied.documents.length, 1);
  assert.equal(saved.documentMessages.length, 2);
  assert.equal(saved.documentMessages[1].citations[0].filename, 'notes.txt');
  assert.equal(saved.description, incident.description);
  assert.equal(saved.status, 'ready_for_triage');
  assert.equal(saved.reviews, undefined);
  assert.equal(saved.triageReports, undefined);
  assert.equal((await store.list())[0].documentMessages[1].content, 'The note reports 24 C.');
});
test('rejects foreign attachments, invalid files, bad citations and oversized questions', async t => {
  const { store, incident } = await setup(t);
  let calls = 0;
  const service = createCaseDocuments(store, { answer: async () => { calls++; return { answer: 'bad', insufficient: false, citations: [{ documentId: 'foreign', blockId: 'B1', quote: 'fake' }] }; } });
  await assert.rejects(service.upload(incident.id, '../file.txt', Buffer.from('x')), /filename/);
  await assert.rejects(service.upload(incident.id, 'run.exe', Buffer.from('x')), /Use PDF/);
  await assert.rejects(service.upload(incident.id, 'empty.txt', Buffer.alloc(0)), /nonempty/);
  await assert.rejects(service.ask(incident.id, { question: 'q', documentIds: ['foreign'] }), /does not belong/);
  await assert.rejects(service.ask(incident.id, { question: 'x'.repeat(2001), documentIds: ['foreign'] }), /2000/);
  assert.equal(calls, 0);
  const uploaded = await service.upload(incident.id, 'notes.md', Buffer.from('Evidence'));
  await assert.rejects(service.ask(incident.id, { question: 'q', documentIds: [uploaded.caseDocuments[0].id] }), /does not match/);
  assert.equal((await store.list())[0].documentMessages, undefined);
  assert.throws(() => validateDocumentAnswer({ answer: 'Claim', insufficient: false, citations: [] }, []), /Invalid/);
});
test('limits attachment counts and fences concurrent case changes during model requests', async t => {
  const { store, incident } = await setup(t);
  const service = createCaseDocuments(store, { parse: async () => ({ blocks: [{ id: 'B1', text: 'Note', location: 'Paragraph 1' }], warnings: [] }), answer: async () => {
    const current = (await store.list())[0]; await store.update(incident.id, { title: 'Concurrent change' }, current.revision);
    return { answer: 'Insufficient evidence', insufficient: true, citations: [] };
  } });
  let current;
  for (let n = 0; n < 5; n++) current = await service.upload(incident.id, `${n}.txt`, Buffer.from('Note'));
  await assert.rejects(service.upload(incident.id, '6.txt', Buffer.from('Note')), /up to 5/);
  await assert.rejects(service.ask(incident.id, { question: 'q', documentIds: [current.caseDocuments[0].id] }), /case changed/);
  assert.equal((await store.list())[0].title, 'Concurrent change');
  assert.equal((await store.list())[0].documentMessages, undefined);
});
test('document model uses untrusted reference context and upload is operator-authorized', async () => {
  let request;
  const answer = createDocumentAnswer({ env: { SOCLAAS_API_KEY: 'test-key', SOCLAAS_BASE_URL: 'https://model.example/v1' }, fetchImpl: async (url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Unknown', insufficient: true, citations: [] }) } }] }) }; } });
  await answer({ question: 'q', documents: [] });
  assert.match(request.messages[0].content, /untrusted data/);
  assert.match(request.messages[0].content, /Never approve/);
  assert.equal(permitted({ roles: ['viewer'] }, '/api/incidents/C1/documents', 'POST'), false);
  assert.equal(permitted({ roles: ['operator'] }, '/api/incidents/C1/documents', 'POST'), true);
  assert.equal(permitted({ roles: ['viewer'] }, '/api/incidents/C1/document-questions', 'POST'), false);
});

test('attachment HTTP endpoint accepts bounded binary uploads and validates filenames', async t => {
  const { store, incident } = await setup(t), handler = createHandler(store);
  const request = async (filename, bytes) => {
    const req = Readable.from([bytes]); Object.assign(req, { method: 'POST', url: `/api/incidents/${incident.id}/documents`, headers: { host: 'localhost', 'x-filename': filename } });
    let status, result;
    await handler(req, { writeHead(code) { status = code; }, end(body) { result = JSON.parse(body); } });
    return { status, result };
  };
  const saved = await request('notes.txt', Buffer.from('Inspection notes'));
  assert.equal(saved.status, 201);
  assert.equal(saved.result.incident.caseDocuments[0].filename, 'notes.txt');
  assert.equal((await request('%invalid', Buffer.from('x'))).status, 400);
  assert.equal((await request('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
});
