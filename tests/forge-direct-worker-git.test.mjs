import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { directWorkerConfinement, directWorkerSpawnSpec } from '../docker/harness/forge-direct-worker-sandbox.mjs';
import { withDirectToolPolicy, currentDirectToolPolicy } from '../docker/harness/forge-direct-development.mjs';
import { createToolWorkerBashExecutor } from '../docker/harness/forge-tool-worker-bash.mjs';

const filesystem = {
  realpathSync: value => value,
  readdirSync: value => value === '/workspace' ? ['.git', '.env', 'src'] : ['config', 'config.worktree', 'hooks', 'objects', 'HEAD'],
  lstatSync: value => ({ isSymbolicLink: () => false, isDirectory: () => /(?:\.git|hooks|objects|src)$/u.test(value) }),
};

test('ordinary scripts, pipes and Unicode history use readable immutable Git without command classification', () => {
  for (const command of ['git log --since="2026-09-20" -- "中文 文件.md" | head',
    'ls src; git show HEAD:src/a.js; git diff HEAD~1..HEAD', 'node scripts/analyze.mjs',
    'python3 -c "import subprocess; subprocess.run([\'git\', \'blame\', \'src/a.js\'])"',
    'git add .', 'git config --list']) {
    for (const mode of ['read-only', 'workspace-write']) {
      const argv = ['bash', '-c', command];
      const wrapped = directWorkerConfinement(argv, { mode, workspaceRoot: '/workspace' }, { filesystem }).argv;
      const text = wrapped.join(' ');
      assert.ok(text.includes(`${mode === 'read-only' ? '--ro-bind' : '--bind'} /workspace /workspace`));
      assert.match(text, /--ro-bind \/workspace\/\.git \/workspace\/\.git/u);
      const config = wrapped.indexOf('/workspace/.git/config');
      assert.equal(wrapped[config - 2], '--ro-bind');
      assert.equal(readFileSync(wrapped[config - 1], 'utf8'), '');
      assert.match(text, /--tmpfs \/workspace\/\.git\/hooks/u);
      assert.match(text, /--ro-bind \/dev\/null \/workspace\/\.env/u);
      assert.match(text, /--setenv GIT_OPTIONAL_LOCKS 0/u);
      assert.deepEqual(wrapped.slice(-3), argv);
    }
  }
  assert.throws(() => directWorkerConfinement(['bash'], { mode: 'workspace-write', workspaceRoot: '/workspace' }, { filesystem: {
    ...filesystem, lstatSync: value => ({ isSymbolicLink: () => value === '/workspace/.git/config', isDirectory: () => value === '/workspace/.git' }),
  } }), /must not be symlinks/u);
});

test('caller environment cannot change the trusted launcher or inherit Git configuration', () => {
  const argv = directWorkerConfinement(['bash', '-c', 'git status'], { mode: 'read-only', workspaceRoot: '/workspace' }, { filesystem }).argv;
  const safe = directWorkerSpawnSpec({ argv, cwd: '/workspace', env: { PATH: '/usr/bin', CI: 'true', GIT_DIR: '/other',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', LD_PRELOAD: 'bad', FORGE_TOKEN: 'bad' } });
  assert.deepEqual(safe.env, { PATH: '/usr/bin', CI: 'true' });
  assert.equal(directWorkerSpawnSpec({ argv, cwd: '/tmp', env: {} }).cwd, '/tmp');
  for (const cwd of ['/integration', '/home/node', '/tmp/../home', '/workspace/../integration']) {
    assert.throws(() => directWorkerSpawnSpec({ argv, cwd, env: {} }), /cwd/u);
  }
});

test('authenticated per-call sandbox policy survives async execution without leaking between concurrent tasks', async t => {
  const old = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => old === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = old);
  class Ordinary { run(spec) { return spec.sandboxPolicy.mode; } start(spec) { return this.run(spec); } }
  const Executor = createToolWorkerBashExecutor(Ordinary, { runArgv() {}, startArgv() {} });
  const executor = new Executor();
  assert.equal(executor.run({ command: 'python3 inspect.py', sandboxPolicy: { mode: 'danger-full-access' } }), 'read-only');
  const results = await Promise.all(['read-only', 'workspace-write'].map(mode => withDirectToolPolicy({ mode, workspaceRoot: '/workspace' }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentDirectToolPolicy().mode, mode);
    return executor.start({ command: 'node script.mjs', sandboxPolicy: { mode: 'danger-full-access' } });
  })));
  assert.deepEqual(results, ['read-only', 'workspace-write']);
  assert.equal(currentDirectToolPolicy().mode, 'read-only');
});
