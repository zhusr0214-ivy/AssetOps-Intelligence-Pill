import { mkdir, readFile, writeFile, readdir, rm, copyFile, lstat, chmod, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.js';
import { backupData } from './runtime.js';
import { createPillStudio } from './pill-studio.js';

export async function registerInstance(root, mode) {
  const gate = join(root, '.assetops-lock'), instances = join(root, '.assetops-instances');
  await mkdir(gate);
  try {
    await mkdir(instances, { recursive: true, mode: 0o700 });
    const others = await readdir(instances);
    if (mode === 'json' && others.length) throw new Error('SQLite instances are running. Stop all instances before changing storage mode.');
    if (mode === 'json') {
      await writeFile(join(gate, 'owner.json'), JSON.stringify({ pid: process.pid, mode }));
      return () => rm(gate, { recursive: true, force: true });
    }
    const marker = join(instances, `${process.pid}-${randomUUID()}.json`);
    await writeFile(marker, JSON.stringify({ pid: process.pid, mode, startedAt: new Date().toISOString() }), { mode: 0o600 });
    await rm(gate, { recursive: true, force: true });
    return () => rm(marker, { force: true });
  } catch (error) { await rm(gate, { recursive: true, force: true }); throw error; }
}
export async function assertOffline(root) {
  try { if ((await readdir(join(root, '.assetops-instances'))).length) throw new Error('Stop all SQLite instances first. Inspect stale instance markers after a crash.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function migrateToSqlite(directory) {
  const target = join(directory, 'assetops.sqlite');
  try { await lstat(target); throw new Error('Database already exists. Migration never overwrites it.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const read = async name => { try { const data = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8')); if (!Array.isArray(data)) throw new Error(`Invalid ${name} storage.`); return data; } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const values = { incidents: await read('incidents'), users: await read('users'), pills: await createPillStudio(join(directory, 'pills.json')).list() };
  const staging = `${target}.migration-${randomUUID()}`, db = openDatabase(staging);
  try {
    await db.transaction(async () => { for (const [name, rows] of Object.entries(values)) await db.mutate(name, () => [], list => { list.push(...rows); }); });
    db.markInitialized(); if (db.status().integrity !== 'ok') throw new Error('Database verification failed.');
    db.close(); await rename(staging, target);
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.length]));
  } catch (error) { try { db.close(); } catch {} await rm(staging, { force: true }); throw error; }
}
export async function createDatabaseBackup(db, directory, backupRoot, { keep = 7, dueMinutes } = {}) {
  return db.withLease('scheduled-backup', async () => {
    const last = db.setting('backup:last');
    if (dueMinutes && last && Date.now() - Date.parse(last.at) < dueMinutes * 60000) return { skipped: true };
    const id = `sqlite-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const stage = join(backupRoot, `.stage-${id}`), target = join(backupRoot, id);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      await db.snapshot(join(stage, 'assetops.sqlite'));
      const copy = openDatabase(join(stage, 'assetops.sqlite')); let pills;
      try { pills = copy.read('pills'); } finally { copy.close(); }
      const documents = [...new Set(pills.flatMap(p => (p.documents || []).map(d => d.id)))];
      if (documents.length) await mkdir(join(stage, 'pills.json.uploads'), { mode: 0o700 });
      for (const id of documents) {
        if (!/^DOC-[a-z0-9-]+$/i.test(id)) throw new Error('Invalid source identifier in snapshot.');
        const source = join(directory, 'pills.json.uploads', id), destination = join(stage, 'pills.json.uploads', id);
        if ((await lstat(source)).isSymbolicLink() || (await lstat(join(directory, 'pills.json.uploads'))).isSymbolicLink()) throw new Error('Source links are not allowed in backups.');
        await copyFile(source, destination); await chmod(destination, 0o600);
      }
      const result = await backupData(stage, target);
      db.setting('backup:last', { at: new Date().toISOString(), status: 'complete', name: id, files: result.files });
      let retentionWarning = null;
      try {
        const names = (await readdir(backupRoot)).filter(n => /^sqlite-\d{4}-.*-[a-f0-9]{8}$/.test(n)).sort().reverse();
        for (const name of names.slice(keep)) await rm(join(backupRoot, name), { recursive: true, force: true });
      } catch {
        retentionWarning = 'Backup completed, but old backups could not be removed.';
        db.setting('backup:last', { at: new Date().toISOString(), status: 'complete', name: id, files: result.files, retentionWarning });
      }
      return { name: id, files: result.files, retentionWarning };
    } catch (error) { await rm(target, { recursive: true, force: true }); db.setting('backup:last', { at: new Date().toISOString(), status: 'failed', error: 'Backup failed; inspect storage availability and source files.' }); throw error; }
    finally { await rm(stage, { recursive: true, force: true }); }
  });
}
export function startBackupScheduler(db, directory, root, { intervalMinutes = 360, keep = 7, tickMs = 60000 } = {}) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || !Number.isInteger(keep) || keep < 1 || keep > 100) throw new Error('Invalid backup schedule.');
  let pending = null;
  const tick = () => {
    if (pending) return pending;
    const last = db.setting('backup:last');
    if (last && Date.now() - Date.parse(last.at) < intervalMinutes * 60000) return Promise.resolve();
    pending = createDatabaseBackup(db, directory, resolve(root), { keep, dueMinutes: intervalMinutes }).catch(error => { if (error.status !== 409) console.error('Scheduled backup failed. Inspect admin storage status.'); }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(tick, tickMs); timer.unref();
  return { tick, async stop() { clearInterval(timer); await pending; }, status: () => ({ intervalMinutes, keep, running: Boolean(pending), last: db.setting('backup:last') }) };
}
