import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { createUploadServer, sanitizeFilename } from '../docker/harness/upload-server.mjs';
import { documentCapability, extractProjectDocument } from '../docker/harness/document-extractor.mjs';

const TOKEN = 'a'.repeat(64);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function request(port, pathname, options = {}) {
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method ?? 'GET',
      headers: {
        ...(options.token === false ? {} : { 'x-forge-upload-token': TOKEN }),
        ...(body === undefined ? {} : { 'content-length': body.length }),
        ...options.headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-harness-upload-test-'));
  const server = await createUploadServer({
    uploadRoot: root,
    token: TOKEN,
    auditScope: {
      scopeType: 'taskspace-private',
      projectSlug: 'validation-project',
      taskspaceId: 'c-upload-test',
      actorId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
    },
    maxFileBytes: 32,
    maxBatchFiles: 2,
    maxBatchBytes: 48,
    maxProjectBytes: 4096,
    documentExtractor: async ({ filename }) => ({
      ...documentCapability(filename),
      status: documentCapability(filename).mode,
    }),
    ...overrides,
  });
  const port = await listen(server);
  return {
    port,
    root,
    async close() {
      await close(server);
      await rm(root, { force: true, recursive: true });
    },
  };
}

test('document capability routes browser formats without treating legacy Office files as readable', () => {
  assert.deepEqual(documentCapability('需求说明.md').mode, 'native');
  assert.deepEqual(documentCapability('需求说明.pdf').mode, 'extract');
  assert.deepEqual(documentCapability('需求说明.docx').mode, 'extract');
  assert.deepEqual(documentCapability('台账.xlsx').mode, 'extract');
  assert.deepEqual(documentCapability('原型页面.html').mode, 'extract');
  assert.deepEqual(documentCapability('组件.vue').mode, 'native');
  assert.deepEqual(documentCapability('旧格式.doc').mode, 'unsupported');
});

test('filename normalization removes traversal and control characters', () => {
  assert.equal(sanitizeFilename('../../客户\u0000台账.xlsx'), '客户_台账.xlsx');
  assert.equal(sanitizeFilename('folder\\需求说明.docx'), '需求说明.docx');
  assert.throws(() => sanitizeFilename('../..'), /文件名无效/);
});

test('health is public inside the private network but upload configuration requires the proxy token', async () => {
  const current = await fixture();
  try {
    const health = await request(current.port, '/healthz', { token: false });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    const forbidden = await request(current.port, '/config', { token: false });
    assert.equal(forbidden.status, 403);

    const config = await request(current.port, '/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.maxFileBytes, 32);
    assert.equal(config.json.maxBatchFiles, 2);
    assert.equal(config.json.projectPath, '/project-inputs');
    assert.ok(config.json.readableFormats.includes('zip（Axure/前端 HTML 原型包）'));
  } finally {
    await current.close();
  }
});

test('archive downloads use Chinese disposition names while returning the original sealed bytes', async () => {
  const current = await fixture({ maxProjectBytes: 1024 * 1024 });
  try {
    const snapshot = {
      schemaVersion: 'forge-conversation-output/v1', sessionId: 'session-download-labels', status: 'completed',
      firstSeq: 1, lastSeq: 2, eventCount: 2, eventDigest: 'b'.repeat(64),
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: '生成中文方案' },
        { seq: 2, type: 'assistant/message', role: 'assistant', text: '这是保存的真实回复。' }],
      files: [{ name: 'assistant-2.md', mediaType: 'text/markdown', content: '这是保存的真实回复。' }],
    };
    const saved = await request(current.port, '/outputs', { method: 'POST', body: JSON.stringify(snapshot) });
    assert.equal(saved.status, 201);
    const originalManifest = saved.json.archive;
    const directory = path.join(current.root, 'outputs', snapshot.sessionId, originalManifest.snapshotId);
    const manifestBefore = await readFile(path.join(directory, 'manifest.json'));
    const page = await request(current.port, `/outputs?sessionId=${snapshot.sessionId}`);
    assert.equal(page.status, 200);
    const files = page.json.items[0].files;
    for (const name of ['conversation.md', 'conversation.json', 'assistant-2.md', 'manifest.json']) {
      const file = files.find((entry) => entry.name === name);
      assert.ok(file);
      assert.equal(file.phaseLabel, '对话记录（未关联阶段）');
      assert.match(file.downloadName, /^对话记录_/u);
      const canonicalPath = `/outputs/${snapshot.sessionId}/${originalManifest.snapshotId}/${name}`;
      const download = await fetch(`http://127.0.0.1:${current.port}${canonicalPath}?download=1`, {
        headers: { 'x-forge-upload-token': TOKEN },
      });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent(file.downloadName)}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.deepEqual(bytes, await readFile(path.join(directory, name)));
      assert.equal(bytes.length, file.bytes);
      assert.equal(download.headers.get('x-content-sha256'), file.sha256);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      const preview = await fetch(`http://127.0.0.1:${current.port}${canonicalPath}`, {
        headers: { 'x-forge-upload-token': TOKEN },
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-disposition'), `inline; filename*=UTF-8''${encodeURIComponent(file.downloadName)}`);
      assert.equal(preview.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
    }
    assert.deepEqual(await readFile(path.join(directory, 'manifest.json')), manifestBefore);
    assert.deepEqual(JSON.parse(manifestBefore), originalManifest);
    assert.ok(originalManifest.files.every((file) => !Object.hasOwn(file, 'downloadName')));
  } finally {
    await current.close();
  }
});

test('prototype ZIP upload publishes the generated AI index and archive metadata', async () => {
  let receivedOptions;
  const current = await fixture({
    prototypeProcessor: async (options) => {
      receivedOptions = options;
      const derivedRoot = path.join(options.destinationDirectory, '.forge-derived', 'prototype-fixture');
      await mkdir(derivedRoot, { recursive: true });
      await writeFile(path.join(derivedRoot, 'README.md'), '# prototype index\n');
      return {
        archiveType: 'axure-published-html',
        contentRoot: `${options.publicDirectory}/.forge-derived/prototype-fixture/site`,
        derivedBytes: 1024,
        derivedRoot,
        extractedFiles: 12,
        format: 'Axure 发布 HTML ZIP',
        pageCount: 3,
        path: `${options.publicDirectory}/.forge-derived/prototype-fixture/README.md`,
        skippedFiles: 1,
        status: 'ready',
      };
    },
  });
  try {
    const uploaded = await request(current.port, `/files?batch=prototype-ready&name=${encodeURIComponent('原型.zip')}`, {
      method: 'POST',
      body: 'ZIP-fixture',
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.file.readable.status, 'ready');
    assert.equal(uploaded.json.file.readable.archiveType, 'axure-published-html');
    assert.equal(uploaded.json.file.readable.pageCount, 3);
    assert.match(uploaded.json.file.readable.path, /\.forge-derived\/prototype-fixture\/README\.md$/);
    assert.equal(receivedOptions.sourceSha256, uploaded.json.file.sha256);
    assert.match(receivedOptions.publicDirectory, /\/incoming\/\d{4}-\d{2}-\d{2}\/prototype-ready$/);
  } finally {
    await current.close();
  }
});

test('upload publishes an immutable project path, hashes content and records an audit line', async () => {
  const current = await fixture();
  try {
    const batch = '11111111-1111-4111-8111-111111111111';
    const pathname = `/files?batch=${batch}&name=${encodeURIComponent('../客户台账.xlsx')}`;
    const first = await request(current.port, pathname, { method: 'POST', body: 'ledger-one' });
    assert.equal(first.status, 201);
    assert.match(first.json.file.path, new RegExp(`/incoming/\\d{4}-\\d{2}-\\d{2}/${batch}/客户台账\\.xlsx$`));
    assert.equal(first.json.file.bytes, 10);
    assert.match(first.json.file.sha256, /^[0-9a-f]{64}$/);

    const relative = first.json.file.path.replace('/project-inputs/', '');
    assert.equal(await readFile(path.join(current.root, ...relative.split('/')), 'utf8'), 'ledger-one');
    const audit = (await readFile(path.join(current.root, '.upload-audit.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(audit.length, 1);
    const record = JSON.parse(audit[0]);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.path, first.json.file.path);
    assert.deepEqual(record.scope, {
      scopeType: 'taskspace-private',
      projectSlug: 'validation-project',
      taskspaceId: 'c-upload-test',
      actorId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
    });

    const second = await request(current.port, pathname, { method: 'POST', body: 'ledger-two' });
    assert.equal(second.status, 201);
    assert.match(second.json.file.path, /客户台账 \(2\)\.xlsx$/);
    assert.notEqual(second.json.file.path, first.json.file.path);
  } finally {
    await current.close();
  }
});

test('binary upload publishes a bounded readable companion and records it in the audit trail', async () => {
  const current = await fixture({
    documentExtractor: async ({ sourceLabel }) => ({
      format: 'PDF',
      markdown: `# readable\n\nsource: ${sourceLabel}\n\nFMT-PDF`,
      status: 'ready',
      truncated: false,
    }),
  });
  try {
    const batch = 'document-ready-1234';
    const uploaded = await request(current.port, `/files?batch=${batch}&name=${encodeURIComponent('验收.pdf')}`, {
      method: 'POST',
      body: '%PDF-fixture',
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.file.readable.status, 'ready');
    assert.equal(uploaded.json.file.readable.format, 'PDF');
    assert.match(uploaded.json.file.readable.path, /验收\.pdf\.extracted\.md$/);

    const relative = uploaded.json.file.readable.path.replace('/project-inputs/', '');
    assert.match(await readFile(path.join(current.root, ...relative.split('/')), 'utf8'), /FMT-PDF/);
    const audit = JSON.parse((await readFile(path.join(current.root, '.upload-audit.jsonl'), 'utf8')).trim());
    assert.equal(audit.readable.path, uploaded.json.file.readable.path);
  } finally {
    await current.close();
  }
});

test('standalone HTML upload indexes business content after a large style block without executing scripts', async () => {
  const body = '<html>\n<style>\n' + '.prototype { color: red; }\n'.repeat(2100)
    + '</style>\n<body><h1>验收业务页面</h1><button>提交</button>\n<script>\n'
    + 'const localValue = 1;\n'.repeat(2000)
    + 'const menuData = [{ label: "独立维护菜单" }];\n'
    + 'function renderBusinessPage() { throw new Error("must not execute"); }\n</script></body></html>';
  const current = await fixture({
    maxFileBytes: 128 * 1024, maxBatchBytes: 128 * 1024, maxProjectBytes: 512 * 1024,
    documentExtractor: extractProjectDocument,
  });
  try {
    const uploaded = await request(current.port, '/files?batch=html-outline-1234&name=prototype.html', { method: 'POST', body });
    assert.equal(uploaded.status, 201);
    const file = uploaded.json.file;
    assert.equal(file.readable.status, 'ready');
    assert.equal(file.readable.format, 'HTML 原型阅读索引');
    const localPath = (publicPath) => path.join(current.root, publicPath.replace('/project-inputs/', ''));
    const index = await readFile(localPath(file.readable.path), 'utf8');
    assert.match(index, /验收业务页面/);
    assert.match(index, /原文第 2104 行/);
    assert.match(index, /const menuData/);
    assert.match(index, /function renderBusinessPage/);
    assert.doesNotMatch(index, /\.prototype \{ color: red; \}/);
    assert.equal(await readFile(localPath(file.path), 'utf8'), body);
    assert.equal(file.sha256, createHash('sha256').update(body).digest('hex'));
  } finally {
    await current.close();
  }
});

test('document parser failure keeps the immutable original and returns an explicit non-readable state', async () => {
  const current = await fixture({
    documentExtractor: async () => { throw new Error('fixture parser failure'); },
  });
  try {
    const uploaded = await request(current.port, '/files?batch=document-failed-1234&name=broken.docx', {
      method: 'POST',
      body: 'not-a-docx',
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.file.readable.status, 'failed');
    assert.equal(uploaded.json.file.readable.code, 'DOCUMENT_PARSE_FAILED');
    const relative = uploaded.json.file.path.replace('/project-inputs/', '');
    assert.equal(await readFile(path.join(current.root, ...relative.split('/')), 'utf8'), 'not-a-docx');
  } finally {
    await current.close();
  }
});

test('server rejects oversized files and enforces the per-batch file count without partial files', async () => {
  const current = await fixture();
  try {
    const oversized = await request(current.port, '/files?batch=oversize-1234&name=large.bin', {
      method: 'POST',
      body: 'x'.repeat(33),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json.code, 'FILE_TOO_LARGE');

    const batch = 'batch-limit-1234';
    for (const name of ['one.txt', 'two.txt']) {
      const uploaded = await request(current.port, `/files?batch=${batch}&name=${name}`, {
        method: 'POST',
        body: name,
      });
      assert.equal(uploaded.status, 201);
    }
    const rejected = await request(current.port, `/files?batch=${batch}&name=three.txt`, {
      method: 'POST',
      body: 'three',
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, 'BATCH_FILE_LIMIT');

    const staging = await readdir(path.join(current.root, '.forge-upload-staging'));
    assert.deepEqual(staging, []);
  } finally {
    await current.close();
  }
});

test('project quota rejects a new upload before writing bytes', async () => {
  const current = await fixture({ maxProjectBytes: 12 });
  try {
    const first = await request(current.port, '/files?batch=quota-one&name=one.txt', {
      method: 'POST',
      body: '12345678',
    });
    assert.equal(first.status, 201);
    const second = await request(current.port, '/files?batch=quota-two&name=two.txt', {
      method: 'POST',
      body: '12345678',
    });
    assert.equal(second.status, 507);
    assert.equal(second.json.code, 'PROJECT_QUOTA_EXCEEDED');
  } finally {
    await current.close();
  }
});
