import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const MAX_BYTES = 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * MAX_BYTES;

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'RUNTIME_DOWNLOAD_INVALID' });
}

function downloadName(header, format) {
  if (typeof header !== 'string' || header.length > 4096 || /[\x00-\x1f\x7f]/u.test(header)) invalid('Invalid Content-Disposition.');
  const parts = /^\s*(?:attachment|inline)\s*((?:;.*)?)$/iu.exec(header);
  if (!parts) invalid('A download disposition is required.');
  const values = new Map();
  const parameters = parts[1];
  const pattern = /;\s*([\w*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]+)\s*/gy;
  let offset = 0;
  while (offset < parameters.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(parameters);
    if (!match) invalid('Malformed download disposition.');
    const key = match[1].toLowerCase();
    if (values.has(key)) invalid('Duplicate download disposition parameter.');
    values.set(key, match[2].startsWith('"') ? match[2].slice(1, -1).replace(/\\(.)/gu, '$1') : match[2]);
    offset = pattern.lastIndex;
  }
  let name = values.get('filename');
  if (values.has('filename*')) {
    const encoded = /^UTF-8'[^']*'(.*)$/iu.exec(values.get('filename*'));
    if (!encoded) invalid('Only UTF-8 extended filenames are supported.');
    try { name = decodeURIComponent(encoded[1]); } catch { invalid('Invalid extended filename encoding.'); }
  }
  if (typeof name !== 'string' || !name || name.length > 255
    || /[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name)
    || /[. ]$/u.test(name) || name === '.' || name === '..') invalid('Unsafe download filename.');
  if (format === 'xlsx' && !/\.xlsx$/iu.test(name)) invalid('XLSX filename extension is required.');
  return name;
}

async function inspectWorkbookZip(bytes) {
  // Detect the extended end record before yauzl normalizes Zip64 metadata.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)
    || bytes.readUInt16LE(end + 10) === 0xffff || bytes.readUInt32LE(end + 12) === 0xffffffff
    || bytes.readUInt32LE(end + 16) === 0xffffffff) invalid('Invalid or Zip64 workbook archive.');
  const yauzl = require('yauzl');
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes,
    { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => error ? reject(error) : resolve(archive)));
  await new Promise((resolve, reject) => {
    let count = 0; let declared = 0; let actual = 0; let done = false;
    const names = new Set();
    const finish = error => { if (done) return; done = true; zip.close(); error ? reject(error) : resolve(); };
    zip.on('error', finish);
    zip.on('end', () => {
      if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) return finish(new Error('Not an XLSX workbook.'));
      finish();
    });
    zip.on('entry', entry => {
      try {
        count += 1; declared += entry.uncompressedSize;
        const name = entry.fileName;
        if (count > 64 || zip.entryCount > 64 || names.has(name) || /[\x00-\x1f\x7f\\]/u.test(name)
          || name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.split('/').includes('..')
          || (entry.generalPurposeBitFlag & 0x41) !== 0 || entry.extraFields.some(field => field.id === 1)
          || entry.versionNeededToExtract >= 45 || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
          || entry.uncompressedSize > MAX_EXPANDED_BYTES || declared > MAX_EXPANDED_BYTES
          || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100) invalid('Workbook archive exceeds its safety bounds.');
        names.add(name);
        zip.openReadStream(entry, (error, stream) => {
          if (error) return finish(error);
          let size = 0;
          stream.on('error', finish);
          stream.on('data', chunk => {
            size += chunk.length; actual += chunk.length;
            if (size > MAX_EXPANDED_BYTES || actual > MAX_EXPANDED_BYTES) {
              stream.destroy(); finish(new Error('Workbook expansion exceeds its limit.'));
            }
          });
          stream.on('end', () => { if (!done) zip.readEntry(); });
        });
      } catch (error) { finish(error); }
    });
    zip.readEntry();
  });
}

export async function projectRuntimeDownload({ bytes, contentType, contentDisposition, format }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES
    || !['text', 'xlsx'].includes(format)) invalid('Invalid download bytes or format.');
  if (typeof contentType !== 'string' || !contentType || contentType.length > 256
    || /[\x00-\x1f\x7f]/u.test(contentType) || /(?:\bjson\b|\+json)/iu.test(contentType)) invalid('A JSON response is not download evidence.');
  const fileName = downloadName(contentDisposition, format);
  const result = { contentType, fileName, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (format === 'text') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { invalid('Download text must be valid UTF-8.'); }
    const trimmed = text.replace(/^\uFEFF/u, '').trim();
    if (/^[\[{]/u.test(trimmed)) {
      let json = false;
      try { JSON.parse(trimmed); json = true; } catch { /* Ordinary text need not be JSON. */ }
      if (json) invalid('A JSON body is not download evidence.');
    }
    return { ...result, text };
  }
  await inspectWorkbookZip(bytes);
  // Same pinned Buffer API and sheets[].data contract as document-extractor.mjs.
  const { default: readExcelFile } = await import(pathToFileURL(require.resolve('read-excel-file/node')).href);
  const sheets = await readExcelFile(bytes, { trim: false });
  const rows = sheets[0]?.data;
  if (!Array.isArray(rows) || rows.length > 1000) invalid('Workbook row limit exceeded.');
  return { ...result, rows: rows.map(row => {
    if (!Array.isArray(row) || row.length > 128) invalid('Workbook column limit exceeded.');
    return Array.from(row, cell => {
      if (cell instanceof Date) {
        if (!Number.isFinite(cell.getTime())) invalid('Invalid workbook date.');
        return cell.toISOString();
      }
      if (cell === undefined || cell === null) return null;
      if (typeof cell === 'string' || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell))) return cell;
      invalid('Workbook cells must be scalar values.');
    });
  }) };
}
