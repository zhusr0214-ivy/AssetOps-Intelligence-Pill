import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, copyFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.js';
import { createIncidentStore } from '../incident-store.js';
import { createPillStudio } from '../pill-studio.js';
import { createAuth } from '../auth.js';
import { createLearningService, learningSnapshot } from '../learning.js';
import { migrateToSqlite, createDatabaseBackup, startBackupScheduler, registerInstance, assertOffline } from '../storage-operations.js';
import { restoreData } from '../runtime.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'assetops-db-')); const data = join(root, 'data'); await mkdir(data);
  const db = openDatabase(join(data, 'assetops.sqlite')); db.markInitialized();
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, data, db, store: createIncidentStore('unused', { persistence: db }), studio: createPillStudio(join(data, 'pills.json'), { persistence: db }) };
}
test('SQLite stores preserve IDs, revisions and seeds; transactions roll back every collection', async t => {
  const { db, store, studio } = await setup(t);
  const i = await store.create({ title: 'Original', revision: 0 });
  const p = (await studio.list())[0];
  await assert.rejects(db.transaction(async () => { await store.update(i.id, { title: 'Changed' }, 0); await studio.create({ name: 'Draft', owner: 'Team' }); throw new Error('Injected failure'); }), /Injected/);
  assert.equal((await store.list())[0].title, 'Original'); assert.equal((await studio.list()).length, 1);
  await db.transaction(async () => { await store.update(i.id, { title: 'Changed' }, 0); await studio.create({ name: 'Draft', owner: 'Team' }); });
  assert.equal((await store.list())[0].revision, 1); assert.equal((await studio.list())[0].id, p.id); assert.equal((await studio.list()).length, 2); assert.equal(db.status().integrity, 'ok');
});
test('two connections detect stale writes without losing the other instance update', async t => {
  const { db, store } = await setup(t), other = openDatabase(db.file); t.after(() => other.close());
  const second = createIncidentStore('unused', { persistence: other }), i = await store.create({ title: 'Initial', revision: 0 });
  let release, ready; const paused = new Promise(r => { release = r; }), entered = new Promise(r => { ready = r; });
  const transaction = db.transaction(async () => { await store.list(); ready(); await paused; await store.update(i.id, { title: 'Stale' }, 0); });
  await entered; await second.update(i.id, { title: 'Other instance' }, 0); release();
  await assert.rejects(transaction, { status: 409 }); assert.equal((await store.list())[0].title, 'Other instance');
});
test('shared leases reject duplicate work and release after failure', async t => {
  const { db } = await setup(t), other = openDatabase(db.file); t.after(() => other.close());
  await db.withLease('evaluation:pill', async () => { assert.equal(other.isLeased('evaluation:pill'), true); await assert.rejects(other.withLease('evaluation:pill', async () => {}), { status: 409 }); });
  await assert.rejects(db.withLease('evaluation:pill', async () => { throw new Error('failure'); }));
  assert.equal(other.isLeased('evaluation:pill'), false);
});
test('a separate process shares commits, and a lost lease fences writes', async t => {
  const { db, store } = await setup(t);
  const i = await store.create({ title: 'Parent', revision: 0 });
  const script = `import {openDatabase} from ${JSON.stringify(new URL('../database.js', import.meta.url).href)}; const db=openDatabase(process.argv[1]); await db.mutate('incidents',()=>[],items=>{items[0].title='Child';}); db.close();`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, db.file]);
  assert.equal((await store.list())[0].title, 'Child');
  const raw = new DatabaseSync(db.file);
  try {
    await assert.rejects(db.withLease('fenced', async () => {
      raw.prepare('UPDATE leases SET owner=? WHERE name=?').run('other-worker', 'fenced');
      await store.update(i.id, { title: 'Forbidden stale writer' }, 0);
    }), { status: 409 });
    assert.equal((await store.list())[0].title, 'Child');
  } finally { raw.close(); }
});
test('accounts and sessions work across instances, with shared revocation and login throttle', async t => {
  const { db } = await setup(t), other = openDatabase(db.file); t.after(() => other.close());
  const a = createAuth('unused', { persistence: db }), b = createAuth('unused', { persistence: other });
  const user = await a.create({ username: 'testadmin', name: 'Admin', roles: ['admin'], password: 'long-password-1234' }, true);
  const session = await a.login(user.username, 'long-password-1234'), req = { headers: { cookie: `assetops_session=${session.id}` } };
  assert.equal((await b.session(req)).user.id, user.id);
  await b.update(user.id, { name: 'Renamed' }); assert.equal(await a.session(req), null);
  for (let n = 0; n < 10; n++) await assert.rejects((n % 2 ? a : b).login('unknown', 'bad', 'same-address'), { status: 401 });
  await assert.rejects(a.login('unknown', 'bad', 'same-address'), { status: 429 });
});
test('migration retains JSON, refuses overwrites, and imports all collections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'assetops-migration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const json = JSON.stringify([{ id: 'INC-existing', title: 'Retained', revision: 7 }]); await writeFile(join(root, 'incidents.json'), json);
  const counts = await migrateToSqlite(root); assert.equal(counts.incidents, 1); assert.equal(counts.pills, 1);
  assert.equal(await readFile(join(root, 'incidents.json'), 'utf8'), json);
  const db = openDatabase(join(root, 'assetops.sqlite')); assert.equal(db.read('incidents')[0].revision, 7); assert.equal(db.initialized(), true); db.close();
  await assert.rejects(migrateToSqlite(root), /already exists/);
});
test('online backup snapshots database and referenced sources; restore revokes snapshot sessions', async t => {
  const { root, data, db, store } = await setup(t);
  await store.create({ title: 'Backed up', revision: 0 });
  await mkdir(join(data, 'pills.json.uploads')); await writeFile(join(data, 'pills.json.uploads', 'DOC-test'), 'original');
  await db.mutate('pills', () => [], list => list.push({ id: 'p', documents: [{ id: 'DOC-test' }] }));
  db.sessions.set('test', { userId: 'u' });
  const result = await createDatabaseBackup(db, data, join(root, 'backups'));
  const target = join(root, 'restore'); await mkdir(target); await restoreData(join(root, 'backups', result.name), target);
  const restored = openDatabase(join(target, 'assetops.sqlite'));
  assert.equal(restored.read('incidents')[0].title, 'Backed up'); assert.equal(restored.sessions.size, 0); restored.close();
  assert.equal(await readFile(join(target, 'pills.json.uploads', 'DOC-test'), 'utf8'), 'original');
});
test('scheduler runs due backups, respects interval and retains configured number', async t => {
  const { root, data, db } = await setup(t), backups = join(root, 'backups');
  const scheduler = startBackupScheduler(db, data, backups, { intervalMinutes: 1, keep: 2 });
  try { await scheduler.tick(); assert.equal(scheduler.status().last.status, 'complete'); await scheduler.tick(); assert.equal((await readdir(backups)).length, 1); }
  finally { await scheduler.stop(); }
  await createDatabaseBackup(db, data, backups, { keep: 2 }); await createDatabaseBackup(db, data, backups, { keep: 2 }); assert.equal((await readdir(backups)).length, 2);
});
test('instance registration prevents offline administration while allowing SQLite peers', async t => {
  const { root } = await setup(t);
  const first = await registerInstance(root, 'sqlite'), second = await registerInstance(root, 'sqlite');
  await assert.rejects(assertOffline(root), /Stop all/); await assert.rejects(registerInstance(root, 'json'), /SQLite instances/);
  await first(); await second(); await assertOffline(root);
  const json = await registerInstance(root, 'json'); await assert.rejects(registerInstance(root, 'sqlite'), { code: 'EEXIST' }); await json();
});
test('learning import and case receipt commit together and remain idempotent', async t => {
  const { store, studio } = await setup(t);
  let i = await store.create({ title: 'Case', category: 'water_leak', revision: 0, handlingRecords: [{ id: 'a', kind: 'action', notes: 'Checked', occurredAt: '2026-01-01' }, { id: 'o', kind: 'outcome', notes: 'Verified', occurredAt: '2026-01-02', verified: true, status: 'resolved' }] });
  const snapshot = learningSnapshot(i), proposal = { id: 'proposal', disposition: 'new_pill', applicability: 'Water leaks', limitations: 'One observation', decision: { status: 'accepted', reviewer: 'Expert', reviewedAfter: 'Check verified evidence' }, evidence: [{ blockId: 'a' }, { blockId: 'o' }] };
  i = await store.update(i.id, { learningRuns: [{ id: 'run', snapshot, proposals: [proposal] }] }, 0);
  const originalUpdate = store.update; store.update = () => { throw new Error('Injected receipt failure'); };
  const service = createLearningService(store, studio);
  await assert.rejects(service.apply(i.id, 'run', 'proposal', { name: 'Water checks', owner: 'Team' }), /receipt failure/); assert.equal((await studio.list()).length, 1);
  store.update = originalUpdate;
  const p = await service.apply(i.id, 'run', 'proposal', { name: 'Water checks', owner: 'Team' });
  assert.equal((await store.list())[0].learningRuns[0].proposals[0].importReceipt.pillId, p.id);
  assert.equal((await service.apply(i.id, 'run', 'proposal', {})).id, p.id); assert.equal((await studio.list()).length, 2);
});

test('offline CLI migrates, backs up and restores in an isolated project copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'assetops-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const name of await readdir(source)) if (name.endsWith('.js') || name === 'package.json') await copyFile(join(source, name), join(root, name));
  await cp(join(source, 'scripts'), join(root, 'scripts'), { recursive: true });
  await cp(join(source, 'pills'), join(root, 'pills'), { recursive: true });
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'incidents.json'), JSON.stringify([{ id: 'cli-case', title: 'Original', revision: 0 }]));
  const env = { ...process.env }; for (const key of ['DATA_FILE', 'PILL_DATA_FILE', 'STORAGE_DRIVER', 'SOCLAAS_API_KEY']) delete env[key];
  const cli = (...args) => promisify(execFile)(process.execPath, ['scripts/admin.js', ...args], { cwd: root, env });
  await cli('migrate-sqlite');
  const { stdout } = await cli('backup'), result = JSON.parse(stdout);
  const db = openDatabase(join(root, 'data', 'assetops.sqlite'));
  await db.mutate('incidents', () => [], records => { records[0].title = 'Later'; }); db.sessions.set('active', { userId: 'u' }); db.close();
  await cli('restore', join(root, 'backups', result.name), '--confirm');
  const restored = openDatabase(join(root, 'data', 'assetops.sqlite'));
  try { assert.equal(restored.read('incidents')[0].title, 'Original'); assert.equal(restored.sessions.size, 0); } finally { restored.close(); }
  assert.ok((await readdir(root)).some(name => name.startsWith('data.before-')));
  await assert.rejects(cli('migrate-sqlite'), /already exists/);
  assert.equal((await readdir(root)).includes('.assetops-lock'), false);
});
