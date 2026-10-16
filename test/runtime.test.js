import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupData, restoreData } from '../runtime.js';
import { createModelTransport } from '../model-runtime.js';
import { recognizeDocument, validateImage } from '../ocr.js';

async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'assetops-runtime-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('offline backup restores originals and user store, retaining pre-restore data', async t => {
  const dir = await temporary(t), data = join(dir, 'data'), backup = join(dir, 'backup');
  await mkdir(join(data, 'pills.json.uploads'), { recursive: true }); await mkdir(join(data, 'audit'));
  await writeFile(join(data, 'pills.json'), '{"version":1}'); await writeFile(join(data, 'users.json'), '[]'); await writeFile(join(data, 'pills.json.uploads', 'doc'), 'Source'); await writeFile(join(data, 'audit', 'today'), 'excluded');
  assert.equal((await backupData(data, backup)).files, 3);
  await writeFile(join(data, 'pills.json'), '{"version":2}');
  const { previous } = await restoreData(backup, data);
  assert.equal(await readFile(join(data, 'pills.json'), 'utf8'), '{"version":1}');
  assert.equal(await readFile(join(previous, 'pills.json'), 'utf8'), '{"version":2}');
  assert.equal(await readFile(join(data, 'pills.json.uploads', 'doc'), 'utf8'), 'Source');
});
test('corruption and traversal never replace live data', async t => {
  const dir = await temporary(t), data = join(dir, 'data'), backup = join(dir, 'backup'); await mkdir(data); await writeFile(join(data, 'cases.json'), '[]');
  await backupData(data, backup); await writeFile(join(backup, 'cases.json'), 'tampered');
  await assert.rejects(restoreData(backup, data), /integrity/); assert.equal(await readFile(join(data, 'cases.json'), 'utf8'), '[]');
  await writeFile(join(backup, 'manifest.json'), JSON.stringify({ version: 1, files: [{ name: '../outside' }] }));
  await assert.rejects(restoreData(backup, data), /path/);
  await t.test('backup rejects symbolic links when the host permits creating them', async subtest => {
    const target = join(dir, 'link-target');
    await mkdir(target); await writeFile(join(target, 'cases.json'), '[]');
    try {
      await symlink(target, join(data, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      subtest.skip('Windows sandbox does not permit creating symbolic links or junctions.');
      return;
    }
    await assert.rejects(backupData(data, join(dir, 'bad-backup')), /symbolic/);
  });
});
test('model failures open a circuit and recover after cooldown; bodies are bounded', async () => {
  let now = 0, fail = true;
  const transport = createModelTransport({ clock: () => now, threshold: 2, cooldownMs: 100, fetchImpl: async () => new Response(fail ? 'busy' : '{}', { status: fail ? 503 : 200 }) });
  await transport('https://provider.test'); await transport('https://provider.test');
  await assert.rejects(transport('https://provider.test'), { status: 503 }); assert.equal(transport.status().circuit, 'open');
  now = 101; fail = false; assert.equal(await (await transport('https://provider.test')).text(), '{}'); assert.equal(transport.status().circuit, 'closed');
  const oversized = createModelTransport({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(oversized('https://provider.test'), /size limit/);
});
test('model concurrency limit rejects extra work without duplicate model calls', async () => {
  let release; const transport = createModelTransport({ concurrency: 1, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const first = transport('https://provider.test'); await assert.rejects(transport('https://provider.test'), { status: 503 });
  release(new Response('{}')); await first; assert.equal(transport.status().calls, 1); assert.equal(transport.status().active, 0);
});
test('OCR uses argument arrays, preserves page provenance, cleans temporary files and fails closed', async () => {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: 'Supply temperature 12 C' }; };
  const result = await recognizeDocument(Buffer.from('%PDF-1.4'), '.pdf', [2], { enabled: true, run });
  assert.equal(result[0].location, 'Page 2 (OCR)'); assert.equal(result[0].method, 'ocr');
  assert.ok(calls[0].args.includes('-scale-to')); assert.equal(calls[1].options.timeout, 20000);
  await assert.rejects(readFile(calls[0].args.at(-2)), { code: 'ENOENT' });
  await assert.rejects(recognizeDocument(Buffer.from('x'), '.png', [], { enabled: false, run }), /disabled/);
  await assert.rejects(recognizeDocument(Buffer.from('x'), '.pdf', [1, 2, 3, 4, 5, 6], { enabled: true, run }), /5 scanned pages/);
  await assert.rejects(recognizeDocument(Buffer.from('x'), '.png', [], { enabled: true, run: async () => { throw new Error('private file path'); } }), /OCR failed/);
});
test('image signature and pixel dimensions are checked before OCR', () => {
  assert.throws(() => validateImage(Buffer.from('not png'), '.png'), /Invalid/);
  const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12); png.writeUInt32BE(100000, 16); png.writeUInt32BE(100000, 20);
  assert.throws(() => validateImage(png, '.png'), /megapixels/);
  png.writeUInt32BE(200, 16); png.writeUInt32BE(200, 20); assert.doesNotThrow(() => validateImage(png, '.png'));
});
