import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { projectDirectoryScope, readHarnessDirectoryScope, readManagedFileTargets } from '../docker/harness/harness-directory-scope.mjs';
import { createHarnessProxy } from '../docker/harness/tcp-proxy.mjs';

const mount = (id, source, target, mode = 'rw') => `${id} 1 8:1 ${source} ${target} ${mode},relatime - ext4 /dev/sda rw\n`;
const mounts = mount(2, '/srv/project/task/workspace', '/workspace')
  + mount(3, '/srv/project/workspace', '/integration', 'ro')
  + mount(4, '/srv/ftp/project\\040files', '/project-ftp-inputs', 'ro')
  + mount(5, '/srv/secrets', '/run/secrets', 'ro')
  + mount(6, '/srv/task/cache', '/workspace/.forge-cache/m2')
  + mount(7, '/srv/platform/PROJECT_CONTEXT.md', '/workspace/PROJECT_CONTEXT.md', 'ro');

test('directory view reflects real project mounts, FTP binding and ro without exposing private mounts', () => {
  const result = projectDirectoryScope(mounts);
  assert.equal(result.editable, false);
  assert.equal(result.defaultDirectory, '/workspace');
  assert.deepEqual(result.directories.map((entry) => [entry.path, entry.access]), [
    ['/workspace', 'read-write'], ['/integration', 'read-only'], ['/project-ftp-inputs', 'read-only'],
  ]);
  assert.equal(result.directories[2].sourcePath, '/srv/ftp/project files');
  assert.equal(result.directories[0].writeRequiresTaskAuthorization, true);
  assert.match(result.directories[0].exclusions.join(','), /平台保护文件/);
  assert.doesNotMatch(JSON.stringify(result), /\/srv\/secrets|\/srv\/task\/cache|\/run\/secrets/);
  assert.equal(projectDirectoryScope(mount(2, '/srv/code', '/workspace', 'ro')).directories[0].access, 'read-only');
  assert.equal(projectDirectoryScope('').defaultDirectory, null);
});

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-directories-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return server.address().port;
}

test('managed directories come from authenticated broker targets and omit configuration secrets', async (t) => {
  const root = await temporary(t);
  const tokenFile = path.join(root, 'token');
  const mountInfoPath = path.join(root, 'mountinfo');
  await writeFile(tokenFile, 'private-workpod-token');
  await writeFile(mountInfoPath, mounts);
  let action;
  const port = await listen(t, http.createServer(async (req, res) => {
    assert.equal(req.headers['x-forge-taskspace-token'], 'private-workpod-token');
    assert.equal(req.url, '/v1/actions');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    action = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { ok: true, targets: [
      { targetId: 'ftp-output', name: 'FTP 输出', transport: 'local', serverDirectory: '/srv/project/output', toolPath: 'managed_file:ftp-output/', read: true, write: true, secret: 'must-not-echo' },
    ] } }));
  }));
  const result = await readHarnessDirectoryScope({ mountInfoPath, managedTargetReader: () => readManagedFileTargets({ brokerUrl: `http://127.0.0.1:${port}`, tokenFile }) });
  assert.deepEqual(action, { action: 'managed-files', operation: 'targets' });
  assert.equal(result.managedDirectoryStatus, 'available');
  assert.equal(result.directories.at(-1).scope, 'explicit-task');
  assert.equal(result.directories.at(-1).path, 'managed_file:ftp-output/');
  assert.doesNotMatch(JSON.stringify(result), /must-not-echo|private-workpod-token/);
  const unavailable = await readHarnessDirectoryScope({ mountInfoPath, managedTargetReader: async () => { throw new Error('down'); } });
  assert.equal(unavailable.managedDirectoryStatus, 'unavailable');
  assert.equal(unavailable.directories.length, 3);
});

test('directory HTTP view enforces existing auth, offers no write API and reports missing authority', async (t) => {
  const root = await temporary(t);
  const fence = path.join(root, 'fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'directory-test' }));
  let reads = 0, fail = false;
  const proxy = createHarnessProxy({ targetHost: '127.0.0.1', targetPort: 1,
    trustedAuthority: '127.0.0.1:18080', maintenanceFencePath: fence,
    accessToken: 'a'.repeat(40), directoryScopeReader: async () => {
      reads += 1;
      if (fail) throw new Error('private internal error');
      return projectDirectoryScope(mounts);
    },
  });
  const port = await listen(t, proxy);
  const send = (method, cookie) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/forge-directories', method,
      headers: { host: '127.0.0.1:18080', ...(cookie ? { cookie } : {}) } }, async (res) => {
      const chunks = []; for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
    }); req.on('error', reject); req.end();
  });
  assert.equal((await send('GET')).status, 403);
  assert.equal(reads, 0);
  const cookie = `forge_harness_access=${'a'.repeat(40)}`;
  const allowed = await send('GET', cookie);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(allowed.body).editable, false);
  assert.equal((await send('POST', cookie)).status, 405);
  assert.equal(reads, 1);
  fail = true;
  const missing = await send('GET', cookie);
  assert.equal(missing.status, 503);
  assert.doesNotMatch(missing.body, /private internal/);
});

test('default page directory panel is prominent, text-only and readonly; failed refresh removes old grants', async () => {
  const walk = (element) => [element, ...element.children.flatMap(walk)];
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.ownText = ''; }
    set textContent(text) { this.ownText = String(text); this.children = []; }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('unsafe HTML'); }
    append(...elements) { this.children.push(...elements); }
    prepend(...elements) { this.children.unshift(...elements); }
    replaceChildren(...elements) { this.ownText = ''; this.children = [...elements]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll(selector) {
      return walk(this).slice(1).filter((element) => {
        if (!selector.startsWith('[')) return element.tagName === selector;
        const name = selector.slice(1, -1).split('=')[0].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return element.dataset[name] !== undefined;
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const document = new Element('document'); document.head = new Element('head'); document.body = new Element('body');
  document.createElement = (tag) => new Element(tag); document.append(document.head, document.body);
  const card = new Element('div'); card.dataset.composerCard = 'true'; document.body.append(card);
  const window = new EventTarget(); let fail = false, requests = 0;
  const data = projectDirectoryScope(mounts); data.directories[2].name = '<img src=x onerror=alert(1)>';
  const source = await readFile(new URL('../docker/harness/harness-directory-scope.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { document, window, HTMLElement: Element,
    MutationObserver: class { observe() {} }, requestAnimationFrame: (callback) => callback(),
    fetch: async (_url, options) => { requests += 1; assert.equal(options.credentials, 'same-origin');
      if (fail) throw new Error('offline'); return { ok: true, json: async () => data }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.children[0].dataset.forgeDirectoryScope, 'true');
  assert.match(card.textContent, /可操作目录.*当前 Forge.*\/workspace/s);
  assert.match(card.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(walk(card).some((element) => ['input', 'select', 'button', 'img'].includes(element.tagName)), false);
  fail = true; window.dispatchEvent(new Event('focus'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.match(card.textContent, /目录信息暂不可用/);
  assert.doesNotMatch(card.textContent, /\/workspace/);
});
