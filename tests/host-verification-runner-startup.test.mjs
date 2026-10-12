import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startHostVerificationServers } from '../docker/harness/host-verification-runner.mjs';

test('Host startup closes source listener if execution socket binding fails', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sockets = { socketPath: path.join(root, 'verify.sock'), sourceSocketPath: path.join(root, 'source.sock') };
  const runner = {
    stateRoot: path.join(root, 'state'), projectSlug: 'forge-host', contract: { runnerRevision: 'startup-test' },
    async prepareInstalledDependencies() {
      assert.equal((await lstat(sockets.sourceSocketPath)).mode & 0o777, 0o660);
      await mkdir(sockets.socketPath);
      return [];
    },
    execute: async () => assert.fail('execution must not run before the execution listener opens'),
  };
  await assert.rejects(startHostVerificationServers(runner, sockets), { code: 'EADDRINUSE' });
  await assert.rejects(lstat(sockets.sourceSocketPath), { code: 'ENOENT' });
  assert.equal((await lstat(sockets.socketPath)).isDirectory(), true, 'failed bind must not remove a foreign path');
});
