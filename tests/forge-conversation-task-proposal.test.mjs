import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { compileConversationTaskProposal, conversationWriterScopeOwnsPath, isCurrentProjectWriterScope } from '../docker/harness/forge-conversation-task-proposal.mjs';
import {
  canonicalStringify,
  compileForgeTaskExecutionContract,
  deriveForgeTaskIntent,
  validateForgeTaskExecutionContract,
} from '../docker/harness/forge-task-execution-contract.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const projectFilesScope = { taskProfile: 'project-files', scopeRoot: 'current-project', ownedPaths: [] };

test('project files trusted current-project scope keeps exact task ownership and per-request profiles', () => {
  const input = { writerScopes: [projectFilesScope], proposal: {
    goal: '创建独立 HTML 文件。', ownedPaths: ['static/demo/index.html'], taskProfiles: ['project-files'],
    references: [{ path: 'README.md', sha256: HASH_A }],
  } };
  const compiled = compileConversationTaskProposal(input, { independentReview: 'suspended', verificationScope: 'changed' });
  assert.deepEqual(compiled.contract.ownedPaths, ['static/demo/index.html']);
  assert.deepEqual(compiled.contract.requiredVerificationProfiles, ['governance']);
  assert.equal(compiled.contract.scopeRoot, undefined);
  assert.ok(isCurrentProjectWriterScope(projectFilesScope));
  assert.ok(conversationWriterScopeOwnsPath(projectFilesScope, 'static/demo/index.html'));
  assert.deepEqual(validateForgeTaskExecutionContract(compiled.contract), compiled.contract);
  const next = compileConversationTaskProposal({ ...input, proposal: { ...input.proposal,
    goal: '更新 Java 文件。', ownedPaths: ['forge-server/example/src/main/java/Example.java'] } },
  { independentReview: 'suspended', verificationScope: 'changed' });
  assert.deepEqual(next.contract.ownedPaths, ['forge-server/example/src/main/java/Example.java']);
  assert.ok(next.contract.requiredVerificationProfiles.includes('backend-module-test'));
  assert.deepEqual(projectFilesScope.ownedPaths, []);
  assert.throws(() => compileConversationTaskProposal({ ...input, writerScopes: [] }));
  assert.throws(() => compileConversationTaskProposal({ ...input, proposal: { ...input.proposal, scopeRoot: 'current-project' } }));
  assert.throws(() => compileConversationTaskProposal({ ...input,
    writerScopes: [{ ...projectFilesScope, scopeRoot: 'server' }] }));
  assert.throws(() => compileConversationTaskProposal({ ...input,
    writerScopes: [{ ...projectFilesScope, ownedPaths: ['static'] }] }));
});

test('project files preserve sensitive and traversal boundaries and scoped alternatives', () => {
  const input = { writerScopes: [projectFilesScope], proposal: {
    goal: '更新普通项目文件。', ownedPaths: ['static/demo/index.html'], taskProfiles: ['project-files'],
    references: [{ path: 'README.md', sha256: HASH_A }],
  } };
  for (const file of ['.', '*', '../index.html', '/project-inputs/index.html', 'C:/temp/index.html',
    '.env', '.git/config', 'nested/.git/config', '.forge-state/data.json', 'nested/.forge-context/data.json']) {
    assert.equal(conversationWriterScopeOwnsPath(projectFilesScope, file), false, file);
    assert.throws(() => compileConversationTaskProposal({ ...input, proposal: { ...input.proposal, ownedPaths: [file] } }), undefined, file);
  }
  const scoped = { ...input, writerScopes: [{ taskProfile: 'project-files', ownedPaths: ['static'] }] };
  assert.deepEqual(compileConversationTaskProposal(scoped).contract.ownedPaths, ['static/demo/index.html']);
  assert.throws(() => compileConversationTaskProposal({ ...scoped,
    proposal: { ...input.proposal, ownedPaths: ['docs/notes.md'] } }));
});

const paths = Object.freeze({
  page: 'forge-admin-ui/src/views/security/index.vue',
  migration: 'forge-server/db/migration/V1.0.200__add_security_menu.sql',
  test: 'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/security/SecurityMenuMigrationTest.java',
});

const matchingScopes = Object.freeze([
  { taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] },
  { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
  {
    taskProfile: 'backend',
    ownedPaths: ['forge-server/forge-business/forge-business-core/src/test/java'],
  },
]);

function proposal(overrides = {}) {
  return {
    goal: '在领导引领力后增加安保导航，并提供可进入的落地页。',
    ownedPaths: [paths.page, paths.migration, paths.test],
    taskProfiles: ['frontend-admin'],
    references: [
      { path: 'forge-admin-ui/src/router/index.ts', sha256: HASH_A },
      { path: 'forge-server/db/migration/V1.0.199__leadership_menu.sql', sha256: HASH_B },
    ],
    ...overrides,
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test('admin Docker packaging proposal requires its exact configured writer scope', () => {
  const file = 'docker-forge-admin/Dockerfile.admin';
  const input = { proposal: proposal({ goal: '修复 Admin 镜像打包资源接线。',
    ownedPaths: [file], taskProfiles: ['backend'], references: [{ path: file, sha256: HASH_A }] }),
  writerScopes: [{ taskProfile: 'backend', ownedPaths: [file] }] };
  const compiled = compileConversationTaskProposal(input);
  assert.deepEqual(compiled.contract.ownedPaths, [file]);
  assert.deepEqual(compiled.contract.taskProfiles, ['backend']);
  assert.deepEqual(validateForgeTaskExecutionContract(compiled.contract), compiled.contract);
  expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({ ...input, writerScopes: matchingScopes }));
  expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({ ...input, writerScopes: [] }));
  expectCode('CONTRACT_UNKNOWN_WRITE_PATH', () => compileConversationTaskProposal({ ...input,
    proposal: { ...input.proposal, ownedPaths: ['docker-forge-admin/Dockerfile.app'] } }));
});

test('dual review proposal binds a hashed contract and adds an unsuspendable semantic obligation', () => {
  const sourcePath = 'forge-admin-ui/review-contract.json';
  const value = { proposal: proposal({ ownedPaths: [paths.page], taskProfiles: ['frontend-admin'],
    reviewContractSource: sourcePath, references: [{ path: sourcePath, sha256: HASH_A }] }), writerScopes: matchingScopes };
  const options = { independentReview: 'suspended', verificationScope: 'changed' };
  const result = compileConversationTaskProposal(value, options);
  assert.deepEqual(result.contract.dualReview, { sourcePath, sha256: HASH_A });
  assert.ok(result.contract.requiredObligations.includes('spec-and-quality-review'));
  assert.ok(!result.contract.suspendedReviewObligations.includes('spec-and-quality-review'));
  assert.deepEqual(validateForgeTaskExecutionContract(result.contract), result.contract);
  const plain = structuredClone(value); delete plain.proposal.reviewContractSource;
  const ordinary = compileConversationTaskProposal(plain, options);
  assert.equal(ordinary.contract.dualReview, undefined);
  assert.deepEqual(result.contract.requiredVerificationProfiles, ordinary.contract.requiredVerificationProfiles);
  assert.deepEqual(result.contract.requiredObligations.filter(id => id !== 'spec-and-quality-review'), ordinary.contract.requiredObligations);
  const changed = structuredClone(value); changed.proposal.references[0].sha256 = HASH_B;
  assert.notEqual(compileConversationTaskProposal(changed, options).contract.contractId, result.contract.contractId);
  const missing = structuredClone(value); missing.proposal.reviewContractSource = 'forge-admin-ui/unread.json';
  expectCode('CONVERSATION_REVIEW_REFERENCE_INVALID', () => compileConversationTaskProposal(missing, options));
  const dropped = structuredClone(result.contract); dropped.requiredObligations = dropped.requiredObligations.filter(id => id !== 'spec-and-quality-review');
  expectCode('CONTRACT_DERIVATION_MISMATCH', () => validateForgeTaskExecutionContract(dropped));
});

test('H5 password API followup remains one exact shared consumer with real H5 verification', () => {
  const file = 'forge-h5-ui/src/api/index.js';
  const value = { proposal: proposal({ goal: '修复改密请求的现有移动端消费者并发布。', ownedPaths: [file], taskProfiles: ['shared-owner'], references: [{ path: file, sha256: HASH_A }] }), writerScopes: [{ taskProfile: 'shared-owner', ownedPaths: [file] }] };
  const result = compileConversationTaskProposal(value);
  assert.deepEqual(result.contract.ownedPaths, [file]);
  assert.ok(result.contract.requiredVerificationProfiles.includes('frontend-h5-build'));
  assert.deepEqual(validateForgeTaskExecutionContract(result.contract), result.contract);
  expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({ ...value, writerScopes: matchingScopes }));
});

test('completed archive persistence context does not widen a frontend layout proposal', () => {
  const promptText = '上一个密码接口验证任务已经完成，保留其结果。现在切换到一个独立的前端方案准备任务：第一批安保档案的编辑、刷新持久化已经完成，这句话只是说明已完成的历史工作。本轮想把安保档案页面现有的导出按钮放到查询区右侧，并调整该按钮与查询按钮的间距。只涉及已有前端页面的布局，不改变导出接口、数据结构或业务流程。请先通过平台正常任务准备入口形成这次改动的具体范围和必要检查清单，并给出简短方案。本轮只完成方案和范围准备，不实际修改任何文件，不运行测试或构建，不提交、不发布；方案准备完成就直接结束。';
  const ownedPaths = [
    'forge-admin-ui/src/components/ai-form/AiCrudPage.vue',
    'forge-admin-ui/src/components/ai-form/AiCrudPageProps.js',
    'forge-admin-ui/src/views/security/components/SecurityArchivePage.vue',
    'forge-admin-ui/src/views/security/__tests__/security-archive-page.test.js',
  ];
  const input = { promptText, writerScopes: matchingScopes,
    proposal: proposal({ goal: '仅准备安保档案页面导出按钮布局调整方案。', ownedPaths,
      taskProfiles: ['frontend-admin'], references: [{ path: 'forge-admin-ui/src/components/ai-form/AiSearch.vue', sha256: HASH_A }] }) };
  const compiled = compileConversationTaskProposal(input);
  assert.deepEqual(compiled.contract.taskProfiles, ['frontend-admin']);
  assert.ok(compiled.contract.requiredVerificationProfiles.every(profile =>
    profile === 'governance' || profile.startsWith('frontend-admin-')));
  assert.deepEqual(validateForgeTaskExecutionContract(compiled.contract), compiled.contract);
  const currentDatabaseWork = compileConversationTaskProposal({ ...input,
    promptText: promptText + '同时需要修改数据库索引。' });
  assert.ok(currentDatabaseWork.contract.taskProfiles.includes('database'));
  const mixedSentence = compileConversationTaskProposal({ ...input,
    promptText: '前情：第一批持久化已经完成，但本轮还需修改数据库索引。' });
  assert.ok(mixedSentence.contract.taskProfiles.includes('database'));
  const actualPermissionChange = compileConversationTaskProposal({ ...input,
    promptText: promptText + '本轮还需要调整导出权限。' });
  assert.ok(actualPermissionChange.contract.taskProfiles.includes('security'));
  for (const relative of [
    'forge-admin-ui/src/security/permission.js',
    'forge-admin-ui/src/views/security/permission/index.vue',
    'forge-admin-ui/src/views/auth/index.vue',
  ]) {
    const secured = compileConversationTaskProposal({ ...input,
      proposal: { ...input.proposal, ownedPaths: [relative] } });
    assert.ok(secured.contract.taskProfiles.includes('security'), relative);
  }
});

test('recorded Health frontend request keeps menu SQL references outside backend verification scope', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/frontend-health-ui-task-proposal.json', import.meta.url), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(fixture.promptText).digest('hex'), fixture.promptTextSha256);
  assert.deepEqual(fixture.proposal.taskProfiles, ['frontend-admin']);
  assert.equal(fixture.proposal.ownedPaths.length, 6);
  const compiled = compileConversationTaskProposal({ promptText: fixture.promptText,
    proposal: fixture.proposal, writerScopes: [matchingScopes[0]] },
  { verificationScope: 'changed', independentReview: 'suspended' });
  assert.deepEqual(compiled.contract.taskProfiles, ['crud', 'dictionary', 'frontend-admin', 'security', 'shared-owner']);
  assert.deepEqual(compiled.contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.ok(compiled.contract.requiredObligations.includes('security-negative-tests'));
  assert.ok(compiled.contract.requiredObligations.includes('dual-consumer-contract-tests'));
  assert.deepEqual(validateForgeTaskExecutionContract(compiled.contract), compiled.contract);
});

test('frontend database-context filtering preserves explicit database intent and owned backend changes', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/frontend-health-ui-task-proposal.json', import.meta.url), 'utf8'));
  const input = { promptText: fixture.promptText, proposal: fixture.proposal, writerScopes: matchingScopes };
  const options = { verificationScope: 'changed', independentReview: 'suspended' };
  const declared = compileConversationTaskProposal({ ...input,
    proposal: { ...input.proposal, taskProfiles: ['frontend-admin', 'database'] } }, options);
  assert.ok(declared.contract.requiredVerificationProfiles.includes('backend-module-test'));
  for (const extra of ['本轮还需修改数据库索引。', '本轮需要给数据库增加索引。', 'Create a database index for the query.']) {
    const requested = compileConversationTaskProposal({ ...input, promptText: input.promptText + '\n' + extra }, options);
    assert.ok(requested.contract.taskProfiles.includes('database'));
    assert.ok(requested.contract.requiredVerificationProfiles.includes('backend-module-test'));
  }
  const excluded = compileConversationTaskProposal({ ...input,
    promptText: input.promptText + '\n本次不要修改数据库索引。' }, options);
  assert.ok(!excluded.contract.requiredVerificationProfiles.includes('backend-module-test'));
  for (const file of [paths.migration, paths.test]) {
    const owned = compileConversationTaskProposal({ ...input,
      proposal: { ...input.proposal, ownedPaths: [...input.proposal.ownedPaths, file] } }, options);
    assert.ok(owned.contract.requiredVerificationProfiles.includes('backend-module-test'));
  }
});

function securityFrontendProposal(overrides = {}) {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/frontend-security-ui-task-proposal.json', import.meta.url), 'utf8'));
  return { promptText: fixture.promptText, actionCeiling: 'release',
    proposal: fixture.proposal, writerScopes: matchingScopes, ...overrides };
}

const securityFrontendOptions = { verificationScope: 'changed', independentReview: 'suspended' };

test('recorded Security frontend request keeps consumer context and excluded checks out of task profiles', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/frontend-security-ui-task-proposal.json', import.meta.url), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(fixture.promptText).digest('hex'), '8da2c72e82e52f715e0fa8ab427b339d84fbbe57bf36dae9501d4b947fc73849');
  assert.deepEqual(fixture.proposal.taskProfiles, fixture.originalProposal.taskProfiles);
  assert.deepEqual(fixture.proposal.ownedPaths, fixture.originalProposal.ownedPaths);
  assert.equal(fixture.proposal.goal, fixture.originalProposal.goal);
  assert.deepEqual(fixture.proposal.references.map(ref => ref.path), fixture.originalProposal.references);
  const { contract } = compileConversationTaskProposal(securityFrontendProposal(), securityFrontendOptions);
  assert.deepEqual(contract.taskProfiles, ['dictionary', 'frontend-admin']);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.ok(contract.suspendedReviewObligations.includes('stable-dictionary-code-contract'));
  assert.ok(!contract.requiredObligations.includes('security-negative-tests'));
  assert.ok(!contract.requiredObligations.includes('dual-consumer-contract-tests'));
  assert.equal(contract.actionCeiling, 'release');
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
});

test('Security frontend excluded checks preserve positive database requests and actual backend paths', () => {
  const base = securityFrontendProposal();
  for (const extra of ['不夹带无关后端/数据库测试，但本轮需要给数据库增加索引。',
    '不要夹带额外数据库检查，同时修改数据库索引。', '本轮执行 SQL 并调整数据库表结构。']) {
    const { contract } = compileConversationTaskProposal({ ...base, promptText: base.promptText + '\n' + extra }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('database'), extra);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'), extra);
  }
  for (const file of [paths.migration, paths.test]) {
    const { contract } = compileConversationTaskProposal({ ...base,
      proposal: { ...base.proposal, ownedPaths: [...base.proposal.ownedPaths, file] } }, securityFrontendOptions);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'), file);
  }
});

test('Security business root scope keeps nested auth and explicit security responsibilities', () => {
  const base = securityFrontendProposal({ promptText: '修复现有业务页面。' });
  for (const file of ['forge-admin-ui/src/views/security', paths.page]) {
    const { contract } = compileConversationTaskProposal({ ...base,
      proposal: { ...base.proposal, ownedPaths: [file] } }, securityFrontendOptions);
    assert.deepEqual(contract.taskProfiles, ['frontend-admin'], file);
  }
  for (const file of ['forge-admin-ui/src/views/security/auth/index.vue',
    'forge-admin-ui/src/views/security/permission/index.vue', 'forge-admin-ui/src/security/permission.js']) {
    const { contract } = compileConversationTaskProposal({ ...base,
      proposal: { ...base.proposal, ownedPaths: [file] } }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('security'), file);
    assert.ok(contract.requiredObligations.includes('security-negative-tests'), file);
  }
  const { contract } = compileConversationTaskProposal({ ...base, promptText: '修复下载权限与租户隔离。' }, securityFrontendOptions);
  assert.ok(contract.taskProfiles.includes('security'));
});

test('Security frontend shared component consumption retains real shared owner changes', () => {
  const base = securityFrontendProposal();
  for (const promptText of ['公共组件不会自动补附件，请修复业务页面接线。',
    '复用现有公共组件显示附件。', '调用已有共享组件完成业务接线。']) {
    const { contract } = compileConversationTaskProposal({ ...base, promptText }, securityFrontendOptions);
    assert.ok(!contract.taskProfiles.includes('shared-owner'), promptText);
  }
  for (const promptText of ['请修改公共组件的下载行为。',
    '复用公共组件并修改公共组件的错误处理。', '公共组件不会自动补附件，但本轮需要修复公共组件。',
    '复用现有公共组件并修改其下载行为。', '公共组件不会自动补附件但本轮需要修复其行为。']) {
    const { contract } = compileConversationTaskProposal({ ...base, promptText }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('shared-owner'), promptText);
    assert.ok(contract.requiredObligations.includes('dual-consumer-contract-tests'), promptText);
  }
  for (const change of [
    { ownedPaths: ['forge-admin-ui/src/components/common/Attachment.vue'] },
    { taskProfiles: ['frontend-admin', 'shared-owner'] },
  ]) {
    const { contract } = compileConversationTaskProposal({ ...base, promptText: '复用公共组件显示附件。',
      proposal: { ...base.proposal, ...change } }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('shared-owner'));
  }
});

test('recorded Leadership frontend request preserves existing permissions without unrelated database scope', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/frontend-leadership-ui-task-proposal.json', import.meta.url), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(fixture.promptText).digest('hex'), 'c440b5413c5d7de975e3e1544918d1669039165316b9847cae2ea65b3cead12d');
  assert.deepEqual(fixture.proposal.taskProfiles, fixture.originalProposal.taskProfiles);
  assert.deepEqual(fixture.proposal.ownedPaths, fixture.originalProposal.ownedPaths);
  assert.equal(fixture.proposal.goal, fixture.originalProposal.goal);
  assert.deepEqual(fixture.proposal.references.map(ref => ref.path), fixture.originalProposal.references);
  const { contract } = compileConversationTaskProposal({ promptText: fixture.promptText,
    actionCeiling: 'release', proposal: fixture.proposal, writerScopes: matchingScopes }, securityFrontendOptions);
  assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.ok(!contract.requiredObligations.includes('security-negative-tests'));
  assert.equal(contract.actionCeiling, 'release');
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
});

test('Leadership permission context and excluded checks retain explicit changes and owned authority paths', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/frontend-leadership-ui-task-proposal.json', import.meta.url), 'utf8'));
  const base = { promptText: fixture.promptText, actionCeiling: 'release', proposal: fixture.proposal, writerScopes: matchingScopes };
  for (const extra of ['前端任务不增加无关后端或数据库测试，但请增加数据库索引。',
    '前端任务不增加无关后端或数据库测试，同时调整数据库表结构。']) {
    const { contract } = compileConversationTaskProposal({ ...base, promptText: base.promptText + '\n' + extra }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('database'), extra);
    assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'), extra);
  }
  for (const extra of ['保留实际状态与权限，同时调整租户隔离。', '保留实际状态与权限并修改权限。',
    '上传必须沿当前文件API和权限形成真实操作，同时修改上传鉴权。']) {
    const { contract } = compileConversationTaskProposal({ ...base, promptText: base.promptText + '\n' + extra }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('security'), extra);
    assert.ok(contract.requiredObligations.includes('security-negative-tests'), extra);
  }
  for (const file of [paths.test, 'forge-admin-ui/src/views/auth/index.vue', 'forge-admin-ui/src/security/permission.js']) {
    const { contract } = compileConversationTaskProposal({ ...base,
      proposal: { ...base.proposal, ownedPaths: [...base.proposal.ownedPaths, file] } }, securityFrontendOptions);
    assert.ok(contract.taskProfiles.includes('security'), file);
    if (file === paths.test) assert.ok(contract.requiredVerificationProfiles.includes('backend-module-test'));
  }
});

test('compiles an exact frontend page, menu migration, and test proposal within matching project scopes', () => {
  const compiled = compileConversationTaskProposal({
    proposal: proposal(),
    writerScopes: matchingScopes,
  });

  assert.equal(compiled.goal, '在领导引领力后增加安保导航，并提供可进入的落地页。');
  assert.deepEqual(compiled.contract.ownedPaths, [paths.page, paths.test, paths.migration].sort());
  assert.equal(compiled.contract.actionCeiling, 'workspace-write');
  assert.ok(compiled.contract.taskProfiles.includes('frontend-admin'));
  assert.ok(compiled.contract.taskProfiles.includes('migration'));
  assert.ok(compiled.contract.taskProfiles.includes('database'));
  assert.ok(compiled.contract.taskProfiles.includes('backend'));
  assert.deepEqual(compiled.references.map((entry) => entry.path), [
    'forge-admin-ui/src/router/index.ts',
    'forge-server/db/migration/V1.0.199__leadership_menu.sql',
  ]);
  const expectedDigest = crypto.createHash('sha256').update(canonicalStringify({
    goal: compiled.goal,
    contract: compiled.contract,
    references: compiled.references,
  }), 'utf8').digest('hex');
  assert.equal(compiled.proposalDigest, expectedDigest);
  assert.ok(Object.isFrozen(compiled));
});

test('a frontend-only project scope reports every concrete denied migration and backend-test path', () => {
  assert.throws(
    () => compileConversationTaskProposal({
      proposal: proposal(),
      writerScopes: [matchingScopes[0]],
    }),
    (error) => {
      assert.equal(error?.code, 'CONVERSATION_TASK_SCOPE_DENIED');
      assert.deepEqual(error.deniedPaths, [paths.test, paths.migration].sort());
      assert.match(error.message, new RegExp(paths.migration.replaceAll('.', '\\.')));
      assert.match(error.message, new RegExp(paths.test.replaceAll('.', '\\.')));
      return true;
    },
  );
});

test('path-derived database obligations cannot be removed by a frontend-only declared profile', () => {
  const compiled = compileConversationTaskProposal({
    proposal: proposal({ taskProfiles: ['frontend-admin'] }),
    writerScopes: matchingScopes,
  });
  assert.ok(compiled.contract.taskProfiles.includes('migration'));
  assert.ok(compiled.contract.taskProfiles.includes('database'));
  assert.ok(compiled.contract.requiredObligations.includes('forward-only-migration'));
  assert.ok(compiled.contract.requiredObligations.includes('immutable-migration-history'));
  assert.ok(compiled.contract.requiredObligations.includes('transaction-index-and-query-review'));
  assert.ok(compiled.contract.requiredRedProfiles.includes('backend-red-test'));
});

test('trusted promptText binds the contract and preserves prompt-derived profiles independently of goal', () => {
  const frontendOnly = proposal({
    goal: '调整现有页面。',
    ownedPaths: [paths.page],
    references: [{ path: 'forge-admin-ui/src/router/index.ts', sha256: HASH_A }],
  });
  const withoutPrompt = compileConversationTaskProposal({
    proposal: frontendOnly,
    writerScopes: [matchingScopes[0]],
  });
  const withPrompt = compileConversationTaskProposal({
    proposal: frontendOnly,
    writerScopes: [matchingScopes[0]],
    promptText: '为安保模块增加权限控制页面。',
  });

  assert.equal(withPrompt.goal, frontendOnly.goal);
  assert.ok(withPrompt.contract.taskProfiles.includes('security'));
  assert.notEqual(withPrompt.contract.sourceFingerprint, withoutPrompt.contract.sourceFingerprint);
  assert.notEqual(withPrompt.proposalDigest, withoutPrompt.proposalDigest);
  assert.deepEqual(withPrompt.contract, compileForgeTaskExecutionContract({
    prompt: '为安保模块增加权限控制页面。',
    actionCeiling: 'workspace-write',
    ownedPaths: withPrompt.contract.ownedPaths,
    taskProfiles: withPrompt.contract.taskProfiles,
  }));
});

test('backend task preparation does not turn page context into a frontend verification scope', () => {
  const backendPath = 'forge-server/forge-business/forge-business-core/src/main/resources/mapper/business/AccidentReportMapper.xml';
  for (const promptText of [
    '修复事故上报审批通过后自动生成调查任务，调查页面会展示结果，本次只修改后端。',
    'Fix the backend task creation consumed by the frontend page; keep the API contract unchanged.',
  ]) {
    const compiled = compileConversationTaskProposal({
      proposal: proposal({ goal: '修复任务生成逻辑。', ownedPaths: [backendPath], taskProfiles: ['backend'] }),
      writerScopes: [{ taskProfile: 'backend', ownedPaths: ['forge-server/forge-business'] }],
      promptText,
    });
    assert.deepEqual(compiled.contract.taskProfiles, ['database', 'backend']);
    assert.deepEqual(compiled.contract.requiredVerificationProfiles, ['governance', 'backend-module-test']);
    assert.deepEqual(compiled.contract.ownedPaths, [backendPath]);
  }
});

test('exact Required Spec proposals retain their declared profile when the prompt supplies no layer', () => {
  const spec = 'code-copilot/changes/customer-qualification-archive/spec.md';
  const promptText = `请继续刚才的范围方案，复用已经读到的资料。仍只提交 ${spec} 这一个文件的任务范围方案，停在待我确认实施，不创建或修改文件，不运行编译测试，不提交或发布，不推进原八阶段。`;
  const compiled = compileConversationTaskProposal({
    promptText,
    proposal: proposal({ goal: '准备客户资质档案的资料范围方案。', ownedPaths: [spec], taskProfiles: ['backend'],
      references: [{ path: 'PROJECT_CONTEXT.md', sha256: HASH_A }] }),
    writerScopes: [{ taskProfile: 'backend', ownedPaths: [spec] }],
  });

  assert.deepEqual(compiled.contract.ownedPaths, [spec]);
  assert.deepEqual(compiled.contract.taskProfiles, ['backend']);
  assert.deepEqual(validateForgeTaskExecutionContract(compiled.contract), compiled.contract);
});

test('exact Required Spec proposals still reject unknown profiles, adjacent paths, and unowned Specs', () => {
  const spec = 'code-copilot/changes/customer-qualification-archive/spec.md';
  const input = {
    promptText: '请先提交这个文件的范围方案，待我确认实施。',
    proposal: proposal({ goal: '准备资料范围方案。', ownedPaths: [spec], taskProfiles: ['backend'],
      references: [{ path: 'PROJECT_CONTEXT.md', sha256: HASH_A }] }),
    writerScopes: [{ taskProfile: 'backend', ownedPaths: [spec] }],
  };
  for (const [code, overrides] of [
    ['CONTRACT_TASK_PROFILE_UNKNOWN', { taskProfiles: ['forge-backend-architecture'] }],
    ['CONTRACT_UNKNOWN_WRITE_PATH', { ownedPaths: [spec + '/child.md'] }],
    ['CONVERSATION_TASK_SCOPE_DENIED', { ownedPaths: ['code-copilot/changes/another-archive/spec.md'] }],
  ]) {
    expectCode(code, () => compileConversationTaskProposal({ ...input,
      proposal: { ...input.proposal, ...overrides } }));
  }
});

test('do-not-refactor Mapper context stays outside a backend-only task at both contract consumers', () => {
  const ownedPaths = [
    'forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/leadership/controller/ArchiveController.java',
    'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/leadership/controller/ArchiveControllerTest.java',
  ];
  const promptText = '领导引领力档案查询在取不到当前租户时返回空列表，容易让用户以为没有数据。请把这个场景改为项目现有的明确业务异常，只改这个查询分支并补相应单类回归测试。不要重构现有 Controller、Mapper、DTO 或分页结构；本次未改的历史治理问题只记录。不改前端、数据库或其他模块。完成修改与必要检查和验收入账即可，不提交、不发布，不用等我再说继续。已有且输入不变的通过结果复用，后台检查完成后自行回收；遇到阻塞给出真实错误及对应任务或回执。';
  const prepare = (prompt, paths = ownedPaths, taskProfiles = ['backend']) => compileConversationTaskProposal({
    promptText: prompt,
    proposal: proposal({ goal: '修复档案查询的租户缺失分支并补单类测试。', ownedPaths: paths,
      taskProfiles, references: [{ path: ownedPaths[0], sha256: HASH_A }] }),
    writerScopes: [{ taskProfile: 'backend', ownedPaths: ['forge-server/forge-business/forge-business-core/src'] }],
  }, { verificationScope: 'changed', focusedBackendVerification: true }).contract;
  const intent = deriveForgeTaskIntent({ prompt: promptText, actionCeiling: 'workspace-write' });
  assert.ok(!intent.taskProfiles.includes('database'));
  const contract = prepare(promptText);
  assert.deepEqual(contract.taskProfiles, ['backend', 'security']);
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'backend-test-class']);
  assert.ok(!contract.requiredObligations.includes('transaction-index-and-query-review'));
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);

  for (const actual of [
    prepare('请重构Mapper，修复当前租户的数据查询。'),
    prepare('不要重构现有Mapper，但需要修改数据库查询。'),
    prepare(promptText, [...ownedPaths, 'forge-server/forge-business/forge-business-core/src/main/java/mapper/ArchiveMapper.java']),
    prepare(promptText, ownedPaths, ['backend', 'database']),
  ]) {
    assert.ok(actual.taskProfiles.includes('database'));
    assert.ok(actual.requiredObligations.includes('transaction-index-and-query-review'));
    assert.deepEqual(validateForgeTaskExecutionContract(actual), actual);
  }
});

test('frontend-only changes retain backend context without acquiring backend verification', () => {
  const ownedPaths = ['forge-admin-ui/src/utils/investigation-mode.js',
    'forge-admin-ui/src/utils/__tests__/investigation-mode.spec.js'];
  for (const promptText of [
    '确认替换当前任务。现在直接实施刚才的前端调查方式显示工具及单元测试：TEAM 显示“团队调查”，SINGLE 显示“个人调查”，UNKNOWN、空值及其他未知输入显示“待确认”。仅在 forge-admin-ui 中修改这个工具及它的测试，并完成本次变更范围的 lint、类型检查、相关测试和必要构建。\n\n保留现有后端文件及问题记录。本次授权仅为上述前端文件的工作区修改和检查；不提交、不发布、不接入页面或接口、不增加依赖或改锁文件。若正常任务准备仍被拒绝，请保留原始错误后结束，不重复尝试，不要求我无限继续。',
    '调整前端显示工具，沿用后端返回的调查方式；保留后端代码及此前检查记录。',
    'Update the frontend display utility using the existing backend API response. Keep the server files and previous test results.',
  ]) {
    const compiled = compileConversationTaskProposal({ promptText,
      proposal: proposal({ goal: '调整调查方式显示工具及对应测试。', ownedPaths, taskProfiles: ['frontend-admin'] }),
      writerScopes: [matchingScopes[0]],
    }, { verificationScope: 'changed' });
    assert.deepEqual(compiled.contract.taskProfiles, ['frontend-admin']);
    assert.deepEqual(compiled.contract.requiredVerificationProfiles,
      ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
    assert.deepEqual(compiled.contract.ownedPaths, [...ownedPaths].sort());
  }
});

test('backend paths and declared backend impact survive a frontend-only task description', () => {
  for (const scope of [
    { ownedPaths: [paths.page, paths.test], taskProfiles: ['frontend-admin'] },
    { ownedPaths: [paths.page], taskProfiles: ['frontend-admin', 'backend'] },
  ]) {
    const compiled = compileConversationTaskProposal({
      proposal: proposal({ goal: '调整调查方式显示。', ...scope }),
      writerScopes: matchingScopes,
      promptText: '本次只修改前端显示工具。保留后端记录。',
    }, { verificationScope: 'changed' });
    assert.ok(compiled.contract.taskProfiles.includes('backend'));
    assert.ok(compiled.contract.requiredVerificationProfiles.includes('backend-module-test'));
  }
});

test('frontend receipt-only scope does not add excluded backend or platform dependency-security checks', () => {
  const ownedPaths = ['forge-admin-ui/src'];
  for (const promptText of [
    '确认继续验证当前改动。本轮只收尾此前前端测试的验收回执，不修改业务源码、不发布。\n本轮不重复后端测试、全量回归、lint、类型检查或构建。',
    '继续验证当前改动。平台已修复预装依赖目录读取权限，业务源码未变，只续跑当前前端测试。',
  ]) {
    const compiled = compileConversationTaskProposal({ promptText,
      proposal: proposal({ goal: '仅复核并接收已完成的前端测试结果。', ownedPaths, taskProfiles: ['frontend-admin'] }),
      writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths }] });
    assert.deepEqual(compiled.contract.taskProfiles, ['frontend-admin']);
    assert.deepEqual(compiled.contract.requiredVerificationProfiles,
      ['governance', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build']);
  }
});

test('frontend paths or declared consumer impact retain frontend checks even in a backend proposal', () => {
  const backendPath = 'forge-server/forge-business/forge-business-core/src/main/java/example/ReportService.java';
  for (const scope of [
    { ownedPaths: [backendPath, paths.page], taskProfiles: ['backend'] },
    { ownedPaths: [backendPath], taskProfiles: ['backend', 'frontend-admin'] },
  ]) {
    const compiled = compileConversationTaskProposal({
      proposal: proposal({ goal: '调整调用合同。', ...scope }),
      writerScopes: [matchingScopes[0], { taskProfile: 'backend', ownedPaths: ['forge-server/forge-business'] }],
      promptText: '修复接口并验证前端调用兼容性。',
    });
    for (const check of ['frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build']) {
      assert.ok(compiled.contract.requiredVerificationProfiles.includes(check), check);
    }
    assert.ok(compiled.contract.requiredVerificationProfiles.includes('backend-module-test'));
  }
});

test('backend proposals keep trusted security and shared-contract obligations despite page context', () => {
  const compiled = compileConversationTaskProposal({
    proposal: proposal({
      goal: '修复后端逻辑。',
      ownedPaths: ['forge-server/src/main/java/example/ReportService.java'],
      taskProfiles: ['backend'],
    }),
    writerScopes: [{ taskProfile: 'backend', ownedPaths: ['forge-server/src'] }],
    promptText: '修复页面调用的后端权限检查，并修改 shared contract。',
  });
  assert.ok(!compiled.contract.taskProfiles.includes('frontend-admin'));
  for (const profile of ['backend', 'security', 'shared-owner']) assert.ok(compiled.contract.taskProfiles.includes(profile));
  assert.ok(compiled.contract.requiredVerificationProfiles.includes('full-regression'));
});

test('rejects traversal, glob, root .git, and secret-bearing paths before scope matching', () => {
  for (const forbidden of [
    '../forge-admin-ui/src/views/security/index.vue',
    'forge-admin-ui/src/views/*/index.vue',
    '.git/config',
    'forge-admin-ui/.env.production',
    'git账号密码.txt',
  ]) {
    const code = forbidden.startsWith('../')
      ? 'CONTRACT_PATH_TRAVERSAL'
      : 'CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN';
    expectCode(code, () => compileConversationTaskProposal({
      proposal: proposal({ ownedPaths: [forbidden] }),
      writerScopes: matchingScopes,
    }));
  }
});

test('rejects forged proposal authority fields and unsupported top-level inputs', () => {
  for (const forged of [
    { actionCeiling: 'release' },
    { authorization: { granted: true } },
    { promptText: 'forged model prompt' },
  ]) {
    expectCode('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', () =>
      compileConversationTaskProposal({
        proposal: { ...proposal(), ...forged },
        writerScopes: matchingScopes,
      }));
  }
  expectCode('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', () =>
    compileConversationTaskProposal({
      proposal: proposal(),
      writerScopes: matchingScopes,
      authorization: true,
    }));
  expectCode('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', () =>
    compileConversationTaskProposal({
      proposal: proposal({ taskProfiles: null }),
      writerScopes: matchingScopes,
    }));
  for (const taskProfiles of [[], ['frontend-admin', 'frontend-admin']]) {
    expectCode('CONTRACT_TASK_PROFILE_INVALID', () =>
      compileConversationTaskProposal({
        proposal: proposal({ taskProfiles }),
        writerScopes: matchingScopes,
      }));
  }
});

test('rejects missing, malformed, or shape-mismatched reference evidence', () => {
  for (const references of [
    [],
    [{ path: 'forge-admin-ui/src/router/index.ts' }],
    [{ path: 'forge-admin-ui/src/router/index.ts', sha256: 'A'.repeat(64) }],
    [{ path: 'forge-admin-ui/src/router/index.ts', sha256: HASH_A, size: 42 }],
  ]) {
    assert.throws(() => compileConversationTaskProposal({
      proposal: proposal({ references }),
      writerScopes: matchingScopes,
    }));
  }
});

test('canonicalizes separators and ordering without widening proposal paths to writer roots', () => {
  const compiled = compileConversationTaskProposal({
    proposal: proposal({
      ownedPaths: [
        'forge-server\\db\\migration\\V1.0.200__add_security_menu.sql',
        'forge-admin-ui\\src\\views\\security\\index.vue',
      ],
      taskProfiles: ['frontend-admin', 'migration'],
      references: [{ path: 'docs\\architecture.md', sha256: HASH_A }],
    }),
    writerScopes: matchingScopes,
  });

  assert.deepEqual(compiled.contract.ownedPaths, [paths.page, paths.migration]);
  assert.deepEqual(compiled.references, [{ path: 'docs/architecture.md', sha256: HASH_A }]);
  assert.ok(!compiled.contract.ownedPaths.includes('forge-admin-ui/src'));
  assert.ok(!compiled.contract.ownedPaths.includes('forge-server/db/migration'));
});

const maintenancePrompt = '本次只修复已有 lint 格式问题，保持业务行为不变。';
const maintenanceProposal = () => proposal({
  goal: '修正页面的两项 lint 报告。',
  ownedPaths: [paths.page],
  references: [{ path: paths.page, sha256: HASH_A }],
});

test('contract intent A4 distinguishes negated test-first wording from mandatory business TDD', () => {
  const input = { proposal: maintenanceProposal(), writerScopes: [matchingScopes[0]], formatMaintenanceSupported: true };
  const baseline = compileConversationTaskProposal({ ...input, promptText: maintenancePrompt });
  for (const suffix of ['不需要先写失败测试。', '不做 TDD。']) {
    const result = compileConversationTaskProposal({ ...input, promptText: `${maintenancePrompt}${suffix}` });
    assert.equal(result.contract.tddRequired, false, suffix);
    assert.deepEqual(result.contract.requiredRedProfiles, [], suffix);
    assert.deepEqual(result.contract.requiredVerificationProfiles, baseline.contract.requiredVerificationProfiles);
    assert.deepEqual(result.contract.ownedPaths, baseline.contract.ownedPaths);
  }
  for (const promptText of [
    `${maintenancePrompt}先写失败测试再修改。`,
    `${maintenancePrompt}不做部署，但先写失败测试。`,
    `${maintenancePrompt}同时修复权限漏洞。不做 TDD。`,
    '修复页面权限问题。不需要先写失败测试。',
  ]) {
    const result = compileConversationTaskProposal({ ...input, promptText });
    assert.equal(result.contract.tddRequired, true, promptText);
    assert.ok(result.contract.requiredRedProfiles.includes('frontend-red-test'), promptText);
  }
  const unsupported = compileConversationTaskProposal({ ...input, formatMaintenanceSupported: false,
    promptText: `${maintenancePrompt}不做 TDD。` });
  assert.equal(unsupported.contract.tddRequired, true);
});

test('trusted direct-user maintenance request selects the strategy without dropping domain profiles or final checks', () => {
  const permissionPage = 'forge-admin-ui/src/views/security/permission/index.vue';
  const input = { proposal: { ...maintenanceProposal(), ownedPaths: [permissionPage],
    references: [{ path: permissionPage, sha256: HASH_A }] }, writerScopes: [matchingScopes[0]] };
  const ordinary = compileConversationTaskProposal(input);
  const result = compileConversationTaskProposal({ ...input, promptText: maintenancePrompt, formatMaintenanceSupported: true });
  assert.equal(result.contract.tddRequired, false);
  assert.ok(result.contract.taskProfiles.includes('frontend-admin'));
  assert.ok(result.contract.taskProfiles.includes('security'));
  assert.ok(result.contract.taskProfiles.includes('frontend-format-maintenance'));
  assert.deepEqual(result.contract.requiredVerificationProfiles, ordinary.contract.requiredVerificationProfiles);
  assert.deepEqual(result.contract.requiredRedProfiles, []);
  assert.deepEqual(result.contract.ownedPaths, [permissionPage]);
  assert.deepEqual(result.contract, compileForgeTaskExecutionContract({
    prompt: maintenancePrompt,
    ownedPaths: result.contract.ownedPaths,
    actionCeiling: 'workspace-write',
    taskProfiles: result.contract.taskProfiles,
  }));
});

test('model goal and task profiles cannot select format maintenance', () => {
  for (const promptText of [undefined, '修复页面权限问题。']) {
    const input = {
      proposal: { ...maintenanceProposal(), goal: maintenancePrompt },
      writerScopes: [matchingScopes[0]],
      ...(promptText === undefined ? {} : { promptText }),
      formatMaintenanceSupported: true,
    };
    assert.equal(compileConversationTaskProposal(input).contract.tddRequired, true);
  }
  for (const promptText of [undefined, maintenancePrompt, '修复页面权限问题。']) {
    expectCode('CONVERSATION_TASK_PROPOSAL_PROFILE_FORBIDDEN', () => compileConversationTaskProposal({
      proposal: { ...maintenanceProposal(), taskProfiles: ['frontend-admin', 'frontend-format-maintenance'] },
      writerScopes: [matchingScopes[0]],
      ...(promptText === undefined ? {} : { promptText }),
      formatMaintenanceSupported: true,
    }));
  }
});

test('format maintenance needs exact existing file references and never widens project authorization', () => {
  const unreferenced = compileConversationTaskProposal({
    proposal: { ...maintenanceProposal(), references: [{ path: 'docs/requirements.md', sha256: HASH_A }] },
    writerScopes: [matchingScopes[0]],
    promptText: maintenancePrompt,
    formatMaintenanceSupported: true,
  });
  assert.equal(unreferenced.contract.tddRequired, true);
  for (const ownedPaths of [['forge-admin-ui/src'], [paths.page, paths.migration]]) {
    const result = compileConversationTaskProposal({
      proposal: { ...proposal(), ownedPaths, references: ownedPaths.map((path) => ({ path, sha256: HASH_A })) },
      writerScopes: matchingScopes,
      promptText: maintenancePrompt,
      formatMaintenanceSupported: true,
    });
    assert.equal(result.contract.tddRequired, true);
  }
  expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({
    proposal: maintenanceProposal(),
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src/views/other.vue'] }],
    promptText: maintenancePrompt,
    formatMaintenanceSupported: true,
  }));
});

test('mixed behavior or explicit TDD requests retain test-first even with a maintenance-looking model goal', () => {
  for (const promptText of [
    '修复页面权限问题。',
    '只修复 lint 问题。',
    '只修复格式问题，保持行为不变。',
    `${maintenancePrompt}同时修复权限漏洞。`,
    `${maintenancePrompt}先写失败测试再修改。`,
    'Only fix existing lint formatting issues; preserve business behavior. Add permission checks.',
  ]) {
    const result = compileConversationTaskProposal({
      proposal: { ...maintenanceProposal(), goal: maintenancePrompt },
      writerScopes: [matchingScopes[0]],
      promptText,
      formatMaintenanceSupported: true,
    });
    assert.equal(result.contract.tddRequired, true);
    assert.ok(result.contract.requiredObligations.includes('test-first'));
  }
});

test('format maintenance remains test-first without the host-owned runtime capability', () => {
  for (const supported of [undefined, false, true]) {
    const result = compileConversationTaskProposal({
      proposal: maintenanceProposal(), writerScopes: [matchingScopes[0]],
      promptText: maintenancePrompt,
      ...(supported === undefined ? {} : { formatMaintenanceSupported: supported }),
    });
    assert.equal(result.contract.tddRequired, supported !== true);
    assert.equal(result.contract.taskProfiles.includes('frontend-format-maintenance'), supported === true);
  }
  expectCode('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', () => compileConversationTaskProposal({
    proposal: maintenanceProposal(), writerScopes: [matchingScopes[0]],
    promptText: maintenancePrompt, formatMaintenanceSupported: 'true',
  }));
  expectCode('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', () => compileConversationTaskProposal({
    proposal: { ...maintenanceProposal(), formatMaintenanceSupported: true },
    writerScopes: [matchingScopes[0]], promptText: maintenancePrompt,
  }));
});

test('literal Vue route files remain exact paths while actual glob and escaping paths are rejected', () => {
  const route = 'forge-admin-ui/src/views/accident/report-form/[type].vue';
  const input = {
    proposal: proposal({
      goal: '修复已有事故表单的字段显示。',
      ownedPaths: [route],
      references: [{ path: route, sha256: HASH_A }],
    }),
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: [route] }],
  };
  const result = compileConversationTaskProposal(input);
  assert.deepEqual(result.contract.ownedPaths, [route]);
  assert.deepEqual(result.references, [{ path: route, sha256: HASH_A }]);
  const prefixedRoute = 'forge-admin-ui/src/views/app-center/object-designer.[objectCode].vue';
  const prefixedInput = {
    ...input,
    proposal: { ...input.proposal, ownedPaths: [prefixedRoute], references: [{ path: prefixedRoute, sha256: HASH_A }] },
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: [prefixedRoute] }],
  };
  const prefixedResult = compileConversationTaskProposal(prefixedInput);
  assert.deepEqual(prefixedResult.contract.ownedPaths, [prefixedRoute]);
  assert.deepEqual(prefixedResult.references, [{ path: prefixedRoute, sha256: HASH_A }]);
  expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({
    ...prefixedInput,
    proposal: { ...prefixedInput.proposal, ownedPaths: [prefixedRoute.replace('[objectCode]', '[other]')] },
  }));
  for (const sibling of ['t.vue', 'type.vue', '[other].vue']) {
    expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({
      ...input,
      proposal: { ...input.proposal, ownedPaths: [route.replace('[type].vue', sibling)] },
    }));
  }
  for (const forbidden of [
    'forge-admin-ui/src/views/*/[type].vue',
    'forge-admin-ui/src/views/report-form/[a-z].vue',
    'forge-admin-ui/src/views/report-form/[!type].vue',
    'forge-admin-ui/src/views/report-form/field[type].vue',
    'forge-admin-ui/src/views/report-form/[type]?.vue',
    'forge-admin-ui/src/views/report-form/{create,edit}.vue',
    'forge-admin-ui/src/views/report-form/[type].vue/*',
    'forge-admin-ui/src/views/app-center/object*.[objectCode].vue',
    'forge-admin-ui/src/views/app-center/object-designer.[a-z].vue',
    'forge-admin-ui/src/views/app-center/object-designer..[objectCode].vue',
    '.git/[type].vue',
    'forge-admin-ui/.env/[type].vue',
    '.git/object-designer.[objectCode].vue',
    'forge-admin-ui/.env/object-designer.[objectCode].vue',
  ]) {
    for (const field of ['ownedPaths', 'references']) {
      expectCode('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', () => compileConversationTaskProposal({
        ...input,
        proposal: {
          ...input.proposal,
          [field]: field === 'references' ? [{ path: forbidden, sha256: HASH_A }] : [forbidden],
        },
      }));
    }
  }
  for (const [forbidden, code] of [
    ['../forge-admin-ui/src/views/[type].vue', 'CONTRACT_PATH_TRAVERSAL'],
    ['/forge-admin-ui/src/views/[type].vue', 'CONTRACT_PATH_INVALID'],
    ['C:/forge-admin-ui/src/views/[type].vue', 'CONTRACT_PATH_INVALID'],
    ['../forge-admin-ui/src/views/app-center/object-designer.[objectCode].vue', 'CONTRACT_PATH_TRAVERSAL'],
  ]) {
    expectCode(code, () => compileConversationTaskProposal({
      ...input, proposal: { ...input.proposal, ownedPaths: [forbidden] },
    }));
  }
});


test('actual login repair accepts PasswordUtil Java source references without granting secret access', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/security-fifth-login-proposals-20260925.json', import.meta.url), 'utf8'));
  for (const source of fixture.proposals) {
    const current = { ...source, references: source.references.map(path => ({ path, sha256: HASH_A })) };
    const compiled = compileConversationTaskProposal({ proposal: current, writerScopes: [matchingScopes[0]] });
    assert.deepEqual(compiled.contract.ownedPaths, [...source.ownedPaths].sort());
    assert.ok(!compiled.contract.ownedPaths.some(path => path.endsWith('PasswordUtil.java')));
  }
});

test('PasswordUtil reference exception preserves secret directories and non-source boundaries', () => {
  for (const forbidden of [
    'PasswordUtil.java', 'secrets/src/main/java/com/example/PasswordUtil.java',
    'forge-server/src/main/java/com/example/passwords.json',
    'forge-server/src/main/java/com/example/PasswordUtil.java.pem',
    'forge-server/src/main/java/com/example/PasswordUtil.java.secret',
    'forge-server/src/main/java/com/example/SecretKey.java',
    'forge-server/.env.production', '验收测试账号密码.json',
  ]) {
    expectCode('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', () => compileConversationTaskProposal({
      proposal: proposal({ ownedPaths: [paths.page], references: [{ path: forbidden, sha256: HASH_A }] }),
      writerScopes: [matchingScopes[0]],
    }));
  }
  expectCode('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', () => compileConversationTaskProposal({
    proposal: proposal({ ownedPaths: ['forge-server/src/main/java/com/example/PasswordUtil.java'] }),
    writerScopes: matchingScopes,
  }));
});

test('login decoder implementation is a read-only source reference without credential or writer access', () => {
  const decoder = 'forge-server/forge-framework/forge-plugin-parent/forge-plugin-system/src/main/java/com/mdframe/forge/plugin/system/auth/LoginPasswordDecoder.java';
  const owned = 'forge-server/forge-admin-server/src/test/java/com/mdframe/forge/business/core/eqrepair/EqRepairLedgerIdorCrossTenantIntegrationTest.java';
  const input = {
    proposal: proposal({ goal: '修复既有登录测试的真实加密请求，保持认证实现和权限检查。',
      ownedPaths: [owned], taskProfiles: ['backend', 'security'],
      references: [{ path: decoder, sha256: HASH_A }] }),
    writerScopes: [{ taskProfile: 'backend', ownedPaths: [owned] }],
  };
  const compiled = compileConversationTaskProposal(input);
  assert.deepEqual(compiled.contract.ownedPaths, [owned]);
  assert.equal(compiled.contract.ownedPaths.includes(decoder), false);
  for (const path of [
    'LoginPasswordDecoder.java',
    `secrets/${decoder}`,
    decoder.replace('/auth/', '/passwords/'),
    decoder + '.pem', decoder + '.key',
    decoder.replace('LoginPasswordDecoder.java', 'LoginPasswordDecoder.json'),
    decoder.replace('LoginPasswordDecoder.java', 'SecretLoginPasswordDecoder.java'),
  ]) {
    expectCode('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', () => compileConversationTaskProposal({
      ...input, proposal: { ...input.proposal, references: [{ path, sha256: HASH_A }] },
    }));
  }
  expectCode('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', () => compileConversationTaskProposal({
    ...input, proposal: { ...input.proposal, ownedPaths: [decoder] },
    writerScopes: [{ taskProfile: 'backend', ownedPaths: [decoder] }],
  }));
});

test('actual password transport repair accepts source DTOs tests and API clients within exact scopes', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/security-fifth-password-proposals-20260925.json', import.meta.url), 'utf8'));
  for (const source of fixture.proposals) {
    const current = { ...source, references: source.references.map(path => ({ path, sha256: HASH_A })) };
    const writerScopes = [
      { taskProfile: 'backend', ownedPaths: source.ownedPaths.filter(path => path.startsWith('forge-server/')) },
      { taskProfile: 'frontend-admin', ownedPaths: source.ownedPaths.filter(path => path.startsWith('forge-admin-ui/')) },
    ];
    const compiled = compileConversationTaskProposal({ proposal: current, writerScopes });
    assert.deepEqual(compiled.contract.ownedPaths, [...source.ownedPaths].sort());
    expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({
      proposal: current, writerScopes: [matchingScopes[0]],
    }));
  }
});

test('credential source classification does not admit secret files or sensitive parent directories', () => {
  for (const path of [
    'ChangePasswordRequest.java',
    'secrets/src/main/java/com/example/ChangePasswordRequest.java',
    'forge-server/src/main/java/com/passwords/ChangePasswordRequest.java',
    'forge-server/src/main/java/com/example/ChangePasswordRequest.java.pem',
    'forge-server/src/main/java/com/example/SecretPasswordRequest.java',
    'forge-server/src/test/java/com/secrets/PasswordTest.java',
    'forge-admin-ui/src/api/system/credential.json',
    'forge-admin-ui/src/api/secrets/credential.js',
    'forge-admin-ui/src/config/credential.js',
    'forge-admin-ui/src/api/system/credential.js.key',
    'forge-admin-ui/src/api/system/password.json',
    'forge-admin-ui/src/api/passwords/resetPassword.js',
    'forge-admin-ui/src/config/password.js',
    'forge-admin-ui/src/api/system/password.js.pem',
    'forge-admin-ui/src/api/system/secretPassword.js',
    'ops/credentials.json', '.env', '验收测试账号密码.json',
  ]) {
    for (const asReference of [true, false]) {
      expectCode('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', () => compileConversationTaskProposal({
        proposal: proposal(asReference
          ? { ownedPaths: [paths.page], references: [{ path, sha256: HASH_A }] }
          : { ownedPaths: [path] }),
        writerScopes: matchingScopes,
      }));
    }
  }
});

test('actual password API recurrence accepts normal source identifiers within exact scopes', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/security-fifth-password-api-proposals-20260925.json', import.meta.url), 'utf8'));
  for (const source of fixture.proposals) {
    const current = { ...source, references: source.references.map(path => ({ path, sha256: HASH_A })) };
    const writerScopes = [
      { taskProfile: 'backend', ownedPaths: source.ownedPaths.filter(path => path.startsWith('forge-server/')) },
      { taskProfile: 'frontend-admin', ownedPaths: source.ownedPaths.filter(path => path.startsWith('forge-admin-ui/')) },
    ];
    assert.deepEqual(compileConversationTaskProposal({ proposal: current, writerScopes }).contract.ownedPaths, [...source.ownedPaths].sort());
  }
  for (const name of ['password.js', 'changePassword.ts', 'resetUserPassword.spec.js', 'credentials.ts']) {
    const path = `forge-admin-ui/src/api/system/${name}`;
    const current = proposal({ ownedPaths: [path], references: [{ path, sha256: HASH_A }] });
    assert.deepEqual(compileConversationTaskProposal({ proposal: current, writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: [path] }] }).contract.ownedPaths, [path]);
    expectCode('CONVERSATION_TASK_SCOPE_DENIED', () => compileConversationTaskProposal({ proposal: current, writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: [paths.page] }] }));
  }
});

function prepareTaskProposalSchemaInput(overrides = {}) {
  const generator = 'forge-server/forge-framework/forge-plugin-parent/forge-plugin-generator/src/main/java/com/mdframe/forge/plugin/generator';
  const ownedPaths = [
    'forge-server/forge-admin-server/src/test/java/com/mdframe/forge/plugin/generator/CodeRuleOptimisticLockIntegrationTest.java',
    `${generator}/controller/CodeRuleController.java`,
    `${generator}/controller/SystemCodeRuleController.java`,
    `${generator}/dto/businessapp/CodeRuleSaveDTO.java`,
    `${generator}/service/businessapp/CodeRuleOptimisticLockException.java`,
    `${generator}/service/businessapp/CodeRuleService.java`,
    `${generator}/vo/businessapp/CodeRuleDetailVO.java`,
  ];
  return {
    // Exact normal parameter-description sentence from the actual prompt.
    promptText: '参数仍只使用公开 prepare_task proposal schema；由运行端检查文件内容、计算 SHA、派生集成测试绑定及实际 admission，不手工构造额外字段。',
    proposal: proposal({ goal: '继续准备同一 CodeRule 七文件任务。', ownedPaths,
      taskProfiles: ['backend', 'security', 'shared-owner'],
      references: ownedPaths.map(path => ({ path, sha256: HASH_A })) }),
    writerScopes: [{ taskProfile: 'backend', ownedPaths: [...ownedPaths, paths.migration] }],
    ...overrides,
  };
}

test('prepare_task proposal schema keeps the real seven-file task profiles', () => {
  const input = prepareTaskProposalSchemaInput();
  const originalPrompt = input.promptText;
  const actual = compileConversationTaskProposal(input).contract;
  assert.deepEqual(actual.taskProfiles, ['backend', 'security', 'shared-owner']);
  assert.deepEqual(actual.ownedPaths, input.proposal.ownedPaths);
  assert.equal(input.promptText, originalPrompt);
  assert.deepEqual(validateForgeTaskExecutionContract(actual), actual);
});

test('prepare_task proposal schema preserves explicit and real database work', () => {
  const base = prepareTaskProposalSchemaInput();
  for (const input of [
    { ...base, promptText: '参数仍只使用公开 prepare_task proposal schema，同时修改数据库 schema。' },
    { ...base, proposal: { ...base.proposal, ownedPaths: [...base.proposal.ownedPaths, paths.migration] } },
    { ...base, proposal: { ...base.proposal, taskProfiles: [...base.proposal.taskProfiles, 'database'] } },
  ]) {
    const actual = compileConversationTaskProposal(input).contract;
    assert.ok(actual.taskProfiles.includes('database'));
    assert.ok(actual.requiredObligations.includes('transaction-index-and-query-review'));
    assert.deepEqual(validateForgeTaskExecutionContract(actual), actual);
  }
});
