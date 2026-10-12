import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { beginForgeDeliveryPhase, completeForgeDeliveryPhase, createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState, recordForgeAccessAcceptedCorrection, writeForgeDeliveryPhaseState,
  readForgeDeliveryPhaseState } from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { preflightForgeDeliveryPhaseRun, finalizeForgeDeliveryPhaseRun } from '../docker/harness/forge-delivery-phase-controller.mjs';
import { isForgeBackendPhaseCompletion } from '../docker/harness/forge-protected-acceptance-service.mjs';
const catalogFile = path.resolve(import.meta.dirname, '../docker/harness/skills/forge-task-router/references/phase-profiles.json');
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const sourceCommit = '6eb2881e6f6af85a5348acf3da63cef53a873b0e';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const prompt = "确认当前后端阶段修复产物，继续原消防管理任务的跨层验收。\n\n本轮后端编译及1581项测试已经通过，保留这批真实回执和其余已接受阶段。源码已经变化，请通过受控入口准备包含本次库存修复的新候选，不要把旧候选的运行结果当成新修复已经生效。\n\n先把备件的实际业务链走通：新建和详情、初始版本入库、正常出库、库存不足拒绝、库存和流水复读、有流水时的删除约束，以及这条链直接相关的权限和租户边界。使用真实业务响应及数据库结果判断，不以HTTP200代替成功。库存链通过后继续原消防材料范围中尚未完成的跨层检查，复用仍有效且未受改动影响的结果，不重跑前七阶段，不追加浏览器或界面UAT。\n\n不要继续打磨已通过的后端测试。对新的失败先定位直接根因；需要业务修复时继续在本Harness对话处理，非阻塞细节登记后继续交付。最终如实报告本轮实际通过、失败和未执行项，证据不足不能宣称整个第8阶段通过。\n";
const stamp = generation => `2026-09-03T00:${String(generation).padStart(2, '0')}:00.000Z`;
function begin(state, generation) {
  return beginForgeDeliveryPhase({ state, catalog, phaseId: state.currentPhaseId, rpcId: `rpc-${generation}`,
    promptDigest: sha(`prompt-${generation}`), executionGeneration: generation, now: stamp(generation) });
}
function receipts(phase, fingerprint) {
  return phase.hostVerificationProfiles.map(profile => ({ profile, status: 'passed', receiptDigest: sha(profile), patchDigest: fingerprint }));
}

test('backend corrected artifact confirmation returns to cross-layer with normal intent boundaries', () => {
  const backend = { workflowId: 'crud-production', phaseId: 'backend', phaseIndex: 4, actionCeiling: 'workspace-write' };
  const cross = { ...backend, phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' };
  assert.equal(isForgeBackendPhaseCompletion(prompt, backend), true);
  assert.equal(isForgeBackendPhaseCompletion(prompt, cross), true);
  for (const text of [prompt + '\n撤回当前确认。', prompt + '\n不要继续跨层验收。', prompt + '是否可以？']) {
    assert.equal(isForgeBackendPhaseCompletion(text, backend), false);
  }
  assert.equal(isForgeBackendPhaseCompletion(prompt, { ...backend, phaseId: 'frontend', phaseIndex: 5 }), false);
});

test('bound backend correction keeps unchanged paths through preflight, acceptance and cross-layer capture', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-backend-correction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDirectory = path.join(root, 'artifacts'), stateFile = path.join(root, 'state.json');
  await mkdir(artifactsDirectory);
  let state = createForgeDeliveryPhaseState({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
    taskId: 'eval-backend-repair', sessionId: 'session-backend-repair', sourceCommit, now: stamp(0) });
  const originals = new Map();
  const backend = catalog.workflows[0].phases[4];
  const backendPaths = [`${backend.ownedPaths[0]}/Changed.java`, `${backend.ownedPaths[0]}/Unchanged.java`, `${backend.ownedPaths[1]}/ChangedTest.java`].sort();
  for (let generation = 1; generation <= 7; generation++) {
    state = begin(state, generation);
    const phase = catalog.workflows[0].phases[state.currentPhaseIndex];
    const changedPaths = phase.id === 'backend' ? backendPaths : phase.patchScope === 'phase' ? [`${phase.ownedPaths[0]}/${phase.id}.txt`] : [];
    const artifact = createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id, attemptId: state.activeAttempt.attemptId,
      sourceFingerprint: sha('accepted-source'), changedPaths, patchDigest: phase.patchScope === 'none' ? null : sha(phase.id),
      payload: Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, {}])) });
    const bytes = JSON.stringify(artifact); originals.set(artifact.artifactKind, bytes);
    await writeFile(path.join(artifactsDirectory, `${artifact.artifactKind}.json`), bytes);
    state = completeForgeDeliveryPhase({ state, catalog, decision: 'accepted', artifact,
      hostReceipts: receipts(phase, artifact.sourceFingerprint), now: stamp(generation) }).state;
  }
  const seven = state; state = begin(state, 8);
  state = recordForgeAccessAcceptedCorrection({ state, catalog, phaseId: 'backend', now: stamp(8), binding: {
    acceptedSourceFingerprint: sha('accepted-source'), failureEvidenceSha256: sha('failure'), jobId: null,
    executionId: crypto.randomUUID(), executionGeneration: 8, rpcId: state.activeAttempt.rpcId,
    workspaceFingerprint: sha('workspace'), candidateCommit: sourceCommit, sourceStateSha256: sha(JSON.stringify(state)),
    repairRequestSha256: sha('repair'), runtimeFailure: { observationId: crypto.randomUUID(), manifestSha256: sha('manifest'), formalTerminalSha256: sha('terminal') },
  } });
  state = begin(state, 9); await writeForgeDeliveryPhaseState(stateFile, state, catalog);
  const delta = backendPaths.filter(file => !file.endsWith('/Unchanged.java'));
  const all = [...new Set([...originals.values()].flatMap(bytes => JSON.parse(bytes).changedPaths))].sort();
  const proposal = { schemaVersion: 'forge-delivery-phase-proposal/v1', phaseId: 'backend', unresolvedDecisions: [],
    payload: { ...Object.fromEntries(backend.requiredPayloadKeys.map(key => [key, {}])), changedPaths: delta } };
  const inputs = { catalogFile, stateFile, artifactsDirectory, expectedAttemptId: state.activeAttempt.attemptId };
  for (const [key, name, value] of [
    ['responseFile', 'response.md', 'Isolated platform candidate; business acceptance is not claimed.\n<forge-phase-artifact>' + JSON.stringify(proposal) + '</forge-phase-artifact>'],
    ['allChangedPathsFile', 'all.json', JSON.stringify(all)], ['phaseChangedPathsFile', 'delta.json', JSON.stringify(delta)],
    ['phasePatchFile', 'phase.patch', 'isolated backend delta'], ['cumulativePatchFile', 'cumulative.patch', 'isolated cumulative source'],
  ]) { inputs[key] = path.join(root, name); await writeFile(inputs[key], value); }
  const backendFile = path.join(artifactsDirectory, 'backend-implementation.json');
  await writeFile(backendFile, originals.get('backend-implementation').replace('Unchanged.java', 'Tampered.java'));
  await assert.rejects(preflightForgeDeliveryPhaseRun({ ...inputs, receiptFile: path.join(root, 'tampered.json') }), error => /^PHASE_/.test(error.code));
  await writeFile(backendFile, originals.get('backend-implementation'));
  await writeFile(inputs.allChangedPathsFile, JSON.stringify([...all, 'unexpected.txt'].sort()));
  await assert.rejects(preflightForgeDeliveryPhaseRun({ ...inputs, receiptFile: path.join(root, 'drift.json') }), { code: 'PHASE_CONTROLLER_PATH_DRIFT' });
  await writeFile(inputs.allChangedPathsFile, JSON.stringify(all));
  const preflight = await preflightForgeDeliveryPhaseRun({ ...inputs, receiptFile: path.join(root, 'preflight.json') });
  assert.deepEqual(preflight.changedPaths, delta);
  const outputDirectory = path.join(root, 'final'); await mkdir(outputDirectory);
  const originalRequestFile = path.join(root, 'request.md'), hostReceiptsFile = path.join(root, 'host.json');
  await writeFile(originalRequestFile, 'Complete the isolated backend repair.');
  await writeFile(hostReceiptsFile, JSON.stringify(receipts(backend, sha('isolated cumulative source'))));
  await finalizeForgeDeliveryPhaseRun({ ...inputs, originalRequestFile, hostReceiptsFile, outputDirectory, nextPromptFile: path.join(root, 'prompt.md') });
  const accepted = await readForgeDeliveryPhaseState(stateFile, catalog);
  assert.equal(accepted.currentPhaseId, 'cross-layer-acceptance');
  for (const [kind, bytes] of originals) {
    assert.equal(await readFile(path.join(artifactsDirectory, `${kind}.json`), 'utf8'), bytes);
    if (kind !== 'backend-implementation') assert.equal(accepted.acceptedArtifacts[kind], seven.acceptedArtifacts[kind]);
  }
  assert.deepEqual(accepted.history.slice(0, -2), seven.history);
  const cross = beginForgeDeliveryPhase({ state: accepted, catalog, phaseId: accepted.currentPhaseId,
    rpcId: 'rpc-10', promptDigest: sha('prompt-10'), executionGeneration: 10 });
  await writeForgeDeliveryPhaseState(stateFile, cross, catalog);
  const phase = catalog.workflows[0].phases[7];
  const crossProposal = { schemaVersion: 'forge-delivery-phase-proposal/v1', phaseId: phase.id, unresolvedDecisions: [],
    payload: Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, {}])) };
  await writeFile(inputs.responseFile, '<forge-phase-artifact>' + JSON.stringify(crossProposal) + '</forge-phase-artifact>');
  await writeFile(inputs.phaseChangedPathsFile, '[]'); await writeFile(inputs.phasePatchFile, '');
  // Path closure succeeds; absent runtime receipts still block real cross acceptance.
  await assert.rejects(preflightForgeDeliveryPhaseRun({ ...inputs, expectedAttemptId: cross.activeAttempt.attemptId,
    receiptFile: path.join(root, 'cross.json') }), { code: 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED' });
});
