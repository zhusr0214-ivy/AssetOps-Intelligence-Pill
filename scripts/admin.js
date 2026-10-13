import { createAuth } from '../auth.js';
import { backupData, restoreData } from '../runtime.js';
import { loadLocalEnv } from '../config.js';
import { mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openDatabase } from '../database.js';
import { assertOffline, migrateToSqlite, createDatabaseBackup } from '../storage-operations.js';

loadLocalEnv();
const root = fileURLToPath(new URL('../', import.meta.url)), directory = join(root, 'data');
const [command, ...args] = process.argv.slice(2);
const lock = join(root, '.assetops-lock');
let locked = false;
async function newPassword(confirm = false) {
  const configured = process.env.ASSETOPS_ADMIN_PASSWORD;
  if (configured !== undefined && (!confirm || !process.stdin.isTTY)) {
    if (configured.length < 12 || configured.length > 128) throw new Error('Password must contain 12 to 128 characters.');
    return configured;
  }
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal or provide ASSETOPS_ADMIN_PASSWORD through a secret mechanism.');
  const hidden = async prompt => {
    process.stdout.write(prompt);
    const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    try { return await rl.question(''); }
    finally { rl.close(); muted.end(); process.stdout.write('\n'); }
  };
  const password = await hidden('New password (12-128 characters; input hidden): ');
  if (password.length < 12 || password.length > 128) throw new Error('Password must contain 12 to 128 characters.');
  if (confirm && password !== await hidden('Confirm new password (input hidden): ')) throw new Error('Passwords do not match. No account was changed.');
  return password;
}
try {
  if (!['bootstrap', 'reset-password', 'backup', 'restore', 'migrate-sqlite'].includes(command)) throw new Error('Usage: npm run admin -- bootstrap <username> <name> | reset-password <username> | migrate-sqlite | backup | restore <backup-directory> --confirm');
  if (command === 'reset-password' && (args.length !== 1 || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(args[0]))) throw new Error('Provide exactly one username: npm run admin -- reset-password <username>. Never pass a password as an argument.');
  if (process.env.DATA_FILE || process.env.PILL_DATA_FILE) throw new Error('This local administration command supports the default data directory only. Remove custom path configuration or back up all configured stores together using your deployment tooling.');
  await mkdir(lock); locked = true;
  await assertOffline(root);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }), { mode: 0o600 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let sqlite = false; try { await access(join(directory, 'assetops.sqlite')); sqlite = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (command === 'bootstrap') {
    if (!args[0] || !args[1]) throw new Error('Provide username and display name.');
    const password = await newPassword();
    const persistence = sqlite ? openDatabase(join(directory, 'assetops.sqlite')) : null;
    let user; try { user = await createAuth(join(directory, 'users.json'), { persistence }).create({ username: args[0], name: args[1], roles: ['admin'], password }, true); } finally { persistence?.close(); }
    console.log(`Administrator created: ${user.username}`);
  } else if (command === 'reset-password') {
    const persistence = sqlite ? openDatabase(join(directory, 'assetops.sqlite')) : null;
    try {
      const auth = createAuth(join(directory, 'users.json'), { persistence });
      const user = (await auth.list()).find(user => user.username === args[0]);
      if (!user) throw new Error('Username not found. No account was changed.');
      await auth.update(user.id, { password: await newPassword(true) });
      console.log(`Password reset for ${user.username}. Existing sessions revoked; roles and account status unchanged.${user.disabled ? ' This account remains disabled.' : ''}`);
    } finally { persistence?.close(); }
  } else if (command === 'migrate-sqlite') {
    const destination = join(root, 'backups', `before-migration-${Date.now()}`);
    await backupData(directory, destination);
    console.log(JSON.stringify({ migrated: await migrateToSqlite(directory), previousJsonBackup: destination, next: 'STORAGE_DRIVER=sqlite npm run dev' }, null, 2));
  } else if (command === 'backup') {
    if (sqlite) {
      const db = openDatabase(join(directory, 'assetops.sqlite'));
      try { console.log(JSON.stringify(await createDatabaseBackup(db, directory, join(root, 'backups')), null, 2)); } finally { db.close(); }
    } else {
    const destination = join(root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    console.log(JSON.stringify(await backupData(directory, destination), null, 2));
    }
  } else {
    if (!args[0] || args[1] !== '--confirm') throw new Error('Restore requires a backup directory and --confirm. Stop the server first.');
    const source = resolve(args[0]); await readFile(join(source, 'manifest.json'));
    const result = await restoreData(source, directory);
    try {
      await access(join(directory, 'assetops.sqlite'));
      const db = openDatabase(join(directory, 'assetops.sqlite')); try { db.clearRuntime(); } finally { db.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(`Restored. Previous data retained at ${result.previous}. All sessions are revoked on restart.`);
  }
} catch (error) { console.error(error.code === 'EEXIST' ? 'Data is locked. Stop the server before administration.' : error.message); process.exitCode = 1; }
finally { if (locked) await rm(lock, { recursive: true, force: true }); }
