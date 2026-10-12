import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
const fail = message => Object.assign(new Error(message), { status: 422 });
export function validateImage(bytes, extension) {
  let width, height;
  if (extension === '.png') {
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw fail('Invalid PNG image.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw fail('Invalid JPEG image.');
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 255) throw fail('Invalid JPEG marker.');
      const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2);
      if ([192, 193, 194].includes(marker)) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; }
      if (size < 2 || offset + size + 2 > bytes.length) break;
      offset += size + 2;
    }
  }
  if (!width || !height || width * height > 20000000) throw fail('Image dimensions are unsupported or exceed 20 megapixels.');
}
export async function recognizeDocument(bytes, extension, pages = [], { run = execute, enabled = process.env.OCR_ENABLED === 'true', language = process.env.OCR_LANGUAGE || 'eng' } = {}) {
  if (!enabled) throw fail('OCR is disabled. Enable OCR_ENABLED=true and install Tesseract (plus Poppler for scanned PDFs), or upload searchable text.');
  if (!/^[a-z_+0-9-]{1,80}$/i.test(language)) throw fail('Invalid OCR language configuration.');
  if (pages.length > 5) throw fail('At most 5 scanned pages can be recognized per upload. Split the PDF.');
  const directory = await mkdtemp(join(tmpdir(), 'assetops-ocr-'));
  try {
    const source = join(directory, `source${extension}`); await writeFile(source, bytes, { mode: 0o600 });
    const sections = [];
    for (const page of extension === '.pdf' ? pages : [1]) {
      let input = source;
      if (extension === '.pdf') {
        const prefix = join(directory, `page-${page}`);
        await run(process.env.PDFTOPPM_PATH || 'pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '2000', '-png', source, prefix], { timeout: 20000, maxBuffer: 1024 * 1024 });
        input = `${prefix}.png`;
      }
      const { stdout } = await run(process.env.TESSERACT_PATH || 'tesseract', [input, 'stdout', '-l', language], { timeout: 20000, maxBuffer: 256000 });
      const text = stdout.trim(); if (!text) throw fail(`OCR found no readable text on page ${page}. Provide a clearer source.`);
      sections.push({ location: extension === '.pdf' ? `Page ${page} (OCR)` : 'Image (OCR)', text, method: 'ocr' });
    }
    return sections;
  } catch (error) { if (error.status) throw error; throw fail('OCR failed or timed out. Check local OCR tools and language packs, or upload searchable text.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
