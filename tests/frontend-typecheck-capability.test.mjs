import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, '..');
const helperPath = path.join(repoRoot, 'scripts', 'lib', 'frontend-typecheck-capability.sh');
const upgradePath = path.join(repoRoot, 'scripts', 'upgrade-frontend-typecheck.sh');
const manifestPath = path.join(repoRoot, 'templates', 'project', 'frontend-typecheck-capability.json');
const patchPath = path.join(repoRoot, 'templates', 'project', 'frontend-typecheck-capability.patch');
const createProjectPath = path.join(repoRoot, 'scripts', 'create-project.sh');
const validatePath = path.join(repoRoot, 'tests', 'validate.ps1');
const productionFixturePath = path.join(testRoot, 'fixtures', 'frontend-typecheck-capability');

const TYPECHECK_COMMAND = 'vue-tsc --noEmit --project jsconfig.json';
const TYPESCRIPT_VERSION = '5.9.3';
const VUE_TSC_VERSION = '3.3.11';

function sha256(value) {
  return createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex');
}

function resolvePortableBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (gitExec.status === 0) {
    const candidate = path.resolve(gitExec.stdout.trim(), '../../../bin/bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

function bashPath(value) {
  if (process.platform !== 'win32') return value;
  const matched = /^([A-Za-z]):[\\/](.*)$/u.exec(path.resolve(value));
  if (!matched) return value.replaceAll('\\', '/');
  return `/${matched[1].toLowerCase()}/${matched[2].replaceAll('\\', '/')}`;
}

const jqProbe = spawnSync(resolvePortableBash(), ['-lc', 'command -v jq'], {
  encoding: 'utf8',
  windowsHide: true,
});
const helperRuntimeSkip = jqProbe.status === 0 ? false : 'jq is unavailable in the local Bash runtime';

function runInternal(action, fixture) {
  const script = [
    'set -Eeuo pipefail',
    'source "$1"',
    'frontend_typecheck_capability_run "$2" "$3" "$4" "$5" "$6"',
  ].join('; ');
  return spawnSync(resolvePortableBash(), [
    '-c',
    script,
    'forge-r2-test',
    bashPath(helperPath),
    action,
    bashPath(fixture.workspace),
    bashPath(fixture.manifest),
    bashPath(fixture.patch),
    fixture.metadata ? bashPath(fixture.metadata) : '',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
}

const beforePackage = `${JSON.stringify({
  private: true,
  scripts: { test: 'vitest run' },
  devDependencies: { vitest: '2.1.9' },
}, null, 2)}\n`;

const targetPackage = `${JSON.stringify({
  private: true,
  scripts: { test: 'vitest run', typecheck: TYPECHECK_COMMAND },
  devDependencies: {
    vitest: '2.1.9',
    typescript: TYPESCRIPT_VERSION,
    'vue-tsc': VUE_TSC_VERSION,
  },
}, null, 2)}\n`;

const beforeJsconfig = `{
  "compilerOptions": {
    "target": "ESNext",
    "jsx": "preserve",
    "baseUrl": "./",
    "moduleResolution": "node",
    "paths": {
      "@/*": ["src/*"],
      "~/*": ["./*"]
    },
    "allowJs": true
  },
  "exclude": ["node_modules", "dist"]
}
`;

const previousTargetJsconfig = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "jsx": "preserve",
    "baseUrl": "./",
    "moduleResolution": "node",
    "paths": {
      "@/*": ["src/*"],
      "~/*": ["./*"]
    },
    "allowJs": true,
    "esModuleInterop": true
  },
  "exclude": ["node_modules", "dist"]
}
`;

const targetJsconfig = `{
  "compilerOptions": {
    "target": "ESNext",
    "jsx": "preserve",
    "baseUrl": "./",
    "module": "ESNext",
    "moduleResolution": "node",
    "paths": {
      "@/*": ["src/*"],
      "~/*": ["./*"]
    },
    "allowJs": true,
    "esModuleInterop": true
  },
  "exclude": ["node_modules", "dist"]
}
`;

const beforeLock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      vitest:
        specifier: 2.1.9
        version: 2.1.9

packages:

  vitest@2.1.9:
    resolution: {integrity: sha512-fixture}

snapshots:

  vitest@2.1.9: {}
`;

const targetLock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      typescript:
        specifier: 5.9.3
        version: 5.9.3
      vitest:
        specifier: 2.1.9
        version: 2.1.9
      vue-tsc:
        specifier: 3.3.11
        version: 3.3.11(typescript@5.9.3)

packages:

  '@volar/typescript@2.4.28':
    resolution: {integrity: sha512-Ja6yvWrbis2QtN4ClAKreeUZPVYMARDYZl9LMEv1iQ1QdepB6wn0jTRxA9MftYmYa4DQ4k/DaSZpFPUfxl8giw==}

  '@vue/language-core@3.3.11':
    resolution: {integrity: sha512-QJmpliwAVpC/OxubIByPAhNzsQPRc8/gxlN2qnVzVfIMjMDz/9RnXRFoetjz5yEgXVXyp4LqhXq3V53PjmNzFw==}

  alien-signals@3.2.1:
    resolution: {integrity: sha512-I8FjmltrfnDFoZedi5CG8DghVYNhzb/Ijluz7tCSJH0xpd0484Kowhbb1XDYOxfJpU1p5wnM2X54dA+IfGyD1g==}

  typescript@5.9.3:
    resolution: {integrity: sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==}
    engines: {node: '>=14.17'}
    hasBin: true

  vscode-uri@3.2.0:
    resolution: {integrity: sha512-m2gXo3bn0G1kT9InzMf07fTbqMbGtyckj3bH5ktLO+1Ssv+yiATZ4dhwaQv9UZWxJh6E9IFGnQyjgWVDWVBDrg==}

  vue-tsc@3.3.11:
    resolution: {integrity: sha512-gOb0B9rtU2+f1dszwPqSH5kAieIF9ReeLhD3kSRNHv5WZZUQz/JdVXW0RTdqhNTMlQkqKzrTTviqKr/4FYZraQ==}
    hasBin: true
    peerDependencies:
      typescript: '>=5.0.0'

  vitest@2.1.9:
    resolution: {integrity: sha512-fixture}

snapshots:

  '@volar/typescript@2.4.28':
    dependencies:
      '@volar/language-core': 2.4.28
      path-browserify: 1.0.1
      vscode-uri: 3.2.0

  '@vue/language-core@3.3.11':
    dependencies:
      '@volar/language-core': 2.4.28
      '@vue/compiler-dom': 3.5.30
      '@vue/shared': 3.5.30
      alien-signals: 3.2.1
      muggle-string: 0.4.1
      path-browserify: 1.0.1
      picomatch: 4.0.5

  alien-signals@3.2.1: {}

  typescript@5.9.3: {}

  vscode-uri@3.2.0: {}

  vue-tsc@3.3.11(typescript@5.9.3):
    dependencies:
      '@volar/typescript': 2.4.28
      '@vue/language-core': 3.3.11
      typescript: 5.9.3

  vitest@2.1.9: {}
`;

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-frontend-typecheck-'));
  const taskspace = path.join(root, 'project', 'taskspaces', 'c-0123456789abcdef01234567');
  const workspace = path.join(taskspace, 'workspace');
  const frontend = path.join(workspace, 'forge-admin-ui');
  await mkdir(frontend, { recursive: true });
  await writeFile(path.join(frontend, 'package.json'), beforePackage);
  await writeFile(path.join(frontend, 'pnpm-lock.yaml'), beforeLock);
  await writeFile(path.join(frontend, 'jsconfig.json'), beforeJsconfig);
  await writeFile(path.join(workspace, 'sentinel.txt'), 'unchanged\n');

  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 'Forge R2 Test'],
    ['config', 'user.email', 'forge-r2@example.invalid'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) {
    const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }

  await writeFile(path.join(frontend, 'package.json'), targetPackage);
  await writeFile(path.join(frontend, 'pnpm-lock.yaml'), targetLock);
  await writeFile(path.join(frontend, 'jsconfig.json'), targetJsconfig);
  const diff = spawnSync('git', [
    '-C', workspace, 'diff', '--no-ext-diff', '--binary', '--',
    'forge-admin-ui/package.json', 'forge-admin-ui/pnpm-lock.yaml', 'forge-admin-ui/jsconfig.json',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(diff.status, 0, diff.stderr);
  const patch = path.join(root, 'capability.patch');
  await writeFile(patch, diff.stdout);
  await writeFile(path.join(frontend, 'package.json'), beforePackage);
  await writeFile(path.join(frontend, 'pnpm-lock.yaml'), beforeLock);
  await writeFile(path.join(frontend, 'jsconfig.json'), beforeJsconfig);

  const manifest = path.join(root, 'capability.json');
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: 1,
    capability: 'frontend-admin-typecheck',
    frontendDirectory: 'forge-admin-ui',
    command: TYPECHECK_COMMAND,
    packageManager: { name: 'pnpm', sourceVersion: '11.7.0', runnerVersion: '11.24.0' },
    dependencies: {
      typescript: { version: TYPESCRIPT_VERSION },
      'vue-tsc': { version: VUE_TSC_VERSION, typescriptPeerRange: '>=5.0.0' },
    },
    files: {
      packageJson: {
        path: 'forge-admin-ui/package.json',
        beforeSha256: sha256(beforePackage),
        targetSha256: sha256(targetPackage),
      },
      lockfile: {
        path: 'forge-admin-ui/pnpm-lock.yaml',
        beforeSha256: sha256(beforeLock),
        targetSha256: sha256(targetLock),
      },
      jsconfig: {
        path: 'forge-admin-ui/jsconfig.json',
        beforeSha256: sha256(beforeJsconfig),
        upgradeFromSha256: sha256(previousTargetJsconfig),
        targetSha256: sha256(targetJsconfig),
      },
    },
    patch: {
      path: 'templates/project/frontend-typecheck-capability.patch',
      sha256: sha256(diff.stdout),
    },
  }, null, 2)}\n`);

  const metadata = path.join(taskspace, 'metadata.json');
  await writeFile(metadata, `${JSON.stringify({
    taskId: 'c-0123456789abcdef01234567',
    projectSlug: 'fixture-project',
    status: 'active',
    accessMode: 'conversation',
  })}\n`);
  return { root, workspace, manifest, patch, metadata };
}

async function createProductionPreimageFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-frontend-typecheck-production-'));
  const taskspace = path.join(root, 'project', 'taskspaces', 'c-fedcba9876543210fedcba98');
  const workspace = path.join(taskspace, 'workspace');
  const frontend = path.join(workspace, 'forge-admin-ui');
  await mkdir(frontend, { recursive: true });
  await Promise.all([
    readFile(path.join(productionFixturePath, 'package.json.before'))
      .then((content) => writeFile(path.join(frontend, 'package.json'), content)),
    readFile(path.join(productionFixturePath, 'pnpm-lock.yaml.before.gz'))
      .then((content) => writeFile(path.join(frontend, 'pnpm-lock.yaml'), gunzipSync(content))),
    readFile(path.join(productionFixturePath, 'jsconfig.json.before'))
      .then((content) => writeFile(path.join(frontend, 'jsconfig.json'), content)),
  ]);

  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 'Forge Production Preimage Test'],
    ['config', 'user.email', 'forge-production-preimage@example.invalid'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'production preimage'],
  ]) {
    const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }

  const metadata = path.join(taskspace, 'metadata.json');
  await writeFile(metadata, `${JSON.stringify({
    taskId: 'c-fedcba9876543210fedcba98',
    projectSlug: 'fixture-project',
    status: 'active',
    accessMode: 'conversation',
  })}\n`);
  return { root, workspace, manifest: manifestPath, patch: patchPath, metadata };
}

test('production manifest pins the real vue-tsc command, exact dependencies, compiler options, and three patch paths', async () => {
  const [manifestText, patchText] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(patchPath, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.capability, 'frontend-admin-typecheck');
  assert.equal(manifest.source.repository, 'https://github.com/yaomindong1996/forge-admin.git');
  assert.equal(manifest.command, TYPECHECK_COMMAND);
  assert.equal(manifest.dependencies.typescript.version, TYPESCRIPT_VERSION);
  assert.equal(manifest.dependencies['vue-tsc'].version, VUE_TSC_VERSION);
  assert.equal(manifest.dependencies['vue-tsc'].typescriptPeerRange, '>=5.0.0');
  assert.match(manifest.dependencies.typescript.integrity, /^sha512-/u);
  assert.match(manifest.dependencies['vue-tsc'].integrity, /^sha512-/u);
  assert.match(manifest.files.packageJson.beforeSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.files.packageJson.targetSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.files.lockfile.beforeSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.files.lockfile.targetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.files.jsconfig.beforeSha256, 'da26240813bd172503f579d859c7788d999784088b4f2ec12218e8eb93d92896');
  assert.equal(manifest.files.jsconfig.upgradeFromSha256, 'db89fbfebdaaf016297e14e4577ed706c6bfd80af28bfec3ae2a34a1167713ce');
  assert.equal(manifest.files.jsconfig.targetSha256, sha256(targetJsconfig));
  assert.equal(manifest.patch.sha256, sha256(patchText));

  const touched = [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(touched, [
    ['forge-admin-ui/package.json', 'forge-admin-ui/package.json'],
    ['forge-admin-ui/pnpm-lock.yaml', 'forge-admin-ui/pnpm-lock.yaml'],
    ['forge-admin-ui/jsconfig.json', 'forge-admin-ui/jsconfig.json'],
  ]);
  assert.match(patchText, /"typecheck": "vue-tsc --noEmit --project jsconfig\.json"/u);
  assert.match(patchText, /^\+    "module": "ESNext",$/mu);
  assert.match(patchText, /^\+    "esModuleInterop": true$/mu);
  assert.ok(patchText.indexOf('    "baseUrl": "./",') < patchText.indexOf('+    "module": "ESNext",'));
  assert.doesNotMatch(patchText, /^[-+].*"exclude"/mu);
  assert.doesNotMatch(patchText, /skipLibCheck/u);
  assert.doesNotMatch(patchText, /forge-admin-ui\/src\//u);
});

test('production manifest patch applies its exact three-file preimage to target and is target-idempotent', {
  skip: helperRuntimeSkip,
}, async (t) => {
  const fixture = await createProductionPreimageFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entries = Object.values(manifest.files);
  const filePaths = entries.map((entry) => path.join(fixture.workspace, entry.path));

  assert.deepEqual(
    await Promise.all(filePaths.map(async (file) => sha256(await readFile(file, 'utf8')))),
    entries.map((entry) => entry.beforeSha256),
  );

  const applied = runInternal('apply', fixture);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.deepEqual(
    await Promise.all(filePaths.map(async (file) => sha256(await readFile(file, 'utf8')))),
    entries.map((entry) => entry.targetSha256),
  );
  const targetStats = await Promise.all(filePaths.map((file) => stat(file)));

  const reapplied = runInternal('apply', fixture);
  assert.equal(reapplied.status, 0, `${reapplied.stdout}\n${reapplied.stderr}`);
  assert.match(reapplied.stdout, /already active; no files changed/u);
  assert.deepEqual(
    await Promise.all(filePaths.map(async (file) => (await stat(file)).mtimeMs)),
    targetStats.map((fileStat) => fileStat.mtimeMs),
  );
});

test('shared helper checks without writing, applies only the exact candidate preimage, and is target-idempotent', {
  skip: helperRuntimeSkip,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const baselineCheck = runInternal('check', fixture);
  assert.notEqual(baselineCheck.status, 0);
  assert.match(`${baselineCheck.stdout}\n${baselineCheck.stderr}`, /requires reviewed new-project provision or candidate apply/u);

  const applied = runInternal('apply', fixture);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(await readFile(path.join(fixture.workspace, 'forge-admin-ui', 'package.json'), 'utf8'), targetPackage);
  assert.equal(await readFile(path.join(fixture.workspace, 'forge-admin-ui', 'pnpm-lock.yaml'), 'utf8'), targetLock);
  assert.equal(await readFile(path.join(fixture.workspace, 'forge-admin-ui', 'jsconfig.json'), 'utf8'), targetJsconfig);
  assert.equal(await readFile(path.join(fixture.workspace, 'sentinel.txt'), 'utf8'), 'unchanged\n');
  const statusResult = spawnSync('git', ['-C', fixture.workspace, 'status', '--short'], { encoding: 'utf8' });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  assert.deepEqual(statusResult.stdout.trimEnd().split(/\r?\n/u).sort(), [
    ' M forge-admin-ui/jsconfig.json',
    ' M forge-admin-ui/package.json',
    ' M forge-admin-ui/pnpm-lock.yaml',
  ]);

  const packageStat = await stat(path.join(fixture.workspace, 'forge-admin-ui', 'package.json'));
  const lockStat = await stat(path.join(fixture.workspace, 'forge-admin-ui', 'pnpm-lock.yaml'));
  const jsconfigStat = await stat(path.join(fixture.workspace, 'forge-admin-ui', 'jsconfig.json'));
  const reapplied = runInternal('apply', fixture);
  assert.equal(reapplied.status, 0, `${reapplied.stdout}\n${reapplied.stderr}`);
  assert.match(reapplied.stdout, /already active; no files changed/u);
  assert.equal((await stat(path.join(fixture.workspace, 'forge-admin-ui', 'package.json'))).mtimeMs, packageStat.mtimeMs);
  assert.equal((await stat(path.join(fixture.workspace, 'forge-admin-ui', 'pnpm-lock.yaml'))).mtimeMs, lockStat.mtimeMs);
  assert.equal((await stat(path.join(fixture.workspace, 'forge-admin-ui', 'jsconfig.json'))).mtimeMs, jsconfigStat.mtimeMs);

  const targetCheck = runInternal('check', fixture);
  assert.equal(targetCheck.status, 0, `${targetCheck.stdout}\n${targetCheck.stderr}`);
  assert.match(targetCheck.stdout, /capability is active/u);
});

test('candidate apply upgrades the deployed package and lock intermediate state by changing only jsconfig', {
  skip: helperRuntimeSkip,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const frontend = path.join(fixture.workspace, 'forge-admin-ui');
  const packagePath = path.join(frontend, 'package.json');
  const lockPath = path.join(frontend, 'pnpm-lock.yaml');
  const jsconfigPath = path.join(frontend, 'jsconfig.json');
  await writeFile(packagePath, targetPackage);
  await writeFile(lockPath, targetLock);
  const packageStat = await stat(packagePath);
  const lockStat = await stat(lockPath);

  const applied = runInternal('apply', fixture);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(await readFile(packagePath, 'utf8'), targetPackage);
  assert.equal(await readFile(lockPath, 'utf8'), targetLock);
  assert.equal(await readFile(jsconfigPath, 'utf8'), targetJsconfig);
  assert.equal((await stat(packagePath)).mtimeMs, packageStat.mtimeMs);
  assert.equal((await stat(lockPath)).mtimeMs, lockStat.mtimeMs);

  const targetStats = await Promise.all([packagePath, lockPath, jsconfigPath].map((file) => stat(file)));
  const reapplied = runInternal('apply', fixture);
  assert.equal(reapplied.status, 0, `${reapplied.stdout}\n${reapplied.stderr}`);
  assert.match(reapplied.stdout, /already active; no files changed/u);
  assert.deepEqual(
    await Promise.all([packagePath, lockPath, jsconfigPath].map(async (file) => (await stat(file)).mtimeMs)),
    targetStats.map((fileStat) => fileStat.mtimeMs),
  );
});

test('candidate apply upgrades only the exact previous jsconfig target to canonical lint order', {
  skip: helperRuntimeSkip,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const frontend = path.join(fixture.workspace, 'forge-admin-ui');
  const packagePath = path.join(frontend, 'package.json');
  const lockPath = path.join(frontend, 'pnpm-lock.yaml');
  const jsconfigPath = path.join(frontend, 'jsconfig.json');
  await writeFile(packagePath, targetPackage);
  await writeFile(lockPath, targetLock);
  await writeFile(jsconfigPath, previousTargetJsconfig);
  const packageStat = await stat(packagePath);
  const lockStat = await stat(lockPath);

  const applied = runInternal('apply', fixture);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(await readFile(packagePath, 'utf8'), targetPackage);
  assert.equal(await readFile(lockPath, 'utf8'), targetLock);
  assert.equal(await readFile(jsconfigPath, 'utf8'), targetJsconfig);
  assert.equal((await stat(packagePath)).mtimeMs, packageStat.mtimeMs);
  assert.equal((await stat(lockPath)).mtimeMs, lockStat.mtimeMs);

  const jsconfigStat = await stat(jsconfigPath);
  const reapplied = runInternal('apply', fixture);
  assert.equal(reapplied.status, 0, `${reapplied.stdout}\n${reapplied.stderr}`);
  assert.match(reapplied.stdout, /already active; no files changed/u);
  assert.equal((await stat(jsconfigPath)).mtimeMs, jsconfigStat.mtimeMs);
});

test('new-project provision produces a clean three-file capability commit while preserving source ancestry', {
  skip: helperRuntimeSkip,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceHead = spawnSync('git', ['-C', fixture.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  const provisioned = runInternal('provision', { ...fixture, metadata: undefined });
  assert.equal(provisioned.status, 0, `${provisioned.stdout}\n${provisioned.stderr}`);
  const changed = spawnSync('git', [
    '-C', fixture.workspace, 'status', '--porcelain=v1', '--untracked-files=all',
  ], { encoding: 'utf8' });
  assert.equal(changed.stdout, [
    ' M forge-admin-ui/jsconfig.json',
    ' M forge-admin-ui/package.json',
    ' M forge-admin-ui/pnpm-lock.yaml',
    '',
  ].join('\n'));
  assert.equal(spawnSync('git', [
    '-C', fixture.workspace, 'add', '--',
    'forge-admin-ui/package.json', 'forge-admin-ui/pnpm-lock.yaml', 'forge-admin-ui/jsconfig.json',
  ]).status, 0);
  assert.equal(spawnSync('git', [
    '-C', fixture.workspace, 'commit', '--quiet', '-m', 'chore: enable frontend typecheck',
  ]).status, 0);
  const initialHead = spawnSync('git', ['-C', fixture.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(initialHead, sourceHead);
  assert.equal(spawnSync('git', [
    '-C', fixture.workspace, 'merge-base', '--is-ancestor', sourceHead, initialHead,
  ]).status, 0);
  assert.equal(spawnSync('git', [
    '-C', fixture.workspace, 'status', '--porcelain=v1', '--untracked-files=all',
  ], { encoding: 'utf8' }).stdout, '');
  const reprovisioned = runInternal('provision', { ...fixture, metadata: undefined });
  assert.equal(reprovisioned.status, 0, `${reprovisioned.stdout}\n${reprovisioned.stderr}`);
  assert.match(reprovisioned.stdout, /already active; no files changed/u);
  assert.equal(spawnSync('git', [
    '-C', fixture.workspace, 'status', '--porcelain=v1', '--untracked-files=all',
  ], { encoding: 'utf8' }).stdout, '');
  assert.equal(spawnSync('git', ['-C', fixture.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), initialHead);
  assert.equal(runInternal('check', fixture).status, 0);
});

test('shared helper rejects an unknown preimage and invalid candidate metadata without partial writes', {
  skip: helperRuntimeSkip,
}, async (t) => {
  const unknownCases = [
    ['package.json', beforePackage.replace('"private": true', '"private": false')],
    ['pnpm-lock.yaml', beforeLock.replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'")],
    ['jsconfig.json', beforeJsconfig.replace('"allowJs": true', '"allowJs": false')],
  ];
  for (const [filename, unknownContent] of unknownCases) {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const frontend = path.join(fixture.workspace, 'forge-admin-ui');
    const paths = ['package.json', 'pnpm-lock.yaml', 'jsconfig.json'].map((file) => path.join(frontend, file));
    await writeFile(path.join(frontend, filename), unknownContent);
    const preApply = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
    const unknown = runInternal('apply', fixture);
    assert.notEqual(unknown.status, 0, filename);
    assert.match(`${unknown.stdout}\n${unknown.stderr}`, /unknown frontend typecheck preimage/u);
    assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, 'utf8'))), preApply);
  }

  const invalidFixture = await createFixture();
  t.after(() => rm(invalidFixture.root, { recursive: true, force: true }));
  await writeFile(invalidFixture.metadata, '{"taskId":"wrong","projectSlug":"fixture-project","status":"active"}\n');
  const invalidIdentity = runInternal('apply', invalidFixture);
  assert.notEqual(invalidIdentity.status, 0);
  assert.match(`${invalidIdentity.stdout}\n${invalidIdentity.stderr}`, /candidate TaskSpace metadata/u);
  assert.equal(await readFile(path.join(invalidFixture.workspace, 'forge-admin-ui', 'package.json'), 'utf8'), beforePackage);
  assert.equal(await readFile(path.join(invalidFixture.workspace, 'forge-admin-ui', 'pnpm-lock.yaml'), 'utf8'), beforeLock);
  assert.equal(await readFile(path.join(invalidFixture.workspace, 'forge-admin-ui', 'jsconfig.json'), 'utf8'), beforeJsconfig);
});

test('create-project provisions then checks the fixed capability and the explicit upgrade wrapper binds apply to one active candidate TaskSpace', async () => {
  const [createProject, upgrade, validate] = await Promise.all([
    readFile(createProjectPath, 'utf8'),
    readFile(upgradePath, 'utf8'),
    readFile(validatePath, 'utf8'),
  ]);
  const cloneOffset = createProject.indexOf('git clone --no-hardlinks');
  const provisionOffset = createProject.indexOf('frontend_typecheck_capability provision');
  const checkOffset = createProject.indexOf('frontend_typecheck_capability check');
  const keyOffset = createProject.indexOf('ssh-keygen -q');
  assert.ok(cloneOffset >= 0 && provisionOffset > cloneOffset && checkOffset > provisionOffset && keyOffset > checkOffset);
  assert.doesNotMatch(createProject, /frontend_typecheck_capability apply/u);
  assert.match(createProject, /git -C "\$\{stage_path\}\/workspace" add -- \\\n+    forge-admin-ui\/package\.json forge-admin-ui\/pnpm-lock\.yaml forge-admin-ui\/jsconfig\.json/u);
  assert.match(createProject, /FORGE_ADMIN_COMMIT__\/\$\{forge_commit\}/u);
  assert.match(createProject, /PROJECT_SOURCE_COMMIT__\/\$\{source_commit\}/u);
  const forgeRefSuffix = createProject.match(/forge_ref="\$\{source_ref\}([^"]+)"/u)?.[1];
  assert.equal(forgeRefSuffix, '-frontend-typecheck');
  const generatedForgeRef = `foundation-6eb2881e6f6a${forgeRefSuffix}`;
  assert.match(generatedForgeRef, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);

  assert.match(upgrade, /--candidate-taskspace/u);
  assert.match(upgrade, /--confirm frontend-typecheck-capability/u);
  assert.match(upgrade, /\.taskId/u);
  assert.match(upgrade, /\.projectSlug/u);
  assert.match(upgrade, /\.status/u);
  assert.match(upgrade, /frontend_typecheck_capability apply/u);
  assert.doesNotMatch(upgrade, /upgrade-forge-delivery-toolkit\.sh/u);
  assert.match(validate, /tests\/frontend-typecheck-capability\.test\.mjs/u);

  for (const script of [helperPath, upgradePath]) {
    const syntax = spawnSync(resolvePortableBash(), ['-n', bashPath(script)], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

// Exact non-secret i18n delta in the existing promoted foundation 1a0d2b6.
const promotedFoundationDelta = "--- a/forge-admin-ui/package.json\n+++ b/forge-admin-ui/package.json\n@@ -67,6 +67,7 @@\n     \"unplugin-vue-router\": \"^0.19.2\",\n     \"vue\": \"^3.5.20\",\n     \"vue-echarts\": \"^7.0.3\",\n+    \"vue-i18n\": \"11.4.12\",\n     \"vue-router\": \"^4.5.1\",\n     \"vue3-slide-verify\": \"^1.1.7\",\n     \"vuedraggable\": \"^4.1.0\",\n--- a/forge-admin-ui/pnpm-lock.yaml\n+++ b/forge-admin-ui/pnpm-lock.yaml\n@@ -158,6 +158,9 @@\n       vue-echarts:\n         specifier: ^7.0.3\n         version: 7.0.3(@vue/runtime-core@3.5.30)(echarts@6.0.0)(vue@3.5.30(typescript@5.9.3))\n+      vue-i18n:\n+        specifier: 11.4.12\n+        version: 11.4.12(vue@3.5.30(typescript@5.9.3))\n       vue-router:\n         specifier: ^4.5.1\n         version: 4.6.4(vue@3.5.30(typescript@5.9.3))\n@@ -261,6 +264,33 @@\n \n packages:\n \n+  vue-i18n@11.4.12:\n+    resolution: {integrity: sha512-yvArvvo3ErLKFNlQrZUGmRkxL/ctM5xFYtE9FxTKiE/PalWP1bnTopBgbSRGLluYEyYSNl1Pt8l2J7zVavbXww==}\n+    engines: {node: '>= 22'}\n+    peerDependencies:\n+      vue: ^3.0.0\n+\n+\n+  '@intlify/shared@11.4.12':\n+    resolution: {integrity: sha512-ojfehaXMFrGFcSnK3cJPaMxlrSXT8FwZUG9H4i+WKX4OFD4Yl1WKdTmfwoC0REnwIfTrnt1QhRtd8kwi/te6bQ==}\n+    engines: {node: '>= 22'}\n+\n+\n+  '@intlify/message-compiler@11.4.12':\n+    resolution: {integrity: sha512-kBczk9r44fdBYnkC5tXRWa/UaA+e9NglXE3cX7jPnDd2nHzoFHYrKGfIbn8JFZpMA9omexZZo2WxOpTvlHdjsw==}\n+    engines: {node: '>= 22'}\n+\n+\n+  '@intlify/devtools-types@11.4.12':\n+    resolution: {integrity: sha512-Ctkcs8DQItaEL9HHdkyasFFcZFP59iBvZmrjiA7b72JFq/JlI6c6GPQHN7oEwbYTo8rndPMqNY7SX71aPm4MkA==}\n+    engines: {node: '>= 22'}\n+\n+\n+  '@intlify/core-base@11.4.12':\n+    resolution: {integrity: sha512-tvYUWgMJmk+UvLFa7ck8uRQ9m19tTI9B2e01KCAjBV7+HN2zFLnnORvMO85hM1P8DIw4MTvot1ZSBUdoR+F6jA==}\n+    engines: {node: '>= 22'}\n+\n+\n   '@antfu/eslint-config@5.4.1':\n     resolution: {integrity: sha512-x7BiNkxJRlXXs8tIvg0CgMuNo5IZVWkGLMJotCtCtzWUHW78Pmm8PvtXhvLBbTc8683GGBK616MMztWLh4RNjA==}\n     hasBin: true\n@@ -6601,6 +6631,37 @@\n \n snapshots:\n \n+  '@intlify/shared@11.4.12': {}\n+\n+\n+  '@intlify/message-compiler@11.4.12':\n+    dependencies:\n+      '@intlify/shared': 11.4.12\n+      source-map-js: 1.2.1\n+\n+\n+  '@intlify/devtools-types@11.4.12':\n+    dependencies:\n+      '@intlify/core-base': 11.4.12\n+      '@intlify/shared': 11.4.12\n+\n+\n+  '@intlify/core-base@11.4.12':\n+    dependencies:\n+      '@intlify/devtools-types': 11.4.12\n+      '@intlify/message-compiler': 11.4.12\n+      '@intlify/shared': 11.4.12\n+\n+\n+  vue-i18n@11.4.12(vue@3.5.30(typescript@5.9.3)):\n+    dependencies:\n+      '@intlify/core-base': 11.4.12\n+      '@intlify/devtools-types': 11.4.12\n+      '@intlify/shared': 11.4.12\n+      '@vue/devtools-api': 6.6.4\n+      vue: 3.5.30(typescript@5.9.3)\n+\n+\n   '@antfu/eslint-config@5.4.1(@typescript-eslint/rule-tester@8.57.0(eslint@9.39.4(jiti@2.6.1))(typescript@5.9.3))(@typescript-eslint/typescript-estree@8.57.0(typescript@5.9.3))(@typescript-eslint/utils@8.57.0(eslint@9.39.4(jiti@2.6.1))(typescript@5.9.3))(@unocss/eslint-plugin@66.6.6(eslint@9.39.4(jiti@2.6.1))(typescript@5.9.3))(@vue/compiler-sfc@3.5.30)(eslint-plugin-format@1.5.0(eslint@9.39.4(jiti@2.6.1)))(eslint@9.39.4(jiti@2.6.1))(typescript@5.9.3)(vitest@2.1.9)':\n     dependencies:\n       '@antfu/install-pkg': 1.1.0\n";

async function createPromotedFoundationFixture() {
  const fixture = await createProductionPreimageFixture();
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    const target = path.join(fixture.workspace, 'forge-admin-ui', file);
    await writeFile(target, (await readFile(target, 'utf8')).replaceAll('\r\n', '\n'));
  }
  const changed = spawnSync('git', ['-C', fixture.workspace, '-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'], {
    input: promotedFoundationDelta, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(changed.status, 0, changed.stderr);
  return fixture;
}

test('promoted foundation fixture exactly reproduces the approved package and lock preimage', async t => {
  const fixture = await createPromotedFoundationFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const name of ['packageJson', 'lockfile']) {
    const raw = await readFile(path.join(fixture.workspace, manifest.files[name].path), 'utf8');
    assert.equal(sha256(raw), manifest.foundationPreimage.files[name].beforeSha256);
  }
});

test('promoted foundation provision preserves i18n and rejects mixed or unknown preimages', { skip: helperRuntimeSkip }, async t => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const mode of ['known', 'mixed', 'unknown']) {
    const fixture = await createPromotedFoundationFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const packageFile = path.join(fixture.workspace, 'forge-admin-ui/package.json');
    const lockFile = path.join(fixture.workspace, 'forge-admin-ui/pnpm-lock.yaml');
    if (mode === 'mixed') await writeFile(packageFile, await readFile(path.join(productionFixturePath, 'package.json.before')));
    if (mode === 'unknown') await writeFile(packageFile, `${await readFile(packageFile, 'utf8')}\n`);
    const before = await Promise.all([packageFile,lockFile].map(file => readFile(file,'utf8')));
    const result = runInternal('provision', fixture);
    if (mode !== 'known') {
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, /unknown frontend typecheck preimage/u);
      assert.deepEqual(await Promise.all([packageFile,lockFile].map(file => readFile(file,'utf8'))), before);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(packageFile, 'utf8')).dependencies['vue-i18n'], '11.4.12');
    for (const [name,file] of [['packageJson',packageFile],['lockfile',lockFile]]) {
      assert.equal(sha256(await readFile(file,'utf8')), manifest.foundationPreimage.files[name].targetSha256);
    }
    assert.equal(runInternal('check', fixture).status, 0);
  }
});
