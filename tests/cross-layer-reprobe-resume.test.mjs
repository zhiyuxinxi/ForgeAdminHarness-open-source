import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isForgeAccessWiringPhaseCompletion, isForgeCrossLayerPreparationContinuation,
  isForgeCrossLayerRuntimeReprobeContinuation } from '../docker/harness/forge-protected-acceptance-service.mjs';
const prompt = "继续原消防跨层验收。当前 prepare 拒绝是输入格式问题，请停止猜测 browser 字段及 runtimeProbes 包装层。\n\n请先读取 forge-release capability 的现有合同；browser 必须是 {\"status\":\"not-executed\",\"reason\":\"owner-excluded\"}。原第89轮已成功准备的计划也使用此声明。请由你按该合同修正本轮计划，保留已设计的库存新增、入库、出库、无权限拒绝及数据库核验，用当前源码重新受控准备，再执行实际运行验收。不要以空 api/database 清单或增加浏览器操作绕过错误。\n\n复用当前源码、已通过的治理/编译/1581项测试与前七阶段，不重做这些检查；只推进新候选库存运行验收。未执行的消防需求及发布仍如实保留。\n\n上一轮已停止。若停止前最后一次 prepare 已创建作业，先查询实际作业结果并复用同源码候选，禁止重复构建；空清单不作为消防验收通过依据。\n";
const promptSha256 = "43eed4bdb82c351a986d757500e0b4504abc535627bf6267b8d2020176cff18d";

// This executes the production catch body only; real Manager/Harness routing is separate.
test('cross-layer missing-evidence fallback resumes original reprobe intent within its existing authority', async () => {
  assert.equal(crypto.createHash('sha256').update(prompt).digest('hex'), promptSha256);
  const source = await readFile(new URL('../docker/harness/conversation-manager.mjs', import.meta.url), 'utf8');
  const anchor = "                const preparationPhase = { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' };";
  assert.equal(source.split(anchor).length, 2, 'Expected exactly one production fallback');
  const start = source.indexOf(anchor), end = source.indexOf('\n              }', start);
  assert.ok(end > start);
  const body = source.slice(start, end);
  assert.match(body, /browserPhase = await prepareForgeCrossLayerPreparation/);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fallback = new AsyncFunction('error', 'workspaceWriteAuthorized', 'originalPrepareRequest', 'phaseFiles',
    'observation', 'taskId', 'prepareRequest', 'isForgeAccessWiringPhaseCompletion', 'isForgeCrossLayerPreparationContinuation',
    'isForgeCrossLayerRuntimeReprobeContinuation', 'prepareForgeCrossLayerPreparation', `let browserPhase;\n${body}\nreturn browserPhase;`);
  const phase = { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' };
  assert.equal(isForgeCrossLayerPreparationContinuation(prompt, phase), false);
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(prompt, phase), true);
  const observation = { source: { head: 'a'.repeat(40), fingerprint: 'b'.repeat(64) } };
  for (const [text, authorized, code, allowed] of [
    [prompt, true, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED', true],
    [prompt, false, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED', false],
    [prompt, true, 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', false],
    [prompt + '\n不要执行运行检查。', true, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED', false],
  ]) {
    const error = Object.assign(new Error('original refusal'), { code });
    const calls = [], result = { crossLayerPreparation: true };
    const invoke = () => fallback(error, authorized, { promptText: text }, { stateFile: 'isolated-state' }, observation,
      'task-reprobe', { dshSessionId: 'session-reprobe', rpcId: 'rpc-reprobe' }, isForgeAccessWiringPhaseCompletion,
      isForgeCrossLayerPreparationContinuation, isForgeCrossLayerRuntimeReprobeContinuation, async input => { calls.push(input); return result; });
    if (allowed) {
      assert.equal(await invoke(), result);
      assert.deepEqual(calls, [{ stateFile: 'isolated-state', sourceCommit: observation.source.head,
        workspaceFingerprint: observation.source.fingerprint, taskId: 'task-reprobe', sessionId: 'session-reprobe',
        rpcId: 'rpc-reprobe', promptText: prompt }]);
    } else {
      await assert.rejects(invoke, actual => actual === error);
      assert.equal(calls.length, 0);
    }
  }
});
