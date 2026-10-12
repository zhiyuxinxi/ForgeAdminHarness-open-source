import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { governedPersona } from '../docker/harness/forge-agent-preset-policy.mjs';
import {
  completionClaimConflict,
  completionEvidence,
  installCompletionClaimGuard,
  PROTECTED_COMPLETION_OBSERVATION_MARKER,
  protectedCompletionProjectionReady,
} from '../docker/harness/forge-completion-claim-guard.mjs';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { assertGovernedAssembly } from '../docker/harness/forge-governance-prompt-guard.mjs';
import { EXPECTED_PRESETS } from '../docker/harness/forge-agent-preset-prompt-probe.mjs';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const base = 'a'.repeat(40);
const verificationReceiptId = '123e4567-e89b-12d3-a456-426614174000';
const verificationAdmissionId = '123e4567-e89b-12d3-a456-426614174099';
const readyProtectedProjection = () => {
  const payload = {
    schemaVersion: 1,
    gateType: 'forge-protected-completion-gate/v1',
    evaluationMode: 'read-only-verifier',
    ledgerDigest: `sha256:${'1'.repeat(64)}`,
    ledgerSummaryDigest: `sha256:${'2'.repeat(64)}`,
    sourceFingerprint: `sha256:${'3'.repeat(64)}`,
    candidateDiffSha256: `sha256:${'4'.repeat(64)}`,
    evaluatedAt: '2026-09-01T01:00:00.000Z',
    signedVerdictVerified: true,
    outcome: 'READY',
    maximumTerminalOutcome: 'COMPLETE',
    cannotClaim: [],
    blockers: [],
    ledgerSummary: {
      taskContractId: 'task-contract-1',
      sourceFingerprint: '3'.repeat(64),
      counts: { closed: 14, open: 0 },
    },
    attestation: 'local-integrity-only; upstream-authentication-is-ed25519',
  };
  return { ...payload, gateDigest: canonicalSha256(payload) };
};
const governanceReceipt = (ok, obligations = []) => JSON.stringify({
  ok,
  receiptDigest: `sha256:${'b'.repeat(64)}`,
  obligations,
});
const verificationReceipt = (status, verificationProven) => JSON.stringify({
  receiptType: 'forge-verify/run',
  receiptId: verificationReceiptId,
  status,
  source: { workspaceFingerprint: 'c'.repeat(64) },
  request: {
    profile: 'backend-test-class',
    admissionId: verificationAdmissionId,
    selectors: { modules: ['forge-server/example'], tests: ['ExampleTest'] },
  },
  truth: { verificationProven, semanticCorrectnessProven: false },
});

test('web and headless Harness profiles wire the Forge completion floor and preset contract', async () => {
  const [
    runtimePatch, headlessPatch, startHarness, projectContext, dockerfile, overlay,
    presetPolicy, promptProbePatch, buildInputs, completionGuard, phaseBudgetGuard,
  ] = await Promise.all([
    read('docker/harness/forge-governance-runtime.patch.yml'),
    read('tests/fixtures/forge-harness-behavior-evals/headless-audit.patch.yml'),
    read('docker/harness/start-harness.sh'),
    read('templates/project/PROJECT_CONTEXT.md.tpl'),
    read('docker/harness/Dockerfile'),
    read('docker/harness/Dockerfile.overlay'),
    read('docker/harness/forge-agent-preset-policy.mjs'),
    read('docker/harness/forge-agent-preset-prompt-probe.patch.yml'),
    read('docker/harness/image-build-inputs.json'),
    read('docker/harness/forge-completion-claim-guard.mjs'),
    read('docker/harness/forge-phase-budget-guard.mjs'),
  ]);

  for (const patch of [runtimePatch, headlessPatch]) {
    assert.match(patch, /file:\/\/\/usr\/local\/lib\/forge-typed-file-removal\.mjs/u);
    assert.match(patch, /FORGE_HARNESS_GOVERNANCE_V1/u);
    assert.match(patch, /FORGE_PHASE_BUDGET_GUARD_V1/u);
    assert.match(patch, /Invoke forge-task-contract, forge-task-router/u);
    assert.match(patch, /Forge Task Execution\s+Contract/u);
    assert.match(patch, /Arbitrary shell and direct Git\s+commands fail closed/u);
    assert.match(patch, /Bash is\s+reserved only for exact/u);
    assert.match(patch, /\/usr\/local\/bin\/forge-governance/u);
    assert.match(patch, /\/usr\/local\/bin\/forge-verify/u);
    assert.match(patch, /invoke forge-evidence-truth/u);
    assert.match(patch, /forbids\s+claiming completed/u);
    assert.match(
      patch,
      /Identity, owned paths, permissions, tenant isolation, secrets and dangerous-operation authority remain mandatory/u,
    );
  }
  for (const patch of [runtimePatch, headlessPatch, presetPolicy]) {
    assert.match(patch, /Ordinary development suspends mandatory Skill order, RED-before-edit/u);
    assert.match(patch, /Integration and release still require actual applicable compilation/u);
  }
  const controlledCliParagraph = (source) => source.split('\n')
    .find((line) => line.includes('Use structured read, grep, glob, edit, write and remove_file'))
    .trim().replace(/^"/u, '').replace(/",$/u, '').trim();
  assert.equal(controlledCliParagraph(runtimePatch), controlledCliParagraph(headlessPatch));
  assert.equal(controlledCliParagraph(runtimePatch), controlledCliParagraph(presetPolicy));
  assert.match(controlledCliParagraph(runtimePatch), /forge-governance, \/usr\/local\/bin\/forge-verify, \/usr\/local\/bin\/forge-release and \/usr\/local\/bin\/forge-delivery argv shapes/u);
  assert.match(controlledCliParagraph(runtimePatch), /state writes require the current scoped writer contract/u);
  assert.match(controlledCliParagraph(runtimePatch), /verify record is not a model-facing operation/u);
  assert.match(controlledCliParagraph(runtimePatch), /forge-release is a CLI invoked through Bash, not a separately registered tool/u);
  assert.match(controlledCliParagraph(runtimePatch), /authorized checkpoint, integrate and release actions under the valid Forge Task Execution Contract/u);
  assert.match(runtimePatch, /default: standard/u);
  assert.match(runtimePatch, /includeUserRoot: false/u);
  assert.match(runtimePatch, /file:\/\/\/usr\/local\/lib\/forge-governance-prompt-guard\.mjs/u);
  assert.match(headlessPatch, /file:\/\/\/usr\/local\/lib\/forge-governance-prompt-guard\.mjs/u);
  assert.match(runtimePatch, /file:\/\/\/usr\/local\/lib\/forge-completion-claim-guard\.mjs/u);
  assert.match(headlessPatch, /file:\/\/\/usr\/local\/lib\/forge-completion-claim-guard\.mjs/u);
  assert.match(runtimePatch, /file:\/\/\/usr\/local\/lib\/forge-phase-budget-guard\.mjs/u);
  assert.match(headlessPatch, /file:\/\/\/usr\/local\/lib\/forge-phase-budget-guard\.mjs/u);
  assert.match(promptProbePatch, /file:\/\/\/usr\/local\/lib\/forge-agent-preset-prompt-probe\.mjs/u);
  assert.match(startHarness, /--patch \/usr\/local\/share\/forge-governance-runtime\.patch\.yml/u);
  assert.match(projectContext, /FORGE_PROJECT_COMPLETION_GATE_V1/u);
  assert.deepEqual(EXPECTED_PRESETS, ['standard']);
  assert.match(presetPolicy, /DISABLED_PRESETS = Object\.freeze\(\['code', 'cordis', 'minimal'\]\)/u);
  assert.match(presetPolicy, /upstream composition hash changed/u);
  assert.match(presetPolicy, /runtime preset roster must be exactly/u);
  for (const image of [dockerfile, overlay]) {
    assert.match(image, /docker\/harness\/forge-typed-file-removal\.mjs/u);
    assert.match(image, /node --check \/usr\/local\/lib\/forge-typed-file-removal\.mjs/u);
    assert.match(image, /docker\/harness\/forge-governance-runtime\.patch\.yml/u);
    assert.match(image, /\/usr\/local\/share\//u);
    assert.match(image, /forge-agent-preset-policy\.mjs (?:apply|verify)/u);
    assert.match(image, /agent-preset-prompt-contract\.json/u);
    assert.match(image, /forge-agent-preset-prompt-probe\.patch\.yml/u);
    assert.match(image, /forge-completion-claim-guard\.mjs/u);
  }
  for (const file of [
    'forge-agent-preset-policy.mjs',
    'forge-agent-preset-prompt-probe.mjs',
    'forge-agent-preset-prompt-probe.patch.yml',
    'forge-governance-prompt-guard.mjs',
    'forge-completion-claim-guard.mjs',
    'forge-controlled-command.mjs',
    'forge-task-execution-contract.mjs',
    'forge-execution-capability-registry.json',
    'forge-execution-capability-registry.mjs',
    'forge-capability-negotiator.mjs',
    'forge-execution-pack.mjs',
    'forge-execution-store.mjs',
    'forge-execution-orchestrator.mjs',
    'forge-progress-detector.mjs',
    'forge-acceptance-aggregator.mjs',
    'forge-protected-issuer-adapter.mjs',
    'forge-production-task-grant.mjs',
    'forge-protected-acceptance-service.mjs',
    'forge-ui-contract.mjs',
    'forge-ui-contract.json',
  ]) assert.match(buildInputs, new RegExp(file.replaceAll('.', '\\.'), 'u'));
  assert.match(completionGuard, /agent\/turn-stopping/u);
  assert.match(completionGuard, /agent\.steer/u);
  assert.match(phaseBudgetGuard, /agent\/pre-step/u);
  assert.match(phaseBudgetGuard, /tools\/pre-execute/u);
  assert.match(phaseBudgetGuard, /tools\/result/u);
  assert.match(phaseBudgetGuard, /ctx\.tools\.guard/u);
  assert.match(phaseBudgetGuard, /agent\/turn-stopping/u);
  assert.match(phaseBudgetGuard, /agent\.cancel/u);
});

test('governed preset upgrade admits the observed release CLI and rejects unreviewed personas', async (t) => {
  const evidence = JSON.parse(await read('docs/validation-evidence/2026-09-23-release-preset-consumer.json'));
  const captured = evidence.files.find((file) => file.path.endsWith('/standard/agent.cordis.yml'));
  const oldText = captured.lines.map((line, index) => {
    assert.equal(line.line, index + 1);
    return line.text;
  }).join('\n');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(oldText), '9eaf793755e422e967fae3080ea1ddec783dc4bf0f679e011a10af78596ee6be');
  assert.equal(Buffer.byteLength(oldText), captured.bytes);
  const start = oldText.indexOf('    text: |-');
  const end = oldText.indexOf('\n\n- id: agent-instructions', start);
  assert.ok(start >= 0 && end > start);
  const original = oldText.slice(0, start) + [
    '    text: >-',
    '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  ].join('\n') + oldText.slice(end);
  assert.equal(digest(original), 'fa14feb98daef20b810fef30bb7239a89a786de3c45c602b37743f7100d9a5af');
  const expected = governedPersona(original, 'standard');

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-release-preset-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, 'dsh', 'config', 'agent-presets');
  const file = path.join(root, 'standard', 'agent.cordis.yml');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, oldText);
  const policy = fileURLToPath(new URL('../docker/harness/forge-agent-preset-policy.mjs', import.meta.url));
  const invoke = (command) => promisify(execFile)(process.execPath, [policy, command, '--root', root]);
  const upgraded = JSON.parse((await invoke('upgrade')).stdout);
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.presets[0].sha256, digest(expected));
  assert.equal(await readFile(file, 'utf8'), expected);
  assert.match(expected, /forge-release is a CLI invoked through Bash, not a separately registered tool/u);
  assert.match(expected, /Arbitrary shell and direct Git commands fail closed/u);
  assert.deepEqual(JSON.parse((await invoke('upgrade')).stdout), upgraded);
  assert.deepEqual(JSON.parse((await invoke('verify')).stdout), upgraded);

  const unknown = oldText + '\n# unreviewed change\n';
  await writeFile(file, unknown);
  await assert.rejects(invoke('upgrade'), /upgrade refuses an unknown governed persona/u);
  assert.equal(await readFile(file, 'utf8'), unknown);
});

test('prompt guard fails closed when the final assembled prompt loses the governance floor', () => {
  const governed = {
    sections: [{
      name: 'deployment:persona',
      text: 'FORGE_HARNESS_GOVERNANCE_V1 Invoke forge-task-contract, forge-task-router invoke forge-evidence-truth forbids claiming completed',
    }],
  };
  assert.equal(assertGovernedAssembly(governed), governed);
  assert.throws(
    () => assertGovernedAssembly({ sections: [{ name: 'deployment:persona', text: 'ordinary persona' }] }),
    /assembled prompt is missing FORGE_HARNESS_GOVERNANCE_V1/u,
  );
});

test('completion claim guard detects contradictory final status without flagging quoted prohibitions', () => {
  assert.deepEqual(
    completionClaimConflict('所有工作已完成。Maven 测试未运行，浏览器验收未验证。')?.claim,
    '所有工作已完成',
  );
  assert.ok(completionClaimConflict('The task is complete. Required integration tests were not run.'));
  assert.ok(completionClaimConflict('测试未运行，但所有工作已完成。'));
  assert.ok(completionClaimConflict('Tests were not run, but the task is complete.'));
  assert.ok(completionClaimConflict('实现已就绪，但 Maven 尚未验证。'));
  assert.ok(completionClaimConflict('Everything is fully delivered, but browser acceptance is unverified.'));
  assert.ok(completionClaimConflict('验证通过，但迁移未执行。'));
  assert.equal(
    completionClaimConflict('不得声称“所有工作已完成”；当前只是静态候选，Maven 未运行。'),
    null,
  );
  assert.equal(completionClaimConflict('所有工作已完成。预期负向测试 exit code 1，拒绝路径正确。'), null);
  assert.equal(completionClaimConflict('所有工作已完成。不存在未验证项，全部证据已核对。'), null);
  assert.equal(completionClaimConflict('所有工作已完成。用户要求中引用了“测试未运行”，实际测试均有通过证据。'), null);
  assert.equal(completionClaimConflict('所有工作已完成。治理、测试与运行验收均有通过证据。'), null);
  assert.equal(
    completionClaimConflict(
      '不能声称 TDD 闭环或测试通过。任务仍处「实施完成、验证阻塞」状态，不构成完成或通过。',
      { blockers: ['maven-verification-failed'] },
    ),
    null,
  );
  for (const truthfulBlockedStatus of [
    '因此当前仅为候选实现，尚不能认定整体测试通过、验证完成或已交付；也未部署、发布。',
    '尚不能认为所有测试均通过；仍存在失败项。',
    '不能声明测试通过，当前测试仍未执行。',
    '不能算测试通过、功能完成或已经上线。\n\n真实状态是：**仅完成方案和改动范围准备**；尚未修改任何文件，未实施功能，未运行测试、Lint、构建或浏览器验证，也未提交、发布或部署。',
    '不得声明 TDD 闭环或测试通过。',
    '未宣称测试通过。',
    '测试执行被平台准备阻塞，未宣称测试通过或数据库运行时验证通过。',
    '并未宣称所有测试均已通过。',
    '不宣称验证通过。',
    '没有任何运行时验证通过。',
    '| Maven 最窄测试通过 | `unverified`（blocked：`VERIFY_CACHE_MISS`） |',
  ]) {
    assert.equal(
      completionClaimConflict(truthfulBlockedStatus, { blockers: ['maven-verification-failed'] }),
      null,
    );
  }
  assert.ok(completionClaimConflict(
    '不能声称测试通过，但任务已完成。',
    { blockers: ['maven-verification-failed'] },
  ));
  for (const contradictoryStatus of [
    '尚不能认定整体测试通过，但所有工作已完成。',
    '不能声明测试通过，但任务已完成。',
    '不能算测试通过，但任务已完成。',
    '不得声明测试通过。实际所有测试均已通过。',
    '未宣称测试通过，但任务已完成。',
    '未宣称测试通过，但全部验证已通过。',
    '未宣称测试通过。实际所有测试均已通过。',
    '不宣称验证通过，不过实现已就绪。',
  ]) {
    assert.ok(completionClaimConflict(
      contradictoryStatus,
      { blockers: ['maven-verification-failed'] },
    ));
  }
});

test('completion claim guard keeps the observed not-announced validation failure terminal', () => {
  const text = '当前页面按钮权限验证失败，因此没有宣布组件验证通过。';
  const evidence = { blockers: ['frontend-verification-failed'] };
  assert.equal(completionClaimConflict(text), null);
  assert.equal(completionClaimConflict(text, evidence), null);
  for (const contradictory of [
    '当前页面按钮权限验证失败，因此宣布组件验证通过。',
    text + '但本次验证通过。',
    '没有宣布组件验证通过，不过任务已完成。',
  ]) assert.ok(completionClaimConflict(contradictory, evidence), contradictory);

  let stop;
  const steered = [];
  installCompletionClaimGuard({ on(_event, handler) { stop = handler; } }, input => input);
  const message = { id: 'truthful-button-permission-failure', role: 'assistant', content: [{ type: 'text', text }] };
  const agent = { session: { events: [{ type: 'assistant/message', data: { turn: 39, message } }] },
    steer(value) { steered.push(value); } };
  stop({ agent, turn: 39 });
  stop({ agent, turn: 39 });
  assert.equal(steered.length, 0, 'a truthful negative answer must not consume a correction step');
  agent.session.events.push({ type: 'assistant/message', data: { turn: 39,
    message: { ...message, id: 'false-button-permission-pass', content: [{ type: 'text', text: text + '但本次验证通过。' }] } } });
  stop({ agent, turn: 39 });
  stop({ agent, turn: 39 });
  assert.equal(steered.length, 1, 'a later affirmative contradiction is still corrected exactly once');
});

test('completion claim guard preserves scoped results and negated claims without hiding current failures', () => {
  const truthful = [
    '单元测试通过，生产部署未执行。',
    '测试通过，历史失败记录已保留。',
    '本轮测试通过，历史失败记录已保留。',
    '测试通过，失败数为0。',
    '本轮测试通过，失败数为 0。',
    '不能据此记录测试通过或宣布验收完成。',
    '当前无法证明测试通过，任务验收未完成。',
    '状态名本身不证明测试通过或业务发布。',
  ];
  assert.deepEqual(truthful.map(text => completionClaimConflict(text)), truthful.map(() => null));
  for (const text of truthful.slice(5)) {
    assert.equal(completionClaimConflict(text, { blockers: ['maven-verification-failed'] }), null, text);
  }
  for (const text of [
    '所有工作已完成。单元测试通过，生产部署未执行。',
    '单元测试通过，生产部署未执行，但任务已就绪。',
    '测试通过，但测试未执行。',
    '单元测试通过，但本次测试失败。',
    '测试通过，失败数为1。',
    '测试通过，失败数为10。',
    '测试通过，失败数为0.5。',
    '测试通过，历史失败记录已保留，但本轮仍失败。',
    '测试通过，失败数为0，但退出码为1。',
  ]) assert.ok(completionClaimConflict(text), text);
  assert.ok(completionClaimConflict('测试通过，失败数为0。', { blockers: ['maven-verification-failed'] }));
  for (const text of [
    '不能据此记录测试通过，但所有工作已完成。',
    '当前无法证明测试通过，实际所有测试均已通过。',
  ]) assert.ok(completionClaimConflict(text, { blockers: ['maven-verification-failed'] }), text);

  let stop;
  const steered = [];
  installCompletionClaimGuard({ on(_event, handler) { stop = handler; } }, value => value);
  for (const text of truthful) {
    const agent = { session: { events: [{ type: 'assistant/message', seq: 1, data: {
      turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] },
    } }] }, steer(message) { steered.push(message); } };
    stop({ agent, turn: 1 });
  }
  assert.equal(steered.length, 0, 'truthful zero-tool answers must end without a correction turn');
});

test('completion evidence binds claims to verification outcomes without a mandatory Skill call', () => {
  const agent = { session: { events: [
    { type: 'tool/call', data: { turn: 8, callId: 'edit-1', name: 'edit', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'edit-1' }, content: [] } } },
    { type: 'tool/call', data: { turn: 8, callId: 'skill-1', name: 'skill', arguments: '{"name":"forge-evidence-truth"}' } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'skill-1' }, content: [] } } },
    { type: 'tool/call', data: { turn: 8, callId: 'audit-1', name: 'bash', arguments: JSON.stringify({ command: `forge-governance audit --root /workspace --base ${base} --format json` }) } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'audit-1' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(false) }] }] } } },
  ] } };
  const failed = completionEvidence(agent, 8);
  assert.deepEqual(failed.blockers, ['forge-governance-verification-failed']);
  assert.ok(completionClaimConflict('所有工作已完成。', failed));

  agent.session.events.push(
    { type: 'tool/call', data: { turn: 8, callId: 'audit-2', name: 'bash', arguments: JSON.stringify({ command: `forge-governance audit --root /workspace --base ${base} --format json` }) } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'audit-2' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true) }] }] } } },
  );
  agent.session.events = agent.session.events.filter((event) => event.data?.callId !== 'skill-1'
    && event.data?.message?.source?.callId !== 'skill-1');
  const passed = completionEvidence(agent, 8);
  assert.equal(passed.evidenceSkillObserved, false);
  assert.deepEqual(passed.blockers, []);
  assert.equal(completionClaimConflict('所有工作已完成。治理与全部必需验证均有通过证据。', passed), null);

  agent.session.events.push(
    { type: 'tool/call', data: { turn: 8, callId: 'audit-obligation', name: 'bash', arguments: { command: `forge-governance audit --root /workspace --base ${base} --format json` } } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'audit-obligation' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true, [{ ruleId: 'BE-RELIABILITY-001' }]) }] }] } } },
  );
  assert.deepEqual(completionEvidence(agent, 8).blockers, ['protected-obligation-closure-missing-or-blocked']);
  const projection = readyProtectedProjection();
  assert.equal(protectedCompletionProjectionReady(projection), true);
  assert.deepEqual(completionEvidence(agent, 8, projection).blockers, []);
  assert.equal(protectedCompletionProjectionReady({ ...projection, outcome: 'BOUNDED_BLOCKED' }), false);
  agent.session.events.push({
    type: 'assistant/message',
    data: {
      turn: 8,
      message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(projection) }] },
    },
  });
  assert.deepEqual(
    completionEvidence(agent, 8).blockers,
    ['protected-obligation-closure-missing-or-blocked'],
    'model-emitted projection JSON must not enter the protected resolver channel',
  );
  agent.session.events.push(
    { type: 'tool/call', data: { turn: 8, callId: 'audit-clean', name: 'bash', arguments: { command: `forge-governance audit --root /workspace --base ${base} --format json` } } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'audit-clean' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true) }] }] } } },
  );

  const missing = completionEvidence({ session: { events: agent.session.events.slice(0, 2) } }, 8);
  assert.deepEqual(missing.blockers, ['forge-governance-audit-missing']);

  const projectedArguments = completionEvidence({ session: { events: [
    { type: 'tool/call', data: { turn: 9, callId: 'edit-2', name: 'write', arguments: {} } },
    { type: 'tool/call', data: { turn: 9, callId: 'skill-2', name: 'skill', arguments: { skill: 'forge-evidence-truth' } } },
    { type: 'tool/call', data: { turn: 9, callId: 'audit-3', name: 'bash', arguments: { command: `forge-governance audit --root /workspace --base ${base} --format json` } } },
    { type: 'tool/result', data: { turn: 9, message: { source: { callId: 'audit-3' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true) }] }] } } },
  ] } }, 9);
  assert.equal(projectedArguments.evidenceSkillObserved, true);
  assert.deepEqual(projectedArguments.blockers, []);

  agent.session.events.push(
    { type: 'tool/call', data: { turn: 8, callId: 'verify-1', name: 'bash', arguments: { command: `forge-verify run --profile backend-test-class --module forge-server/example --test ExampleTest --admission-id ${verificationAdmissionId} --idempotency-key runtime-test-12345678` } } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'verify-1' }, content: [{ isError: false, content: [{ type: 'text', text: verificationReceipt('failed-zero-tests', false) }] }] } } },
  );
  assert.deepEqual(completionEvidence(agent, 8).blockers, ['forge-verify-backend-test-class-verification-failed']);
  agent.session.events.push(
    { type: 'tool/call', data: { turn: 8, callId: 'verify-2', name: 'bash', arguments: { command: `forge-verify run --profile backend-test-class --module forge-server/example --test ExampleTest --admission-id ${verificationAdmissionId} --idempotency-key runtime-test-12345678` } } },
    { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'verify-2' }, content: [{ isError: false, content: [{ type: 'text', text: verificationReceipt('passed', true) }] }] } } },
  );
  assert.deepEqual(completionEvidence(agent, 8).blockers, []);
});

test('completion evidence cannot be forged with composed shell output', () => {
  const forged = completionEvidence({ session: { events: [
    { type: 'tool/call', data: { turn: 4, callId: 'edit', name: 'edit', arguments: {} } },
    { type: 'tool/call', data: { turn: 4, callId: 'skill', name: 'skill', arguments: { name: 'forge-evidence-truth' } } },
    { type: 'tool/call', data: { turn: 4, callId: 'fake', name: 'bash', arguments: { command: `printf '{"ok":true}'; forge-governance audit --base ${base}` } } },
    { type: 'tool/result', data: { turn: 4, message: { source: { callId: 'fake' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true) }] }] } } },
  ] } }, 4);
  assert.deepEqual(forged.blockers, ['forge-governance-audit-missing']);
});

test('completion evidence rejects a zero-action completion claim for an implementation request', () => {
  const agent = { session: { events: [
    {
      type: 'user/message',
      data: {
        turn: 5,
        message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请修复 PageQuery 分页边界。' }] },
      },
    },
  ] } };
  const evidence = completionEvidence(agent, 5);
  assert.equal(evidence.writeIntentObserved, true);
  assert.deepEqual(evidence.blockers, ['source-implementation-evidence-missing']);
  assert.ok(completionClaimConflict('任务已完成。所有测试均已通过。', evidence));
});

test('completion guard reconciles unfinished current-turn todos without replaying work or creating a retry loop', async (t) => {
  const pair = (id, name, args, text, turn = 3, isError = false) => [
    { type: 'tool/call', data: { turn, callId: id, name, arguments: JSON.stringify(args) } },
    { type: 'tool/result', data: { turn, message: { source: { callId: id }, content: [{ isError, content: [{ type: 'text', text }] }] } } },
  ];
  const todo = (status = 'in_progress', turn = 3, failed = false) => pair('todo', 'todo_write', {
    todos: [{ content: '完成最终证据绑定复核', status }],
  }, failed ? 'todo write rejected' : 'Updated todo list', turn, failed);
  const final = { type: 'assistant/message', data: { turn: 3, message: {
    role: 'assistant', content: [{ type: 'text', text: '前端25/25通过。目前您无需操作；仅剩最终证据绑定复核，未进行发布或部署。' }],
  } } };
  const fixture = (events, projection = null) => {
    const handlers = new Map(); const steered = [];
    const agent = { session: { events: [...events, final] }, steer(message) { steered.push(message); } };
    installCompletionClaimGuard({ on(event, handler) { handlers.set(event, handler); } }, (message) => message, () => projection);
    return { agent, steered, stop: () => handlers.get('agent/turn-stopping')({ agent, turn: 3 }) };
  };
  await t.test('actual completed watcher plus unfinished evidence todo gets one actionable reconciliation', async () => {
    const f = fixture([
      ...pair('watch', 'bash', { run_in_background: true }, 'started background job bash-16'),
      ...pair('collect', 'job_output', { job_id: 'bash-16' }, '[status: completed, exit code: 0]'),
      ...todo(),
    ]);
    const original = JSON.stringify(f.agent.session.events);
    await f.stop();
    assert.equal(f.steered.length, 1);
    assert.equal(f.steered[0].source.form, 'todo-status-reconciliation');
    assert.match(f.steered[0].content[0].text, /forge-verify run --reuse-receipt/u);
    assert.match(f.steered[0].content[0].text, /Respect an explicit pause, stop, analysis-only request/u);
    assert.equal(JSON.stringify(f.agent.session.events), original, 'the guard must not mutate the plan or fabricate results');
    await f.stop();
    assert.equal(f.steered.length, 1, 'the same pending plan must not start an unbounded correction loop');
  });
  await t.test('failed native watcher is terminal and cannot suppress unfinished todo reconciliation', async () => {
    for (const [text, isError] of [
      ['Verification failed\n[status: completed, exit code: 1]', true],
      ['{"ok":false}\n[status: completed, exit code: 1]', false],
      ['[exit code: 1]\n[status: failed, exit code: 1]', false],
    ]) {
      const f = fixture([
        ...todo(),
        ...pair('watch', 'bash', { run_in_background: true }, 'started background job bash-16'),
        ...pair('collect', 'job_output', { job_id: 'bash-16' }, text, 3, isError),
      ]);
      const original = JSON.stringify(f.agent.session.events);
      await f.stop();
      assert.equal(f.steered.length, 1);
      assert.equal(f.steered[0].source.form, 'todo-status-reconciliation');
      assert.equal(JSON.stringify(f.agent.session.events), original, 'the failed native result must remain unchanged');
    }
  });
  await t.test('automatically backgrounded release requires its real native job acknowledgement', async () => {
    const release = { command: 'forge-release release --services forge-admin,forge-ui', timeoutMs: 30000 };
    const active = fixture([...todo(), ...pair('release', 'bash', release, 'started background job bash-16')]);
    await active.stop();
    assert.equal(active.steered.length, 0);
    for (const [args, text, isError] of [
      [release, 'release accepted', false],
      [release, 'Failed; previous output: started background job bash-16', false],
      [release, 'started background job bash-16', true],
      [{ command: 'echo started background job bash-16' }, 'started background job bash-16', false],
    ]) {
      const missing = fixture([...todo(), ...pair('release', 'bash', args, text, 3, isError)]);
      await missing.stop();
      assert.equal(missing.steered.length, 1, 'a command or failed/quoted output cannot manufacture an active observer');
    }
    const collected = fixture([...todo(), ...pair('release', 'bash', release, 'started background job bash-16'),
      ...pair('collect-release', 'job_output', { job_id: 'bash-16' }, '[status: completed, exit code: 0]')]);
    await collected.stop();
    assert.equal(collected.steered.length, 1, 'after collecting the release result, remaining in-progress work is reconciled normally');
  });
  for (const [name, events] of [
    ['historical plan in a status-only turn', todo('in_progress', 2)],
    ['failed todo update', todo('in_progress', 3, true)],
    ['completed todo', todo('completed')],
    ['pending work is honestly not running', todo('pending')],
    ['registered unfinished native background job', [...todo(), ...pair('watch', 'bash', { run_in_background: true }, 'started background job bash-16')]],
    ['an earlier job is still running when observed this turn', [...todo(), ...pair('collect', 'job_output', { job_id: 'bash-16' }, '[status: running]')]],
  ]) await t.test(name, async () => {
    const f = fixture(events);
    await f.stop();
    assert.equal(f.steered.length, 0);
  });
  await t.test('READY proof accompanies stale todo reconciliation and does not require new tests', async () => {
    const f = fixture(todo(), readyProtectedProjection());
    await f.stop();
    assert.equal(f.steered.length, 1);
    assert.match(f.steered[0].content[0].text, /FORGE_PROTECTED_COMPLETION_OBSERVATION_V1/u);
    assert.match(f.steered[0].content[0].text, /not new authorization, a test rerun requirement/u);
  });
});

test('completion claim guard steers a correction before the DSH turn can close', () => {
  const handlers = new Map();
  const steered = [];
  const ctx = {
    on(name, callback) {
      handlers.set(name, callback);
    },
  };
  const createUserMessage = (input) => ({ id: 'fixture-message', role: 'user', ...input });
  installCompletionClaimGuard(ctx, createUserMessage);
  const handler = handlers.get('agent/turn-stopping');
  const agent = {
    session: {
      events: [{
        type: 'assistant/message',
        data: {
          turn: 3,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '不能声明测试通过，当前测试仍未执行。' }],
          },
        },
      }],
    },
    steer(message) { steered.push(message); },
  };
  handler({ agent, turn: 3 });
  assert.equal(steered.length, 0, 'an explicit negated claim must not inject another correction turn');
  agent.session.events[0].data.message.content[0].text = '不能算测试通过、功能完成或已经上线。仅完成方案准备，测试未执行。';
  handler({ agent, turn: 3 });
  assert.equal(steered.length, 0, 'a plan-only status must not be mistaken for a passing test claim');
  agent.session.events[0].data.message.content[0].text = '所有工作已完成。后端测试未运行，迁移未验证。';
  handler({ agent, turn: 3 });
  assert.equal(steered.length, 1);
  assert.equal(steered[0].source.plugin, 'forge-completion-claim-guard');
  assert.match(steered[0].content[0].text, /FORGE_COMPLETION_CLAIM_GUARD_V1/u);
  assert.match(steered[0].content[0].text, /Do not repeat the broad completion claim/u);

  handler({ agent, turn: 3 });
  assert.equal(steered.length, 1, 'repeated stopping event for the same assistant message must be idempotent');

  agent.session.events.push({
    type: 'assistant/message',
    data: {
      turn: 3,
      message: {
        id: 'second-contradictory-message',
        role: 'assistant',
        content: [{ type: 'text', text: '测试未运行，但任务已完成。' }],
      },
    },
  });
  handler({ agent, turn: 3 });
  assert.equal(steered.length, 2, 'a new contradictory assistant message must consume another correction step');

  agent.session.events.push({
    type: 'assistant/message',
    data: {
      turn: 3,
      message: {
        id: 'third-contradictory-message',
        role: 'assistant',
        content: [{ type: 'text', text: '任务已完成，但数据库迁移未执行。' }],
      },
    },
  });
  assert.throws(
    () => handler({ agent, turn: 3 }),
    /model repeated a contradictory completion claim after 2 correction steps/u,
  );
});

test('a verified final summary closes without an extra READY model request', async () => {
  for (const text of [
    '小数尾差已最小修复并发布。定向前端7项测试、Lint、治理检查均通过。现在可按计划做浏览器核验。',
    '三个指定测试完整组合11/11通过，0失败、0跳过。未修改任何文件，未提交、未发布。',
  ]) {
    let stop;
    const steered = [];
    const agent = { session: { events: [{ type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }] }, steer(value) { steered.push(value); } };
    installCompletionClaimGuard({ on(_event, handler) { stop = handler; } }, (input) => input, async () => readyProtectedProjection());
    await stop({ agent, turn: 1 });
    assert.equal(steered.length, 0, 'READY with a consistent summary must not start another model stream');
  }
});

test('completion guard consumes obligation closure only through its protected resolver', () => {
  const handlers = new Map();
  const context = { on(event, callback) { handlers.set(event, callback); } };
  const projection = readyProtectedProjection();
  const steered = [];
  const agent = {
    session: { events: [
      { type: 'tool/call', data: { turn: 6, callId: 'audit', name: 'bash', arguments: { command: `forge-governance audit --root /workspace --base ${base} --format json` } } },
      { type: 'tool/result', data: { turn: 6, message: { source: { callId: 'audit' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true, [{ ruleId: 'BE-RELIABILITY-001' }]) }] }] } } },
      { type: 'assistant/message', data: { turn: 6, message: { id: 'protected-ready', role: 'assistant', content: [{ type: 'text', text: '任务已完成，全部验收证据已通过。' }] } } },
    ] },
    steer(message) { steered.push(message); },
  };
  installCompletionClaimGuard(context, (text) => text, () => projection);
  const handler = handlers.get('agent/turn-stopping');
  handler({ agent, turn: 6 });
  assert.equal(steered.length, 0);
  handler({ agent, turn: 6 });
  assert.equal(steered.length, 0, 'closed protected obligations must not trigger correction');
});

test('completion guard awaits an asynchronous protected resolver and fails closed on resolver error', async () => {
  let handler;
  const context = { on(_event, callback) { handler = callback; } };
  let steered = 0;
  const agent = {
    session: { events: [
      { type: 'tool/call', data: { turn: 7, callId: 'audit', name: 'bash', arguments: { command: `forge-governance audit --root /workspace --base ${base} --format json` } } },
      { type: 'tool/result', data: { turn: 7, message: { source: { callId: 'audit' }, content: [{ isError: false, content: [{ type: 'text', text: governanceReceipt(true, [{ ruleId: 'BE-RELIABILITY-001' }]) }] }] } } },
      { type: 'assistant/message', data: { turn: 7, message: { id: 'async-ready', role: 'assistant', content: [{ type: 'text', text: '任务已完成。' }] } } },
    ] },
    steer() { steered += 1; },
  };
  installCompletionClaimGuard(context, (value) => value, async () => readyProtectedProjection());
  await handler({ agent, turn: 7 });
  assert.equal(steered, 0);

  installCompletionClaimGuard(context, (value) => value, async () => { throw new Error('unavailable'); });
  await handler({ agent, turn: 7 });
  assert.equal(steered, 1);
});

test('trusted blocked completion corrects current READY claims without renewing authority', async t => {
  const originalReply = '最终证据绑定复核已真实完成并收口：\n\n- 前端测试回执有效且为当前候选：25/25 通过。\n- 治理回执有效且为当前候选：检查通过。\n- 正式完成结论保持 **READY，16/16 项义务关闭**，无剩余验证缺项。\n\n任务清单已全部完成。本轮仅只读核对，未修改文件、未重跑检查、未提交或发布。';
  const seal = value => {
    const { gateDigest: _ignored, ...payload } = value;
    return { ...payload, gateDigest: canonicalSha256(payload) };
  };
  const blockedProjection = () => {
    const sourceFingerprint = '682c89dd756612a7c602cf876bbe686cade00676801b7f9635bae1e1369d324f';
    const summary = { schemaVersion: 1, summaryType: 'forge-obligation-ledger-summary/v1',
      taskContractId: 'b39233d0e8e4c17b81b271fd6d8cd839200e8af5de941df3c08895c40ad14ff0',
      sourceFingerprint, generation: 1, ledgerDigest: `sha256:${'1'.repeat(64)}`,
      counts: { total: 16, open: 0, closed: 16, stale: 0 }, open: [],
      closed: Array.from({ length: 16 }, (_, index) => ({ id: `contract:obligation-${index}`, receiptId: `adapter-${index}` })), stale: [] };
    const summaryDigest = canonicalSha256(summary);
    return seal({ ...readyProtectedProjection(), sourceFingerprint: `sha256:${sourceFingerprint}`,
      evaluatedAt: '2026-10-08T10:46:19.524Z', outcome: 'BOUNDED_BLOCKED', maximumTerminalOutcome: 'BOUNDED_BLOCKED',
      ledgerDigest: summary.ledgerDigest, ledgerSummaryDigest: summaryDigest, ledgerSummary: { ...summary, summaryDigest },
      signedVerdictVerified: true, cannotClaim: ['implemented', 'verified', 'accepted', 'complete', 'released'],
      blockers: [
        { code: 'ACCEPTANCE_CONTRACT_EXPIRED', detail: 'The signed acceptance contract has expired; current authority and evidence require formal revalidation.' },
        ...summary.closed.map(item => ({ code: 'LEDGER_CLOSURE_PROVENANCE_INVALID', detail: `Ledger closure ${item.id} has invalid signed provenance.` })),
        ...Array.from({ length: 4 }, (_, index) => ({ code: 'SIGNED_RECEIPT_INVALID', detail: `signedReceipts[${index}] failed protected verification.` })),
      ] });
  };
  const setup = (projection, text = originalReply) => {
    let stop;
    const steered = [];
    const events = [];
    const append = (messageText, id) => events.push({ type: 'assistant/message', seq: 22950 + events.length,
      data: { turn: 7, message: { id, role: 'assistant', content: [{ type: 'text', text: messageText }] } } });
    append(text, 'original');
    const agent = { session: { events }, steer(message) { steered.push(message); } };
    installCompletionClaimGuard({ on(_event, handler) { stop = handler; } }, input => input, async () => projection);
    return { stop: () => stop({ agent, turn: 7 }), steered, append, events };
  };
  await t.test('expired signed projection corrects the actual final claim once and accepts an honest correction', async () => {
    const projection = blockedProjection();
    const before = JSON.stringify(projection);
    assert.equal(protectedCompletionProjectionReady(projection), false);
    const f = setup(projection);
    const originalEvents = JSON.stringify(f.events);
    await f.stop(); await f.stop();
    assert.equal(f.steered.length, 1);
    assert.equal(f.steered[0].source.form, 'trusted-blocked-observation');
    const text = f.steered[0].content[0].text;
    assert.match(text, /current code contract execution acceptance is BOUNDED_BLOCKED/u);
    for (const code of ['ACCEPTANCE_CONTRACT_EXPIRED', 'LEDGER_CLOSURE_PROVENANCE_INVALID', 'SIGNED_RECEIPT_INVALID']) assert.ok(text.includes(code));
    assert.match(text, /"closed":16/u);
    assert.match(text, /"open":0/u);
    assert.match(text, /"signedVerdictVerified":true/u);
    assert.match(text, /does not authorize renewal, receipt revalidation, rerunning checks/u);
    assert.match(text, /respect the current read-only request/u);
    assert.equal(JSON.stringify(f.events), originalEvents);
    assert.equal(JSON.stringify(projection), before);
    f.append('当前正式验收合同已过期，需恢复授权后继续复核。历史测试通过结果保留；本轮未续期、未重跑检查。', 'corrected');
    await f.stop();
    assert.equal(f.steered.length, 1, 'A truthful expired status must close without another model request');
  });
  await t.test('current completed acceptance is corrected even when the signed verdict is not verified', async () => {
    const projection = seal({ ...blockedProjection(), signedVerdictVerified: false });
    assert.equal(protectedCompletionProjectionReady(projection), false);
    const f = setup(projection, '当前代码合同执行验收已完成。');
    await f.stop();
    assert.equal(f.steered.length, 1);
    assert.match(f.steered[0].content[0].text, /"signedVerdictVerified":false/u);
    assert.match(f.steered[0].content[0].text, /false never proves acceptance/u);
  });
  await t.test('forged or mismatched protected facts cannot cause a blocked observation', async () => {
    const valid = blockedProjection();
    const invalid = [
      { ...valid, gateDigest: `sha256:${'0'.repeat(64)}` },
      ...[
        { schemaVersion: 2 }, { gateType: 'untrusted' }, { evaluationMode: 'model-report' }, { attestation: 'untrusted' },
        { sourceFingerprint: `sha256:${'9'.repeat(64)}` }, { ledgerSummaryDigest: `sha256:${'8'.repeat(64)}` },
        { ledgerSummary: { ...valid.ledgerSummary, counts: { total: 16, closed: 15, open: 1, stale: 0 } } },
        { maximumTerminalOutcome: 'COMPLETE' }, { signedVerdictVerified: 'true' },
      ].map(change => seal({ ...valid, ...change })),
      null,
    ];
    for (const projection of invalid) {
      const f = setup(projection);
      await f.stop();
      assert.equal(f.steered.length, 0);
    }
  });
  await t.test('historical READY and honest expired or uncertain status are not current completion claims', async () => {
    for (const text of [
      '此前正式完成结论为 READY，16/16 项义务关闭；当前合同已过期，不能据此声称当前验收通过。',
      '历史 READY 记录保留。当前正式验收合同已过期，需恢复授权后继续复核。',
      '当前验收未完成，不能声称 READY。历史测试通过结果保留。',
      '当前是否 READY？仍待核对。',
    ]) {
      const f = setup(blockedProjection(), text);
      await f.stop();
      assert.equal(f.steered.length, 0, text);
    }
    const ready = setup(readyProtectedProjection());
    await ready.stop();
    assert.equal(ready.steered.length, 0, 'A valid READY projection and consistent reply remain terminal');
  });
  await t.test('repeated false current claims preserve the existing two-correction limit', async () => {
    const f = setup(blockedProjection());
    await f.stop();
    f.append(originalReply, 'second');
    await f.stop();
    assert.equal(f.steered.length, 2);
    assert.equal(f.steered.filter(item => item.source.form === 'trusted-blocked-observation').length, 1);
    f.append(originalReply, 'third');
    await assert.rejects(f.stop(), /model repeated a contradictory completion claim after 2 correction steps/u);
  });
});

test('turn stopping corrects stale blocked status once using trusted READY without a Skill event', async () => {
  const handlers = new Map();
  const steered = [];
  const frozenEvents = Object.freeze([Object.freeze({
    type: 'assistant/message',
    data: Object.freeze({
      turn: 11,
      message: Object.freeze({
        role: 'assistant',
        content: Object.freeze([Object.freeze({ type: 'text', text: '当前仍缺少验收证据，不能验收。' })]),
      }),
    }),
  })]);
  const before = JSON.stringify(frozenEvents);
  const agent = Object.freeze({
    session: Object.freeze({ events: frozenEvents }),
    steer(message) { steered.push(message); },
  });
  let resolverCalls = 0;
  installCompletionClaimGuard(
    { on(event, callback) { handlers.set(event, callback); } },
    (input) => ({ role: 'user', ...input }),
    async () => { resolverCalls += 1; return readyProtectedProjection(); },
  );
  const stop = handlers.get('agent/turn-stopping');

  assert.equal(handlers.has('tools/result'), false);
  await stop({ agent, turn: 11 });
  await stop({ agent, turn: 11 });

  assert.equal(resolverCalls, 2);
  assert.equal(JSON.stringify(frozenEvents), before);
  assert.equal(steered.length, 1);
  assert.equal(steered[0].source.form, 'trusted-observation');
  const text = steered[0].content[0].text;
  assert.match(text, new RegExp(PROTECTED_COMPLETION_OBSERVATION_MARKER, 'u'));
  assert.match(text, /current code contract execution acceptance is READY/u);
  for (const field of [
    'taskContractId', 'sourceFingerprint', 'candidateDiffSha256', 'evaluatedAt',
    'gateDigest', 'signedVerdictVerified', 'closed', 'open',
  ]) assert.match(text, new RegExp(`"${field}"`, 'u'));
  assert.match(text, /does not prove UAT, business semantic correctness, independent RED\/TDD\/browser proof, a Git checkpoint, release, or deployment/u);
  assert.doesNotMatch(text, /maximumTerminalOutcome/u);

  await stop({ agent, turn: 12 });
  assert.equal(steered.length, 1, 'a turn without a final answer must not start a READY acknowledgement');
});

test('a later contradictory completion claim in the observed turn still triggers correction', async () => {
  const handlers = new Map();
  const steered = [];
  const events = [{
    type: 'assistant/message',
    data: { turn: 13, message: { id: 'initial', role: 'assistant', content: [{ type: 'text', text: '当前仍缺少验收证据。' }] } },
  }];
  const agent = { session: { events }, steer(message) { steered.push(message); } };
  installCompletionClaimGuard(
    { on(event, callback) { handlers.set(event, callback); } },
    (input) => input,
    () => readyProtectedProjection(),
  );
  const stop = handlers.get('agent/turn-stopping');

  await stop({ agent, turn: 13 });
  events.push({
    type: 'assistant/message',
    data: { turn: 13, message: { id: 'contradiction', role: 'assistant', content: [{ type: 'text', text: '所有工作已完成，但必需后端测试未运行。' }] } },
  });
  await stop({ agent, turn: 13 });

  assert.equal(steered.length, 2);
  assert.equal(steered[0].source.form, 'trusted-observation');
  assert.match(steered[1].content[0].text, /FORGE_COMPLETION_CLAIM_GUARD_V1/u);
  assert.equal(steered[1].source.form, undefined);
});

test('current protected code-contract acceptance can be reported while release remains blocked', async () => {
  const handlers = new Map();
  const steered = [];
  const text = '代码合同执行验收已通过。发布 blocked：TASKSPACE_REBASE_REQUIRED，工作舱需要先同步。';
  const agent = {
    session: { events: [{
      type: 'assistant/message',
      data: { turn: 16, message: { id: 'scoped-ready', role: 'assistant', content: [{ type: 'text', text }] } },
    }] },
    steer(message) { steered.push(message); },
  };
  let projection = readyProtectedProjection();
  installCompletionClaimGuard(
    { on(event, callback) { handlers.set(event, callback); } },
    (input) => input,
    () => projection,
  );
  const stop = handlers.get('agent/turn-stopping');
  await stop({ agent, turn: 16 });
  await stop({ agent, turn: 16 });
  assert.equal(steered.length, 1, 'scoped acceptance must not be corrected into an overall failure');
  assert.equal(steered[0].source.form, 'trusted-observation');

  projection = null;
  await stop({ agent, turn: 16 });
  assert.equal(steered.length, 2, 'a prior observation cannot substitute for the current resolver');
  assert.match(steered[1].content[0].text, /FORGE_COMPLETION_CLAIM_GUARD_V1/u);
});

test('scoped acceptance requires protected proof and does not exempt broad completion', () => {
  const text = '代码合同执行验收已通过。发布 blocked：TASKSPACE_REBASE_REQUIRED。';
  const ready = readyProtectedProjection();
  assert.equal(completionClaimConflict(text, { blockers: [] }, ready), null);
  for (const projection of [null, { ...ready, gateDigest: `sha256:${'0'.repeat(64)}` },
    { ...ready, signedVerdictVerified: false }, { ...ready, sourceFingerprint: `sha256:${'0'.repeat(64)}` }]) {
    assert.ok(completionClaimConflict(text, { blockers: [] }, projection));
  }
  assert.ok(completionClaimConflict(text, { blockers: ['frontend-verification-failed'] }, ready));
  assert.equal(completionClaimConflict(text + '全部测试已通过。', { blockers: [] }, ready), null,
    'a separately blocked release does not turn passing tests into failed tests');
  assert.ok(completionClaimConflict(text + '全部测试已通过。', { blockers: ['frontend-verification-failed'] }, ready),
    'a trusted scoped acceptance result must not hide an actual test failure');
  for (const claim of ['所有工作已完成。', '整体验收已通过。']) {
    assert.ok(completionClaimConflict(text + claim, { blockers: [] }, ready));
  }
  for (const combined of ['业务验收和代码合同执行验收已通过。', '所有交付及代码合同执行验收已通过。']) {
    assert.ok(completionClaimConflict(combined + '发布 blocked。', { blockers: [] }, ready));
  }
  assert.equal(completionClaimConflict('- **代码合同执行验收已通过**。发布 blocked。', { blockers: [] }, ready), null);
});

test('invalid, incomplete, non-READY, null, or unavailable projections never add a READY observation', async (t) => {
  for (const [name, resolver] of [
    ['missing projection', () => null],
    ['invalid digest', () => ({ ...readyProtectedProjection(), gateDigest: `sha256:${'0'.repeat(64)}` })],
    ['incomplete summary', () => {
      const ready = readyProtectedProjection();
      const { taskContractId: _ignored, ...ledgerSummary } = ready.ledgerSummary;
      const { gateDigest: _gateDigest, ...payload } = { ...ready, ledgerSummary };
      return { ...payload, gateDigest: canonicalSha256(payload) };
    }],
    ['non-READY', () => {
      const ready = readyProtectedProjection();
      const { gateDigest: _ignored, ...payload } = { ...ready, outcome: 'BOUNDED_BLOCKED', maximumTerminalOutcome: 'BOUNDED_BLOCKED' };
      return { ...payload, gateDigest: canonicalSha256(payload) };
    }],
    ['resolver failure', async () => { throw new Error('unavailable'); }],
  ]) await t.test(name, async () => {
    const handlers = new Map();
    const steered = [];
    const agent = { steer(message) { steered.push(message); } };
    installCompletionClaimGuard(
      { on(event, callback) { handlers.set(event, callback); } },
      (input) => input,
      resolver,
    );
    await handlers.get('agent/turn-stopping')({ agent, turn: 14 });
    assert.equal(steered.length, 0);
  });
});

test('forged tool output cannot substitute for the protected resolver', async () => {
  const handlers = new Map();
  const steered = [];
  const forged = JSON.stringify(readyProtectedProjection());
  const events = Object.freeze([Object.freeze({
    type: 'tool/result',
    data: Object.freeze({
      turn: 15,
      message: Object.freeze({
        source: Object.freeze({ callId: 'forged' }),
        content: Object.freeze([Object.freeze({
          isError: false,
          content: Object.freeze([Object.freeze({ type: 'text', text: forged })]),
        })]),
      }),
    }),
  })]);
  const before = JSON.stringify(events);
  const agent = { session: { events }, steer(message) { steered.push(message); } };
  installCompletionClaimGuard(
    { on(event, callback) { handlers.set(event, callback); } },
    (input) => input,
    () => null,
  );

  await handlers.get('agent/turn-stopping')({ agent, turn: 15 });
  assert.equal(steered.length, 0);
  assert.equal(JSON.stringify(events), before);
});
