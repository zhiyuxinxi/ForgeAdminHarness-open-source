// Platform-only Linux probe: same real confinement with a synthetic payload.
// No application workspace, model request, host proc, or business data is used.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { directWorkerConfinement } from '/usr/local/lib/forge-direct-worker-sandbox.mjs';

const status = readFileSync('/proc/self/status', 'utf8');
for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(status, new RegExp(`${key}:\\s+0000000000000000`));
assert.match(status, /Uid:\s+1000\s+1000/u);
assert.match(status, /NoNewPrivs:\s+1/u);
assert.match(status, /Seccomp:\s+2/u);
assert.match(readFileSync('/proc/self/attr/current', 'utf8'), /^forge-direct-worker /u);

function inspectInner() {
  const assert = require('node:assert/strict'), fs = require('node:fs');
  const browser = process.argv[1] === 'browser';
  const observations = [];
  const masked = ['/proc/acpi', '/proc/asound', '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap'];
  for (const target of masked) {
    try { assert.deepEqual(fs.readdirSync(target), [], target); observations.push({ target, access: 'empty-directory' }); }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; observations.push({ target, access: error.code }); }
  }
  for (const name of ['interrupts', 'kcore', 'keys', 'latency_stats', 'sched_debug', 'timer_list', 'timer_stats']) {
    const target = '/proc/' + name;
    try { assert.equal(fs.readFileSync(target).length, 0, target); observations.push({ target, access: 'zero-bytes' }); }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; observations.push({ target, access: error.code }); }
  }
  for (const name of ['bus', 'fs', 'irq', 'sys', 'sysrq-trigger']) {
    const target = '/proc/' + name;
    if (!fs.existsSync(target)) {
      assert.throws(() => fs.lstatSync(target), error => { observations.push({ target, access: error.code }); return ['ENOENT', 'EACCES', 'EPERM'].includes(error.code); });
      continue;
    }
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
    assert.ok(mounts.some(line => { const fields = line.split(' '); return fields[4] === target && fields[5].split(',').includes('ro'); }), target);
    observations.push({ target, access: 'readonly-mount' });
  }
  if (browser) {
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\s+1/u);
    const command = fs.readFileSync('/proc/1/cmdline', 'utf8');
    assert.doesNotMatch(command, /\0\/probe\.mjs(?:\0|$)/u, 'Outer fixture must not be PID 1');
    assert.match(fs.readFileSync('/proc/self/mountinfo', 'utf8'), / - proc proc /u);
  } else {
    assert.deepEqual(fs.readdirSync('/proc').sort(), ['cpuinfo', 'loadavg', 'meminfo', 'stat', 'uptime', 'version']);
    assert.throws(() => fs.readFileSync('/proc/1/environ'), { code: 'ENOENT' });
    assert.throws(() => fs.readFileSync('/proc/self/environ'), { code: 'ENOENT' });
  }
  console.log(JSON.stringify({ kind: browser ? 'browser' : 'ordinary', sensitiveProcHidden: true, readonlyProcPreserved: true, sysHidden: true, outerProcessesHidden: true, observations }));
}

const visibility = ['/proc/acpi', '/proc/asound', '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap'].map(target => {
  let lstat = 'visible'; try { lstatSync(target); } catch (error) { lstat = error.code; }
  return { target, exists: existsSync(target), lstat };
});
console.log(JSON.stringify({ outerSystemPathVisibility: visibility }));

for (const kind of ['ordinary', 'browser']) {
  const selected = kind === 'browser' ? ['/usr/local/bin/node', '/usr/local/lib/forge-browser-worker.mjs'] : ['/bin/true'];
  const command = directWorkerConfinement(selected, { mode: 'workspace-write', workspaceRoot: '/workspace' }).argv;
  const marker = command.lastIndexOf('--');
  // Replace only the synthetic payload after building the exact production wrapper.
  command.splice(marker + 1, command.length, '/usr/local/bin/node', '-e', `(${inspectInner.toString()})()`, kind);
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', cwd: '/workspace', timeout: 10000 });
  assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
  process.stdout.write(result.stdout);
}
console.log(JSON.stringify({ status: 'passed', uid: 1000, capabilities: 0, noNewPrivileges: true, appArmor: 'forge-direct-worker', seccomp: true }));
