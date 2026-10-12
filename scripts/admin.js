import { createAuth } from '../auth.js';
import { backupData, restoreData } from '../runtime.js';
import { loadLocalEnv } from '../config.js';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

loadLocalEnv();
const root = fileURLToPath(new URL('../', import.meta.url)), directory = join(root, 'data');
const [command, ...args] = process.argv.slice(2);
const lock = join(root, '.assetops-lock');
let locked = false;
try {
  if (!['bootstrap', 'backup', 'restore'].includes(command)) throw new Error('Usage: npm run admin -- bootstrap <username> <name> | backup | restore <backup-directory> --confirm');
  if (process.env.DATA_FILE || process.env.PILL_DATA_FILE) throw new Error('This local administration command supports the default data directory only. Remove custom path configuration or back up all configured stores together using your deployment tooling.');
  await mkdir(lock); locked = true;
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }), { mode: 0o600 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (command === 'bootstrap') {
    if (!args[0] || !args[1]) throw new Error('Provide username and display name.');
    let password = process.env.ASSETOPS_ADMIN_PASSWORD;
    if (!password) {
      if (!process.stdin.isTTY) throw new Error('Set ASSETOPS_ADMIN_PASSWORD for noninteractive initialization.');
      process.stdout.write('New password (12+ characters; input hidden): ');
      const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
      const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
      try { password = await rl.question(''); } finally { rl.close(); muted.end(); process.stdout.write('\n'); }
    }
    const user = await createAuth(join(directory, 'users.json')).create({ username: args[0], name: args[1], roles: ['admin'], password }, true);
    console.log(`Administrator created: ${user.username}`);
  } else if (command === 'backup') {
    const destination = join(root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    console.log(JSON.stringify(await backupData(directory, destination), null, 2));
  } else {
    if (!args[0] || args[1] !== '--confirm') throw new Error('Restore requires a backup directory and --confirm. Stop the server first.');
    const source = resolve(args[0]); await readFile(join(source, 'manifest.json'));
    const result = await restoreData(source, directory);
    console.log(`Restored. Previous data retained at ${result.previous}. All sessions are revoked on restart.`);
  }
} catch (error) { console.error(error.code === 'EEXIST' ? 'Data is locked. Stop the server before administration.' : error.message); process.exitCode = 1; }
finally { if (locked) await rm(lock, { recursive: true, force: true }); }
