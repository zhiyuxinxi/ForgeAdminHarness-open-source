import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { renderHostVerificationUnit } from '../scripts/render-host-verification-unit.mjs';

const options = {
  deliveryOwner: 'forge', deliveryGroup: 'forge', hostNodePath: '/opt/node/bin/node',
  hostRunnerRoot: '/opt/forge-host-runner',
};

test('Host unit renders both legacy and isolated paths without changing its security boundary', async () => {
  for (const deliveryRoot of [undefined, '/srv/forge-coverage-upgrade-b']) {
    const unit = await renderHostVerificationUnit({ ...options, deliveryRoot });
    const root = deliveryRoot ?? '/srv/forge-delivery';
    for (const line of [
      `EnvironmentFile=${root}/projects/%i/verification/host-runner.env`,
      `WorkingDirectory=${root}/projects/%i/verification`,
      `ReadOnlyPaths=${root}/projects/%i/taskspaces`,
      `ReadWritePaths=${root}/projects/%i/verification`,
      `ReadWritePaths=${root}/projects/%i/acceptance/ipc-issuer`,
      'ExecStart=/opt/node/bin/node /opt/forge-host-runner/current/lib/host-verification-runner.mjs',
      'User=forge', 'Group=forge', 'NoNewPrivileges=true', 'ProtectSystem=strict',
      'PrivateDevices=true', 'ProtectHome=true',
    ]) assert.ok(unit.split(/\r?\n/u).includes(line), line);
    assert.doesNotMatch(unit, /__[A-Z_]+__|docker\.sock|\/bin\/sh/u);
    if (deliveryRoot) assert.ok(!unit.includes('/srv/forge-delivery'));
    assert.equal(await renderHostVerificationUnit({ ...options, deliveryRoot }), unit);
  }
});

test('Host unit rejects paths or accounts that systemd could interpret as additional directives', async () => {
  for (const deliveryRoot of ['/', 'relative', '/srv/../etc', '/srv/test/', '/srv/test space', '/srv/%i', '/srv/test\nUser=root', '/srv/forge\\x20other']) {
    await assert.rejects(renderHostVerificationUnit({ ...options, deliveryRoot }), /absolute normalized Linux path/u);
  }
  for (const value of ['root', '0', 'forge\nExecStart=/bin/sh', 'forge group']) {
    await assert.rejects(renderHostVerificationUnit({ ...options, deliveryOwner: value }), /non-root Linux account/u);
    await assert.rejects(renderHostVerificationUnit({ ...options, deliveryGroup: value }), /non-root Linux account/u);
  }
});

test('Host unit command writes only a complete rendered unit and refuses missing required arguments', () => {
  const entry = 'scripts/render-host-verification-unit.mjs';
  const args = ['--delivery-root', '/srv/forge-coverage-upgrade-b', '--delivery-owner', 'forge',
    '--delivery-group', 'forge', '--host-node-path', '/opt/node/bin/node', '--host-runner-root', '/opt/forge-host-runner'];
  const rendered = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.ok(rendered.stdout.startsWith('[Unit]'));
  assert.ok(rendered.stdout.includes('WorkingDirectory=/srv/forge-coverage-upgrade-b/projects/%i/verification'));
  const missing = spawnSync(process.execPath, [entry, ...args.slice(0, -2)], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
});
