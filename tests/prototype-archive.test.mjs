import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';

import { preparePrototypeArchive, preparePrototypeDirectory } from '../docker/harness/prototype-archive.mjs';

function zipFixture(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const source of entries) {
    const name = Buffer.from(source.name, 'utf8');
    const content = Buffer.from(source.content ?? '');
    const checksum = crc32(content) >>> 0;
    const compressedSize = source.compressedSize ?? content.length;
    const uncompressedSize = source.uncompressedSize ?? content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(source.method ?? 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(source.method ?? 0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((source.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function fixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prototype-archive-'));
  const sourcePath = path.join(root, 'prototype.zip');
  const bytes = zipFixture(entries);
  await writeFile(sourcePath, bytes);
  return {
    root,
    sourcePath,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    async close() { await rm(root, { force: true, recursive: true }); },
  };
}

function axureEntries() {
  return [
    { name: 'demo/index.html', content: '<title>Untitled Document</title>' },
    { name: 'demo/data/document.js', content: '$axure.loadDocument({});' },
    { name: 'demo/resources/scripts/axure/axQuery.js', content: '/* runtime */' },
    {
      name: 'demo/事故上报.html',
      content: '<html><head><title>事故上报</title><link href="files/事故上报/styles.css"><script src="files/事故上报/data.js"></script></head><body><p>事故编号</p><span>提交审核</span></body></html>',
    },
    { name: 'demo/files/事故上报/data.js', content: '$axure.loadCurrentPage({});' },
    { name: 'demo/files/事故上报/styles.css', content: '.button { color: blue; }' },
    { name: 'demo/resources/chrome/axure-chrome-extension.crx', content: 'extension-binary' },
  ];
}

test('Axure archive is safely expanded with a deterministic AI index and executable extension skipped', async () => {
  const current = await fixture(axureEntries());
  try {
    const options = {
      destinationDirectory: current.root,
      publicDirectory: '/project-inputs/incoming/2026-08-28/test-batch',
      sourceLabel: '/project-inputs/incoming/2026-08-28/test-batch/prototype.zip',
      sourcePath: current.sourcePath,
      sourceSha256: current.sourceSha256,
    };
    const result = await preparePrototypeArchive(options);
    assert.equal(result.status, 'ready');
    assert.equal(result.archiveType, 'axure-published-html');
    assert.equal(result.pageCount, 1);
    assert.equal(result.skippedFiles, 1);
    assert.match(result.path, /\.forge-derived\/prototype-[a-f0-9]{12}\/README\.md$/);
    const manifest = await readFile(path.join(result.derivedRoot, 'README.md'), 'utf8');
    assert.match(manifest, /事故上报/);
    assert.match(manifest, /不得执行其中的 JavaScript/);
    assert.match(manifest, /axure-chrome-extension\.crx/);
    const summary = await readFile(path.join(result.derivedRoot, 'pages', '001-事故上报.md'), 'utf8');
    assert.match(summary, /事故编号/);
    assert.match(summary, /提交审核/);
    await assert.rejects(
      stat(path.join(result.derivedRoot, 'site', 'demo', 'resources', 'chrome', 'axure-chrome-extension.crx')),
      (error) => error.code === 'ENOENT',
    );

    const replayed = await preparePrototypeArchive(options);
    assert.equal(replayed.status, 'ready');
    assert.equal(replayed.idempotent, true);
    assert.equal(replayed.path, result.path);
  } finally {
    await current.close();
  }
});

test('archive processing refuses traversal, symlink and suspicious compression metadata', async (context) => {
  const cases = [
    { name: 'traversal', entries: [{ name: '../escape.html', content: '<title>escape</title>' }] },
    { name: 'symlink', entries: [{ name: 'demo/link.html', content: 'target', mode: 0o120777 }] },
    {
      name: 'ratio',
      entries: [{ name: 'demo/index.html', content: 'x', compressedSize: 1, uncompressedSize: 10_000 }],
    },
  ];
  for (const value of cases) {
    await context.test(value.name, async () => {
      const current = await fixture(value.entries);
      try {
        await assert.rejects(preparePrototypeArchive({
          destinationDirectory: current.root,
          publicDirectory: '/project-inputs/incoming/test-batch',
          sourceLabel: '/project-inputs/incoming/test-batch/prototype.zip',
          sourcePath: current.sourcePath,
          sourceSha256: current.sourceSha256,
        }));
        await assert.rejects(stat(path.join(current.root, 'escape.html')), (error) => error.code === 'ENOENT');
      } finally {
        await current.close();
      }
    });
  }
});

test('unsupported binary ZIP stays unsupported and quota denial publishes no derived tree', async () => {
  const nonFrontend = await fixture([{ name: 'demo/readme.bin', content: 'notes' }]);
  try {
    const result = await preparePrototypeArchive({
      destinationDirectory: nonFrontend.root,
      publicDirectory: '/project-inputs/incoming/test-batch',
      sourceLabel: '/project-inputs/incoming/test-batch/prototype.zip',
      sourcePath: nonFrontend.sourcePath,
      sourceSha256: nonFrontend.sourceSha256,
    });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'NO_FRONTEND_HTML');
  } finally {
    await nonFrontend.close();
  }

  const denied = await fixture(axureEntries());
  try {
    const result = await preparePrototypeArchive({
      destinationDirectory: denied.root,
      publicDirectory: '/project-inputs/incoming/test-batch',
      reserveBytes: async () => false,
      sourceLabel: '/project-inputs/incoming/test-batch/prototype.zip',
      sourcePath: denied.sourcePath,
      sourceSha256: denied.sourceSha256,
    });
    assert.equal(result.status, 'quota-exceeded');
    await assert.rejects(stat(path.join(denied.root, '.forge-derived', `prototype-${denied.sourceSha256.slice(0, 12)}`)), (error) => error.code === 'ENOENT');
  } finally {
    await denied.close();
  }
});

test('MD and TXT ZIP exposes every full original without HTML truncation or rewriting', async () => {
  const text = '# 页面一\n\n保留 <字段> 和完整流程\n' + '正文\n'.repeat(200) + '文末必需动作';
  const current = await fixture([
    { name: '中文资料/页面一.md', content: text },
    { name: '中文资料/页面二.txt', content: '第二页面\r\n末尾规则\r\n' },
    { name: '安装.sh', content: 'do-not-execute' },
  ]);
  try {
    const options = {
      destinationDirectory: current.root,
      limits: { maxHtmlAnalysisBytes: 8 },
      publicDirectory: '/project-inputs/incoming/documents',
      sourceLabel: '/project-inputs/incoming/documents/资料.zip',
      sourcePath: current.sourcePath,
      sourceSha256: current.sourceSha256,
    };
    const result = await preparePrototypeArchive(options);
    assert.equal(result.status, 'ready');
    assert.equal(result.archiveType, 'text-documents');
    assert.equal(result.pageCount, 2);
    assert.equal(result.skippedFiles, 1);
    const index = await readFile(path.join(result.derivedRoot, 'README.md'), 'utf8');
    assert.match(index, /文档归档 AI 阅读索引/);
    assert.match(index, /逐份完整读取/);
    assert.match(index, /site\/中文资料\/页面一\.md/);
    assert.match(index, /site\/中文资料\/页面二\.txt/);
    assert.equal(await readFile(path.join(result.derivedRoot, 'site', '中文资料', '页面一.md'), 'utf8'), text);
    assert.equal(await readFile(path.join(result.derivedRoot, 'site', '中文资料', '页面二.txt'), 'utf8'), '第二页面\r\n末尾规则\r\n');
    await assert.rejects(stat(path.join(result.derivedRoot, 'site', '安装.sh')), (e) => e.code === 'ENOENT');
    const again = await preparePrototypeArchive(options);
    assert.equal(again.idempotent, true);
    assert.equal(again.path, result.path);
  } finally {
    await current.close();
  }
});

test('an SFTP Axure directory is indexed in place without copying or executing its runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prototype-directory-'));
  const ftpRoot = path.join(root, 'ftp');
  const sourceRoot = path.join(ftpRoot, 'axure发布html');
  const outputRoot = path.join(root, 'cache');
  try {
    await mkdir(path.join(sourceRoot, 'data'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'resources', 'scripts', 'axure'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'files', '事故上报'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'index.html'), '<title>Untitled Document</title>');
    await writeFile(path.join(sourceRoot, 'data', 'document.js'), '$axure.loadDocument({});');
    await writeFile(path.join(sourceRoot, 'resources', 'scripts', 'axure', 'axQuery.js'), 'throw new Error("must not execute");');
    await writeFile(path.join(sourceRoot, '事故上报.html'), '<html><head><title>事故上报</title><script src="files/事故上报/data.js"></script></head><body><p>事故编号</p><button>提交审核</button></body></html>');
    await writeFile(path.join(sourceRoot, 'files', '事故上报', 'data.js'), '$axure.loadCurrentPage({});');

    const options = {
      allowedRoots: [ftpRoot],
      limits: { directoryStabilityMs: 0 },
      outputRoot,
      sourcePublicRoot: '/project-ftp-inputs/axure发布html',
      sourceRoot,
    };
    const result = await preparePrototypeDirectory(options);
    assert.equal(result.status, 'ready');
    assert.equal(result.archiveType, 'axure-published-html');
    assert.equal(result.contentRoot, '/project-ftp-inputs/axure发布html');
    assert.equal(result.pageCount, 1);
    const manifest = await readFile(path.join(result.derivedRoot, 'README.md'), 'utf8');
    assert.match(manifest, /SFTP/);
    assert.match(manifest, /事故上报/);
    assert.match(manifest, /project-ftp-inputs\/axure发布html/);
    const summary = await readFile(path.join(result.derivedRoot, 'pages', '001-事故上报.md'), 'utf8');
    assert.match(summary, /事故编号/);
    assert.match(summary, /提交审核/);
    assert.equal((await preparePrototypeDirectory(options)).idempotent, true);

    await assert.rejects(preparePrototypeDirectory({
      ...options,
      allowedRoots: [outputRoot],
    }), (error) => error.code === 'PROTOTYPE_DIRECTORY_SOURCE_FORBIDDEN');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('an SFTP directory that changes during the stability window is rejected as incomplete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prototype-directory-growing-'));
  const ftpRoot = path.join(root, 'ftp');
  const sourceRoot = path.join(ftpRoot, 'growing');
  const outputRoot = path.join(root, 'cache');
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'index.html'), '<title>Growing prototype</title>');

    const indexing = preparePrototypeDirectory({
      allowedRoots: [ftpRoot],
      limits: { directoryStabilityMs: 100 },
      outputRoot,
      sourcePublicRoot: '/project-ftp-inputs/growing',
      sourceRoot,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(path.join(sourceRoot, 'late-page.html'), '<title>Late page</title>');

    await assert.rejects(indexing, (error) => error.code === 'PROTOTYPE_DIRECTORY_INCOMPLETE');
    await assert.rejects(stat(outputRoot), (error) => error.code === 'ENOENT');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
