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
  installCompletionClaimGuard,
  PROTECTED_COMPLETION_OBSERVATION_MARKER,
  protectedCompletionProjectionReady,
  protectedCompletionProjectionNotRequired,
} from '../docker/harness/forge-completion-claim-guard.mjs';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { assertGovernedAssembly } from '../docker/harness/forge-governance-prompt-guard.mjs';
import { EXPECTED_PRESETS } from '../docker/harness/forge-agent-preset-prompt-probe.mjs';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const base = 'a'.repeat(40);

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


test('completion observes actual blockers once and never interprets final wording as proof', async () => {
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

  for (const projection of [null,readyProtectedProjection(),blockedProjection()]) {
    let stop;const messages=[];
    const agent={session:{events:[]},steer(message){messages.push(message);}};
    installCompletionClaimGuard({on(_name,callback){stop=callback;}},value=>value,async()=>projection);
    for (const text of ['单元测试通过，集成测试未执行。','上次失败的问题已修复，本次检查通过。','已经搞定了。','当前仍被阻塞，尚未发布。']) {
      agent.session.events.push({type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text}]}}});
      await stop({agent,turn:1});
    }
    assert.equal(messages.length,projection?.outcome==='BOUNDED_BLOCKED'?1:0);
    if(messages.length) assert.equal(messages[0].source.form,'trusted-blocked-observation');
  }
});
