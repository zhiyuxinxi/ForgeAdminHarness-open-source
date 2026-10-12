import assert from 'node:assert/strict';
import test from 'node:test';
import { compileForgeTaskExecutionContract, deriveForgeTaskIntent } from '../docker/harness/forge-task-execution-contract.mjs';
import { compileConversationTaskProposal } from '../docker/harness/forge-conversation-task-proposal.mjs';

const paths = [
  'forge-admin-ui/src/views/security/components/SecurityDossierPage.vue',
  'forge-admin-ui/src/views/security/__tests__/security-dossier-page.test.js',
];
const original = '继续修复并发布当前已授权的安保第二批，第三批及以后仍暂停。第一批刚在真实admin浏览器1280×720完成了上传保存、只读查看和附件下载、编辑刷新持久化、导出内容、单删与两条批删，三个页面分类和二级隔离均实际通过，测试记录也已正常删除，不要重做第一批。现在核对第二批四个卷宗：12/14/14/25类左侧目录已出现，易制毒卷宗/企业基本情况正常上传保存成功、编辑能点开，但行操作仍只有编辑和删除，没有原MD明确要求的只读查看，文件名也没有查看入口。已有测试记录“codex验收-20260925-易制毒卷宗-001”，源附件security-md-acceptance-20260925.txt，说明“第二批卷宗真实验收，完成后正常UI删除。”，请保留供复验。请补齐这四个卷宗对应的正常查看入口，能只读回显文件名、说明和源附件及下载，不用编辑替代查看；仅修改直接相关第二批共用前端和必要回归，通过受影响检查后受控提交并发布前端，不重跑未改后端，不修改后续批次、不新增数据、不重做第一批或全站改造。我再继续真实页面验收。';
const compile = (prompt, ownedPaths = paths, taskProfiles) => compileForgeTaskExecutionContract({
  prompt, ownedPaths, actionCeiling: 'release', ...(taskProfiles ? { taskProfiles } : {}),
}, { verificationScope: 'changed' });

test('completed historical persistence does not add backend checks to the actual frontend request', () => {
  for (const prompt of [original, '第一批已经完成数据库持久化。现在补齐第二批前端查看入口并发布。']) {
    const contract = compile(prompt);
    assert.ok(!contract.taskProfiles.includes('database'));
    assert.ok(!contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.equal(contract.actionCeiling, 'release');
  }
});

test('intent and ordinary proposal consumers agree on the complete real request', () => {
  const intent = deriveForgeTaskIntent({ prompt: original, actionCeiling: 'release' });
  const result = compileConversationTaskProposal({
    promptText: original, actionCeiling: 'release',
    proposal: { goal: '补齐第二批四卷宗的只读查看并发布。', ownedPaths: paths,
      taskProfiles: ['frontend-admin'], references: [{ path: paths[0], sha256: 'a'.repeat(64) }] },
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }],
  }, { verificationScope: 'changed' });
  assert.ok(!intent.taskProfiles.includes('database'));
  assert.ok(!result.contract.taskProfiles.includes('database'));
  assert.ok(!result.contract.requiredVerificationProfiles.includes('backend-module-test'));
});

test('unfinished work, fresh requests, declared impact and real database paths retain database checks', () => {
  const requests = [
    '第一批尚未完成数据库持久化，现在继续修复。',
    '第一批已完成持久化，但本轮需要修复数据库索引。',
    '第一批已完成页面，现在修改数据库索引。',
    '第一批已完成页面，新增数据库索引。',
    '请完成数据库持久化，并修改页面。',
    '第一批已完成页面。现在修复数据库持久化。',
  ];
  for (const prompt of requests) assert.ok(compile(prompt).taskProfiles.includes('database'), prompt);
  assert.ok(compile(original, [...paths, 'forge-server/src/main/java/mapper/ArchiveMapper.java']).taskProfiles.includes('database'));
  assert.ok(compile(original, paths, ['frontend-admin', 'database']).taskProfiles.includes('database'));
});

test('verified browser history and successful comparison do not add database checks to UI repair', async () => {
  const { readFile } = await import('node:fs/promises');
  const input = JSON.parse(await readFile(new URL('./fixtures/security-third-ui-feedback-20260925.json', import.meta.url), 'utf8'));
  const contract = compile(input.prompt, input.ownedPaths);
  assert.ok(!contract.taskProfiles.includes('database'), JSON.stringify(contract.taskProfiles));
  const result = compileConversationTaskProposal({
    promptText: input.prompt, actionCeiling: 'release',
    proposal: { goal: '修复人防详情流程与图片上传状态并发布。', ownedPaths: input.ownedPaths,
      taskProfiles: ['frontend-admin'], references: [{ path: input.ownedPaths[0], sha256: 'a'.repeat(64) }] },
    writerScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }],
  }, { verificationScope: 'changed' });
  assert.ok(!result.contract.taskProfiles.includes('database'));
  assert.ok(!result.contract.requiredVerificationProfiles.includes('backend-module-test'));
});
