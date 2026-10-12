import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { projectRuntimeDownload } from '../docker/harness/runtime-download-evidence.mjs';

// Generic in-memory fixtures use the same stored-ZIP layout as prototype-archive.test.mjs.
function zipFixture(entries) {
  const localParts = []; const centralParts = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content ?? '');
    const compressed = entry.deflate ? deflateRawSync(content) : content;
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30); const central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x800, 6); local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(content) >>> 0, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.uncompressedSize ?? content.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0x800, 8); central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(content) >>> 0, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.uncompressedSize ?? content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, extra, compressed); centralParts.push(central, name, extra);
    offset += local.length + name.length + extra.length + compressed.length;
  }
  const directory = Buffer.concat(centralParts); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function workbookEntries(sheetData) {
  return [
    { name: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', content: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Example" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', content: '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', content: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>` },
  ];
}

test('runtime download text preserves exact UTF-8 bytes and rejects unsafe headers and JSON errors', async () => {
  const text = '\uFEFFname,value\r\n"sample",1\r\n'; const bytes = Buffer.from(text);
  const input = { bytes, contentType: 'text/csv; charset=UTF-8', contentDisposition: "attachment; filename=example.csv; filename*=UTF-8''%E7%A4%BA%E4%BE%8B.csv", format: 'text' };
  assert.deepEqual(await projectRuntimeDownload(input), { contentType: input.contentType, fileName: '示例.csv',
    byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text });
  for (const contentDisposition of ['attachment; filename="../bad.csv"', "attachment; filename*=UTF-8''..%2Fbad.csv",
    "attachment; filename*=UTF-8''bad%0A.csv", 'attachment; filename="bad.csv"\r\nLocation: https://example.com',
    'attachment; filename=a.csv; filename=b.csv', 'attachment; filename="bad.csv. "']) {
    await assert.rejects(projectRuntimeDownload({ ...input, contentDisposition }));
  }
  await assert.rejects(projectRuntimeDownload({ ...input, bytes: Buffer.from([0xc3, 0x28]) }));
  await assert.rejects(projectRuntimeDownload({ ...input, bytes: Buffer.alloc(1024 * 1024 + 1) }));
  await assert.rejects(projectRuntimeDownload({ ...input, contentType: 'application/problem+json' }));
  await assert.rejects(projectRuntimeDownload({ ...input, bytes: Buffer.from('\uFEFF {"code":500,"message":"failed"}') }));
  await assert.rejects(projectRuntimeDownload({ ...input, format: 'html' }));
});

test('runtime download XLSX reads bounded first-sheet scalars and rejects unsafe ZIP archives', async () => {
  const entries = workbookEntries('<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve"> sample </t></is></c><c r="B1"><v>7</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" s="1"><v>45292</v></c></row>');
  const input = { bytes: zipFixture(entries), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentDisposition: 'attachment; filename="example.xlsx"', format: 'xlsx' };
  const actual = await projectRuntimeDownload(input);
  assert.deepEqual(actual.rows, [[' sample ', 7, true, '2024-01-01T00:00:00.000Z']]);
  assert.equal(actual.sha256, createHash('sha256').update(input.bytes).digest('hex'));
  assert.equal(actual.byteLength, input.bytes.length);
  for (const extra of [
    [{ name: '../outside.xml' }], [{ name: 'encrypted.xml', flags: 0x801 }],
    [{ name: 'zip64.xml', extra: Buffer.from([1, 0, 0, 0]) }],
    [{ name: 'bomb.xml', content: 'a'.repeat(32768), deflate: true }],
    Array.from({ length: 59 }, (_, i) => ({ name: `extra-${i}.xml` })),
  ]) await assert.rejects(projectRuntimeDownload({ ...input, bytes: zipFixture([...entries, ...extra]) }));
  await assert.rejects(projectRuntimeDownload({ ...input, bytes: Buffer.from('{"code":500}') }));
  await assert.rejects(projectRuntimeDownload({ ...input, contentDisposition: 'attachment; filename="example.xls"' }));
  for (const sheet of [Array.from({ length: 1001 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>1</v></c></row>`).join(''),
    '<row r="1"><c r="A1"><v>1</v></c><c r="DY1"><v>1</v></c></row>']) {
    await assert.rejects(projectRuntimeDownload({ ...input, bytes: zipFixture(workbookEntries(sheet)) }));
  }
});
