import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('control-plane compose consumes the optional production plan and preserves its existing arguments', async () => {
  const source = await readFile('scripts/conversation-control-planectl.sh', 'utf8');
  const start = source.indexOf('compose() {');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const compose = source.slice(start, end + 2);
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'forge-production-control-plan-'));
  const overlay = path.join(fixture, 'production-delivery', 'service-plans', 'production-gateway.compose.json');
  const invoke = () => spawnSync('bash', ['-s', '--', fixture.replaceAll('\\', '/')], {
    input: ['set -eu', compose,
      'control_root="$1"; control_env="$1/control-plane.env"; compose_file="$1/compose.yaml"',
      'control_plane_project_name=forge-fixture; REPO_ROOT="$1/repo"',
      'docker() { printf "%s\\n" "$@"; }', 'compose config --format json',
    ].join('\n'), encoding: 'utf8', windowsHide: true,
  });
  try {
    const absent = invoke();
    assert.equal(absent.status, 0, absent.stderr);
    assert.doesNotMatch(absent.stdout, /production-gateway\.compose\.json/u);
    await mkdir(path.dirname(overlay), { recursive: true });
    await writeFile(overlay, JSON.stringify({ services: { 'conversation-gateway': { image: `sha256:${'a'.repeat(64)}` } } }));
    const present = invoke();
    assert.equal(present.status, 0, present.stderr);
    const args = present.stdout.trim().split(/\r?\n/u);
    const expected = overlay.replaceAll('\\', '/');
    assert.equal(args.filter((value) => value === expected).length, 1);
    assert.equal(args[args.indexOf(expected) - 1], '--file');
    assert.deepEqual(args.slice(0, 3), ['compose', '--project-name', 'forge-fixture']);
    assert.deepEqual(args.slice(-3), ['config', '--format', 'json']);
    assert.deepEqual(args.filter((value, index) => value !== expected && index !== args.indexOf(expected) - 1),
      absent.stdout.trim().split(/\r?\n/u));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
