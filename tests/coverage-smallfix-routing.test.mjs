import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { compileConversationTaskProposal } from '../docker/harness/forge-conversation-task-proposal.mjs';

const prompt = fs.readFileSync(new URL('./fixtures/forge-behavior-qualification/prompts/small-fix-routing.v1.md', import.meta.url), 'utf8');
const file = 'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/coverage/SmallFixOrderRemarkFixture.java';
const input = {
  promptText: prompt,
  actionCeiling: 'workspace-write',
  proposal: {
    goal: '仅修复测试夹具已有订单备注长度约束，并运行现有聚焦测试。',
    ownedPaths: [file],
    taskProfiles: ['backend'],
    references: [{ path: file, sha256: 'a'.repeat(64) }],
  },
  writerScopes: [{ taskProfile: 'backend', ownedPaths: ['forge-server/forge-business/forge-business-core/src'] }],
};
const options = { independentReview: 'suspended', verificationScope: 'changed', focusedBackendVerification: true };

test('BEH02 excluded domain Skills do not add database or workflow obligations', () => {
  const { contract } = compileConversationTaskProposal(input, options);
  assert.deepEqual(contract.taskProfiles, ['backend']);
  assert.deepEqual(contract.ownedPaths, [file]);
  assert.ok(!contract.requiredObligations.includes('workflow-state-transition-tests'));
  assert.ok(!contract.requiredObligations.includes('idempotent-workflow-callbacks'));
});

test('real added database and workflow work still contributes required obligations', () => {
  const { contract } = compileConversationTaskProposal({
    ...input,
    promptText: `${prompt}\n同时需要修改数据库索引，并实现工作流状态变更及回调。`,
  }, options);
  assert.ok(contract.taskProfiles.includes('database'));
  assert.ok(contract.taskProfiles.includes('workflow'));
  assert.ok(contract.requiredObligations.includes('workflow-state-transition-tests'));
  assert.ok(contract.requiredObligations.includes('idempotent-workflow-callbacks'));
});
