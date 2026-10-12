import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extname } from 'node:path';
import { recognizeDocument, validateImage } from './ocr.js';

export const uploadLimit = 10 * 1024 * 1024;
const textLimit = 60000;
const fail = message => Object.assign(new Error(message), { status: 422 });

export async function extractDocument(filename, bytes) {
  const extension = extname(filename).toLowerCase();
  if (!['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg'].includes(extension)) throw fail('Use PDF, DOCX, TXT, Markdown, PNG or JPEG.');
  if (!bytes.length || bytes.length > uploadLimit) throw fail('Files must be nonempty and no larger than 10 MB.');
  if (extension === '.pdf' && !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw fail('The file is not a valid PDF.');
  if (extension === '.docx' && Buffer.from(bytes.subarray(0, 2)).toString() !== 'PK') throw fail('The file is not a valid DOCX.');
  const image = ['.png', '.jpg', '.jpeg'].includes(extension);
  if (image) validateImage(Buffer.from(bytes), extension);
  const result = image ? { blocks: [], warnings: [], scannedPages: [] } : await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { extension, bytes }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    const timer = setTimeout(() => { worker.terminate(); reject(fail('Document parsing timed out. Use a smaller file.')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(fail(result.error)) : resolve(result); });
    worker.once('error', () => { clearTimeout(timer); reject(fail('Unable to parse this document. Check the format or upload a smaller file.')); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(fail('Document parsing stopped. Check the format or upload a smaller file.')); });
  });
  if (image || result.scannedPages?.length) {
    const recognized = await recognizeDocument(bytes, extension, result.scannedPages);
    result.warnings.push('OCR text can misread units, numbers and table relationships. Verify all extracted evidence against the original before approval.');
    for (const section of recognized) for (let start = 0; start < section.text.length; start += 4000) result.blocks.push({ ...section, text: section.text.slice(start, start + 4000) });
    if (extension === '.pdf') result.blocks.sort((a, b) => Number(a.location.match(/\d+/)?.[0]) - Number(b.location.match(/\d+/)?.[0]));
    result.blocks.forEach((block, index) => { block.id = `B${index + 1}`; });
  }
  if (result.blocks.reduce((sum, block) => sum + block.text.length, 0) > textLimit) throw fail('The extracted text exceeds 60,000 characters. Split the document.');
  if (!result.blocks.length) throw fail('No readable text found. Upload a clearer document; scanned content requires OCR.');
  delete result.scannedPages;
  return result;
}

if (!isMainThread) {
  try {
    const { extension, bytes } = workerData;
    const sections = [];
    let total = 0;
    const warnings = [];
    const scannedPages = [];
    const add = (text, location) => {
      total += text.length;
      if (total > textLimit) throw fail('The extracted text exceeds 60,000 characters. Split the document before uploading.');
      for (let start = 0; start < text.length; start += 4000) {
        const part = text.slice(start, start + 4000).trim();
        if (part) sections.push({ id: `B${sections.length + 1}`, location, text: part });
      }
    };
    if (extension === '.pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false });
      const document = await task.promise;
      try {
        if (document.numPages > 100) throw fail('PDFs may contain at most 100 pages. Split the file before uploading.');
        for (let page = 1; page <= document.numPages; page++) {
          const pdfPage = await document.getPage(page);
          const content = await pdfPage.getTextContent();
          const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
          if (!text) {
            if ((await pdfPage.getOperatorList()).fnArray.length) scannedPages.push(page);
            else warnings.push(`Page ${page} is blank and was skipped.`);
          }
          add(text, `Page ${page}`);
        }
      } finally { await task.destroy(); }
    } else {
      let text;
      if (extension === '.docx') {
        const { default: mammoth } = await import('mammoth');
        const plain = node => node.type === 'text' ? node.value : node.type === 'tab' ? '\t' : (node.children || []).map(plain).join('') + (node.type === 'paragraph' ? '\n' : '');
        const parts = [];
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
          externalFileAccess: false,
          convertImage: mammoth.images.imgElement(async () => { warnings.push('Embedded DOCX images were not interpreted. Upload important diagrams separately and verify their meaning manually.'); return { src: '' }; }),
          transformDocument(document) {
            let table = 0;
            for (const node of document.children || []) {
              if (node.type === 'table') {
                table++;
                parts.push(`Table ${table}\n${node.children.map((row, r) => `Row ${r + 1}: ${row.children.map((cell, c) => `Column ${c + 1}: ${plain(cell).trim()}`).join(' | ')}`).join('\n')}`);
                warnings.push(`Table ${table}: verify merged cells, headers and units against the original.`);
              } else parts.push(plain(node));
            }
            return document;
          }
        });
        text = parts.join('\n\n');
        if (result.messages.length) warnings.push('The DOCX parser reported unsupported content. Compare extracted text with the original.');
      } else {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw fail('Text files must use UTF-8 encoding.'); }
        if (text.includes('\u0000')) throw fail('This file contains binary data, not plain text.');
      }
      if (text.length > textLimit) throw fail('The extracted text exceeds 60,000 characters. Split the document before uploading.');
      text.split(/\n\s*\n/).forEach((part, index) => add(part, `Paragraph ${index + 1}`));
    }
    parentPort.postMessage({ blocks: sections, warnings, scannedPages });
  } catch (error) {
    parentPort.postMessage({ error: error.status ? error.message : 'Unable to read this document. Encrypted, damaged or unsupported files must be converted first.' });
  }
}
