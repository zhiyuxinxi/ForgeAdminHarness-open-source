import test from 'node:test';
import assert from 'node:assert/strict';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { createInitialPhaseState, toolDenialReason, reminderForState, refreshExecutionAdmission, prepareTaskDenialReason } from '../docker/harness/forge-phase-budget-guard.mjs';
import { directDevelopmentEnabled, directDevelopmentPath } from '../docker/harness/forge-direct-development.mjs';
import { directWorkerConfinement, directWorkerSpawnSpec } from '../docker/harness/forge-direct-worker-sandbox.mjs';
import { installForgeWriterScopeLease } from '../docker/harness/forge-writer-scope-client.mjs';
import { removalPath } from '../docker/harness/forge-typed-file-removal.mjs';

function contract(actionCeiling = 'workspace-write') {
  return compileForgeTaskExecutionContract({ prompt: '按当前需求直接修复并验证',
    actionCeiling, taskProfiles: [actionCeiling === 'read-only' ? 'read-only-review' : 'project-files'],
    ownedPaths: actionCeiling === 'read-only' ? [] : ['.'] }, { developmentMode: 'direct' });
}
function state(actionCeiling = 'workspace-write') {
  const taskContract = contract(actionCeiling);
  return Object.assign(createInitialPhaseState(), { taskContract, taskIntent: taskContract, actionCeiling,
    protectedExecutionContextValidated: true, executionContextStatus: 'ready', executionTestOnly: false,
    executionAuthorityClass: actionCeiling === 'read-only' ? 'production-read-only' : 'production-task-writer',
    executionIdentity: { taskId: 'task-a', executionId: 'execution-a', contractId: taskContract.contractId },
    executionContextExpiresAt: new Date(Date.now() + 60000).toISOString(),
    executionProjectionRequired: true, executionProjectionStatus: 'failed', verificationBlocked: true,
    progressDecision: { decision: 'STOP', reasonCodes: ['OLD_DEVELOPMENT_GATE'] } });
}
const exec = (name, args) => ({ name, arguments: args, callId: 'direct-call', agent: { session: { id: 'session-a' } } });

test('direct diagnostic rebind rejection explains optionality instead of a shell syntax failure', t => {
  const old = process.env.FORGE_DEVELOPMENT_MODE;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => old === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = old);
  const id = '91ef050c-5c0e-4182-9864-95885c37ca09';
  const reason = toolDenialReason(state('git-checkpoint'), exec('bash', {
    command: `forge-verify run --profile backend-source-quality --admission-id ${id} --idempotency-key quality-reuse-20261012 --reuse-receipt ${id}`,
  }));
  assert.match(reason, /optional diagnostics, not a checkpoint obligation/);
  assert.match(reason, /do not rerun or rebind/);
});

test('real ordinary read-only contexts use direct shell without a development contract marker', t => {
  const before = process.env.FORGE_DEVELOPMENT_MODE, socket = process.env.FORGE_TOOL_WORKER_SOCKET;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct'; process.env.FORGE_TOOL_WORKER_SOCKET = '/run/forge-tool-worker/worker.sock';
  t.after(() => { before === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = before;
    socket === undefined ? delete process.env.FORGE_TOOL_WORKER_SOCKET : process.env.FORGE_TOOL_WORKER_SOCKET = socket; });
  const current = state('read-only');
  current.taskContract = compileForgeTaskExecutionContract({ prompt: '请只分析上报模块历史，不改文件', actionCeiling: 'read-only', ownedPaths: [] });
  current.taskIntent = current.taskContract;
  assert.equal(current.taskContract.developmentMode, undefined);
  for (const command of ['pwd', 'git log --since="2026-09-20" | head', 'node /tmp/analyze.mjs']) {
    assert.equal(toolDenialReason(current, exec('bash', { command })), undefined);
  }
  assert.match(toolDenialReason(current, exec('write', { file_path: 'src/a.js' })), /read-only/u);
  assert.match(reminderForState(current), /read-only requests use a read-only workspace/u);
  current.protectedExecutionContextValidated = false;
  assert.match(toolDenialReason(current, exec('bash', { command: 'pwd' })), /authenticated/u);
  current.protectedExecutionContextValidated = true; delete process.env.FORGE_DEVELOPMENT_MODE;
  assert.match(toolDenialReason(current, exec('bash', { command: 'pwd' })), /arbitrary shell|closed/u);
});

test('direct prepare refresh permits prior writes while retaining read-only and legacy boundaries', t => {
  const before = process.env.FORGE_DEVELOPMENT_MODE;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => before === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = before);
  const current = state('git-checkpoint'); current.mutationCount = 2; current.mutationSequence = 2;
  assert.equal(prepareTaskDenialReason(current, exec('prepare_task', { operation: 'propose' })), undefined);
  current.promptReadOnlyConstraint = true;
  assert.match(prepareTaskDenialReason(current, exec('prepare_task', { operation: 'propose' })), /read-only/u);
  current.promptReadOnlyConstraint = false;
  delete process.env.FORGE_DEVELOPMENT_MODE;
  assert.match(prepareTaskDenialReason(current, exec('prepare_task', { operation: 'propose' })), /after source mutation/u);
});

test('direct development guard preserves security while removing drafting gates', async t => {
  const oldMode = process.env.FORGE_DEVELOPMENT_MODE, oldSocket = process.env.FORGE_TOOL_WORKER_SOCKET;
  t.after(() => { if (oldMode === undefined) delete process.env.FORGE_DEVELOPMENT_MODE; else process.env.FORGE_DEVELOPMENT_MODE = oldMode;
    if (oldSocket === undefined) delete process.env.FORGE_TOOL_WORKER_SOCKET; else process.env.FORGE_TOOL_WORKER_SOCKET = oldSocket; });
  process.env.FORGE_DEVELOPMENT_MODE = 'direct'; process.env.FORGE_TOOL_WORKER_SOCKET = '/run/forge-tool-worker/worker.sock';
  const current = state();
  for (const file_path of ['new-module/src/Main.java', 'package.json', '.editorconfig', 'renamed/source.txt']) {
    assert.equal(toolDenialReason(current, exec('write', { file_path })), undefined, file_path);
  }
  for (const file_path of ['../other/source.js', '/integration/source.js', '.git/config', 'PROJECT_CONTEXT.md', '.env', 'ops/project.env', 'nested/key.pem']) {
    assert.match(toolDenialReason(current, exec('write', { file_path })), /protected/u, file_path);
  }
  assert.equal(toolDenialReason(current, exec('bash', { command: 'npm test && node scripts/build.mjs' })), undefined);
  assert.equal(toolDenialReason(current, exec('bash', { command: 'mvn -o test' })), undefined);
  assert.equal(toolDenialReason(current, exec('bash', { command: 'git add .' })), undefined); // actual metadata writes are mount-protected
  assert.match(toolDenialReason(current, exec('bash', { command: 'forge-release release --services forge-ui' })), /ceiling/u);
  assert.equal(toolDenialReason(state('release'), exec('bash', { command: 'forge-release release --services forge-ui' })), undefined);
  const readOnly = state('read-only');
  assert.equal(toolDenialReason(readOnly, exec('read', { file_path: 'src/a.js' })), undefined);
  assert.equal(toolDenialReason(readOnly, exec('bash', { command: 'git log --since="2026-09-20" | head' })), undefined);
  assert.equal(toolDenialReason(readOnly, exec('bash', { command: 'python3 analyze.py' })), undefined); // read-only mount, not writable execution
  assert.match(toolDenialReason(readOnly, exec('write', { file_path: 'src/a.js' })), /read-only/u);
  current.prompt = '取消页面的自动刷新功能'; assert.equal(toolDenialReason(current, exec('bash', { command: 'npm test' })), undefined); delete current.prompt;
  current.promptReadOnlyConstraint = true; assert.match(toolDenialReason(current, exec('write', { file_path: 'src/a.js' })), /read-only/u); current.promptReadOnlyConstraint = false;
  current.executionContextExpiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(current, exec('write', { file_path: 'src/a.js' })), /unexpired/u);
  delete process.env.FORGE_TOOL_WORKER_SOCKET;
  assert.match(toolDenialReason(state(), exec('bash', { command: 'npm test' })), /isolated tool worker/u);
  let admissions = 0; await refreshExecutionAdmission(state(), () => { admissions++; }); assert.equal(admissions, 0);
  assert.match(reminderForState(state()), /No task proposal/u);
  assert.equal(removalPath({ file_path: 'package.json' }).relative, 'package.json');
  assert.throws(() => removalPath({ file_path: 'PROJECT_CONTEXT.md' }), /protected|configuration/iu);
  delete process.env.FORGE_DEVELOPMENT_MODE;
  assert.equal(directDevelopmentEnabled(contract()), false);
  assert.match(toolDenialReason(state(), exec('bash', { command: 'npm test' })), /arbitrary shell|closed/u);
  assert.throws(() => removalPath({ file_path: 'package.json' }), /configuration/u);
});

test('direct malformed integrate reports current required arguments without admitting shell composition', t => {
  const before = process.env.FORGE_DEVELOPMENT_MODE;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => before === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = before);
  const current = state('git-checkpoint');
  const failed = 'forge-release integrate --expected-head f99db97ae13c63796f4ea10d8ccbe763b064ba19 --expected-fingerprint a14eab14fab4f2de15736c330b19ddd2194b4c15faed226df36d0b256c3b9168';
  for (const command of [failed, 'forge-release integrate']) {
    const denial = toolDenialReason(current, exec('bash', { command }));
    assert.match(denial, /command was not executed/u);
    assert.match(denial, /--mode, --expected-head, --expected-fingerprint and --canonical-head are required/u);
    assert.match(denial, /Read forge-release status once/u);
    assert.match(denial, /--canonical-head = preflight\.taskspace\.canonicalHead/u);
    assert.match(denial, /Exact start argv: forge-release integrate --mode start/u);
    assert.match(denial, /Exact continue argv: forge-release integrate --mode continue --operation-id/u);
    assert.match(denial, /do not repeat the unchanged command or request user confirmation/u);
  }
  const complete = `${failed} --mode start --canonical-head ${'a'.repeat(40)}`;
  for (const command of [`${complete} && echo done`, `${complete}; echo done`, `${complete} > result.txt`]) {
    const denial = toolDenialReason(current, exec('bash', { command }));
    assert.match(denial, /require one exact argv without shell composition/u);
    assert.doesNotMatch(denial, /Exact start argv/u);
  }
});

test('direct integrate forwards a changed workspace fingerprint to the authoritative broker', t => {
  const old = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => old === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = old);
  const current = state('git-checkpoint');
  current.executionSourceCommit = 'a'.repeat(40); current.executionWorkspaceFingerprint = '1'.repeat(64);
  const command = `forge-release integrate --mode start --expected-head ${'a'.repeat(40)} --expected-fingerprint ${'2'.repeat(64)} --canonical-head ${'b'.repeat(40)}`;
  assert.equal(toolDenialReason(current, exec('bash', { command })), undefined);
  assert.match(toolDenialReason(current, exec('bash', { command: command.replace('a'.repeat(40), 'c'.repeat(40)) })), /exact current protected source HEAD/u);
  current.promptReadOnlyConstraint = true;
  assert.match(toolDenialReason(current, exec('bash', { command })), /read-only/u);
});

test('direct source reads do not wait for a completed transition write refresh', t => {
  const before = process.env.FORGE_DEVELOPMENT_MODE;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => before === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = before);
  const current = state('release');
  current.executionContextStatus = 'unavailable';
  current.pendingSourceTransition = { phase: 'integrated' };
  for (const name of ['read', 'grep', 'glob', 'ls', 'find']) {
    assert.equal(toolDenialReason(current, exec(name, { file_path: 'src/a.js' })), undefined, name);
  }
  assert.match(toolDenialReason(current, exec('write', { file_path: 'src/a.js' })), /context/u);
  assert.match(toolDenialReason(current, exec('bash', { command: 'forge-release release --services forge-ui' })), /context/u);
  delete current.pendingSourceTransition;
  assert.match(toolDenialReason(current, exec('read', { file_path: 'src/a.js' })), /context/u);
  current.pendingSourceTransition = { phase: 'integrated' };
  current.executionContextExpiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(current, exec('read', { file_path: 'src/a.js' })), /unexpired/u);
  current.executionContextExpiresAt = new Date(Date.now() + 60000).toISOString();
  current.protectedExecutionContextValidated = false;
  assert.match(toolDenialReason(current, exec('read', { file_path: 'src/a.js' })), /context/u);
});

test('direct writes bypass obsolete project scope leases only for the current authenticated clone', async t => {
  const before = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => before === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = before);
  const context = { contract: contract(), actionCeiling: 'workspace-write', authorityClass: 'production-task-writer', testOnly: false,
    dshSessionId: 'session-a', expiresAt: new Date(Date.now() + 60000).toISOString() };
  let hook, broker = 0, body = 0;
  installForgeWriterScopeLease({ on(_name, fn) { hook = fn; } }, { resolveContext: () => context, client: () => { broker++; } });
  await hook(exec('write', { file_path: 'new-business/file.js' }), () => { body++; });
  assert.equal(body, 1); assert.equal(broker, 0);
  let finish, entered = 0;
  const first = hook(exec('edit', { file_path: 'first.js' }), async () => { entered++; await new Promise(resolve => { finish = resolve; }); });
  await new Promise(resolve => setImmediate(resolve));
  const second = hook(exec('edit', { file_path: 'second.js' }), () => { entered++; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, 1);
  finish(); await Promise.all([first, second]); assert.equal(entered, 2);
  context.dshSessionId = 'other';
  await assert.rejects(hook(exec('write', { file_path: 'new-business/file.js' }), () => { body++; }), /TaskSpace authority/u);
  assert.equal(body, 1);
});

test('direct worker wraps development shell with protected mounts and rejects an unconfined bridge spawn', () => {
  const entries = ['.git', '.env', 'PROJECT_CONTEXT.md', 'src', 'package.json'];
  const filesystem = { realpathSync: value => value, readdirSync: () => entries,
    lstatSync: value => ({ isSymbolicLink: () => false, isDirectory: () => value.endsWith('.git') || value.endsWith('src') }) };
  const confined = directWorkerConfinement(['bash', '-c', 'npm test'], { mode: 'workspace-write', workspaceRoot: '/workspace' }, { filesystem });
  assert.equal(confined.argv[0], '/usr/bin/bwrap');
  assert.ok(confined.argv.join(' ').includes('--tmpfs /run'));
  assert.ok(confined.argv.join(' ').includes('--ro-bind /workspace/.git /workspace/.git'));
  assert.ok(confined.argv.join(' ').includes('--ro-bind /dev/null /workspace/.env'));
  assert.ok(confined.argv.join(' ').includes('--ro-bind /workspace/PROJECT_CONTEXT.md /workspace/PROJECT_CONTEXT.md'));
  assert.deepEqual(confined.argv.slice(-4), ['--', 'bash', '-c', 'npm test']);
  assert.throws(() => directWorkerSpawnSpec({ argv: ['node', '-e', 'process.exit()'], cwd: '/workspace' }), /sandbox wrapper/u);
  const safe = directWorkerSpawnSpec({ argv: confined.argv, cwd: '/workspace/src', env: { LD_PRELOAD: 'bad', FORGE_TOKEN: 'bad', OPENAI_API_KEY: 'bad', CI: 'true' } });
  assert.deepEqual(safe.env, { CI: 'true' });
  assert.throws(() => directWorkerSpawnSpec({ ...safe, cwd: '/workspace/../integration' }), /TaskSpace/u);
  assert.throws(() => directWorkerConfinement(['bash'], { mode: 'danger-full-access', workspaceRoot: '/workspace' }, { filesystem }), /isolated/u);
  assert.equal(directDevelopmentPath('src/a.js'), 'src/a.js');
});

test('direct tool permission follows the signed ceiling rather than a business cancellation verb', t => {
  const old=process.env.FORGE_DEVELOPMENT_MODE;process.env.FORGE_DEVELOPMENT_MODE='direct';
  t.after(()=>old===undefined?delete process.env.FORGE_DEVELOPMENT_MODE:process.env.FORGE_DEVELOPMENT_MODE=old);
  const current=state();current.prompt='取消页面自动刷新功能';
  assert.equal(toolDenialReason(current,exec('write',{file_path:'/workspace/forge-admin-ui/src/refresh.js',content:'fixture'})),undefined);
  current.actionCeiling='read-only';
  assert.match(toolDenialReason(current,exec('write',{file_path:'/workspace/forge-admin-ui/src/refresh.js',content:'fixture'})),/read-only or stopped/);
});

test('direct conversation bookkeeping remains available after save or lease expiry without enabling writes', t => {
  const before = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => before === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = before);
  const current = state('git-checkpoint');
  current.executionContextStatus = 'unavailable';
  current.executionContextExpiresAt = new Date(0).toISOString();
  for (const name of ['todo_write','ask_user_question']) assert.equal(toolDenialReason(current, exec(name, {})),undefined);
  assert.match(toolDenialReason(current, exec('write',{file_path:'src/a.js'})),/context/u);
  assert.match(toolDenialReason(current, exec('bash',{command:'forge-release release --services forge-ui'})),/context/u);
});
