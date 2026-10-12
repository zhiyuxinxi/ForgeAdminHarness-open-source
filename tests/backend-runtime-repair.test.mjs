import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  beginForgeDeliveryPhase, completeForgeDeliveryPhase, createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState, currentForgeRuntimeSourceArtifactKind,
  projectCompletedForgeDeliveryPhaseExecution, recordForgeAccessAcceptedCorrection,
  validateForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { isForgeBackendRuntimeRepairContinuation } from '../docker/harness/forge-protected-acceptance-service.mjs';

const catalog = JSON.parse(await readFile(new URL(
  '../docker/harness/skills/forge-task-router/references/phase-profiles.json', import.meta.url), 'utf8'));
const sourceCommit = '6eb2881e6f6af85a5348acf3da63cef53a873b0e';
const sha = character => character.repeat(64);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const time = (generation, seconds = '00') => `2026-09-03T00:${String(generation).padStart(2, '0')}:${seconds}.000Z`;
const phaseFor = state => catalog.workflows[0].phases[state.currentPhaseIndex];
// Exact original dialogue requests; the version diagnosis in 90 is historical,
// not independently proven business evidence. This file only tests the platform.
const original90 = "继续修改当前任务，修复刚才库存运行验收发现的备件入库问题。\n\n实际观察中，新增备件和详情查询通过；新建备件的版本号为0，但入库接口要求版本号为正整数，导致合法的新建备件无法入库。请沿现有受控关联修复流程处理这个后端业务缺陷：合法的初始版本应可用于首次入库，同时保留版本匹配、过期版本冲突、库存数量及权限校验。业务代码和必要测试仍由你在Harness内完成。\n\n仅修改本问题及其直接相关测试，取得修复后的正式验证结果，再返回当前跨层验收复验新增、入库、出库和受影响的库存约束。保留已接受的上游合同和未受影响的证据；源码有变化后按既有流程准备新候选，不复用旧候选冒充修复生效。不重启八阶段，不做浏览器操作，本轮不发布。完整消防范围中的其他未完成项继续保留。\n";
const original91 = "继续修改当前任务，定位并修复刚才库存运行验收发现的备件入库后端问题。\n\n完整运行回执已经核对：新增备件和新增后详情查询通过；stockIn返回业务code500，错误为FIRE_VALIDATION_FAILED: 业务ID必须为正整数。上一轮你判断与初始版本号0有关，但回执没有说明被拒字段，请先核对实际请求、相关源码及数据语义再确定根因，不把这个判断直接当作已证实结论。\n\n沿当前受控后端关联修复完成业务代码和必要测试。合法初始版本、版本匹配和过期版本冲突应按既有合同处理，保留业务ID、库存数量、权限和租户校验。只修改本问题及直接相关测试，取得正式验证结果后返回原跨层验收，复验新增、入库、出库及受影响的库存约束。\n\n保留已接受的上游合同、其余未受影响的阶段产物和有效证据；源码变化后按既有流程准备新候选，不用旧候选冒充修复已生效。不重启八阶段，不做浏览器操作，本轮不发布。消防范围中的其他未完成项继续保留。\n";

function freshState() {
  return createForgeDeliveryPhaseState({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
    taskId: 'eval-crud-complete', sessionId: 'session-phased-crud', sourceCommit, now: time(0) });
}
function beginCurrent(state, generation) {
  return beginForgeDeliveryPhase({ state, catalog, phaseId: state.currentPhaseId,
    rpcId: `rpc-${state.currentPhaseId}-${generation}`, promptDigest: sha(String((generation % 9) + 1)),
    executionGeneration: generation, now: time(generation) });
}
function artifactFor(state, fingerprint = sha('b')) {
  const phase = phaseFor(state);
  return createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId, sourceFingerprint: fingerprint,
    changedPaths: phase.patchScope === 'phase' ? [`${phase.ownedPaths[0]}/phase-generated.txt`] : [],
    patchDigest: phase.patchScope === 'none' ? null : sha('a'),
    payload: Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, []])) });
}
function hostReceiptsFor(state, artifact) {
  return phaseFor(state).hostVerificationProfiles.map((profile, index) => ({ profile, status: 'passed',
    receiptDigest: String((index % 9) + 1).repeat(64), patchDigest: artifact.sourceFingerprint }));
}
function acceptCurrent(state, generation, fingerprint = sha('b')) {
  const started = beginCurrent(state, generation), artifact = artifactFor(started, fingerprint);
  return { ...completeForgeDeliveryPhase({ state: started, catalog, decision: 'accepted', artifact,
    hostReceipts: hostReceiptsFor(started, artifact), now: time(generation, '30') }), artifact };
}

test('backend runtime repair accepts original requests and retains intent boundaries', () => {
  const phase = { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' };
  assert.equal(hash(original90), '3ed53d856979bd36d9ce2683615c89750d2570ce8cf7bbbe58ce70cad2868583');
  assert.equal(hash(original91), 'e30ce45da903b60b0140f4b531f556e6c8b92545773cb50895ff8b62d59aa7da');
  for (const [prompt, expected] of [
    [original90, true], [original91, true],
    [original90 + '\n不要继续修改当前任务。', false],
    ['只读分析当前后端运行验收失败，不修改任何文件。', false],
    [original90 + '\n另外新增一个接口。', false],
  ]) assert.equal(isForgeBackendRuntimeRepairContinuation(prompt, phase), expected, prompt);
});

test('backend accepted correction preserves seven-stage history and completes the original cross attempt', () => {
  let state = freshState();
  const oldArtifacts = new Map();
  for (let generation = 1; generation <= 7; generation++) {
    const accepted = acceptCurrent(state, generation);
    state = accepted.state; oldArtifacts.set(accepted.artifact.artifactKind, JSON.stringify(accepted.artifact));
  }
  const acceptedBefore = structuredClone(state.acceptedArtifacts);
  const historyBefore = JSON.stringify(state.history);
  const backendAttempt = state.history.find(entry => entry.phaseId === 'backend').attemptId;
  const cross = beginCurrent(state, 8);
  const correction = recordForgeAccessAcceptedCorrection({ state: cross, catalog, phaseId: 'backend', now: time(8, '30'),
    binding: { acceptedSourceFingerprint: sha('b'), failureEvidenceSha256: sha('d'), jobId: null,
      executionId: '11111111-1111-4111-8111-111111111111', executionGeneration: 8,
      rpcId: cross.activeAttempt.rpcId, workspaceFingerprint: sha('c'), candidateCommit: sourceCommit,
      sourceStateSha256: hash(JSON.stringify(cross)), repairRequestSha256: hash(original90),
      runtimeFailure: { observationId: '22222222-2222-4222-8222-222222222222', manifestSha256: sha('e'), formalTerminalSha256: sha('f') } } });
  validateForgeDeliveryPhaseState(correction, catalog);
  assert.equal(correction.currentPhaseId, 'backend');
  assert.equal(correction.currentPhaseIndex, 4);
  assert.equal(correction.activeAttempt, null);
  assert.equal(JSON.stringify(correction.history.slice(0, -1)), historyBefore);
  assert.deepEqual(correction.history.at(-1).suspendedCrossLayerAttempt, cross.activeAttempt);
  assert.equal(correction.history.at(-1).attemptId, backendAttempt);
  assert.equal(Object.keys(correction.acceptedArtifacts).length, 6);
  const repaired = acceptCurrent(correction, 9, sha('c'));
  assert.equal(repaired.state.currentPhaseId, 'cross-layer-acceptance');
  assert.equal(repaired.state.currentPhaseIndex, 7);
  assert.equal(repaired.state.history.at(-1).attemptId, backendAttempt);
  assert.equal(JSON.stringify(repaired.state.history.slice(0, -2)), historyBefore);
  assert.equal(currentForgeRuntimeSourceArtifactKind(repaired.state), 'backend-implementation');
  assert.notEqual(repaired.state.acceptedArtifacts['backend-implementation'], acceptedBefore['backend-implementation']);
  for (const [kind, digest] of Object.entries(acceptedBefore)) {
    assert.equal(JSON.parse(oldArtifacts.get(kind)).artifactDigest, digest);
    if (kind !== 'backend-implementation') assert.equal(repaired.state.acceptedArtifacts[kind], digest);
  }
  const resumed = beginCurrent(repaired.state, 10);
  assert.equal(resumed.activeAttempt.attemptId, cross.activeAttempt.attemptId);
  assert.deepEqual(resumed.history, repaired.state.history);
  const finalArtifact = artifactFor(resumed, sha('c'));
  const completed = completeForgeDeliveryPhase({ state: resumed, catalog, decision: 'accepted', artifact: finalArtifact,
    hostReceipts: hostReceiptsFor(resumed, finalArtifact), now: time(10, '30') });
  const projection = projectCompletedForgeDeliveryPhaseExecution({ catalog, workflowId: completed.state.workflowId,
    caseFamily: completed.state.caseFamily, state: completed.state });
  assert.equal(completed.state.status, 'completed');
  assert.equal(projection.operatorAdvancementProven, true);
  assert.equal(Object.keys(projection.acceptedArtifactDigests).length, 8);
  assert.equal(projection.acceptedArtifactDigests['backend-implementation'], repaired.artifact.artifactDigest);
  assert.deepEqual(completed.state.history.slice(0, -1), resumed.history);
  for (const [kind, digest] of Object.entries(acceptedBefore)) {
    if (kind !== 'backend-implementation') assert.equal(projection.acceptedArtifactDigests[kind], digest);
  }
});
