import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPillStudio} from '../pill-studio.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { canonicalPath, caseRoute } from '../public/routes.js';
import { createHandler } from '../server.js';

test('old links resolve to four workspaces and preserve case identity and stage', () => {
  for (const [old, current] of [['/', '/studio'], ['/dashboard', '/studio'], ['/overview', '/studio'], ['/overview/analytics', '/studio/analytics'], ['/incidents', '/cases'], ['/incidents/new', '/cases/new'], ['/incidents/INC-1/edit', '/cases/INC-1/edit'], ['/triage/INC-1', '/cases/INC-1/triage'], ['/review/INC-1', '/cases/INC-1/review'], ['/triage', '/cases/triage'], ['/review', '/cases/review'], ['/learning', '/studio'], ['/studio/improvements', '/studio'], ['/governance', '/studio']]) {
    assert.equal(canonicalPath(old), current);
    assert.equal(canonicalPath(current), current);
  }
  assert.deepEqual(caseRoute('/cases/INC-1/triage'), { id: 'INC-1', stage: 'triage', legacy: '/triage/INC-1' });
  assert.deepEqual(caseRoute('/cases/INC-1/review'), { id: 'INC-1', stage: 'review', legacy: '/review/INC-1' });
  assert.deepEqual(caseRoute('/cases/INC-1/edit'), { id: 'INC-1', stage: 'intake', legacy: '/incidents/INC-1/edit' });
  assert.equal(caseRoute('/cases/INC-1/unknown'), null);
});

test('module API exposes four workspaces; demo knowledge remains in Studio, not approved library', async t => {
  const dir=await mkdtemp(join(tmpdir(),'workspace-routes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const candidate = { id: 'feedback', pillId: 'assetops-ahu-cooling' };
  const handler = createHandler({ list: async () => [{ learningCandidates: [candidate] }] },undefined,undefined,createPillStudio(join(dir,'pills.json')));
  const get = async url => {
    const req = Readable.from([]); Object.assign(req, { method: 'GET', url, headers: { host: 'localhost' } });
    let result;
    await handler(req, { writeHead(code) { assert.equal(code, 200); }, end(body) { result = JSON.parse(body); } });
    return result;
  };
  assert.deepEqual((await get('/api/modules')).modules.map(m => m.id), ['overview', 'cases', 'studio', 'library']);
  const studio = await get('/api/studio');
  assert.equal(studio.drafts[0].status, 'demo');
  assert.deepEqual(studio.candidates, [candidate]);
  assert.deepEqual((await get('/api/library')).pills, []);
  assert.equal((await get('/api/governance')).pills[0].id, studio.drafts[0].id);
});
