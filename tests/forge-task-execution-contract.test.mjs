import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileConversationTaskProposal } from '../docker/harness/forge-conversation-task-proposal.mjs';
import {
  ACTION_CEILINGS,
  ForgeTaskContractError,
  MAX_TASK_CONTRACT_PROMPT_BYTES,
  TASK_PROFILES,
  assertActionWithinCeiling,
  canonicalStringify,
  compileForgeTaskExecutionContract,
  deriveForgeTaskIntent,
  fingerprintForgeTaskExecutionSource,
  isForgeChangeRecordPath,
  isForgeRequiredChangeSpecPath,
  isForgeTaskOwnedPath,
  isActionWithinCeiling,
  validateForgeTaskExecutionContract,
  backendTestSelectorsForOwnedPaths,
  verificationScopeForContract,
} from '../docker/harness/forge-task-execution-contract.mjs';

test('direct development has no workflow obligations and cannot enter through public input', () => {
  const input = { prompt: '修改当前项目并发布', actionCeiling: 'release', ownedPaths: ['.'], taskProfiles: ['project-files'] };
  const contract = compileForgeTaskExecutionContract(input, { developmentMode: 'direct' });
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  assert.deepEqual(contract.requiredObligations, []);
  assert.equal(contract.tddRequired, false);
  assert.throws(() => compileForgeTaskExecutionContract({ ...input, developmentMode: 'direct' }));
  assert.throws(() => compileForgeTaskExecutionContract(input));
  assert.throws(() => validateForgeTaskExecutionContract({ ...contract, ownedPaths: ['../other'] }));
});

test('UI release retry context does not create database source work', async t => {
  const promptText = await readFile(new URL('./fixtures/frontend-security-ui-release-after-platform-fix.md', import.meta.url), 'utf8');
  const ownedPaths = ['forge-admin-ui/src/views/security', 'forge-admin-ui/src/views/security-guard'];
  const proposal = { goal: '发布已完成的安保前端候选', ownedPaths, taskProfiles: ['frontend-admin'],
    references: [{ path: 'PROJECT_CONTEXT.md', sha256: '1'.repeat(64) }] };
  const cases = [
    ['full actual retry request', promptText, false],
    ['recorded failed release step', '发布当前前端。上一发布在 test-database-snapshot 失败。', false],
    ['service-based release responsibility', '平台按本次实际发布的服务判断数据库义务。不再因候选继承并行后端源码而强制执行数据库快照。', false],
    ['Runner release operations are not database development', '修改页面文案。数据库校验及备份按现役Runner的真实要求办理。', false],
    ['separate database work survives Runner context', '修改页面文案。数据库校验及备份按现役Runner的真实要求办理。同时修改数据库表结构。', true],
    ['mixed database work survives Runner context', '数据库校验及备份按现役Runner的真实要求办理并修改数据库表结构。', true],
    ['explicit database operation remains', promptText + '\n同时执行数据库快照。', true],
    ['separate schema repair remains', promptText + '\n请修改数据库表结构。', true],
    ['positive work in the same clause remains', '不再因历史失败而执行旧检查但仍需修改数据库表结构。', true],
  ];
  for (const [name, prompt, expected] of cases) await t.test(name, () => {
    const value = compileConversationTaskProposal({ promptText: prompt, actionCeiling: 'release', proposal,
      writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths }] });
    assert.equal(value.contract.taskProfiles.includes('database'), expected);
    assert.equal(value.contract.requiredVerificationProfiles.includes('backend-module-test'), expected);
    assert.deepEqual(validateForgeTaskExecutionContract(value.contract), value.contract);
    const direct = compileForgeTaskExecutionContract({ prompt, actionCeiling: 'release', ownedPaths });
    assert.equal(direct.taskProfiles.includes('database'), expected);
  });
  await t.test('declared and actual database ownership stays binding', () => {
    for (const input of [
      { ownedPaths, taskProfiles: ['frontend-admin', 'database'] },
      { ownedPaths: [...ownedPaths, 'forge-server/db/migration/V1__repair.sql'] },
    ]) for (const prompt of [promptText, '修改页面文案。数据库校验及备份按现役Runner的真实要求办理。']) {
      assert.ok(compileForgeTaskExecutionContract({ prompt, actionCeiling: 'release', ...input }).taskProfiles.includes('database'));
    }
  });
});

const compile = (overrides = {}) => compileForgeTaskExecutionContract({
  prompt: '实现设备台账 CRUD，包含后端、管理端、权限和数据库迁移。',
  ownedPaths: [
    'forge-admin-ui/src/views/device/index.vue',
    'forge-server/db/migration/V202609010001__device.sql',
    'forge-server/forge-modules/forge-device/src/main/java/DeviceController.java',
  ],
  actionCeiling: 'test',
  ...overrides,
}, { verificationScope: 'changed' });

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeTaskContractError);
    assert.equal(error.code, code);
    return true;
  });
}

const semanticInput = () => ({ prompt: '调整设备页面提示。',
  ownedPaths: ['forge-admin-ui/src/views/device/index.vue'], actionCeiling: 'workspace-write', taskProfiles: ['frontend-admin'] });

const frontendVerificationOptions = { independentReview: 'suspended', verificationScope: 'changed' };
const frontendVerificationRequest = '使用当前已有受控 profile 完成本前端模块必要的类型检查、构建和精准 API 合同验证，由你选择准确命令、文件选择器和当前准入 ID。已有 frontend-admin-typecheck、frontend-admin-build、支持 --test-file 的 frontend-admin-test 可供正常受控入口使用，不跑全部前端测试，不扩到后端或其他模块。';
const frontendRequestedProfiles = ['frontend-admin-typecheck', 'frontend-admin-build'];

test('project files compile and validate ordinary exact files without framework checks', () => {
  for (const file of ['index.html', 'static/demo/index.html', 'docs/notes.md', 'custom/app.py',
    'forge-server/README.md', 'forge-admin-ui/examples/index.html', 'forge-h5-ui/src/readme.md']) {
    const contract = compileForgeTaskExecutionContract({ prompt: '更新这个普通项目文件。',
      ownedPaths: [file], taskProfiles: ['project-files'], actionCeiling: 'workspace-write' }, frontendVerificationOptions);
    assert.deepEqual(contract.taskProfiles, ['project-files'], file);
    assert.deepEqual(contract.requiredVerificationProfiles, ['governance'], file);
    assert.equal(contract.tddRequired, false, file);
    assert.ok(!contract.requiredObligations.includes('final-verification'), file);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
});

test('project files cannot drop actual Java or Vue checks or authorize internal root paths', () => {
  for (const [file, profile, check] of [
    ['forge-server/example/src/main/java/Example.java', 'backend', 'backend-module-test'],
    ['forge-admin-ui/src/views/example.vue', 'frontend-admin', 'frontend-admin-test'],
  ]) {
    const contract = compileForgeTaskExecutionContract({ prompt: '更新指定项目文件。',
      ownedPaths: ['docs/notes.md', file], taskProfiles: ['project-files'], actionCeiling: 'workspace-write' }, frontendVerificationOptions);
    assert.ok(contract.taskProfiles.includes(profile));
    assert.ok(contract.requiredVerificationProfiles.includes(check));
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
    const dropped = structuredClone(contract);
    dropped.taskProfiles = ['project-files'];
    assert.throws(() => validateForgeTaskExecutionContract(dropped));
  }
  for (const file of ['.', '*', '../index.html', '/tmp/index.html', 'C:/temp/index.html', '.git/config', '.forge-state/data.json']) {
    assert.throws(() => compileForgeTaskExecutionContract({ prompt: '更新指定项目文件。',
      ownedPaths: [file], taskProfiles: ['project-files'], actionCeiling: 'workspace-write' }), undefined, file);
  }
});

test('contract intent A5 named deferral removes only that check and a later request restores it', () => {
  for (const [prompt, expected] of [
    ['需要运行构建，暂不执行构建。', []],
    ['需要运行类型检查和构建，暂不运行构建。', ['frontend-admin-typecheck']],
    ['需要运行类型检查和构建。当前暂不执行构建。', ['frontend-admin-typecheck']],
    ['需要运行类型检查和构建。类型检查暂缓。', ['frontend-admin-build']],
    ['需要运行构建。暂不执行构建。现在需要运行构建。', ['frontend-admin-build']],
    ['需要运行构建，暂不执行构建，现在需要运行构建。', ['frontend-admin-build']],
    ['需要运行构建。上一轮暂不执行构建。', ['frontend-admin-build']],
    ['需要运行构建，不要发布。', ['frontend-admin-build']],
    ['需要运行构建，暂不执行。', []],
  ]) {
    const contract = compileForgeTaskExecutionContract({ ...semanticInput(), prompt }, frontendVerificationOptions);
    assert.deepEqual(contract.requestedVerificationProfiles ?? [], expected, prompt);
    for (const profile of ['frontend-admin-typecheck', 'frontend-admin-build']) {
      assert.equal(contract.requiredVerificationProfiles.includes(profile), expected.includes(profile), `${prompt}: ${profile}`);
    }
    assert.equal(contract.actionCeiling, 'workspace-write');
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
});

test('contract intent A5 binds explicit builds independently of unrelated negative or historical clauses', () => {
  for (const prompt of [
    '需要运行构建。',
    '需要运行构建，不要发布。',
    '需要运行构建，不必重跑历史测试。',
    '此前构建未执行，本次需要运行构建。',
  ]) {
    const contract = compileForgeTaskExecutionContract({ ...semanticInput(), prompt }, frontendVerificationOptions);
    assert.deepEqual(contract.requestedVerificationProfiles, ['frontend-admin-build'], prompt);
    assert.ok(contract.requiredVerificationProfiles.includes('frontend-admin-build'), prompt);
    assert.equal(contract.actionCeiling, 'workspace-write');
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
  for (const prompt of [
    '需要运行类型检查，不运行构建。',
    '需要运行类型检查，构建暂缓。',
  ]) {
    const contract = compileForgeTaskExecutionContract({ ...semanticInput(), prompt }, frontendVerificationOptions);
    assert.deepEqual(contract.requestedVerificationProfiles, ['frontend-admin-typecheck'], prompt);
    assert.equal(contract.requiredVerificationProfiles.includes('frontend-admin-build'), false, prompt);
  }
  for (const prompt of ['不要执行构建。', '需要运行构建，暂不执行。', '是否需要运行构建？', '示例：需要运行构建。',
    '上一轮要求执行构建。现在只修复页面。']) {
    const contract = compileForgeTaskExecutionContract({ ...semanticInput(), prompt }, frontendVerificationOptions);
    assert.equal(Object.hasOwn(contract, 'requestedVerificationProfiles'), false, prompt);
  }
});

test('contract intent A6 excludes database negatives without hiding positive, declared or path obligations', () => {
  for (const exclusion of ['无需修改数据库。', '无需调整数据库。', '数据库无需修改。', '不要更改数据库。']) {
    const prompt = `修改页面文案。${exclusion}`;
    assert.deepEqual(deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' }).taskProfiles, ['frontend-admin'], prompt);
    const contract = compileForgeTaskExecutionContract({ prompt, actionCeiling: 'workspace-write',
      ownedPaths: ['forge-admin-ui/src/views/device/index.vue'] });
    assert.equal(contract.taskProfiles.includes('database'), false, prompt);
  }
  for (const prompt of ['修改页面文案。同时调整数据库。', '数据库无需修改，但需要新增数据库索引。']) {
    assert.ok(deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' }).taskProfiles.includes('database'), prompt);
  }
  const declared = compileForgeTaskExecutionContract({ prompt: '修改页面文案。数据库无需修改。', actionCeiling: 'workspace-write',
    ownedPaths: ['forge-admin-ui/src/views/device/index.vue'], taskProfiles: ['frontend-admin', 'database'] });
  assert.ok(declared.taskProfiles.includes('database'));
  const migration = compileForgeTaskExecutionContract({ prompt: '修改页面文案。无需调整数据库。', actionCeiling: 'workspace-write',
    ownedPaths: ['forge-server/db/migration/V202610060001__fixture.sql'] });
  assert.ok(migration.taskProfiles.includes('database'));
  assert.ok(migration.requiredVerificationProfiles.includes('backend-module-test'));
});

test('explicit frontend verification preserves defaults and binds requested checks to the current contract', () => {
  const ordinary = compileForgeTaskExecutionContract(semanticInput(), frontendVerificationOptions);
  assert.deepEqual(ordinary.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.equal(Object.hasOwn(ordinary, 'requestedVerificationProfiles'), false);
  assert.deepEqual(validateForgeTaskExecutionContract(ordinary), ordinary);
  const requested = compileForgeTaskExecutionContract({ ...semanticInput(), prompt: frontendVerificationRequest }, frontendVerificationOptions);
  assert.deepEqual(requested.requestedVerificationProfiles, frontendRequestedProfiles);
  assert.deepEqual(requested.requiredVerificationProfiles, [...ordinary.requiredVerificationProfiles, ...frontendRequestedProfiles]);
  assert.deepEqual(validateForgeTaskExecutionContract(JSON.parse(JSON.stringify(requested))), requested);
  assert.equal(verificationScopeForContract(requested), 'changed');
  assert.notEqual(requested.contractId, ordinary.contractId);
  assert.notEqual(requested.sourceFingerprint, ordinary.sourceFingerprint);
  assert.deepEqual(requested.requiredObligations, ordinary.requiredObligations);
  assert.equal(deriveForgeTaskIntent({ prompt: '修改管理端页面。', actionCeiling: 'workspace-write' }).actionCeiling, 'workspace-write');
  // Existing full/phase-style contracts retain their historical shape and ID.
  const legacy = compileForgeTaskExecutionContract(semanticInput());
  assert.equal(legacy.contractId, '38566b919ef242ed7c9e54e0b5f291a13afdd0aa1a839af7cb0d52449362ef94');
  assert.equal(Object.hasOwn(legacy, 'requestedVerificationProfiles'), false);
  assert.deepEqual(validateForgeTaskExecutionContract(legacy), legacy);
  const typeOnly = compileForgeTaskExecutionContract({ ...semanticInput(), prompt: '请执行 typecheck。' }, frontendVerificationOptions);
  assert.deepEqual(typeOnly.requestedVerificationProfiles, ['frontend-admin-typecheck']);
  assert.equal(typeOnly.requiredVerificationProfiles.includes('frontend-admin-build'), false);
});

test('explicit frontend verification ignores negatives, deferral, quotations and read-only requests', () => {
  const prompts = [
    '本轮不要执行 typecheck、build。',
    '不要执行 typecheck，build 也暂缓，请仅检查当前页面。',
    '本轮暂缓类型检查和构建，先完成 lint。',
    'typecheck/build 当前未被平台普通前端准入合同包含，平台正在处理该明确要求与执行准入不一致的问题。本轮不重复已拒绝的 typecheck，不手工签发准入或改平台文件；先完成不受影响的 lint 和 API 合同检查，收取真实 Host 终态和回执。不得因暂缓 type/build 而停止本轮这两项可执行工作。',
    '上一轮要求执行 typecheck 和 build。现在只修复页面。',
    '请解释 typecheck 和 build 字段，说明如何执行。',
    '请运行 MIME type 相关单元测试。',
    '是否需要执行 typecheck 和 build？',
    '请阅读日志：“请执行 typecheck 和 build”。只处理页面。',
    '示例：请执行 typecheck 和 build。只处理页面。',
    '```text\n请执行 typecheck 和 build\n```\n只处理页面。',
  ];
  for (const prompt of prompts) {
    const contract = compileForgeTaskExecutionContract({ ...semanticInput(), prompt }, frontendVerificationOptions);
    assert.equal(Object.hasOwn(contract, 'requestedVerificationProfiles'), false, prompt);
    assert.equal(contract.requiredVerificationProfiles.some(profile => frontendRequestedProfiles.includes(profile)), false, prompt);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
  const readOnly = compileForgeTaskExecutionContract({ ...semanticInput(), prompt: frontendVerificationRequest, actionCeiling: 'read-only' }, frontendVerificationOptions);
  assert.equal(Object.hasOwn(readOnly, 'requestedVerificationProfiles'), false);
  assert.deepEqual(readOnly.requiredVerificationProfiles, []);
});

test('explicit frontend verification cannot be supplied by a model proposal instead of protected user text', () => {
  const input = {
    promptText: frontendVerificationRequest,
    actionCeiling: 'workspace-write',
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }],
    proposal: { goal: '调整设备页面提示。', ownedPaths: semanticInput().ownedPaths, taskProfiles: ['frontend-admin'],
      references: [{ path: semanticInput().ownedPaths[0], sha256: 'a'.repeat(64) }] },
  };
  const requested = compileConversationTaskProposal(input, frontendVerificationOptions).contract;
  assert.deepEqual(requested.requestedVerificationProfiles, frontendRequestedProfiles);
  assert.deepEqual(validateForgeTaskExecutionContract(requested), requested);
  const modelRequested = { ...input, promptText: '本轮不执行 typecheck/build，只处理页面。',
    proposal: { ...input.proposal, goal: frontendVerificationRequest } };
  assert.equal(Object.hasOwn(compileConversationTaskProposal(modelRequested, frontendVerificationOptions).contract, 'requestedVerificationProfiles'), false);
  expectCode('CONTRACT_UNSUPPORTED_FIELD', () => compileForgeTaskExecutionContract({
    ...semanticInput(), requestedVerificationProfiles: frontendRequestedProfiles,
  }, frontendVerificationOptions));
  assert.throws(() => compileConversationTaskProposal({ ...input,
    proposal: { ...input.proposal, requestedVerificationProfiles: frontendRequestedProfiles } }, frontendVerificationOptions));
});

test('explicit frontend verification rejects changed hashes and inconsistent requested profile obligations', () => {
  const requested = compileForgeTaskExecutionContract({ ...semanticInput(), prompt: frontendVerificationRequest }, frontendVerificationOptions);
  const rehash = value => {
    const { contractId, ...payload } = value;
    return { ...value, contractId: createHash('sha256').update(canonicalStringify(payload)).digest('hex') };
  };
  expectCode('CONTRACT_HASH_MISMATCH', () => validateForgeTaskExecutionContract({ ...requested, sourceFingerprint: 'a'.repeat(64) }));
  for (const patch of [
    { requiredVerificationProfiles: requested.requiredVerificationProfiles.filter(profile => profile !== 'frontend-admin-typecheck') },
    { requiredVerificationProfiles: requested.requiredVerificationProfiles.filter(profile => profile !== 'frontend-admin-lint') },
    { requestedVerificationProfiles: ['frontend-admin-build'] },
  ]) expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(rehash({ ...requested, ...patch })));
  for (const requestedVerificationProfiles of [[], ['backend-module-test'], [...frontendRequestedProfiles].reverse()]) {
    assert.throws(() => validateForgeTaskExecutionContract(rehash({ ...requested, requestedVerificationProfiles })), ForgeTaskContractError);
  }
  const readOnly = compileForgeTaskExecutionContract({ ...semanticInput(), actionCeiling: 'read-only' }, frontendVerificationOptions);
  expectCode('CONTRACT_VERIFICATION_SCOPE_INVALID', () => validateForgeTaskExecutionContract(rehash({
    ...readOnly, requestedVerificationProfiles: frontendRequestedProfiles,
  })));
});

test('admin Docker packaging accepts only the exact backend Dockerfile and preserves contract validation', () => {
  const file = 'docker-forge-admin/Dockerfile.admin';
  const input = { prompt: '修复 Admin 镜像打包资源接线。', ownedPaths: [file], actionCeiling: 'workspace-write' };
  const contract = compileForgeTaskExecutionContract(input);
  assert.deepEqual(contract.ownedPaths, [file]);
  assert.deepEqual(contract.taskProfiles, ['backend']);
  assert.equal(contract.actionCeiling, 'workspace-write');
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  for (const denied of ['docker-forge-admin', 'docker-forge-admin/Dockerfile.admin/extra',
    'docker-forge-admin/Dockerfile.app', 'docker-forge-admin/docker-compose.yml',
    'docker-forge-admin/.env', 'Dockerfile']) {
    expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compileForgeTaskExecutionContract({ ...input, ownedPaths: [denied] }));
  }
});


const adminPackagingInput = {
  // Actual private migration continuation; keep its full instructions, not a keyword workaround.
  prompt: "继续当前 coverage-upgrade-b 正规会话的 DB-MIGRATION-005 候选交付。目标和限制沿用下面的原始请求；本消息没有授权发布、数据库操作或扩大修改范围。\n\n请依据本次真实新运行状态继续，不要仅复述上一轮阻塞。上一轮 seq1564 已成功准备 docker-forge-admin/Dockerfile.admin 的准确 owned path，但 seq1694 的实际 edit 被旧写入守卫拒绝，seq1928 自然结束，0 成功业务写；这些失败事实保留。\n\n平台已针对该实际不一致交付最小修复：精确的 Admin Dockerfile 路径识别由编译端和实际写入守卫共同消费，不扩大为任意 Docker 或仓库根目录写入。冻结平台源码为 3ee83a21760b599fd9ed26e449fc59244cebc51c；本私有项目 Acceptance、Broker 和当前 Harness 的实际新镜像为 sha256:990afa07f9f3073fc67b9b269b2f64fa964d8fbc29959fba36c28bf1aaeb9418，当前 Harness 容器为 929de71ee59e64f21ab4e7ea5a03030985dcb69c66f6f7dfbaf003c9628d8314。实际部署成功证据为 /srv/forge-delivery/platform-backups/pre-coverage-docker-guard-private-20261004-01/success.json，SHA-256 4fe595e1ebbf7e26633bd80a5d6289b417dee3f03d685653030b774ab24cbaa4。Manager 和已有 scope 配置保持，旧失败没有被改成通过。\n\n请沿正常工具入口核对本请求的准备状态和准确范围；需要时正常 inspect/propose 刷新本请求绑定，随后继续上轮未成功的必要编辑及直接静态自检。不要沿用旧拒绝作为新状态结论，也不要绕过守卫。若新状态仍发生拒绝，请保留这次真实工具调用、错误与当前绑定，不重复无变化的失败命令，不改写或手工制造平台合同。\n\n原始请求（SHA-256 cb258fb3b30019b2fc52a502c27960d46c1b1a15aa68ef913957126f2ef6c1b6）如下：\n\n请在当前 coverage-upgrade-b 项目的当前个人工作舱中，实际完成 DB-MIGRATION-005 的迁移候选交付修改；你是业务代码、测试和打包文件的唯一作者。这是关联原 upgrade-preserve-b 的新正规会话，原 session622、失败记录和私有145/292表基线保留，不能冒充本会话合同或回执。\n\n本轮最小交付目标：解决已有证据指出的迁移制品缺口——现有业务镜像依赖外部只读 /app/db/migration 挂载，脱离该挂载时镜像本身缺少对应版本SQL。先核当前项目实际 Dockerfile、迁移资源路径和应用迁移入口；若当前源码仍有此缺口，正常 inspect/propose 取得本请求的准确可写范围后，真实修改直接必要的业务打包/资源接线及最小验证材料，让候选制品自身包含其源码对应的版本化迁移，并保持现有迁移执行路径一致。不能仅输出方案或只读准备；若当前已经具备这一能力，应明确给出本项目证据，不为制造差异新增无业务意义的migration。\n\n保留历史迁移内容与校验和，不靠修改已发布SQL、禁用Flyway或故意编写坏SQL制造通过。当前源历史到1.0.212，私有测试库历史145是另一层基线，不能混作新候选版本。已有145→146定向验证作为历史保留，不能移植forge-base的合同、凭据、回执或源码改动。\n\n完成候选修改和直接必要的静态自检后，报告实际修改文件、真实准备合同、当前HEAD/dirty范围及后续受控验证需要。本轮停止在候选交付，不执行 release、业务提交发布、SQL、快照导入/恢复或平台故障注入，也不访问生产/共享库。后续迁移失败与恢复演练只允许现有 ReleaseRunner 在 coverage_upgrade_b_test 上按真实job/commit产生自己的备份和恢复记录；历史快照不能手写登记为新恢复点，coverage_upgrade_b 运行库保持。\n",
  ownedPaths: ['docker-forge-admin/Dockerfile.admin'],
  actionCeiling: 'workspace-write',
};
const adminPackagingOptions = { independentReview: 'suspended', verificationScope: 'changed',
  focusedBackendVerification: true, ordinaryFinalVerification: true };
const rehashPackagingContract = value => {
  const { contractId, ...payload } = value;
  return { ...value, contractId: createHash('sha256').update(canonicalStringify(payload)).digest('hex') };
};

test('ordinary admin Docker packaging scopes the actual migration request and preserves consumer readback', () => {
  const contract = compileForgeTaskExecutionContract(adminPackagingInput, adminPackagingOptions);
  assert.deepEqual(contract.taskProfiles, ['migration', 'database', 'backend']);
  assert.deepEqual(contract.ownedPaths, adminPackagingInput.ownedPaths);
  assert.equal(contract.actionCeiling, 'workspace-write');
  assert.equal(contract.tddRequired, false);
  assert.deepEqual(contract.requiredRedProfiles, []);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance']);
  assert.deepEqual(contract.requiredObligations, ['preserve-action-ceiling', 'repository-relative-owned-paths',
    'report-evidence-boundaries', 'final-governance-audit', 'no-implicit-git-or-release']);
  assert.deepEqual(validateForgeTaskExecutionContract(JSON.parse(JSON.stringify(contract))), contract);
  assert.equal(verificationScopeForContract(contract), 'changed');
  // Acceptance and execution-context recompile from these stored bindings.
  const rebuilt = compileForgeTaskExecutionContract({ ...adminPackagingInput, taskProfiles: contract.taskProfiles }, {
    independentReview: 'suspended', verificationScope: verificationScopeForContract(contract),
    focusedBackendVerification: contract.requiredVerificationProfiles.includes('backend-test-class'),
  });
  assert.deepEqual(rebuilt.requiredVerificationProfiles, contract.requiredVerificationProfiles);
  assert.deepEqual(rebuilt.requiredObligations, contract.requiredObligations);
  for (const actionCeiling of ['git-checkpoint', 'release']) {
    const elevated = compileForgeTaskExecutionContract({ ...adminPackagingInput, actionCeiling }, adminPackagingOptions);
    assert.ok(elevated.requiredObligations.includes('explicit-path-git-checkpoint'));
    assert.equal(elevated.requiredObligations.includes('controlled-release-only'), actionCeiling === 'release');
    assert.deepEqual(validateForgeTaskExecutionContract(elevated), elevated);
  }
  expectCode('CONTRACT_ACTION_CEILING_EXCEEDED', () => assertActionWithinCeiling(contract, 'release'));
});

test('ordinary admin Docker packaging retains SQL Java mixed and historical contracts and rejects partial weakening', () => {
  const ordinary = compileForgeTaskExecutionContract(adminPackagingInput, adminPackagingOptions);
  const sql = 'forge-server/forge-admin-server/src/main/resources/db/migration/V3__example.sql';
  const java = 'forge-server/forge-admin-server/src/main/java/example/Example.java';
  for (const ownedPaths of [[sql], [java], [...adminPackagingInput.ownedPaths, sql], [...adminPackagingInput.ownedPaths, java]]) {
    const contract = compileForgeTaskExecutionContract({ ...adminPackagingInput, ownedPaths }, adminPackagingOptions);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.ok(contract.requiredObligations.includes('empty-and-upgrade-schema-verification'));
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
  const security = compileForgeTaskExecutionContract({ ...adminPackagingInput,
    taskProfiles: ['migration', 'database', 'backend', 'security'] }, adminPackagingOptions);
  assert.ok(security.requiredVerificationProfiles.includes('backend-module-test'));
  assert.ok(security.requiredObligations.includes('security-negative-tests'));
  assert.deepEqual(validateForgeTaskExecutionContract(security), security);
  for (const options of [{}, { independentReview: 'suspended' }, { verificationScope: 'changed' },
    { ...adminPackagingOptions, ordinaryFinalVerification: false }]) {
    const contract = compileForgeTaskExecutionContract(adminPackagingInput, options);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.ok(contract.requiredObligations.includes('empty-and-upgrade-schema-verification'));
    assert.equal(contract.tddRequired, true);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
  // Complete pre-fix ordinary content, including its original module obligation,
  // remains readable. Never rewrite a stored contract or its signatures/receipts.
  const phase = compileForgeTaskExecutionContract(adminPackagingInput,
    { ...adminPackagingOptions, ordinaryFinalVerification: false });
  const historical = rehashPackagingContract({ ...phase, tddRequired: false, requiredRedProfiles: [],
    requiredObligations: phase.requiredObligations.filter(id => id !== 'test-first') });
  assert.deepEqual(validateForgeTaskExecutionContract(historical), historical);
  assert.equal(verificationScopeForContract(historical), 'changed');
  const readOnly = compileForgeTaskExecutionContract({ ...adminPackagingInput, actionCeiling: 'read-only' }, adminPackagingOptions);
  assert.deepEqual(readOnly.requiredVerificationProfiles, []);
  assert.deepEqual(validateForgeTaskExecutionContract(readOnly), readOnly);
  expectCode('CONTRACT_ACTION_CEILING_EXCEEDED', () => assertActionWithinCeiling(readOnly, 'workspace-write'));
  for (const mutation of [
    { requiredObligations: ordinary.requiredObligations.filter(id => id !== 'final-governance-audit') },
    { requiredObligations: historical.requiredObligations },
    { requiredVerificationProfiles: historical.requiredVerificationProfiles },
    { ownedPaths: [...ordinary.ownedPaths, sql] },
    { ownedPaths: [java] },
  ]) expectCode('CONTRACT_DERIVATION_MISMATCH', () =>
    validateForgeTaskExecutionContract(rehashPackagingContract({ ...ordinary, ...mutation })));
});

test('semantic resources: absent trusted option preserves pre-change contract bytes and identifiers', () => {
  // Captured from this compiler before semanticResources support was added.
  const contract = compileForgeTaskExecutionContract(semanticInput());
  assert.equal(contract.contractId, '38566b919ef242ed7c9e54e0b5f291a13afdd0aa1a839af7cb0d52449362ef94');
  assert.equal(contract.sourceFingerprint, '1598991603a7b74ad6662dc81a8d3c3fd45ac1748aa9793993ec93997b84c9aa');
  assert.equal(createHash('sha256').update(JSON.stringify(contract)).digest('hex'), '34926ab0173eca944bc3c800ba67e5e228c6f6eefc56a83871c7b4480743d88a');
  assert.equal(Object.hasOwn(contract, 'semanticResources'), false);
  assert.deepEqual(compileForgeTaskExecutionContract(semanticInput(), { semanticResources: undefined }), contract);
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
});

test('semantic resources: trusted options bind canonical resources to fingerprint and contract ID', () => {
  const resources = [{ type: 'table-column', key: 'PUBLIC.ORDERS#STATUS' },
    { type: 'api', key: 'post /orders//{id}/' }];
  const before = structuredClone(resources);
  const approved = compileForgeTaskExecutionContract(semanticInput(), { semanticResources: resources });
  assert.deepEqual(approved.semanticResources, [{ type: 'api', key: 'POST /orders/:id' },
    { type: 'table-column', key: 'public.orders#status' }]);
  assert.deepEqual(resources, before);
  const different = compileForgeTaskExecutionContract(semanticInput(), { semanticResources: [{ type: 'table', key: 'orders_other' }] });
  const absent = compileForgeTaskExecutionContract(semanticInput());
  for (const other of [different, absent]) {
    assert.notEqual(approved.sourceFingerprint, other.sourceFingerprint);
    assert.notEqual(approved.contractId, other.contractId);
  }
  const restored = validateForgeTaskExecutionContract(JSON.parse(JSON.stringify(approved)));
  assert.deepEqual(restored, approved);
  assert.ok(Object.isFrozen(restored.semanticResources) && restored.semanticResources.every(Object.isFrozen));
});

test('semantic resources: model input cannot declare locks and empty options are rejected', () => {
  expectCode('CONTRACT_UNSUPPORTED_FIELD', () => compileForgeTaskExecutionContract({
    ...semanticInput(), semanticResources: [{ type: 'table', key: 'orders' }],
  }));
  for (const semanticResources of [[], null, [{ type: 'table', key: 'ORDERS' }, { type: 'table', key: 'orders' }]]) {
    expectCode('CONTRACT_SEMANTIC_RESOURCES_INVALID', () => compileForgeTaskExecutionContract(semanticInput(), { semanticResources }));
  }
});

test('semantic resources: serialized noncanonical values, duplicates and tampering are rejected', () => {
  const contract = compileForgeTaskExecutionContract(semanticInput(), { semanticResources: [
    { type: 'table', key: 'orders' }, { type: 'permission', key: 'orders:edit' },
  ] });
  const reordered = structuredClone(contract); reordered.semanticResources.reverse();
  const alias = structuredClone(contract); alias.semanticResources.find(item => item.type === 'table').key = 'ORDERS';
  const duplicate = structuredClone(contract); duplicate.semanticResources.push({ ...duplicate.semanticResources[0] });
  const extra = structuredClone(contract); extra.semanticResources[0].extra = true;
  for (const invalid of [reordered, alias, duplicate, extra]) {
    expectCode('CONTRACT_SEMANTIC_RESOURCES_INVALID', () => validateForgeTaskExecutionContract(invalid));
  }
  const tampered = structuredClone(contract); tampered.semanticResources.find(item => item.type === 'table').key = 'other_orders';
  expectCode('CONTRACT_HASH_MISMATCH', () => validateForgeTaskExecutionContract(tampered));
});

test('protected role grant decisions bind exact SQL and recipients without changing legacy contracts', () => {
  const input = { prompt: '新增设备菜单的角色授权。', actionCeiling: 'workspace-write',
    ownedPaths: ['forge-server/db/migration/V2__device_roles.sql'] };
  const legacy = compileForgeTaskExecutionContract(input);
  const missing = compileForgeTaskExecutionContract(input, { roleGrantDecisions: [] });
  const decision = { path: input.ownedPaths[0], roleKeys: ['reviewer', 'operator'], statementSha256: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
  const approved = compileForgeTaskExecutionContract(input, { roleGrantDecisions: [decision] });
  assert.equal(Object.hasOwn(legacy, 'roleGrantDecisions'), false);
  assert.deepEqual(missing.roleGrantDecisions, []);
  assert.notEqual(missing.contractId, legacy.contractId);
  assert.notEqual(approved.contractId, missing.contractId);
  assert.notEqual(approved.sourceFingerprint, missing.sourceFingerprint);
  assert.deepEqual(approved.roleGrantDecisions[0].roleKeys, ['operator', 'reviewer']);
  for (const contract of [legacy, missing, approved]) assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  const forged = structuredClone(approved); forged.roleGrantDecisions[0].roleKeys = ['admin'];
  assert.throws(() => validateForgeTaskExecutionContract(forged), /contractId/u);
  assert.throws(() => compileForgeTaskExecutionContract({ ...input, roleGrantDecisions: [decision] }),
    error => error.code === 'CONTRACT_UNSUPPORTED_FIELD');
});

test('protected role grant decisions reject broad scopes, duplicate decisions and unspecified recipients', () => {
  const input = { prompt: '新增设备菜单的角色授权。', actionCeiling: 'workspace-write',
    ownedPaths: ['forge-server/db/migration/V2__device_roles.sql'] };
  const decision = { path: input.ownedPaths[0], roleKeys: ['reviewer'], statementSha256: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
  for (const value of [null, {}, [decision, decision],
    [{ ...decision, path: 'forge-server/db/migration/V3__other.sql' }],
    [{ ...decision, path: 'forge-server/db/migration/../V2__device_roles.sql' }],
    [{ ...decision, roleKeys: [] }], [{ ...decision, roleKeys: ['*'] }],
    [{ ...decision, roleKeys: ['admin', 'admin'] }], [{ ...decision, statementSha256: 'latest' }],
    [{ ...decision, fileSha256: 'latest' }],
    [{ ...decision, approved: true }]]) {
    expectCode('CONTRACT_ROLE_DECISION_INVALID', () => compileForgeTaskExecutionContract(input, { roleGrantDecisions: value }));
  }
});

test('H5 source admission preserves exact writer scopes and consumes the existing H5 build profile', () => {
  const relative = 'forge-h5-ui/src/api/index.js';
  const contract = compile({ prompt: '修复现有移动端请求适配。', ownedPaths: [relative], actionCeiling: 'release', taskProfiles: ['shared-owner'] });
  assert.deepEqual(contract.ownedPaths, [relative]);
  assert.deepEqual(contract.taskProfiles, ['shared-owner']);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-h5-build']);
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  assert.equal(verificationScopeForContract(contract), 'changed');
  assert.equal(isForgeTaskOwnedPath('forge-h5-ui/src/pages/profile.vue', relative), false);
  const paths = ['forge-h5-ui/src/locales/labels.js', 'forge-h5-ui/src/locales/display.test.js',
    'forge-h5-ui/src/pages/app-entry.vue', 'forge-h5-ui/src/pages/todo.vue',
    'forge-h5-ui/src/pages/mine/index.vue', 'forge-h5-ui/src/pages/lowcode-runtime.vue',
    'forge-h5-ui/src/utils/__tests__/bilingual-display-contract.test.js'];
  const input = { actionCeiling: 'workspace-write', promptText: '实现移动端固定显示中英双语，保留业务值。',
    writerScopes: [{ taskProfile: 'shared-owner', ownedPaths: ['forge-h5-ui/src/api/index.js'] }],
    proposal: { goal: '实现移动端固定显示中英双语，保留业务值。', ownedPaths: paths,
      taskProfiles: ['shared-owner'], references: [{ path: relative, sha256: 'a'.repeat(64) }] } };
  assert.throws(() => compileConversationTaskProposal(input), error => error.code === 'CONVERSATION_TASK_SCOPE_DENIED');
  const admitted = compileConversationTaskProposal({ ...input,
    writerScopes: [{ taskProfile: 'shared-owner', ownedPaths: ['forge-h5-ui/src'] }] },
  { verificationScope: 'changed' }).contract;
  assert.deepEqual(admitted.ownedPaths, [...paths].sort());
  assert.deepEqual(admitted.requiredVerificationProfiles, ['governance', 'frontend-h5-test', 'frontend-h5-build']);
  assert.deepEqual(validateForgeTaskExecutionContract(admitted), admitted);
  assert.equal(isForgeTaskOwnedPath('forge-h5-ui/src/pages/other.vue', paths[2]), false);
  for (const path of ['forge-h5-ui/package.json', 'forge-h5-ui/.env', 'unclassified-zone/source.js']) {
    expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compile({ ownedPaths: [path], taskProfiles: ['shared-owner'] }));
  }
  const admin = compile({ prompt: '修复现有请求适配。', ownedPaths: ['forge-admin-ui/src/api/system/password.js'], actionCeiling: 'release' });
  assert.ok(!admin.requiredVerificationProfiles.includes('frontend-h5-build'));
});

test('standard change records require exact configured file scopes without granting arbitrary documents', () => {
  const root = 'code-copilot/changes/customer-bilingual-mobile-metadata';
  const records = ['spec.md', 'tasks.md', 'test-spec.md', 'execution-log.md'].map(name => `${root}/${name}`);
  const source = 'forge-h5-ui/src/locales/labels.js';
  const input = { actionCeiling: 'workspace-write', promptText: '实现移动端双语并记录本次变更与验证。',
    writerScopes: [{ taskProfile: 'shared-owner', ownedPaths: ['forge-h5-ui/src'] }],
    proposal: { goal: '实现移动端双语并记录本次变更与验证。', ownedPaths: [source, ...records],
      taskProfiles: ['shared-owner'], references: [{ path: source, sha256: 'a'.repeat(64) }] } };
  assert.throws(() => compileConversationTaskProposal(input), error => error.code === 'CONVERSATION_TASK_SCOPE_DENIED');
  const admitted = compileConversationTaskProposal({ ...input,
    writerScopes: [{ taskProfile: 'shared-owner', ownedPaths: [...records, 'forge-h5-ui/src'].sort() }] },
  { verificationScope: 'changed' }).contract;
  assert.deepEqual(validateForgeTaskExecutionContract(admitted), admitted);
  assert.deepEqual(admitted.requiredVerificationProfiles, ['governance', 'frontend-h5-build']);
  assert.equal(isForgeRequiredChangeSpecPath(records[0]), true);
  for (const record of records) assert.equal(isForgeChangeRecordPath(record), true);
  for (const record of records.slice(1)) {
    assert.equal(isForgeRequiredChangeSpecPath(record), false);
    assert.equal(isForgeTaskOwnedPath(record, record), true);
    assert.equal(isForgeTaskOwnedPath(`${record}/nested`, record), false);
  }
  for (const path of [`${root}/README.md`, 'code-copilot/changes', 'AGENTS.md', 'code-copilot/memory/pitfalls.md']) {
    assert.equal(isForgeChangeRecordPath(path), false);
    expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compile({ ownedPaths: [path], taskProfiles: ['shared-owner'] }));
  }
  assert.throws(() => compileConversationTaskProposal({ ...input,
    writerScopes: [{ taskProfile: 'shared-owner', ownedPaths: [...records, 'forge-h5-ui/src'].sort() }],
    proposal: { ...input.proposal, ownedPaths: [source, 'code-copilot/changes/another-task/tasks.md'] } }),
  error => error.code === 'CONVERSATION_TASK_SCOPE_DENIED');
});

test('catalogs expose only the reviewed profiles and monotonic action ceilings', () => {
  assert.deepEqual(ACTION_CEILINGS, [
    'read-only', 'workspace-write', 'test', 'git-checkpoint', 'release',
  ]);
  assert.deepEqual(TASK_PROFILES, [
    'project-files', 'requirements', 'domain-contract',
    'migration', 'database', 'backend', 'crud', 'dictionary', 'frontend-admin',
    'security', 'workflow', 'shared-owner', 'ui-design', 'cross-layer-acceptance',
    'read-only-review', 'frontend-format-maintenance',
  ]);
});

test('operator-declared phases derive only their phase-specific Skill closure', () => {
  const requirements = compile({
    prompt: '梳理并冻结供应商资质需求。',
    ownedPaths: [],
    actionCeiling: 'read-only',
    taskProfiles: ['requirements'],
  });
  assert.deepEqual(requirements.taskProfiles, ['requirements', 'read-only-review']);
  assert.deepEqual(requirements.requiredSkills, [
    'forge-task-contract',
    'forge-task-router',
    'forge-change-design',
    'forge-requirement-coverage',
    'forge-evidence-truth',
  ]);
  assert.ok(!requirements.requiredSkills.includes('forge-database-migration'));
  assert.ok(!requirements.requiredSkills.includes('forge-backend-architecture'));
  assert.ok(!requirements.requiredSkills.includes('forge-frontend-admin'));

  const backend = compile({
    prompt: '实现已冻结的后端合同。',
    ownedPaths: [
      'forge-server/forge-admin-server/src/main/java/com/mdframe/forge/supplier/SupplierController.java',
      'forge-server/forge-admin-server/src/test/java/com/mdframe/forge/supplier/SupplierControllerTest.java',
    ],
    actionCeiling: 'workspace-write',
    taskProfiles: ['backend', 'security'],
  });
  assert.ok(backend.requiredSkills.includes('forge-backend-architecture'));
  assert.ok(!backend.requiredSkills.includes('forge-database-migration'));
  assert.ok(!backend.requiredSkills.includes('forge-frontend-admin'));
});

test('derives a pathless task-intent preflight before the final owned-path contract exists', () => {
  const intent = deriveForgeTaskIntent({
    prompt: '修复后端共享分页 owner，并先写回归测试。',
    actionCeiling: 'workspace-write',
  });
  assert.equal(intent.kind, 'forge-task-intent');
  assert.deepEqual(intent.taskProfiles, ['backend', 'shared-owner']);
  assert.deepEqual(intent.requiredVerificationProfiles, [
    'governance', 'backend-module-test',
  ]);
  assert.deepEqual(intent.requiredRedProfiles, ['backend-red-test']);
  assert.ok(intent.requiredSkills.includes('forge-change-design'));
  assert.ok(intent.requiredSkills.includes('forge-backend-architecture'));
  assert.ok(Object.isFrozen(intent));
});

test('scope inference honors explicit layer limits, excluded checks and completed dependency-permission context', () => {
  for (const [prompt, expected] of [
    ['修复页面调用的后端逻辑，本次仅修改后端。', ['backend', 'read-only-review']],
    ['本轮只收尾此前前端测试的验收回执。本轮不重复后端测试、全量回归、lint、类型检查或构建。', ['frontend-admin', 'read-only-review']],
    ['修复后端逻辑，不改前端权限逻辑。', ['backend', 'read-only-review']],
    ['修复后端逻辑。不改前端，但需要修复租户权限校验。', ['backend', 'security', 'read-only-review']],
    ['继续验证当前改动。平台已修复预装依赖目录读取权限，业务源码未变，只续跑当前前端测试。', ['frontend-admin', 'read-only-review']],
    ['平台已修复预装依赖目录读取权限，同时修复后端租户权限校验。', ['backend', 'security', 'read-only-review']],
  ]) {
    assert.deepEqual(deriveForgeTaskIntent({ prompt, actionCeiling: 'read-only' }).taskProfiles, expected, prompt);
  }
});

test('job resubmission does not infer workflow while approval, declared and path consumers remain required', async () => {
  const original = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-controlled-query-composed-verification-prompt.md', import.meta.url), 'utf8');
  const ownedPaths = [
    'forge-server/forge-framework/forge-plugin-parent/forge-plugin-data/src/main/java/com/mdframe/forge/plugin/data/service/DataQueryExecutor.java',
    'forge-server/forge-admin-server/src/test/java/com/mdframe/forge/plugin/data/DataDatasetReadonlyQueryIntegrationTest.java',
    'forge-server/forge-admin-server/src/test/resources/coverage-controlled-query/spec.md',
  ];
  for (const prompt of [original, '修复后端查询，登记后台观察后不得重提。', '修复后端查询，后台作业失败后可以重提。']) {
    const intent = deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' });
    const contract = compile({ prompt, ownedPaths, actionCeiling: 'workspace-write' });
    for (const result of [intent, contract]) {
      assert.ok(!result.taskProfiles.includes('workflow'), prompt);
      assert.ok(!result.requiredObligations.includes('workflow-state-transition-tests'));
      assert.ok(!result.requiredObligations.includes('idempotent-workflow-callbacks'));
    }
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
  for (const prompt of ['实现采购审批的驳回重提。', '支持审批重提。', '允许重新编辑并重提审批。']) {
    assert.ok(deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' }).taskProfiles.includes('workflow'), prompt);
  }
  for (const overrides of [
    { taskProfiles: ['backend', 'workflow'] },
    { ownedPaths: [...ownedPaths, 'forge-server/forge-flow/src/main/resources/workflow/purchase.bpmn20.xml'] },
  ]) {
    const contract = compile({ prompt: '登记后台观察后不得重提。', ownedPaths, actionCeiling: 'workspace-write', ...overrides });
    assert.ok(contract.requiredObligations.includes('workflow-state-transition-tests'));
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
});

test('workflow inference stays within approval clauses and preserves real workflow consumers', () => {
  for (const separator of ['，', '。', '；', '\n']) {
    const prompt = `修改前端详情。不要做生产删除或审批${separator}不直接写保护状态。`;
    assert.ok(!deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' }).taskProfiles.includes('workflow'), separator);
  }
  for (const prompt of ['修改采购审批状态。', '新增审批页面。', '支持重新编辑并重提审批。', '实现采购审批的驳回重提。']) {
    assert.ok(deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' }).taskProfiles.includes('workflow'), prompt);
  }
  for (const extra of [{ taskProfiles: ['frontend-admin', 'workflow'] },
    { ownedPaths: ['forge-admin-ui/src/views/workflow/approval.vue'] }]) {
    const contract = compile({ prompt: '修改前端详情。不要做生产删除或审批，不直接写保护状态。',
      actionCeiling: 'workspace-write', ownedPaths: ['forge-admin-ui/src/views/fire/detail.vue'], ...extra });
    assert.ok(contract.taskProfiles.includes('workflow'));
  }
});

test('actual paths and declared consumers retain their checks without semantic profiles adding global regression', () => {
  const contract = compile({ prompt: '本次仅修改后端，不改前端权限逻辑。',
    ownedPaths: ['forge-admin-ui/src/views/example.vue', 'forge-server/src/main/java/auth/AccessService.java'] });
  for (const profile of ['backend', 'frontend-admin', 'security']) assert.ok(contract.taskProfiles.includes(profile), profile);
  const declared = compile({ prompt: '本次仅修改后端。',
    ownedPaths: ['forge-server/src/main/java/ExampleService.java'], taskProfiles: ['backend', 'frontend-admin'] });
  assert.ok(declared.requiredVerificationProfiles.includes('frontend-admin-test'));
  const crud = compile({ prompt: '本次仅修改后端，实现完整CRUD。', ownedPaths: ['forge-server/src/main/java/ExampleService.java'] });
  assert.deepEqual(crud.requiredVerificationProfiles, ['governance', 'backend-module-test']);
});

test('additional-work exclusions do not turn no database additions into database obligations', () => {
  const contract = compile({ prompt: '只修改这个前端工具和对应测试，不增加页面、后端或数据库内容。',
    ownedPaths: ['forge-admin-ui/src/utils/boolean-label.js', 'forge-admin-ui/src/utils/__tests__/boolean-label.spec.js'] });
  assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
  assert.ok(!contract.requiredVerificationProfiles.includes('backend-module-test'));
  assert.ok(!contract.requiredObligations.includes('transaction-index-and-query-review'));
});

test('do-not-touch exclusions keep the frontend tool task local at intent, execution and validation', () => {
  const prompt = '本轮请直接完成一个小的前端工具需求：归一化事故查询关键词并补相关单元测试。只改工具函数及其测试，不接页面、不动后端和数据库，不提交、不发版。';
  const ownedPaths = [
    'forge-admin-ui/src/views/accident/incident-query-utils.js',
    'forge-admin-ui/src/views/accident/__tests__/incident-query-utils.spec.js',
  ];
  const intent = deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' });
  assert.deepEqual(intent.taskProfiles, ['frontend-admin']);
  const contract = compile({ prompt, ownedPaths, actionCeiling: 'workspace-write' });
  assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.ok(!contract.requiredObligations.includes('transaction-index-and-query-review'));
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);

  for (const input of [
    { prompt: '只改前端工具，不动页面，但需要修复后端数据库索引。', ownedPaths },
    { prompt, ownedPaths: [...ownedPaths, 'forge-server/src/main/java/mapper/IncidentMapper.java'] },
    { prompt, ownedPaths, taskProfiles: ['frontend-admin', 'database'] },
  ]) {
    const actual = compile(input);
    assert.ok(actual.taskProfiles.includes('database'));
    assert.ok(actual.requiredVerificationProfiles.includes('backend-module-test'));
    assert.deepEqual(validateForgeTaskExecutionContract(actual), actual);
  }
});

test('additional-work exclusions retain positive database requests and actual database paths', () => {
  const frontend = 'forge-admin-ui/src/utils/boolean-label.js';
  for (const [prompt, ownedPaths] of [
    ['只修改前端工具，不增加页面，但需要增加数据库索引。', [frontend]],
    ['只修改前端工具，不增加页面同时增加数据库索引。', [frontend]],
    ['只修改前端工具，不增加数据库内容。', [frontend, 'forge-server/src/main/java/mapper/BooleanMapper.java']],
  ]) {
    const contract = compile({ prompt, ownedPaths });
    assert.ok(contract.taskProfiles.includes('database'), prompt);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'), prompt);
    assert.ok(contract.requiredObligations.includes('transaction-index-and-query-review'), prompt);
  }
});

test('the actual small-fix tool schema request stays backend-only', async () => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-smallfix-binding-resume-prompt.md', import.meta.url), 'utf8');
  const ownedPaths = ['forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/coverage/SmallFixOrderRemarkFixture.java'];
  const contract = compileForgeTaskExecutionContract({ prompt, ownedPaths, actionCeiling: 'workspace-write' },
    { verificationScope: 'changed', focusedBackendVerification: true });
  assert.deepEqual(contract.taskProfiles, ['backend']);
  assert.ok(!contract.requiredSkills.includes('forge-database-migration'));
  assert.ok(!contract.requiredVerificationProfiles.includes('backend-module-test'));
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
});

test('frontend index file references preserve real database intent', async (t) => {
  const actualPrompt = await readFile(new URL('./fixtures/frontend-index-file-feedback.txt', import.meta.url), 'utf8');
  const ownedPaths = ['forge-admin-ui/src/router/index.js',
    'forge-admin-ui/src/router/guards/permission-guard.js',
    'forge-admin-ui/src/router/__tests__/security-guard-entry.spec.js'];
  const proposal = (promptText, paths = ownedPaths, taskProfiles = ['frontend-admin']) => compileConversationTaskProposal({
    promptText, actionCeiling: 'workspace-write',
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] },
      { taskProfile: 'database', ownedPaths: ['forge-server/db'] }],
    proposal: { goal: '修复现有前端菜单入口并保留授权边界。', ownedPaths: paths, taskProfiles,
      references: [{ path: ownedPaths[0], sha256: 'a'.repeat(64) }] },
  }, { independentReview: 'suspended', verificationScope: 'changed' }).contract;

  for (const [name, prompt] of [
    ['actual published bundle feedback', actualPrompt],
    ['Vue source path', '修复前端 forge-admin-ui/src/layouts/components/tab/index.vue 的双语标题。'],
    ['JavaScript source path', '修复前端 router/index.js 中的菜单入口。'],
    ['TypeScript entry reference', '修复前端 index.ts 与 index.tsx 的显示。'],
  ]) await t.test(name, () => {
    const contract = proposal(prompt);
    assert.deepEqual(contract.taskProfiles, name === 'actual published bundle feedback'
      ? ['frontend-admin', 'security'] : ['frontend-admin']);
    assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
    assert.notEqual(contract.sourceFingerprint, proposal('修复相同前端入口。').sourceFingerprint);
  });

  for (const [name, prompt, paths, profiles] of [
    ['explicit SQL index request', `${actualPrompt}\n同时新增数据库索引。`, ownedPaths, ['frontend-admin']],
    ['English index request', 'Update frontend index.vue and add an index to the database table.', ownedPaths, ['frontend-admin']],
    ['actual migration ownership', '修复前端 index.vue。', [...ownedPaths, 'forge-server/db/migration/V202610050001__index.sql'], ['frontend-admin']],
    ['declared database responsibility', '修复前端 index.vue。', ownedPaths, ['frontend-admin', 'database']],
  ]) await t.test(name, () => {
    const contract = proposal(prompt, paths, profiles);
    assert.ok(contract.taskProfiles.includes('database'));
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  });
  await t.test('an entry file reference does not add a frontend role to backend work', () => {
    const contract = compile({ prompt: '修复后端工具，参考 index.js 的行为。',
      ownedPaths: ['forge-server/src/main/java/example/Tool.java'] });
    assert.deepEqual(contract.taskProfiles, ['backend']);
  });
});

test('protocol schema references preserve real database schema obligations', () => {
  const helper = 'forge-server/forge-business/forge-business-core/src/test/java/example/Fixture.java';
  for (const prompt of [
    '按工具 schema 提交参数，修改 API schema 中的订单备注字段说明。',
    '按当前真实schema，读取文件作为references提交；沿当前真实帮助/schema，不猜命令。',
    '修复 JSON Schema 的说明和对应后端测试。',
  ]) assert.deepEqual(compile({ prompt, ownedPaths: [helper] }).taskProfiles, ['backend'], prompt);
  for (const input of [
    { prompt: '按工具 schema 提交参数，同时修改数据库 schema。', ownedPaths: [helper] },
    { prompt: '按当前真实schema，提交references，同时修改schema以增加用户表字段。', ownedPaths: [helper] },
    { prompt: '修改 schema 并补对应后端测试。', ownedPaths: [helper] },
    { prompt: '按工具 schema 提交参数。', ownedPaths: ['forge-server/src/main/java/mapper/OrderMapper.java'] },
    { prompt: '按工具 schema 提交参数。', ownedPaths: [helper], taskProfiles: ['backend', 'database'] },
  ]) assert.ok(compile(input).taskProfiles.includes('database'), input.prompt);
});

test('designer display-name feedback preserves frontend scope and real domain obligations', async (t) => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/frontend-designer-display-name-proposal.json', import.meta.url), 'utf8'));
  const compileProposal = ({ promptText = fixture.promptText, ownedPaths = fixture.proposal.ownedPaths,
    taskProfiles = fixture.proposal.taskProfiles } = {}) => compileConversationTaskProposal({
    promptText, actionCeiling: 'release',
    writerScopes: [
      { taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] },
      { taskProfile: 'backend', ownedPaths: ['forge-server'] },
    ],
    // prepare_task supplies paths; AS hashes verified references before this
    // compiler boundary. The digest value is irrelevant to profile inference.
    proposal: { ...fixture.proposal, ownedPaths, taskProfiles,
      references: fixture.proposal.references.map(path => ({ path, sha256: 'a'.repeat(64) })) },
  }, frontendVerificationOptions).contract;

  await t.test('the original protected request and actual six-path proposal stay frontend-only', () => {
    const contract = compileProposal();
    assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
    assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
    for (const obligation of ['transaction-index-and-query-review', 'complete-crud-vertical-slice',
      'stable-dictionary-code-contract', 'security-negative-tests']) {
      assert.ok(!contract.requiredObligations.includes(obligation), obligation);
    }
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  });

  for (const [name, addition, profile] of [
    ['database schema and index changes', '同时修改数据库schema并新增索引。', 'database'],
    ['new CRUD slice', '同时实现完整CRUD，支持新增、编辑、删除和查询。', 'crud'],
    ['dictionary changes', '同时修改字典码值。', 'dictionary'],
    ['security changes', '同时修复租户权限校验。', 'security'],
  ]) await t.test(name, () => {
    const contract = compileProposal({ promptText: `${fixture.promptText}\n${addition}` });
    const positiveOnly = compileProposal({ promptText: addition });
    assert.ok(contract.taskProfiles.includes(profile), profile);
    // Keep the obligations that the existing changed-scope policy actually
    // derives; semantic roles alone do not impose a full cross-layer slice.
    for (const obligation of positiveOnly.requiredObligations) {
      assert.ok(contract.requiredObligations.includes(obligation), obligation);
    }
    if (profile === 'database') assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  });

  await t.test('actual backend ownership and explicitly declared responsibilities remain required', () => {
    const actual = compileProposal({ ownedPaths: [...fixture.proposal.ownedPaths,
      'forge-server/src/main/java/entity/Example.java'] });
    for (const profile of ['backend', 'database', 'frontend-admin']) assert.ok(actual.taskProfiles.includes(profile), profile);
    assert.ok(actual.requiredVerificationProfiles.includes('backend-module-test'));
    const declared = compileProposal({ taskProfiles: ['frontend-admin', 'database', 'security'] });
    for (const profile of ['database', 'security']) assert.ok(declared.taskProfiles.includes(profile), profile);
    assert.ok(declared.requiredVerificationProfiles.includes('backend-module-test'));
    assert.deepEqual(validateForgeTaskExecutionContract(actual), actual);
    assert.deepEqual(validateForgeTaskExecutionContract(declared), declared);
  });
});

test('frontend UI schema feedback keeps its actual seven-file scope and real database obligations', async (t) => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/frontend-browser-findings-proposal.json', import.meta.url), 'utf8'));
  const compileProposal = ({ promptText = fixture.promptText, ownedPaths = fixture.proposal.ownedPaths,
    taskProfiles = fixture.proposal.taskProfiles } = {}) => compileConversationTaskProposal({
    promptText, actionCeiling: 'release',
    writerScopes: [
      { taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] },
      { taskProfile: 'backend', ownedPaths: ['forge-server'] },
      { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
    ],
    proposal: { ...fixture.proposal, ownedPaths, taskProfiles,
      references: fixture.proposal.references.map(path => ({ path, sha256: 'a'.repeat(64) })) },
  }, frontendVerificationOptions).contract;

  await t.test('the complete original request preserves security and shared-owner without a backend gate', () => {
    assert.equal(createHash('sha256').update(fixture.promptText).digest('hex'), fixture.promptSha256);
    assert.equal(fixture.promptSha256, '8aae26cafb9242879ebbd02fd63bd5b4a65b59777891da64967fd7faf83f9965');
    assert.equal(fixture.proposal.ownedPaths.length, 7);
    const contract = compileProposal();
    assert.deepEqual(contract.ownedPaths, [...fixture.proposal.ownedPaths].sort());
    assert.deepEqual(contract.taskProfiles, ['crud', 'dictionary', 'frontend-admin', 'security', 'shared-owner']);
    assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
    assert.ok(contract.requiredObligations.includes('security-negative-tests'));
    assert.ok(contract.semanticOwners.includes('shared-contract'));
    const trackedObligations = [...contract.requiredObligations, ...(contract.suspendedReviewObligations ?? [])];
    for (const obligation of ['unique-semantic-owner', 'dual-consumer-contract-tests']) {
      assert.ok(trackedObligations.includes(obligation), obligation);
    }
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  });

  await t.test('ordinary UI schema descriptions keep the same frontend verification scope', () => {
    for (const promptText of [
      '修复搜索区据 schema 是否为空决定显示的逻辑。',
      '调整查询区根据 schema 渲染字段的逻辑。',
      '修改表单的 schema，保持权限及公共组件行为。',
      'Update the UI schema, form schema and search schema rendering.',
    ]) {
      const contract = compileProposal({ promptText });
      assert.ok(!contract.taskProfiles.includes('database'), promptText);
      assert.ok(!contract.requiredVerificationProfiles.includes('backend-module-test'), promptText);
      assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
    }
  });

  await t.test('additional excluded database work does not erase a separate positive request', () => {
    const exclusion = '修复搜索区据 schema 是否为空决定显示的逻辑，也不要要求产品重新勾选四项或由操作者改数据库来补标准。';
    const scoped = compileProposal({ promptText: exclusion });
    assert.ok(!scoped.taskProfiles.includes('database'));
    assert.ok(!scoped.requiredVerificationProfiles.includes('backend-module-test'));
    const mixed = compileProposal({ promptText: `${exclusion}同时修改数据库 schema 并新增索引。` });
    assert.ok(mixed.taskProfiles.includes('database'));
    assert.ok(mixed.requiredVerificationProfiles.includes('backend-module-test'));
  });

  for (const [name, overrides] of [
    ['explicit database schema', { promptText: `${fixture.promptText}\n同时修改数据库 schema 并新增索引。` }],
    ['SQL request', { promptText: `${fixture.promptText}\n同时修改 SQL 查询。` }],
    ['ambiguous unqualified schema remains conservative', { promptText: '修改 schema 并补齐测试。' }],
    ['migration ownership', { ownedPaths: [...fixture.proposal.ownedPaths, 'forge-server/db/migration/V202610090001__report.sql'] }],
    ['declared database responsibility', { taskProfiles: [...fixture.proposal.taskProfiles, 'database'] }],
  ]) await t.test(name, () => {
    const contract = compileProposal(overrides);
    assert.ok(contract.taskProfiles.includes('database'), name);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'), name);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  });
});

test('compiles a complete CRUD contract with exact domain skills and real verification profiles', () => {
  const contract = compile();
  assert.deepEqual(contract.taskProfiles, [
    'migration', 'database', 'backend', 'crud', 'dictionary', 'frontend-admin', 'security',
  ]);
  assert.deepEqual(contract.requiredSkills, [
    'forge-task-contract',
    'forge-task-router',
    'forge-change-design',
    'forge-database-migration',
    'forge-backend-architecture',
    'forge-crud-production',
    'forge-frontend-admin',
    'forge-dictionary-contract',
    'forge-security-tenancy-permission',
    'forge-testing-observability',
    'forge-evidence-truth',
  ]);
  assert.ok(!contract.requiredSkills.some((name) => /domain|任一/iu.test(name)));
  assert.ok(contract.requiredObligations.includes('stable-dictionary-code-contract'));
  assert.ok(contract.semanticOwners.includes('dictionary-code-contract'));
  assert.deepEqual(contract.requiredVerificationProfiles, [
    'governance',
    'backend-module-test',
    'frontend-admin-lint',
    'frontend-admin-test',
  ]);
  assert.deepEqual(contract.requiredRedProfiles, ['backend-red-test', 'frontend-red-test']);
  assert.equal(contract.tddRequired, true);
  assert.equal(contract.actionCeiling, 'test');
  assert.match(contract.contractId, /^[0-9a-f]{64}$/u);
  assert.match(contract.sourceFingerprint, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(contract));
  assert.doesNotThrow(() => JSON.stringify(contract));
});

test('backend dictionary changes retain semantics without requiring frontend or global verification', () => {
  const contract = compile({
    prompt: '修复供应商准入等级字典与状态码回显。',
    ownedPaths: ['forge-server/forge-modules/forge-system/src/main/java/DictionaryService.java'],
    actionCeiling: 'test',
  });
  assert.ok(contract.taskProfiles.includes('dictionary'));
  assert.ok(contract.requiredSkills.includes('forge-dictionary-contract'));
  assert.ok(contract.requiredObligations.includes('stable-dictionary-code-contract'));
  assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'));
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'backend-module-test']);
});

test('behavior suite required Skills exactly match the deterministic pathless task intent', async () => {
  const suiteRoot = new URL('./fixtures/forge-harness-behavior-evals/', import.meta.url);
  const suite = JSON.parse(await readFile(new URL('suite.json', suiteRoot), 'utf8'));
  for (const behaviorCase of suite.cases) {
    // This case is intentionally bound by its explicit frontend-only test-shadow
    // writer route. Its broad acceptance prose must not re-expand that route into
    // a CRUD/backend contract through prompt keyword inference.
    if (behaviorCase.id === 'frontend-aicrudpage-api-contract') continue;
    const prompt = await readFile(new URL(behaviorCase.prompt, suiteRoot), 'utf8');
    const intent = deriveForgeTaskIntent({ prompt, actionCeiling: 'workspace-write' });
    assert.deepEqual(
      [...behaviorCase.expectedTrace.skillCallsAll].sort(),
      [...intent.requiredSkills].sort(),
      behaviorCase.id,
    );
  }
});

test('frontend admin tasks default to changed lint and related tests without full typecheck or build', () => {
  const contract = compile({
    prompt: 'Implement the approved Forge Admin page.',
    ownedPaths: ['forge-admin-ui/src/views/device/index.vue'],
    actionCeiling: 'test',
  });
  assert.deepEqual(contract.requiredVerificationProfiles, [
    'governance', 'frontend-admin-lint', 'frontend-admin-test',
  ]);
  assert.ok(!contract.requiredVerificationProfiles.some((profile) => /browser|a11y/iu.test(profile)));
});

const ordinaryToolInput = {
  prompt: '修复前端工具函数及对应测试，不修改页面。',
  ownedPaths: ['forge-admin-ui/src/utils/label.ts', 'forge-admin-ui/src/utils/label.test.ts'],
  actionCeiling: 'release',
  taskProfiles: ['frontend-admin'],
};
const ordinaryConversationOptions = { independentReview: 'suspended', verificationScope: 'changed' };
const uiObligations = ['loading-empty-error-and-busy-states', 'responsive-keyboard-and-browser-review'];

test('ordinary tool contracts omit inapplicable UI and suspended test-first gates while retaining final checks', () => {
  const contract = compileForgeTaskExecutionContract(ordinaryToolInput, ordinaryConversationOptions);
  for (const id of [...uiObligations, 'test-first']) assert.ok(!contract.requiredObligations.includes(id), id);
  assert.equal(contract.tddRequired, false);
  assert.deepEqual(contract.requiredRedProfiles, []);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.ok(contract.requiredObligations.includes('final-verification'));
  assert.ok(contract.requiredObligations.includes('controlled-release-only'));
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
});

test('ordinary page and uncertain directory scopes retain UI requirements without reintroducing test-first order', () => {
  for (const ownedPaths of [
    ['forge-admin-ui/src/views/example.vue'],
    ['forge-admin-ui/src/components/example.tsx'],
    ['forge-admin-ui/src/utils'],
    [...ordinaryToolInput.ownedPaths, 'forge-admin-ui/src/views/example.vue'],
  ]) {
    const contract = compileForgeTaskExecutionContract({ ...ordinaryToolInput, ownedPaths }, ordinaryConversationOptions);
    for (const id of uiObligations) assert.ok(contract.requiredObligations.includes(id), `${ownedPaths}: ${id}`);
    assert.ok(!contract.requiredObligations.includes('test-first'));
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  }
});

test('ordinary scoped obligations preserve legacy and phase contracts and reject selectively removed proof', () => {
  const rehash = value => {
    const { contractId, ...payload } = value;
    return { ...value, contractId: createHash('sha256').update(canonicalStringify(payload)).digest('hex') };
  };
  for (const options of [{}, { independentReview: 'suspended' }, { verificationScope: 'changed' }]) {
    const historical = compileForgeTaskExecutionContract(ordinaryToolInput, options);
    for (const id of [...uiObligations, 'test-first']) assert.ok(historical.requiredObligations.includes(id), id);
    assert.equal(historical.tddRequired, true);
    assert.deepEqual(validateForgeTaskExecutionContract(historical), historical);
  }
  // The pre-fix ordinary contract used changed technical profiles with the old
  // UI and TDD requirements. Its original content and identity stay readable.
  const historical = rehash({
    ...compileForgeTaskExecutionContract(ordinaryToolInput, { independentReview: 'suspended' }),
    requiredVerificationProfiles: ['governance', 'frontend-admin-lint', 'frontend-admin-test'],
  });
  assert.deepEqual(validateForgeTaskExecutionContract(historical), historical);
  const current = compileForgeTaskExecutionContract(ordinaryToolInput, ordinaryConversationOptions);
  expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(rehash({
    ...current, requiredObligations: current.requiredObligations.filter(id => id !== 'final-verification'),
  })));
  expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(rehash({
    ...current, tddRequired: true,
  })));
  expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(rehash({
    ...current, requiredVerificationProfiles: compileForgeTaskExecutionContract(ordinaryToolInput).requiredVerificationProfiles,
  })));
});

test('capable file-scoped backend tasks require class checks without rewriting historical module contracts', () => {
  const ownedPaths = [
    'forge-server/forge-business/core/src/main/java/example/Mapper.java',
    'forge-server/forge-business/core/src/test/java/example/MapperTest.java',
    'forge-admin-ui/src/utils/label.js',
    'forge-admin-ui/src/utils/label.test.js',
  ];
  const input = { prompt: '修改这两个工具，只检查对应测试。', ownedPaths, actionCeiling: 'release' };
  const current = compileForgeTaskExecutionContract(input, { verificationScope: 'changed', focusedBackendVerification: true });
  assert.deepEqual(current.requiredVerificationProfiles, ['governance', 'backend-test-class', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.deepEqual(validateForgeTaskExecutionContract(current), current);
  assert.equal(verificationScopeForContract(current), 'changed');
  assert.deepEqual(backendTestSelectorsForOwnedPaths(ownedPaths), {
    modules: ['forge-server/forge-business/core'], tests: ['example.MapperTest'],
  });
  for (const options of [{ verificationScope: 'changed' }, { verificationScope: 'legacy', focusedBackendVerification: true }]) {
    const historical = compileForgeTaskExecutionContract(input, options);
    assert.ok(historical.requiredVerificationProfiles.includes('backend-module-test'));
    assert.ok(!historical.requiredVerificationProfiles.includes('backend-test-class'));
    assert.deepEqual(validateForgeTaskExecutionContract(historical), historical);
  }
  for (const paths of [
    ['forge-server/forge-business/core'],
    [ownedPaths[0]],
    [ownedPaths[1], 'forge-server/other/src/main/java/Other.java'],
    [ownedPaths[0], ownedPaths[1], 'forge-server/forge-business/core/pom.xml'],
  ]) assert.equal(backendTestSelectorsForOwnedPaths(paths), null);
});

test('backend test specification stays source-bound without expanding an exact class to module verification', () => {
  const module = 'forge-server/forge-admin-server';
  const java = `${module}/src/test/java/com/mdframe/forge/business/core/eqrepair/EqRepairLedgerIdorCrossTenantIntegrationTest.java`;
  const spec = `${module}/src/test/resources/coverage-idor-cross-tenant/spec.md`;
  const input = { prompt: '继续同一 IDOR 测试类及其说明的精确验证。', taskProfiles: ['backend', 'security'],
    ownedPaths: [java, spec], actionCeiling: 'workspace-write' };
  const current = compileForgeTaskExecutionContract(input, { verificationScope: 'changed', focusedBackendVerification: true });
  assert.deepEqual(current.requiredVerificationProfiles, ['governance', 'backend-test-class']);
  assert.deepEqual(current.ownedPaths, [java, spec]);
  assert.deepEqual(validateForgeTaskExecutionContract(current), current);
  assert.deepEqual(backendTestSelectorsForOwnedPaths(current.ownedPaths), {
    modules: [module], tests: ['com.mdframe.forge.business.core.eqrepair.EqRepairLedgerIdorCrossTenantIntegrationTest'],
  });
  const historical = compileForgeTaskExecutionContract(input);
  assert.ok(historical.requiredVerificationProfiles.includes('backend-module-test'));
  assert.deepEqual(validateForgeTaskExecutionContract(historical), historical);
});

test('backend test specification does not hide resource configuration or an untested module', () => {
  const module = 'forge-server/forge-admin-server';
  const java = `${module}/src/test/java/example/IsolationTest.java`;
  for (const paths of [
    [`${module}/src/test/resources/coverage-idor/spec.md`],
    [java, 'forge-server/other/src/test/resources/coverage-idor/spec.md'],
    [java, `${module}/src/test/resources/application.yml`],
    [java, `${module}/src/test/resources/schema.sql`],
    [java, `${module}/src/main/resources/spec.md`],
    [java, `${module}/src/test/resources/../spec.md`],
    [java, `${module}/pom.xml`],
  ]) assert.equal(backendTestSelectorsForOwnedPaths(paths), null);
});

test('scoped defaults also apply to checkpoint and release while exact historical contracts remain readable', () => {
  for (const actionCeiling of ['workspace-write', 'test', 'git-checkpoint', 'release']) {
    const contract = compile({ actionCeiling });
    assert.deepEqual(contract.requiredVerificationProfiles, [
      'governance', 'backend-module-test', 'frontend-admin-lint', 'frontend-admin-test',
    ]);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
    const historical = { ...contract, requiredVerificationProfiles: [
      'governance', 'backend-module-test', 'frontend-admin-lint', 'frontend-admin-test',
      'frontend-admin-typecheck', 'frontend-admin-build', 'changed-safe', 'full-regression',
    ] };
    const rehash = value => {
      const { contractId, ...payload } = value;
      return { ...value, contractId: createHash('sha256').update(canonicalStringify(payload)).digest('hex') };
    };
    assert.deepEqual(validateForgeTaskExecutionContract(rehash(historical)), rehash(historical));
    expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(rehash({
      ...contract, requiredVerificationProfiles: ['governance'],
    })));
  }
});

test('classifies migration, database, backend, security, workflow, and shared owner from paths', () => {
  const contract = compile({
    prompt: 'Implement the reviewed change.',
    ownedPaths: [
      'forge-server/db/migration/V202609010002__approval.sql',
      'forge-server/forge-framework/forge-starter-parent/src/main/java/SharedTenantGuard.java',
      'forge-server/forge-modules/forge-flow/src/main/resources/workflow/approval.bpmn20.xml',
      'forge-server/forge-modules/forge-system/src/main/java/security/TenantPermission.java',
    ],
    actionCeiling: 'workspace-write',
  });
  assert.deepEqual(contract.taskProfiles, [
    'migration', 'database', 'backend', 'security', 'workflow', 'shared-owner',
  ]);
  assert.ok(contract.requiredSkills.includes('forge-workflow-production'));
  assert.ok(contract.requiredObligations.includes('unique-semantic-owner'));
  assert.ok(contract.requiredObligations.includes('tenant-and-permission-fail-closed'));
  assert.deepEqual(contract.semanticOwners, [
    'database-migration-history',
    'database-schema-and-persistence',
    'backend-module-contract',
    'security-tenancy-and-permission',
    'workflow-state-machine',
    'shared-contract',
  ]);
});

test('read-only review accepts an unknown safe path without source-change skills', () => {
  const contract = compile({
    prompt: 'Review this vendor reference and report findings only.',
    ownedPaths: ['vendor/reference/feature.txt'],
    actionCeiling: 'read-only',
  });
  assert.deepEqual(contract.taskProfiles, ['read-only-review']);
  assert.equal(contract.tddRequired, false);
  assert.deepEqual(contract.requiredVerificationProfiles, []);
  assert.ok(!contract.requiredSkills.includes('forge-change-design'));
  assert.ok(!contract.requiredSkills.includes('forge-testing-observability'));
  assert.ok(!contract.requiredSkills.includes('forge-git-checkpoint'));
  assert.ok(!contract.requiredSkills.includes('forge-controlled-release'));
  assert.doesNotThrow(() => validateForgeTaskExecutionContract(contract));
});

test('explicit profiles make test-only ownership precise without accepting an unknown profile', () => {
  const contract = compile({
    prompt: 'Add the approved regression test.',
    ownedPaths: ['tests/device-permission.test.mjs'],
    actionCeiling: 'test',
    taskProfiles: ['security', 'backend'],
  });
  assert.deepEqual(contract.taskProfiles, ['backend', 'security']);
  assert.ok(contract.requiredSkills.includes('forge-backend-architecture'));
  assert.ok(contract.requiredSkills.includes('forge-security-tenancy-permission'));
  expectCode('CONTRACT_TASK_PROFILE_UNKNOWN', () => compile({
    prompt: 'Add a regression test.',
    ownedPaths: ['tests/unknown.test.mjs'],
    actionCeiling: 'test',
    taskProfiles: ['any-domain-skill'],
  }));
});

test('write-capable contracts fail closed for unknown paths and unknown task types', () => {
  expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compile({
    prompt: 'Implement backend behavior.',
    ownedPaths: ['unclassified-zone/handler.java'],
    actionCeiling: 'workspace-write',
  }));
  expectCode('CONTRACT_TASK_PROFILE_UNKNOWN', () => compile({
    prompt: 'Update the approved regression fixture.',
    ownedPaths: ['tests/regression-fixture.txt'],
    actionCeiling: 'workspace-write',
  }));
  for (const unsupportedPath of [
    'forge-h5-ui/package.json',
    'forge-report-ui/src/views/report.vue',
    'pnpm-lock.yaml',
  ]) {
    expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compile({
      prompt: 'Update this frontend source with complete verification.',
      ownedPaths: [unsupportedPath],
      actionCeiling: 'workspace-write',
    }));
  }
});

test('a configured change Spec is an exact owned file without creating a task profile or directory scope', () => {
  const spec = 'code-copilot/changes/customer-qualification-archive/spec.md';
  const contract = compile({
    prompt: 'Implement the approved backend change.',
    ownedPaths: [spec],
    actionCeiling: 'workspace-write',
    taskProfiles: ['backend'],
  });
  assert.deepEqual(contract.taskProfiles, ['backend']);
  assert.deepEqual(contract.ownedPaths, [spec]);
  assert.equal(isForgeRequiredChangeSpecPath(spec), true);
  assert.equal(isForgeTaskOwnedPath(spec, spec), true);
  assert.equal(isForgeTaskOwnedPath(`${spec}/script.sh`, spec), false);
  assert.equal(isForgeTaskOwnedPath('forge-server/example/Child.java', 'forge-server/example'), true);
  for (const unsupported of [
    'code-copilot/changes/customer-qualification-archive',
    'code-copilot/changes/customer-qualification-archive/scripts/setup.sh',
    'code-copilot/changes/Customer Qualification/spec.md',
  ]) {
    expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compile({
      prompt: 'Implement the approved backend change.',
      ownedPaths: [unsupported],
      actionCeiling: 'workspace-write',
      taskProfiles: ['backend'],
    }));
  }
});

test('frontend format maintenance removes only test-first requirements and retains domain verification', () => {
  const input = {
    prompt: '本次只修复已有 lint 格式问题，保持业务行为不变。',
    ownedPaths: ['forge-admin-ui/src/views/security/SecurityListPage.vue'],
    actionCeiling: 'workspace-write',
    taskProfiles: ['frontend-admin', 'security'],
  };
  const ordinary = compile(input);
  const maintenance = compile({ ...input, taskProfiles: [...input.taskProfiles, 'frontend-format-maintenance'] });
  assert.equal(ordinary.tddRequired, true);
  assert.equal(maintenance.tddRequired, false);
  assert.deepEqual(maintenance.requiredRedProfiles, []);
  assert.deepEqual(maintenance.requiredVerificationProfiles, ordinary.requiredVerificationProfiles);
  assert.deepEqual(maintenance.requiredSkills, ordinary.requiredSkills);
  assert.deepEqual(maintenance.semanticOwners, ordinary.semanticOwners);
  assert.deepEqual(maintenance.requiredObligations, ordinary.requiredObligations.filter((item) => item !== 'test-first'));
  assert.deepEqual(maintenance.ownedPaths, ordinary.ownedPaths);
  assert.deepEqual(maintenance.taskProfiles, [...ordinary.taskProfiles, 'frontend-format-maintenance']);
  assert.notEqual(maintenance.contractId, ordinary.contractId);
  assert.deepEqual(validateForgeTaskExecutionContract(maintenance), maintenance);
});

test('format maintenance must be explicitly selected after trusted classification, never inferred by the compiler', () => {
  const input = {
    prompt: 'Only fix existing lint formatting issues; preserve business behavior.',
    ownedPaths: ['forge-admin-ui/src/views/Example.vue'],
    actionCeiling: 'workspace-write',
  };
  const ordinary = compile(input);
  assert.equal(ordinary.tddRequired, true);
  assert.ok(!ordinary.taskProfiles.includes('frontend-format-maintenance'));
  const selected = compile({ ...input, taskProfiles: ['frontend-admin', 'frontend-format-maintenance'] });
  assert.equal(selected.tddRequired, false);
});

test('server-authorized format maintenance recompiles for continuation and release without repeating the user declaration', () => {
  for (const [prompt, actionCeiling] of [['继续', 'workspace-write'], ['发布', 'release']]) {
    const contract = compile({
      prompt, actionCeiling,
      ownedPaths: ['forge-admin-ui/src/views/Example.vue'],
      taskProfiles: ['frontend-admin', 'frontend-format-maintenance'],
    });
    assert.equal(contract.tddRequired, false);
    assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
    assert.ok(!contract.requiredVerificationProfiles.includes('frontend-admin-build'));
    assert.equal(contract.requiredObligations.includes('controlled-release-only'), actionCeiling === 'release');
  }
});

test('format maintenance cannot authorize directories, manifests, backend files, or mixed scopes', () => {
  for (const ownedPaths of [
    ['forge-admin-ui/src'],
    ['forge-admin-ui/src/views'],
    ['forge-admin-ui/package.json'],
    ['forge-admin-ui/src/package.json'],
    ['forge-admin-ui/vite.config.ts'],
    ['forge-server/src/main/java/Example.java'],
    ['forge-admin-ui/src/views/Example.vue', 'forge-server/src/main/java/Example.java'],
  ]) {
    expectCode('CONTRACT_FORMAT_MAINTENANCE_INVALID', () => compile({
      prompt: '本次只修复已有 lint 格式问题，保持业务行为不变。',
      ownedPaths,
      taskProfiles: ['frontend-admin', 'frontend-format-maintenance'],
    }));
  }
  expectCode('CONTRACT_FORMAT_MAINTENANCE_INVALID', () => compile({
    prompt: '只读查看现有格式问题。', actionCeiling: 'read-only',
    ownedPaths: ['forge-admin-ui/src/views/Example.vue'],
    taskProfiles: ['frontend-admin', 'frontend-format-maintenance'],
  }));
});

test('canonical hashes are stable across path order, slash style, line endings, and Unicode composition', () => {
  const first = compile({
    prompt: '实现 Café 后端接口。\r\n先写测试。',
    ownedPaths: [
      'forge-server/forge-modules/forge-demo/src/test/java/DemoTest.java',
      'forge-server\\forge-modules\\forge-demo\\src\\main\\java\\Demo.java',
    ],
    actionCeiling: 'test',
  });
  const second = compile({
    prompt: '实现 Cafe\u0301 后端接口。\n先写测试。',
    ownedPaths: [
      'forge-server/forge-modules/forge-demo/src/main/java/Demo.java',
      'forge-server/forge-modules/forge-demo/src/test/java/DemoTest.java',
    ],
    actionCeiling: 'test',
  });
  assert.deepEqual(first, second);
  assert.equal(
    first.sourceFingerprint,
    fingerprintForgeTaskExecutionSource({
      prompt: '实现 Cafe\u0301 后端接口。\n先写测试。',
      ownedPaths: [
        'forge-server/forge-modules/forge-demo/src/main/java/Demo.java',
        'forge-server/forge-modules/forge-demo/src/test/java/DemoTest.java',
      ],
      actionCeiling: 'test',
    }),
  );
});

test('phased task contracts accept bounded upstream artifacts and reject prompts over one MiB', () => {
  const boundary = 'x'.repeat(MAX_TASK_CONTRACT_PROMPT_BYTES);
  assert.match(compile({
    prompt: boundary,
    ownedPaths: [],
    actionCeiling: 'read-only',
  }).sourceFingerprint, /^[0-9a-f]{64}$/u);
  expectCode('CONTRACT_PROMPT_INVALID', () => compile({
    prompt: `${boundary}x`,
    ownedPaths: [],
    actionCeiling: 'read-only',
  }));
});

test('prompt or action changes produce a different source fingerprint and contract hash', () => {
  const baseline = compile({
    prompt: 'Implement backend API.',
    ownedPaths: ['forge-server/forge-modules/forge-demo/src/main/java/Demo.java'],
    actionCeiling: 'workspace-write',
  });
  const changedPrompt = compile({
    prompt: 'Implement backend API with tenant permission.',
    ownedPaths: ['forge-server/forge-modules/forge-demo/src/main/java/Demo.java'],
    actionCeiling: 'workspace-write',
  });
  const changedCeiling = compile({
    prompt: 'Implement backend API.',
    ownedPaths: ['forge-server/forge-modules/forge-demo/src/main/java/Demo.java'],
    actionCeiling: 'test',
  });
  assert.notEqual(baseline.sourceFingerprint, changedPrompt.sourceFingerprint);
  assert.notEqual(baseline.contractId, changedPrompt.contractId);
  assert.notEqual(baseline.sourceFingerprint, changedCeiling.sourceFingerprint);
  assert.notEqual(baseline.contractId, changedCeiling.contractId);
});

test('canonicalStringify sorts object keys recursively and rejects non-JSON values', () => {
  assert.equal(
    canonicalStringify({ z: 1, a: { z: false, a: ['x', { b: 2, a: 1 }] } }),
    '{"a":{"a":["x",{"a":1,"b":2}],"z":false},"z":1}',
  );
  expectCode('CONTRACT_NOT_SERIALIZABLE', () => canonicalStringify({ invalid: undefined }));
  expectCode('CONTRACT_NOT_SERIALIZABLE', () => canonicalStringify({ invalid: Number.NaN }));
  const cycle = {};
  cycle.self = cycle;
  expectCode('CONTRACT_NOT_SERIALIZABLE', () => canonicalStringify(cycle));
});

test('validation round-trips serialized contracts and detects any derived-field or hash tampering', () => {
  const serialized = JSON.parse(JSON.stringify(compile()));
  assert.deepEqual(validateForgeTaskExecutionContract(serialized), serialized);

  const elevated = { ...serialized, actionCeiling: 'release' };
  expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(elevated));

  const alteredOwner = { ...serialized, semanticOwners: [...serialized.semanticOwners, 'shared-contract'] };
  expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(alteredOwner));

  const alteredFingerprint = { ...serialized, sourceFingerprint: '0'.repeat(64) };
  expectCode('CONTRACT_HASH_MISMATCH', () => validateForgeTaskExecutionContract(alteredFingerprint));

  const extraField = { ...serialized, authority: 'implicit' };
  expectCode('CONTRACT_UNSUPPORTED_FIELD', () => validateForgeTaskExecutionContract(extraField));
});

test('action ceiling comparison is monotonic and never elevates a contract', () => {
  const contract = compile({
    prompt: 'Implement backend API.',
    ownedPaths: ['forge-server/forge-modules/forge-demo/src/main/java/Demo.java'],
    actionCeiling: 'test',
  });
  assert.equal(isActionWithinCeiling('test', 'read-only'), true);
  assert.equal(isActionWithinCeiling('test', 'workspace-write'), true);
  assert.equal(isActionWithinCeiling('test', 'test'), true);
  assert.equal(isActionWithinCeiling('test', 'git-checkpoint'), false);
  assert.equal(assertActionWithinCeiling(contract, 'workspace-write'), 'workspace-write');
  expectCode('CONTRACT_ACTION_CEILING_EXCEEDED', () => assertActionWithinCeiling(contract, 'release'));
  expectCode('CONTRACT_ACTION_CEILING_INVALID', () => isActionWithinCeiling('admin', 'read-only'));
});

test('git and release skills appear only at their explicit ceilings', () => {
  const base = {
    prompt: 'Implement backend API.',
    ownedPaths: ['forge-server/forge-modules/forge-demo/src/main/java/Demo.java'],
  };
  const write = compile({ ...base, actionCeiling: 'workspace-write' });
  const checkpoint = compile({ ...base, actionCeiling: 'git-checkpoint' });
  const release = compile({ ...base, actionCeiling: 'release' });
  assert.ok(!write.requiredSkills.includes('forge-git-checkpoint'));
  assert.ok(!write.requiredSkills.includes('forge-controlled-release'));
  assert.ok(checkpoint.requiredSkills.includes('forge-git-checkpoint'));
  assert.ok(!checkpoint.requiredSkills.includes('forge-controlled-release'));
  assert.ok(release.requiredSkills.includes('forge-git-checkpoint'));
  assert.ok(release.requiredSkills.includes('forge-controlled-release'));
  assert.equal(checkpoint.actionCeiling, 'git-checkpoint');
  assert.equal(release.actionCeiling, 'release');
});

test('rejects traversal, absolute, UNC, ADS, ambiguous, and duplicate owned paths', () => {
  const invalid = [
    '../forge-server/Demo.java',
    'forge-server/../Demo.java',
    '/forge-server/Demo.java',
    'C:\\repo\\forge-server\\Demo.java',
    '\\\\server\\share\\Demo.java',
    'forge-server//Demo.java',
    'forge-server/./Demo.java',
    'forge-server/Demo.java:stream',
  ];
  for (const ownedPath of invalid) {
    assert.throws(() => compile({
      prompt: 'Implement backend API.',
      ownedPaths: [ownedPath],
      actionCeiling: 'workspace-write',
    }), ForgeTaskContractError, ownedPath);
  }
  expectCode('CONTRACT_PATH_DUPLICATE', () => compile({
    prompt: 'Implement backend API.',
    ownedPaths: ['forge-server/Demo.java', 'FORGE-SERVER/demo.java'],
    actionCeiling: 'workspace-write',
  }));
});

test('read-only profile cannot be combined with a write ceiling', () => {
  expectCode('CONTRACT_PROFILE_ACTION_CONFLICT', () => compile({
    prompt: 'Review backend API.',
    ownedPaths: ['forge-server/forge-modules/forge-demo/src/main/java/Demo.java'],
    actionCeiling: 'workspace-write',
    taskProfiles: ['backend', 'read-only-review'],
  }));
});


test('H5 focused test obligation is confined to actual owned JS test files', () => {
  const make = ownedPaths => compile({ prompt: '修复移动端显示并测试。', taskProfiles: ['shared-owner'], ownedPaths });
  const withTest = make(['forge-h5-ui/src/utils/display.js','forge-h5-ui/src/utils/display.test.js']);
  assert.deepEqual(withTest.requiredVerificationProfiles, ['governance','frontend-h5-test','frontend-h5-build']);
  assert.deepEqual(validateForgeTaskExecutionContract(withTest), withTest);
  for (const file of ['forge-h5-ui/src/utils/display.js','forge-h5-ui/src/pages/index.vue','forge-h5-ui/src/locales/tests-helper.js']) {
    assert.deepEqual(make([file]).requiredVerificationProfiles, ['governance','frontend-h5-build']);
  }
});
