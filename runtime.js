import { appendFile, mkdir, readFile, writeFile, readdir, lstat, copyFile, rename, rm, open, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function createAudit(directory) {
  let queue = Promise.resolve();
  return {
    write(event) {
      const pending = queue.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await appendFile(join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
      }); queue = pending.catch(() => {}); return pending;
    },
    async recent() {
      await queue;
      try {
        const file = await open(join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'r');
        try {
          const { size } = await file.stat(), start = Math.max(0, size - 131072), buffer = Buffer.alloc(size - start);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
          if (start) lines.shift();
          return lines.filter(Boolean).slice(-100).map(line => JSON.parse(line));
        } finally { await file.close(); }
      }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    }
  };
}

// The caller must quiesce all writes. The CLI refuses operation while the server lock exists.
export async function backupData(directory, destination) {
  const files = [];
  async function visit(folder) {
    for (const name of await readdir(folder)) {
      if (['backups', 'audit', '.server-lock'].includes(name) || name.endsWith('.tmp')) continue;
      const path = join(folder, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Backup refuses symbolic links.');
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        const bytes = await readFile(path), name = relative(directory, path);
        await mkdir(dirname(join(destination, name)), { recursive: true, mode: 0o700 });
        await writeFile(join(destination, name), bytes, { mode: 0o600 });
        files.push({ name, size: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await mkdir(destination, { recursive: true, mode: 0o700 }); await visit(directory);
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files }, null, 2), { mode: 0o600 });
  return { name: destination, files: files.length };
}
export async function restoreData(source, directory) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Backup refuses symbolic links.');
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid or empty backup manifest.');
  const names = new Set();
  for (const file of manifest.files) {
    if (typeof file.name !== 'string' || isAbsolute(file.name) || file.name.split(/[\\/]/).some(p => !p || ['.', '..', '.server-lock', 'backups', 'audit'].includes(p)) || names.has(file.name)) throw new Error('Invalid backup path.');
    names.add(file.name);
    let cursor = source;
    for (const part of file.name.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Backup refuses symbolic links.'); }
    const bytes = await readFile(join(source, file.name));
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error(`Backup integrity check failed: ${file.name}`);
  }
  const stage = `${resolve(directory)}.restore-${randomUUID()}`, previous = `${resolve(directory)}.before-${randomUUID()}`;
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const file of manifest.files) { const target = join(stage, file.name); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(join(source, file.name), target); await chmod(target, 0o600); }
    await rename(directory, previous);
    try { await rename(stage, directory); } catch (error) { await rename(previous, directory); throw error; }
    return { previous };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
