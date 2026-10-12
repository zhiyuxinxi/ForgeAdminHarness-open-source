import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareDeliverySocket } from '../docker/harness/delivery-center-service.mjs';

const unixOnly = { skip: process.platform === 'win32', timeout: 10000 };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'delivery-socket-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, socketPath: path.join(directory, 'read.sock') };
}

test('reader removes a refused socket left by SIGKILL and can bind it again', unixOnly, async (t) => {
  const { socketPath } = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import net from 'node:net'; net.createServer().listen(process.argv[1], () => process.stdout.write('ready'));", socketPath],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Socket fixture exited before listening.')));
    child.stdout.once('data', (bytes) => { assert.equal(bytes.toString(), 'ready'); resolve(); });
  });
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
  assert.equal((await lstat(socketPath)).isSocket(), true);
  await prepareDeliverySocket(socketPath);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try { assert.equal((await lstat(socketPath)).isSocket(), true); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});

test('reader preserves a live socket and refuses to take over its address', unixOnly, async (t) => {
  const { socketPath } = await fixture(t);
  const server = net.createServer((connection) => connection.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    const previous = await lstat(socketPath, { bigint: true });
    await assert.rejects(prepareDeliverySocket(socketPath), /DELIVERY_SOCKET_ACTIVE/u);
    const current = await lstat(socketPath, { bigint: true });
    assert.equal(current.ino, previous.ino); assert.equal(current.dev, previous.dev);
    assert.equal(server.listening, true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('reader preserves ordinary files and symlinks at its socket path', unixOnly, async (t) => {
  const { directory, socketPath } = await fixture(t);
  await writeFile(socketPath, 'must remain');
  await assert.rejects(prepareDeliverySocket(socketPath), /DELIVERY_SOCKET_INVALID/u);
  assert.equal(await readFile(socketPath, 'utf8'), 'must remain');
  const linkPath = path.join(directory, 'alias.sock');
  await symlink(socketPath, linkPath);
  await assert.rejects(prepareDeliverySocket(linkPath), /DELIVERY_SOCKET_INVALID/u);
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(socketPath, 'utf8'), 'must remain');
});
