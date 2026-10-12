import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit } from '../docker/harness/forge-governance.mjs';
import { governanceTaskScopeArguments, governanceAcceptedApiContractArguments, revalidatedGovernanceTaskArguments } from '../docker/harness/verify-policy.mjs';

test('accepted API contract keeps bounded controller operations without inventing five CRUD routes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-api-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Platform fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, '.gitkeep'), 'platform fixture\n');
  git('add', '.gitkeep'); git('commit', '-m', 'baseline');
  const head = git('rev-parse', 'HEAD');
  const owned = 'forge-server/sample/src/main/java/example/controller';
  await mkdir(path.join(root, owned), { recursive: true });
  const definitions = [
    ['InspectionController', '/business/inspection', ['page','getById','add','sign-maintainer','sign-manager','audit','export']],
    ['ItemController', '/business/item', ['page','add','edit','remove/{id}']],
    ['ReportController', '/business/report', ['page','getById','upload','remove/{id}','export']],
  ];
  const source = (name, base, operations) => `@RestController\n@RequestMapping("${base}")\npublic class ${name} {\n${operations.map((operation, index) => `@${operation === 'page' ? 'Get' : 'Post'}Mapping("/${operation}")\n@RequirePermission("sample:${index}")\n@OperationLog(module="sample")\npublic RespInfo<Object> operation${index}() { return RespInfo.success(); }`).join('\n')}\n}\n`;
  for (const [name, base, operations] of definitions) await writeFile(path.join(root, owned, `${name}.java`), source(name, base, operations));
  const acceptedApiContract = { schemaVersion: 1, taskId: 'task-api-scope', workflowId: 'forge-eight-stage', sourceCommit: head,
    artifactDigest: 'a'.repeat(64), endpoints: definitions.flatMap(([,base, operations]) => operations.map(operation => ({
      method: operation === 'page' ? 'GET' : 'POST', path: `${base}/${operation}` }))) };
  const contractId = 'b'.repeat(64);
  const options = { command: 'audit', root, base: 'HEAD', paths: [], taskScope: { contractId, ownedPaths: [owned] }, acceptedApiContract };
  const policy = JSON.parse(await readFile(new URL('../docker/harness/forge-governance-policy.json', import.meta.url), 'utf8'));
  const crud = receipt => receipt.findings.filter(item => item.ruleId === 'BE-CRUD-001');
  assert.deepEqual(crud(await audit(options, policy)), [], 'An accepted bounded API must not gain the five generic CRUD endpoints.');

  const unknown = await audit({ ...options, acceptedApiContract: undefined }, policy);
  assert.equal(crud(unknown).length, 5, 'No accepted contract retains the original strict check.');
  const full = structuredClone(acceptedApiContract);
  for (const suffix of ['edit', 'remove/{id}']) full.endpoints.push({ method: 'POST', path: `/business/inspection/${suffix}` });
  assert.equal(crud(await audit({ ...options, acceptedApiContract: full }, policy)).length, 2);
  const wrongMethod = structuredClone(acceptedApiContract);
  wrongMethod.endpoints.find(item => item.path === '/business/item/add').method = 'GET';
  assert.ok(crud(await audit({ ...options, acceptedApiContract: wrongMethod }, policy)).some(item => item.message.includes('/add')));
  await assert.rejects(audit({ ...options, acceptedApiContract: { ...acceptedApiContract, sourceCommit: 'c'.repeat(40) } }, policy));
  await assert.rejects(audit({ ...options, acceptedApiContract: { ...acceptedApiContract, endpoints: [] } }, policy));

  const scope = options.taskScope;
  const argv = ['audit', '--base', head, ...governanceTaskScopeArguments(scope), ...governanceAcceptedApiContractArguments(acceptedApiContract)];
  const cli = path.resolve(import.meta.dirname, '../docker/harness/forge-governance');
  const result = spawnSync(process.execPath, [cli, ...argv, '--root', root, '--format', 'json'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 1, result.stderr);
  assert.deepEqual(crud(JSON.parse(result.stdout)), []);
  assert.deepEqual(revalidatedGovernanceTaskArguments(argv, scope, undefined, undefined, acceptedApiContract), argv);
  assert.equal(revalidatedGovernanceTaskArguments(argv, scope, undefined, undefined, full), null);
  const release = await audit({ ...options, taskScope: undefined }, policy);
  assert.deepEqual(crud(release), []);
  assert.equal(release.scope.completeChange, true);
  assert.equal(release.files.length, 3);
  assert.equal(release.scope.ownedPaths, undefined, 'Accepted APIs never narrow a release audit.');
  const releaseArgv = ['audit', '--base', head, ...governanceAcceptedApiContractArguments(acceptedApiContract)];
  assert.deepEqual(revalidatedGovernanceTaskArguments(releaseArgv, undefined, undefined, undefined, acceptedApiContract), releaseArgv);
});
