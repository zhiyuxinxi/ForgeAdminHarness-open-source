import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repository, relative), 'utf8');
const control = read('scripts/taskspacectl.sh');
const seedProgram = control.match(/<<'NODE_CODEX_SEED'\r?\n([\s\S]*?)\r?\nNODE_CODEX_SEED/u)?.[1];
const nativeRequire = createRequire(import.meta.url);

function token(seconds = 3600, account = 'fixture-account') {
  const payload = { exp: Math.floor(Date.now() / 1000) + seconds,
    'https://api.openai.com/auth': { chatgpt_account_id: account } };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;
}

function fixture(shape = 'block') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-seed-'));
  const project = path.join(temporary, 'project');
  const task = path.join(project, 'taskspaces/task-fixture');
  fs.mkdirSync(path.join(project, 'ops/codex-cli'), { recursive: true });
  fs.mkdirSync(path.join(task, 'dsh-home'), { recursive: true });
  const credential = token();
  const seed = shape === 'flow'
    ? `version: 1\nrefs:\n  {\n    FORGE_CODEX_CLI_ACCESS_TOKEN: ${credential}\n  }\n`
    : `version: 1\nrefs:\n  FORGE_CODEX_CLI_ACCESS_TOKEN: ${credential}\n`;
  fs.writeFileSync(path.join(project, 'ops/codex-cli/credentials.yaml'), seed);
  fs.writeFileSync(path.join(project, 'ops/codex-cli.env'),
    'TASKSPACE_CODEX_CLI_ENABLED=true\nTASKSPACE_DEFAULT_HTTPS_PROXY=http://fixture:fixture@172.18.0.1:17897\n');
  fs.writeFileSync(path.join(task, 'task.env'),
    'TASKSPACE_ID=task-fixture\nTASKSPACE_HTTPS_PROXY=\nTASKSPACE_NO_PROXY=\nUNCHANGED=yes\n');
  const unsafe = new Set();
  // Windows cannot express Linux uid/gid/0600 with chmod. Only stat metadata is
  // supplied by the fixture; all seed parsing and file IO run unchanged.
  const files = new Proxy(fs, { get(target, key) {
    if (key !== 'lstatSync') return target[key];
    return (name) => {
      const actual = fs.lstatSync(name);
      return new Proxy(actual, { get(value, property) {
        if (property === 'uid') return unsafe.has(name) ? 999 : 1000;
        if (property === 'gid') return 983;
        if (property === 'mode') return (value.mode & ~0o777) | (value.isDirectory() ? 0o700 : 0o600);
        const item = value[property];
        return typeof item === 'function' ? item.bind(value) : item;
      } });
    };
  } });
  return { project, task, credential, seed, unsafe,
    run() {
      let stderr = '', stdout = '';
      const processFixture = { argv: ['node', '-', project, task, '1000', '983'],
        getuid: () => 1000, stderr: { write: (value) => { stderr += value; } },
        stdout: { write: (value) => { stdout += value; } }, exitCode: 0 };
      vm.runInNewContext(seedProgram, {
        require: (name) => name === 'node:fs' ? files : nativeRequire(name),
        process: processFixture, Buffer, URL,
      }, { timeout: 3000 });
      assert.ok(!stdout.includes(credential) && !stderr.includes(credential));
      return { code: processFixture.exitCode, stdout, stderr };
    },
    close() {
      assert.equal(path.dirname(temporary), os.tmpdir());
      fs.rmSync(temporary, { recursive: true, force: true });
    },
  };
}

test('new TaskSpaces seed exactly the native short ref and preserve other environment values', () => {
  const f = fixture();
  try {
    assert.equal(f.run().code, 0);
    assert.equal(fs.readFileSync(path.join(f.task, 'dsh-home/.credentials.yaml'), 'utf8'), f.seed);
    assert.match(fs.readFileSync(path.join(f.task, 'task.env'), 'utf8'), /^UNCHANGED=yes$/mu);
    assert.match(fs.readFileSync(path.join(f.task, 'task.env'), 'utf8'), /^TASKSPACE_HTTPS_PROXY=http:\/\/fixture:fixture@172\.18\.0\.1:17897$/mu);
  } finally { f.close(); }
});

test('opening a conversation preserves existing credentials byte for byte', () => {
  const f = fixture();
  try {
    const existing = f.seed + '  ANOTHER_PROVIDER: preserved\nrecords: {}\n';
    fs.writeFileSync(path.join(f.task, 'dsh-home/.credentials.yaml'), existing);
    assert.equal(f.run().code, 0);
    assert.equal(fs.readFileSync(path.join(f.task, 'dsh-home/.credentials.yaml'), 'utf8'), existing);
    assert.equal(f.run().code, 0);
    assert.equal(fs.readFileSync(path.join(f.task, 'dsh-home/.credentials.yaml'), 'utf8'), existing);
  } finally { f.close(); }
});

test('new-only enrollment leaves old task environment and credentials untouched', () => {
  for (const shape of ['block', 'flow']) {
    const f = fixture(shape);
    try {
      fs.appendFileSync(path.join(f.project, 'ops/codex-cli.env'), 'TASKSPACE_CODEX_NEW_ONLY=true\n');
      const envPath = path.join(f.task, 'task.env');
      const credentialsPath = path.join(f.task, 'dsh-home/.credentials.yaml');
      const before = fs.readFileSync(envPath);
      assert.equal(f.run().code, 0, shape);
      assert.deepEqual(fs.readFileSync(envPath), before);
      assert.equal(fs.existsSync(credentialsPath), false);
      fs.appendFileSync(envPath, 'TASKSPACE_CODEX_CLI_MANAGED=true\n');
      const created = f.run();
      assert.equal(created.code, 0, shape);
      assert.equal(created.stderr, '', shape);
      assert.equal(fs.readFileSync(credentialsPath, 'utf8'), f.seed);
      assert.match(fs.readFileSync(envPath, 'utf8'), /^TASKSPACE_HTTPS_PROXY=http:/mu);
      const enrolledEnvironment = fs.readFileSync(envPath);
      const recovered = f.run();
      assert.equal(recovered.code, 0, shape);
      assert.equal(recovered.stderr, '', shape);
      assert.equal(fs.readFileSync(credentialsPath, 'utf8'), f.seed);
      assert.deepEqual(fs.readFileSync(envPath), enrolledEnvironment);
      assert.match(control, /^TASKSPACE_CODEX_CLI_MANAGED=true$/mu);
    } finally { f.close(); }
  }
});

test('unsafe seed contents or ownership fail without printing credentials', () => {
  for (const issue of ['extra-ref', 'ownership', 'flow-extra-ref', 'flow-duplicate-ref', 'flow-invalid-jwt']) {
    const f = fixture(issue.startsWith('flow-') ? 'flow' : 'block');
    try {
      const seedPath = path.join(f.project, 'ops/codex-cli/credentials.yaml');
      if (issue === 'extra-ref') fs.appendFileSync(seedPath, '  OTHER: forbidden\n');
      if (issue === 'ownership') f.unsafe.add(seedPath);
      if (issue === 'flow-extra-ref') fs.writeFileSync(seedPath,
        f.seed.replace('\n  }\n', ',\n    OTHER: forbidden\n  }\n'));
      if (issue === 'flow-duplicate-ref') fs.writeFileSync(seedPath,
        f.seed.replace('\n  }\n', `,\n    FORGE_CODEX_CLI_ACCESS_TOKEN: ${f.credential}\n  }\n`));
      if (issue === 'flow-invalid-jwt') fs.writeFileSync(seedPath, f.seed.replace(f.credential, 'invalid-jwt'));
      const result = f.run();
      assert.equal(result.code, 1, issue);
      assert.match(result.stderr, /unsafe structure or ownership/u);
      assert.equal(fs.existsSync(path.join(f.task, 'dsh-home/.credentials.yaml')), false);
    } finally { f.close(); }
  }
});

test('existing credentials without the Codex ref keep other models available and are never overwritten', () => {
  const f = fixture();
  try {
    const existing = 'version: 1\nrefs:\n  OTHER_PROVIDER: preserved\n';
    fs.writeFileSync(path.join(f.task, 'dsh-home/.credentials.yaml'), existing);
    const result = f.run();
    assert.equal(result.code, 0);
    assert.match(result.stderr, /other configured models remain available/u);
    assert.equal(fs.readFileSync(path.join(f.task, 'dsh-home/.credentials.yaml'), 'utf8'), existing);
  } finally { f.close(); }
});

test('logged-out, missing, and expired CLI authorization does not block other models', () => {
  for (const issue of ['logged-out', 'missing', 'expired']) {
    const f = fixture();
    try {
      const seedPath = path.join(f.project, 'ops/codex-cli/credentials.yaml');
      if (issue === 'logged-out') fs.writeFileSync(seedPath, 'version: 1\n');
      if (issue === 'missing') fs.unlinkSync(seedPath);
      if (issue === 'expired') fs.writeFileSync(seedPath, `version: 1\nrefs:\n  FORGE_CODEX_CLI_ACCESS_TOKEN: ${token(-1)}\n`);
      const result = f.run();
      assert.equal(result.code, 0, issue);
      assert.match(result.stderr, /other configured models remain available/u);
      assert.equal(fs.existsSync(path.join(f.task, 'dsh-home/.credentials.yaml')), false);
      assert.match(fs.readFileSync(path.join(f.task, 'task.env'), 'utf8'), /^UNCHANGED=yes$/mu);
    } finally { f.close(); }
  }
});

test('lifecycle checks happen before each launch and preserve no-recreate and existing model defaults', () => {
  assert.ok(seedProgram);
  assert.match(control, /\[\[ -e "\$\{config\}" \|\| -L "\$\{config\}" \]\] \|\| return 0/u);
  assert.equal([...control.matchAll(/if ! prepare_taskspace_codex_credentials "\$\{task_id\}"/gu)].length, 2);
  const start = control.slice(control.indexOf('      start)'), control.indexOf('      stop)'));
  assert.ok(start.indexOf('prepare_taskspace_codex_credentials') < start.indexOf('active_legacy_taskspace_runtime_is_healthy'));
  assert.match(start, /up --detach --no-recreate/u);
  const settings = read('templates/project/harness-settings.yaml');
  assert.match(settings, /openai-codex:\r?\n\s+apiKeyEnv: FORGE_CODEX_CLI_ACCESS_TOKEN\r?\n\s+transport: sse/u);
  assert.match(settings, /apiKeyEnv: KIMI_API_KEY/u);
  assert.match(settings, /apiKeyEnv: GLM_API_KEY/u);
  assert.doesNotMatch(settings, /^\s*(?:defaultModel|model):/mu);
  const create = read('scripts/create-project.sh');
  assert.ok(create.indexOf('--project-root "${project_path}"') > create.indexOf('>>"${registry_file}"'));
});

test('legacy TaskSpace Compose changes only the three optional Harness proxy fields', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-legacy-'));
  try {
    const values = {
      TASKSPACE_COMPOSE_PROJECT_NAME: 'forge-test-codex', HARNESS_IMAGE: 'example.invalid/harness:test',
      TASKSPACE_ROOT: '/srv/test/task', PROJECT_ROOT: '/srv/test/project', PROJECT_COMPOSE_NAME: 'forge-test',
      PROJECT_SLUG: 'forge-test', FORGE_BIND_ADDRESS: '127.0.0.1', TASKSPACE_HARNESS_PORT: '20000',
      HARNESS_UPLOAD_TOKEN: 'fixture', PROJECT_FTP_INPUT_ROOT: '/srv/test/ftp', PROJECT_SHARED_INPUT_ROOT: '/srv/test/shared',
      PLATFORM_CONVERSATION_AUTH_ROOT: '/srv/test/auth', TASKSPACE_ID: 'task-fixture', TASKSPACE_ACTOR_ID: 'admin',
      TASKSPACE_CONVERSATION_ID: 'conversation-fixture', DEEPSEEK_KEY_FILE: '/srv/test/deepseek', KIMI_KEY_FILE: '/srv/test/kimi',
    };
    const envPath = path.join(temporary, 'task.env');
    fs.writeFileSync(envPath, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'));
    const render = (enabled) => {
      const environment = { ...process.env };
      for (const name of [...Object.keys(values), 'TASKSPACE_HTTPS_PROXY', 'TASKSPACE_NO_PROXY']) delete environment[name];
      if (enabled) environment.TASKSPACE_HTTPS_PROXY = 'http://fixture:fixture@172.18.0.1:17897';
      const result = spawnSync('docker', ['compose', '--env-file', envPath, '--file',
        path.join(repository, 'templates/taskspace/compose.legacy-v1.yaml'), 'config', '--format', 'json', '--no-path-resolution'],
      { env: environment, encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const before = render(false), after = render(true);
    assert.equal(before.services.harness.environment.NODE_USE_ENV_PROXY, '');
    assert.equal(after.services.harness.environment.NODE_USE_ENV_PROXY, '1');
    for (const key of ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
      delete before.services.harness.environment[key]; delete after.services.harness.environment[key];
    }
    assert.deepEqual(after, before);
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir());
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
