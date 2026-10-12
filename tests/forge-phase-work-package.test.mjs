import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createForgePhaseWorkPackage,
  FORGE_PHASE_WORK_PACKAGE_VERSION,
  validateForgePhaseWorkPackageDirectory,
  writeForgePhaseWorkPackage,
} from '../docker/harness/forge-phase-work-package.mjs';

const sha = (character) => character.repeat(64);

function acceptedInput() {
  return {
    state: {
      workflowId: 'crud-production',
      taskId: 'eval-crud-complete',
      sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
    },
    phase: {
      id: 'database',
      index: 2,
      actionCeiling: 'workspace-write',
      sourceMutation: true,
      ownedPaths: ['forge-server/db/migration'],
      artifactKind: 'database-implementation',
      requiredSkills: ['forge-task-router', 'forge-phase-work-package', 'forge-database-migration'],
      hostVerificationProfiles: ['governance'],
    },
    proposal: {
      unresolvedDecisions: [],
      payload: { tables: ['sys_employee'] },
    },
    artifact: {
      artifactKind: 'database-implementation',
      artifactDigest: sha('a'),
      patchDigest: sha('b'),
      changedPaths: ['forge-server/db/migration/V20260903__employee.sql'],
      upstreamArtifactDigests: {
        'requirements-contract': sha('c'),
        'domain-api-contract': sha('d'),
      },
      unresolvedDecisions: [],
      payload: {
        tables: ['sys_employee'],
        tenantAuditDeleteContract: ['tenant_id', 'create_by', 'create_time', 'create_dept', 'update_by', 'update_time', 'del_flag'],
      },
    },
    receipt: {
      workflowId: 'crud-production',
      phaseId: 'database',
      attemptId: '11111111-1111-4111-8111-111111111111',
      decision: 'accepted',
      reasonCode: null,
      receiptDigest: sha('e'),
      completedAt: '2026-09-03T08:00:00.000Z',
    },
    hostReceipts: [{
      profile: 'governance',
      status: 'passed',
      receiptDigest: sha('f'),
      patchDigest: sha('b'),
    }],
    requestDigest: sha('1'),
    catalogVersion: '2026.09.03.2',
    phaseCount: 8,
    workflowStatus: 'active',
    nextPhaseId: 'ui-design',
    humanResponse: '员工数据结构已经形成候选实现，覆盖租户、审计和逻辑删除约束。下一步据此完成页面交互设计。',
  };
}

function crossLayerInput() {
  const input = acceptedInput();
  input.phase = {
    ...input.phase,
    id: 'cross-layer-acceptance',
    index: 7,
    artifactKind: 'cross-layer-acceptance',
  };
  input.artifact = {
    ...input.artifact,
    artifactKind: 'cross-layer-acceptance',
    payload: { runtimeEvidenceDigest: sha('9') },
  };
  input.receipt = { ...input.receipt, phaseId: 'cross-layer-acceptance' };
  input.nextPhaseId = null;
  input.runtimeEvidenceReference = {
    path: '../runtime-evidence.json',
    sha256: sha('8'),
    manifestSha256: sha('9'),
    sourceCommit: '745782f4d26b933406f00a0cb841df916defae5d',
  };
  return input;
}

test('work package renders six human documents from machine-owned phase truth', () => {
  const built = createForgePhaseWorkPackage(acceptedInput());
  assert.deepEqual(Object.keys(built.documents), [
    '00-input.md',
    '01-result.md',
    '02-process.md',
    '03-verification.md',
    '04-handoff.md',
    '05-memory-candidate.md',
  ]);
  assert.equal(built.manifest.decision, 'accepted');
  assert.equal(built.manifest.workPackageVersion, FORGE_PHASE_WORK_PACKAGE_VERSION);
  assert.equal(built.manifest.memoryStatus, 'candidate-only');
  assert.equal(built.manifest.documents.length, 6);
  assert.match(built.documents['02-process.md'], /不记录或要求模型暴露隐藏推理过程/u);
  assert.match(built.documents['00-input.md'], /3\/8/u);
  assert.match(built.documents['03-verification.md'], /AI 的自然语言声明不是验证证据/u);
  assert.match(built.documents['05-memory-candidate.md'], /owner-confirmed-only/u);
  assert.match(built.documents['01-result.md'], /员工数据结构已经形成候选实现/u);
  assert.match(built.documents['01-result.md'], /本阶段要求的 1 项检查均已有通过记录/u);
  assert.match(built.documents['01-result.md'], /<details>/u);
  assert.match(built.documents['01-result.md'], /"tenantAuditDeleteContract"/u);
});

test('cross-layer input links the controller-verified runtime evidence without embedding raw payload', () => {
  const input = crossLayerInput();
  const built = createForgePhaseWorkPackage(input);
  const document = built.documents['00-input.md'];
  assert.match(document, /\[runtime-evidence\.json\]\(\.\.\/runtime-evidence\.json\)/u);
  assert.ok(document.includes(`- 文件 SHA-256: \`${sha('8')}\``));
  assert.ok(document.includes(`- Manifest SHA-256: \`${sha('9')}\``));
  assert.ok(document.includes(`- Source commit: \`${input.state.sourceCommit}\``));
  assert.ok(document.includes(`- 运行 Source commit: \`${input.runtimeEvidenceReference.sourceCommit}\``));
  assert.notEqual(input.runtimeEvidenceReference.sourceCommit, input.state.sourceCommit);
  assert.doesNotMatch(document, /"runtimeEvidenceDigest"/u);
});

test('runtime evidence reference is restricted to the matching cross-layer digest, source and path', () => {
  const wrongDigest = crossLayerInput();
  wrongDigest.runtimeEvidenceReference.manifestSha256 = sha('7');
  assert.throws(
    () => createForgePhaseWorkPackage(wrongDigest),
    (error) => error.code === 'PHASE_WORK_PACKAGE_INVALID',
  );

  const wrongSource = crossLayerInput();
  wrongSource.runtimeEvidenceReference.sourceCommit = '1'.repeat(39);
  assert.throws(
    () => createForgePhaseWorkPackage(wrongSource),
    (error) => error.code === 'PHASE_WORK_PACKAGE_INVALID',
  );

  const wrongPath = crossLayerInput();
  wrongPath.runtimeEvidenceReference.path = '../other-runtime-evidence.json';
  assert.throws(
    () => createForgePhaseWorkPackage(wrongPath),
    (error) => error.code === 'PHASE_WORK_PACKAGE_INVALID',
  );

  const wrongPhase = crossLayerInput();
  wrongPhase.phase.id = 'frontend';
  wrongPhase.receipt.phaseId = 'frontend';
  assert.throws(
    () => createForgePhaseWorkPackage(wrongPhase),
    (error) => error.code === 'PHASE_WORK_PACKAGE_INVALID',
  );
});

test('blocked cross-layer proposal may bind the same runtime evidence digest', () => {
  const input = crossLayerInput();
  input.artifact = null;
  input.proposal.payload = { runtimeEvidenceDigest: sha('9') };
  input.receipt.decision = 'blocked';
  input.receipt.reasonCode = 'RUNTIME_EVIDENCE_INCOMPLETE';
  input.workflowStatus = 'blocked';
  const document = createForgePhaseWorkPackage(input).documents['00-input.md'];
  assert.match(document, /\[runtime-evidence\.json\]\(\.\.\/runtime-evidence\.json\)/u);
});

test('result reports missing or failed required checks without claiming all checks passed', () => {
  const missing = acceptedInput();
  missing.phase.hostVerificationProfiles = ['governance', 'database-integration'];
  const missingResult = createForgePhaseWorkPackage(missing).documents['01-result.md'];
  assert.match(missingResult, /1\/2 项通过，0 项未通过，1 项缺少记录/u);
  assert.doesNotMatch(missingResult, /检查均已有通过记录/u);

  const failed = acceptedInput();
  failed.hostReceipts[0].status = 'failed';
  const failedResult = createForgePhaseWorkPackage(failed).documents['01-result.md'];
  assert.match(failedResult, /0\/1 项通过，1 项未通过，0 项缺少记录/u);
  assert.doesNotMatch(failedResult, /检查均已有通过记录/u);
});

test('legacy artifact-only response stays explicit instead of inventing a business result', () => {
  const input = acceptedInput();
  input.humanResponse = null;
  const result = createForgePhaseWorkPackage(input).documents['01-result.md'];
  assert.match(result, /未提供单独的业务说明/u);
  assert.doesNotMatch(result, /员工数据结构已经形成候选实现/u);
});

test('accepted and blocked results quote HTML-shaped model text without changing trusted document structure', () => {
  const injected = [
    '业务事实保留在第一行。',
    '</details>',
    '# 伪造文档标题',
    '本阶段结果已经确认，可以继续后续工作。',
  ].join('\n');

  const accepted = acceptedInput();
  accepted.humanResponse = injected;
  const acceptedResult = createForgePhaseWorkPackage(accepted).documents['01-result.md'];
  assert.match(acceptedResult, /## 业务说明（模型原文）\n\n> 业务事实保留在第一行。\n> &lt;\/details&gt;\n> # 伪造文档标题/u);
  assert.equal((acceptedResult.match(/<\/details>/gu) ?? []).length, 1);
  assert.ok(acceptedResult.indexOf('本阶段结果已经确认，可以继续后续工作。')
    < acceptedResult.indexOf('## 业务说明（模型原文）'));

  const blocked = acceptedInput();
  blocked.artifact = null;
  blocked.proposal.unresolvedDecisions = ['请确认员工编号是否允许跨租户重复。'];
  blocked.receipt.decision = 'blocked';
  blocked.receipt.reasonCode = 'BUSINESS_DECISION_REQUIRED';
  blocked.hostReceipts = [];
  blocked.workflowStatus = 'blocked';
  blocked.nextPhaseId = null;
  blocked.humanResponse = injected;
  const blockedResult = createForgePhaseWorkPackage(blocked).documents['01-result.md'];
  assert.match(blockedResult, /本阶段暂未通过，需要先完成业务决定。/u);
  assert.match(blockedResult, /## 需要业务决定\n\n- 请确认员工编号是否允许跨租户重复。/u);
  assert.match(blockedResult, /> 本阶段结果已经确认，可以继续后续工作。/u);
  assert.doesNotMatch(blockedResult, /\n本阶段结果已经确认，可以继续后续工作。\n/u);
  assert.equal((blockedResult.match(/<\/details>/gu) ?? []).length, 1);
});

test('work package writes atomically, validates hashes and is idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-work-package-'));
  const directory = path.join(root, 'work-package');
  try {
    const first = await writeForgePhaseWorkPackage({ directory, ...acceptedInput() });
    assert.equal(first.created, true);
    const second = await writeForgePhaseWorkPackage({ directory, ...acceptedInput() });
    assert.equal(second.idempotent, true);
    const manifest = await validateForgePhaseWorkPackageDirectory(directory, {
      workflowId: 'crud-production',
      phaseId: 'database',
      decision: 'accepted',
    });
    assert.equal(manifest.packageDigest, first.manifest.packageDigest);
    await writeFile(path.join(directory, '02-process.md'), 'tampered\n', 'utf8');
    await assert.rejects(
      validateForgePhaseWorkPackageDirectory(directory),
      (error) => error.code === 'PHASE_WORK_PACKAGE_DIGEST_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sealed v2 work package remains readable and tampering is still rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-work-package-v2-'));
  const directory = path.join(root, 'work-package');
  try {
    const built = createForgePhaseWorkPackage(acceptedInput());
    await mkdir(directory);
    await Promise.all(Object.entries(built.documents).map(([name, text]) => (
      writeFile(path.join(directory, name), text, 'utf8')
    )));
    const legacyManifest = { ...built.manifest, workPackageVersion: '2026.09.03.2', packageDigest: '' };
    const { packageDigest: _ignored, ...identity } = legacyManifest;
    const canonical = (value) => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
      }
      return JSON.stringify(value);
    };
    legacyManifest.packageDigest = crypto.createHash('sha256').update(canonical(identity)).digest('hex');
    await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');
    const validated = await validateForgePhaseWorkPackageDirectory(directory);
    assert.equal(validated.workPackageVersion, '2026.09.03.2');

    const resultFile = path.join(directory, '01-result.md');
    await writeFile(resultFile, `${await readFile(resultFile, 'utf8')}tampered\n`, 'utf8');
    await assert.rejects(
      validateForgePhaseWorkPackageDirectory(directory),
      (error) => error.code === 'PHASE_WORK_PACKAGE_DIGEST_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('work package preserves ordinary HTTP URLs while rejecting host paths', () => {
  for (const humanResponse of [
    '接口文档见 https://example.com/api。',
    '接口地址是 http://localhost:8080/api/fire。',
  ]) {
    const input = acceptedInput();
    input.humanResponse = humanResponse;
    const built = createForgePhaseWorkPackage(input);
    assert.equal(Object.keys(built.documents).length, 6);
    assert.ok(built.documents['01-result.md'].includes(humanResponse));
  }
  for (const humanResponse of [
    '结果位于 C:\\Users\\operator\\result.json。',
    '结果位于 C:/Users/operator/result.json。',
    '结果位于d:/data/result.json。',
    '结果位于 \\\\server\\share\\result.json。',
    '结果位于 file:///C:/data/result.json。',
    '结果位于 /home/operator/result.json。',
    '接口文档见 https://example.com/api；结果位于 C:/data/result.json。',
  ]) {
    const input = acceptedInput();
    input.humanResponse = humanResponse;
    assert.throws(
      () => createForgePhaseWorkPackage(input),
      (error) => error.code === 'PHASE_WORK_PACKAGE_HOST_PATH_DENIED',
      humanResponse,
    );
  }
});

test('work package distinguishes URL path segments from adjacent Unix host paths', () => {
  for (const humanResponse of [
    '接口文档见 https://example.com/home/help。',
    '接口文档见 http://localhost:8080/root/help。',
    '参考 https://example.com/Users/help 和 https://example.com/private/help。',
    '文档 https://example.com/tmp/help、https://example.com/var/tmp/help。',
    '参考 https://example.com/srv/help；https://example.com/opt/help。',
  ]) {
    const input = acceptedInput();
    input.humanResponse = humanResponse;
    assert.ok(createForgePhaseWorkPackage(input).documents['01-result.md'].includes(humanResponse));
  }
  for (const humanResponse of [
    'https://example.com/home/help；结果位于 /home/operator/result.json。',
    'https://example.com/home/help /tmp/result.json',
    'https://example.com/home/help,/srv/project/result.json',
    'https://example.com/home/help；C:/Users/operator/result.json',
    'https://example.com/home/help；C:\\Users\\operator\\result.json',
    'https://example.com/home/help；\\\\server\\share\\result.json',
    'https://example.com/home/help；file:///opt/result.json',
    '无效链接 https:///home/operator/result.json',
  ]) {
    const input = acceptedInput();
    input.humanResponse = humanResponse;
    assert.throws(() => createForgePhaseWorkPackage(input),
      error => error.code === 'PHASE_WORK_PACKAGE_HOST_PATH_DENIED', humanResponse);
  }
});

test('work package rejects host paths and credential-shaped payloads before archive', () => {
  const hostPath = acceptedInput();
  hostPath.artifact.payload.location = 'C:\\Users\\operator\\result.json';
  assert.throws(
    () => createForgePhaseWorkPackage(hostPath),
    (error) => error.code === 'PHASE_WORK_PACKAGE_HOST_PATH_DENIED',
  );
  const credential = acceptedInput();
  credential.artifact.payload.apiKey = 'should-never-be-archived';
  assert.throws(
    () => createForgePhaseWorkPackage(credential),
    (error) => error.code === 'PHASE_WORK_PACKAGE_SECRET_DENIED',
  );
});
