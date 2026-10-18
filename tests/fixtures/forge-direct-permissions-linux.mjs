import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { directWorkerConfinement, directWorkerSpawnSpec } from '/usr/local/lib/forge-direct-worker-sandbox.mjs';

// Disposable, empty container mount only. Never run against a business clone.
assert.equal(process.env.FORGE_DIRECT_SANDBOX_FIXTURE, '1');
assert.equal(process.getuid(), 1000);
assert.deepEqual(fs.readdirSync('/workspace'), []);
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
function raw(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: '/workspace', env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
}
raw(['git', 'init', '-b', 'fixture']);
fs.writeFileSync('/workspace/中文 文件.txt', 'before\n');
raw(['git', 'add', '.']);
raw(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);
const head = raw(['git', 'rev-parse', 'HEAD']).trim();
fs.writeFileSync('/workspace/中文 文件.txt', 'after\n');
const trap = '#!/bin/sh\necho FORBIDDEN_CONFIG_EXECUTION >&2\nexit 81\n';
fs.writeFileSync('/workspace/trap.sh', trap, { mode: 0o755 });
fs.writeFileSync('/workspace/.git/hooks/post-index-change', trap, { mode: 0o755 });
fs.appendFileSync('/workspace/.git/config', '\n[core]\n fsmonitor = /workspace/trap.sh\n[diff]\n external = /workspace/trap.sh\n[remote "private"]\n url = https://fixture:credential-sentinel@example.invalid/repo\n');
fs.writeFileSync('/workspace/.env', 'credential-sentinel');
fs.writeFileSync('/workspace/PROJECT_CONTEXT.md', 'protected-platform-sentinel');
fs.mkdirSync('/run/forge-tool-worker', { recursive: true });
fs.writeFileSync('/run/forge-tool-worker/worker.sock', 'private-socket-sentinel');
function digest(directory) {
  const hash = createHash('sha256');
  const visit = root => { for (const name of fs.readdirSync(root).sort()) {
    const file = `${root}/${name}`, stat = fs.lstatSync(file); hash.update(`${file}:${stat.mode}:${stat.mtimeMs}:`);
    if (stat.isDirectory()) visit(file); else hash.update(fs.readFileSync(file));
  } }; visit(directory); return hash.digest('hex');
}
const before = digest('/workspace/.git'), observations = [];
function shell(command, mode = 'read-only', expected = 0) {
  const wrapped = directWorkerConfinement(['bash', '-c', command], { mode, workspaceRoot: '/workspace' });
  const spec = directWorkerSpawnSpec({ argv: wrapped.argv, cwd: '/workspace', env: { ...env,
    GIT_DIR: '/wrong', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/workspace/trap.sh' } });
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(expected === 0 ? result.status === 0 : result.status !== 0, true, `${command}: ${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, /credential-sentinel|FORBIDDEN_CONFIG_EXECUTION/);
  observations.push({ command, mode, exit: result.status }); return result.stdout;
}
assert.match(shell('git log --since="2000-01-01" --format="%h %s" -- "中文 文件.txt" | head -2'), /initial/);
assert.match(shell('ls -1; git show HEAD:"中文 文件.txt"; git diff -- "中文 文件.txt"'), /before[\s\S]*\+after/);
assert.match(shell('git blame HEAD -- "中文 文件.txt"'), /before/);
assert.equal(shell('node -e "process.stdout.write(require(\'node:child_process\').execFileSync(\'git\',[\'rev-parse\',\'HEAD\']))"').trim(), head);
assert.equal(shell('printf data > /tmp/analysis.txt; node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'/tmp/analysis.txt\'))"'), 'data');
shell('printf unauthorized > "中文 文件.txt"', 'read-only', 1);
assert.equal(fs.readFileSync('/workspace/中文 文件.txt', 'utf8'), 'after\n');
shell('printf authorized > generated.txt; node -e "if(require(\'node:fs\').readFileSync(\'generated.txt\',\'utf8\')!==\'authorized\')process.exit(1)"', 'workspace-write');
shell('git add generated.txt', 'workspace-write', 1);
shell('printf changed > .git/HEAD', 'workspace-write', 1);
shell('printf changed > PROJECT_CONTEXT.md', 'workspace-write', 1);
shell('test ! -e /run/forge-tool-worker/worker.sock; test -z "$(cat .git/config)"; test -z "$(cat .env 2>/dev/null)"');
shell('test ! -e /proc/1/environ; git status --short | head');
assert.equal(digest('/workspace/.git'), before);
assert.equal(fs.readFileSync('/workspace/.env', 'utf8'), 'credential-sentinel');
assert.equal(fs.readFileSync('/workspace/PROJECT_CONTEXT.md', 'utf8'), 'protected-platform-sentinel');
console.log(JSON.stringify({ status: 'passed', observations, gitMetadataUnchanged: true, credentialsPreserved: true }));
