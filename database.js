import { DatabaseSync, backup } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const conflict = () => Object.assign(new Error('Shared data changed or is busy. Reload and retry.'), { status: 409 });
export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS collections(name TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(collection,id));
    CREATE TABLE IF NOT EXISTS shared_sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts(address TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const context = new AsyncLocalStorage();
  const leaseContext = new AsyncLocalStorage();
  function snapshot(name, seed) {
    const revision = db.prepare('SELECT revision FROM collections WHERE name=?').get(name)?.revision ?? -1;
    return { revision, records: revision < 0 ? seed() : db.prepare('SELECT value FROM records WHERE collection=? ORDER BY rowid').all(name).map(row => JSON.parse(row.value)), dirty: false };
  }
  function current(name, seed) {
    const state = context.getStore();
    if (!state) return snapshot(name, seed);
    if (!state.has(name)) state.set(name, snapshot(name, seed));
    return state.get(name);
  }
  function commit(state) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE'); begun = true;
      for (const lease of leaseContext.getStore() || []) if (!db.prepare('SELECT 1 FROM leases WHERE name=? AND owner=? AND expires>?').get(lease.name, lease.owner, Date.now())) throw conflict();
      for (const [name, entry] of state) if ((db.prepare('SELECT revision FROM collections WHERE name=?').get(name)?.revision ?? -1) !== entry.revision) throw conflict();
      for (const [name, entry] of state) {
        if (!entry.dirty) continue;
        db.prepare('DELETE FROM records WHERE collection=?').run(name);
        const insert = db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?)');
        for (const record of entry.records) { if (!record || typeof record.id !== 'string') throw new Error('Stored records require IDs.'); insert.run(name, record.id, JSON.stringify(record)); }
        db.prepare('INSERT INTO collections(name,revision) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision').run(name, entry.revision + 1);
      }
      db.exec('COMMIT');
    } catch (error) { if (begun) db.exec('ROLLBACK'); if (/busy|locked/i.test(error.message)) throw conflict(); throw error; }
  }
  const service = {
    file,
    read(name, seed = () => []) { return structuredClone(current(name, seed).records); },
    async transaction(fn) {
      if (context.getStore()) return fn();
      const state = new Map();
      return context.run(state, async () => { const result = await fn(); commit(state); return result; });
    },
    mutate(name, seed, fn) {
      return service.transaction(async () => { const entry = current(name, seed), copy = structuredClone(entry.records); const result = await fn(copy); entry.records = copy; entry.dirty = true; return result; });
    },
    initialized() { return db.prepare("SELECT value FROM settings WHERE name='initialized'").get()?.value === 'true'; },
    clearRuntime() { db.exec('DELETE FROM shared_sessions; DELETE FROM leases; DELETE FROM login_attempts;'); },
    markInitialized() { db.prepare("INSERT INTO settings VALUES('initialized','true') ON CONFLICT(name) DO UPDATE SET value='true'").run(); },
    setting(name, value) {
      if (value !== undefined) db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
      const row = db.prepare('SELECT value FROM settings WHERE name=?').get(name); return row ? JSON.parse(row.value) : null;
    },
    consumeLoginAttempt(address, now) {
      db.prepare('DELETE FROM login_attempts WHERE expires <= ?').run(now);
      if (db.prepare('SELECT count(*) AS n FROM login_attempts').get().n >= 10000) throw Object.assign(new Error('Too many login attempts.'), { status: 429 });
      const result = db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(address) DO UPDATE SET attempts=attempts+1 WHERE attempts<10 RETURNING attempts').get(address, now + 15 * 60000);
      if (!result) throw Object.assign(new Error('Too many attempts. Try again later.'), { status: 429 });
    },
    clearLoginAttempts(address) { db.prepare('DELETE FROM login_attempts WHERE address=?').run(address); },
    isLeased(name) { return Boolean(db.prepare('SELECT 1 FROM leases WHERE name=? AND expires>?').get(name, Date.now())); },
    status() { return { driver: 'sqlite', schemaVersion: 1, integrity: db.prepare('PRAGMA quick_check').get().quick_check, coordination: 'same-host-shared-file', collections: db.prepare('SELECT name,revision FROM collections').all() }; },
    async withLease(name, fn) {
      const owner = randomUUID();
      const renew = () => db.prepare('UPDATE leases SET expires=? WHERE name=? AND owner=?').run(Date.now() + 120000, name, owner).changes;
      const acquired = db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires < ?').run(name, owner, Date.now() + 120000, Date.now()).changes;
      if (!acquired) throw Object.assign(new Error('This operation is running on another instance.'), { status: 409 });
      let lost = false;
      const timer = setInterval(() => { try { if (!renew()) lost = true; } catch { lost = true; } }, 30000); timer.unref();
      try { const value = await leaseContext.run([...(leaseContext.getStore() || []), { name, owner }], () => fn(() => { if (lost) throw conflict(); })); if (lost) throw conflict(); return value; }
      finally { clearInterval(timer); db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name, owner); }
    },
    sessions: {
      get size() { return db.prepare('SELECT count(*) AS n FROM shared_sessions').get().n; },
      get(id) { if (!id) return undefined; const row = db.prepare('SELECT value FROM shared_sessions WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; },
      set(id, value) { db.prepare('INSERT OR REPLACE INTO shared_sessions VALUES(?,?)').run(id, JSON.stringify(value)); },
      delete(id) { if (id) db.prepare('DELETE FROM shared_sessions WHERE id=?').run(id); },
      *[Symbol.iterator]() { for (const row of db.prepare('SELECT * FROM shared_sessions').all()) yield [row.id, JSON.parse(row.value)]; }
    },
    async snapshot(destination) { await backup(db, destination); const copy = new DatabaseSync(destination); try { copy.exec('DELETE FROM shared_sessions; DELETE FROM leases; DELETE FROM login_attempts; PRAGMA wal_checkpoint(TRUNCATE);'); } finally { copy.close(); } chmodSync(destination, 0o600); },
    close() { db.close(); }
  };
  return service;
}
