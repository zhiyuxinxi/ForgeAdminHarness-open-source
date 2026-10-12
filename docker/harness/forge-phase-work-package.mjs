import crypto from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { FORGE_CROSS_LAYER_HOST_REUSE_REASON } from './forge-delivery-phase-runtime.mjs';

export const FORGE_PHASE_WORK_PACKAGE_SCHEMA = 'forge-phase-work-package/v1';
export const FORGE_PHASE_WORK_PACKAGE_VERSION = '2026.09.12.1';

const LEGACY_FORGE_PHASE_WORK_PACKAGE_VERSIONS = Object.freeze(new Set(['2026.09.03.2']));

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const DOCUMENT_NAMES = Object.freeze([
  '00-input.md',
  '01-result.md',
  '02-process.md',
  '03-verification.md',
  '04-handoff.md',
  '05-memory-candidate.md',
]);
const DIRECTORY_NAMES = Object.freeze([...DOCUMENT_NAMES, 'manifest.json']);
const PHASE_GUIDANCE = Object.freeze({
  requirements: [
    '把参与者、用例、业务规则、验收条件、非目标、数据归属和权限矩阵写成可判定合同。',
    '未决业务决定必须显式暂停，不能由模型补默认值。',
  ],
  'domain-contract': [
    '业务实体、命令、查询、API、权限码、字典、校验和并发规则使用同一词汇表。',
    '先确定跨层合同，再允许数据库、后端或前端实现。',
  ],
  database: [
    'schema 迁移必须覆盖租户、创建/更新审计、逻辑删除、唯一性、索引、字典/Excel seed 和回退边界。',
    '本阶段禁止菜单、按钮或 API resource；这些内容只能在 access-wiring 中绑定已验收页面/API。',
    '只修改数据库 owner，迁移结果不能由 SQL 文本存在性冒充。',
  ],
  'ui-design': [
    '先确定页面模式、全局组件 owner、字段/动作/状态、响应式、可访问性、API 和权限绑定。',
    '设计阶段只产合同，不提前写页面源码。',
  ],
  backend: [
    '先形成 RED 测试，再沿既有 Controller/Application/Domain/Infrastructure owner 实现。',
    '分页、租户/RBAC、affected rows、异常、事务、幂等和并发必须有对应证据。',
  ],
  frontend: [
    '复用全局组件、设计 token、字典和 API adapter，不在页面内复制第二套基础能力。',
    'Long ID、权限、加载/空/错/成功状态、可访问性和构建测试必须闭合。',
  ],
  'access-wiring': [
    '只为已验收页面和 API 追加菜单、按钮、literal API resource 与合格角色可见性接线。',
    '禁止回写 schema migration；FE-MENU、PERMISSION 和迁移测试任一失败都必须保留。',
  ],
  'cross-layer-acceptance': [
    '逐条连接需求、权限、租户/审计/逻辑删除、API/UI、Long ID、测试和人工语义证据。',
    '任何 cannot-claim、失败或未执行项都必须保留，不能用总结文字覆盖。',
  ],
});
const PHASE_NAMES = Object.freeze({
  requirements: '需求澄清',
  'domain-contract': '领域与接口约定',
  database: '数据实现',
  'ui-design': '页面交互设计',
  backend: '后端实现',
  frontend: '前端实现',
  'access-wiring': '权限接线',
  'cross-layer-acceptance': '跨层验收',
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail('PHASE_WORK_PACKAGE_INVALID', `${label} does not match the reviewed schema.`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestManifest(manifest) {
  const { packageDigest: _packageDigest, ...identity } = manifest;
  return sha256(Buffer.from(canonical(identity), 'utf8'));
}

function safeText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_BYTES) {
    fail('PHASE_WORK_PACKAGE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function assertNoSensitiveValues(value, location = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveValues(entry, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:password|passwd|accessToken|refreshToken|clientSecret|apiKey|privateKey|credential)$/iu.test(key)
      && typeof child === 'string'
      && !/^(?:redacted|none|not-applicable|not_provided|<redacted>)$/iu.test(child.trim())) {
      fail('PHASE_WORK_PACKAGE_SECRET_DENIED', `${location}.${key} looks like a credential value.`);
    }
    assertNoSensitiveValues(child, `${location}.${key}`);
  }
}

function assertPortableText(text, label) {
  // URL path segments are not local filesystem references. Mask only validated
  // HTTP(S) spans for the Unix-path check; adjacent paths remain visible.
  const localPathText = text.replace(/\bhttps?:\/\/[^\s<>"'`\\，,。；;！？、（）()\[\]{}]+/giu, candidate => {
    try {
      const url = new URL(candidate);
      return /^https?:\/\/[^/]/iu.test(candidate) && url.hostname
        && ['http:', 'https:'].includes(url.protocol) ? ' ' : candidate;
    } catch { return candidate; }
  });
  if (text.includes('\0')
    || /(?:(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]|\\\\[^\s\\]+\\[^\s\\]+)/u.test(text)
    || /(?:file:\/\/|\/(?:home|root|Users|private|tmp|var\/tmp|srv|opt)\/)/u.test(localPathText)) {
    fail('PHASE_WORK_PACKAGE_HOST_PATH_DENIED', `${label} contains a host-specific absolute path.`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/u.test(text)
    || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(text)
    || /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/u.test(text)) {
    fail('PHASE_WORK_PACKAGE_SECRET_DENIED', `${label} contains secret-shaped content.`);
  }
}

function bulletList(values, emptyText = '无') {
  if (!Array.isArray(values) || values.length === 0) return `- ${emptyText}`;
  return values.map((value) => `- ${String(value)}`).join('\n');
}

function heading(title, identity) {
  return [
    '<!-- FORGE_PHASE_WORK_PACKAGE_V1 -->',
    `# ${title}`,
    '',
    `- Workflow: \`${identity.workflowId}\``,
    `- Phase: \`${identity.phaseId}\`（${identity.phaseIndex + 1}/${identity.phaseCount}）`,
    `- Attempt: \`${identity.attemptId}\``,
    `- Decision: \`${identity.decision}\``,
    '',
  ];
}

function verificationSummary(phase, hostReceipts, receipt) {
  if (receipt?.reasonCode === FORGE_CROSS_LAYER_HOST_REUSE_REASON) {
    return '本阶段未新增源码，沿用与相同累计源码绑定的七阶段验证；本轮未新执行 governance、changed-safe、full-regression，不将这三项记为通过。';
  }
  const required = phase.hostVerificationProfiles;
  if (required.length === 0) return '本阶段没有要求额外的主机检查。';
  const byProfile = new Map(hostReceipts.map((item) => [item.profile, item]));
  const passed = required.filter((profile) => byProfile.get(profile)?.status === 'passed').length;
  if (passed === required.length) return `本阶段要求的 ${required.length} 项检查均已有通过记录。`;
  const missing = required.filter((profile) => !byProfile.has(profile)).length;
  const failed = required.length - passed - missing;
  return `本阶段要求的检查尚未全部通过：${passed}/${required.length} 项通过，${failed} 项未通过，${missing} 项缺少记录。`;
}

function quotedHumanResponse(text) {
  return text.split(/\r?\n/u).map((line) => `> ${line
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')}`).join('\n');
}

function normalizeBuildInput(input) {
  if (!isPlainObject(input)) return input;
  return {
    ...input,
    runtimeEvidenceReference: input.runtimeEvidenceReference ?? null,
  };
}

function validateRuntimeEvidenceReference(input) {
  const reference = input.runtimeEvidenceReference;
  if (reference === null) return;
  exactKeys(reference, ['path', 'sha256', 'manifestSha256', 'sourceCommit'], 'runtime evidence reference');
  const payload = input.artifact?.payload ?? input.proposal.payload;
  if (input.phase.id !== 'cross-layer-acceptance'
    || reference.path !== '../runtime-evidence.json'
    || !SHA256.test(reference.sha256)
    || !SHA256.test(reference.manifestSha256)
    || !/^[0-9a-f]{40}$/u.test(reference.sourceCommit)
    || !isPlainObject(payload)
    || payload.runtimeEvidenceDigest !== reference.manifestSha256) {
    fail('PHASE_WORK_PACKAGE_INVALID', 'Runtime evidence reference is not bound to the cross-layer artifact.');
  }
}

function buildDocuments(input) {
  const {
    state, phase, proposal, artifact, receipt, hostReceipts, requestDigest, nextPhaseId,
    humanResponse, runtimeEvidenceReference,
  } = input;
  const decision = receipt.decision;
  const identity = {
    workflowId: state.workflowId,
    phaseId: phase.id,
    phaseIndex: phase.index,
    phaseCount: input.phaseCount,
    attemptId: receipt.attemptId,
    decision,
  };
  const hostLines = hostReceipts.map((item) => (
    `- \`${item.profile}\`: \`${item.status}\`; receipt \`${item.receiptDigest}\`; patch \`${item.patchDigest ?? 'none'}\``
  ));
  const reuseLines = receipt.reasonCode === FORGE_CROSS_LAYER_HOST_REUSE_REASON ? [
    '- 验证处置：`reused-upstream`；仅适用于无新增源码且累计源码与最新已接受源一致的只读跨层阶段。',
    `- 复用源产物：\`${receipt.hostVerificationReuse.artifactKind}\`；摘要 \`${receipt.hostVerificationReuse.artifactDigest}\`。`,
    `- 累计源码摘要：\`${receipt.hostVerificationReuse.sourceFingerprint}\`；上游七阶段原 Host 绑定保持。`,
    '- 本轮默认 governance、changed-safe、full-regression 均未新执行；本轮新增 Host 回执为 0，不宣称这三项已通过。',
    '- 实际运行与业务语义证据仍独立判断；未验证权限、浏览器或完整业务验收不能因复用而变为通过。',
  ] : [];
  const upstreamLines = Object.entries(artifact?.upstreamArtifactDigests ?? {})
    .map(([kind, digest]) => `- \`${kind}\`: \`${digest}\``);
  const resultPayload = JSON.stringify(artifact?.payload ?? proposal.payload, null, 2);
  const unresolved = artifact?.unresolvedDecisions ?? proposal.unresolvedDecisions;
  const guidance = PHASE_GUIDANCE[phase.id];
  if (guidance === undefined) fail('PHASE_WORK_PACKAGE_INVALID', `Phase ${phase.id} has no reviewed work-package guidance.`);
  assertNoSensitiveValues(artifact?.payload ?? proposal.payload);
  const phaseName = PHASE_NAMES[phase.id];
  if (phaseName === undefined) fail('PHASE_WORK_PACKAGE_INVALID', `Phase ${phase.id} has no human-readable name.`);
  const nextPhaseName = nextPhaseId === null ? null : PHASE_NAMES[nextPhaseId];
  const statusText = decision === 'accepted'
    ? '本阶段结果已经确认，可以继续后续工作。'
    : '本阶段暂未通过，需要先完成业务决定。';
  const nextStepText = decision === 'blocked'
    ? '请先确认下列业务待决定项；确认后再继续本阶段。'
    : (nextPhaseName === null
      ? '八个交付阶段已经完成；发布、用户验收或上线仍需各自的独立证据与授权。'
      : `下一步进入${nextPhaseName}，并使用本阶段已确认的结果。`);
  const businessText = quotedHumanResponse(humanResponse
    ?? '本次模型响应未提供单独的业务说明；为避免臆造，完整机器结果仅保留在下方技术细节中。');

  const documents = {
    '00-input.md': [
      ...heading('00 输入与资料清单', identity),
      '## 事实源', '',
      `- 原始需求 SHA-256: \`${requestDigest}\``,
      `- Source commit: \`${state.sourceCommit}\``,
      `- Catalog version: \`${input.catalogVersion}\``,
      '- 原始需求正文保留在受控 run 输入中，本工作包只记录摘要，避免复制 Secret 或宿主路径。', '',
      '## 已验收上游产物', '',
      upstreamLines.length === 0 ? '- 无；这是首阶段或当前阻塞产物没有可接受上游。' : upstreamLines.join('\n'), '',
      ...(runtimeEvidenceReference === null ? [] : [
        '## 已验证运行证据', '',
        `- 证据文件: [runtime-evidence.json](${runtimeEvidenceReference.path})`,
        `- 文件 SHA-256: \`${runtimeEvidenceReference.sha256}\``,
        `- Manifest SHA-256: \`${runtimeEvidenceReference.manifestSha256}\``,
        `- 运行 Source commit: \`${runtimeEvidenceReference.sourceCommit}\``, '',
      ]),
      '## 当前阶段授权', '',
      `- Action ceiling: \`${phase.actionCeiling}\``,
      `- Source mutation: \`${phase.sourceMutation}\``,
      `- Owned paths: ${phase.ownedPaths.length === 0 ? '无' : phase.ownedPaths.map((item) => `\`${item}\``).join('、')}`,
      `- Required Skills: ${phase.requiredSkills.map((item) => `\`${item}\``).join('、')}`,
      `- Required Host profiles: ${phase.hostVerificationProfiles.length === 0 ? '无' : phase.hostVerificationProfiles.map((item) => `\`${item}\``).join('、')}`, '',
      '## 同事开始前检查', '',
      '- 只上传本阶段卡片要求的资料；来源、版本、owner 和不确定性必须可追溯。',
      '- 不上传密码、Token、私钥、完整连接串、生产数据或宿主绝对路径。',
      '- 上游摘要变化后，本阶段产物和验证自动视为过期。', '',
    ].join('\n'),
    '01-result.md': [
      '<!-- FORGE_PHASE_WORK_PACKAGE_V1 -->',
      `# 01 ${phaseName}结果`, '',
      statusText, '',
      `下一步：${nextStepText}`, '',
      `检查情况：${verificationSummary(phase, hostReceipts, receipt)}`, '',
      ...(unresolved.length === 0 ? [] : [
        '## 需要业务决定', '', bulletList(unresolved), '',
      ]),
      '## 业务说明（模型原文）', '',
      businessText, '',
      '<details>',
      '<summary>技术细节与完整机器证据</summary>', '',
      `- Workflow: \`${identity.workflowId}\``,
      `- Phase: \`${identity.phaseId}\`（${identity.phaseIndex + 1}/${identity.phaseCount}）`,
      `- Attempt: \`${identity.attemptId}\``,
      `- Decision: \`${identity.decision}\``,
      `- Reason code: \`${receipt.reasonCode ?? 'none'}\``,
      `- Controller receipt: \`${receipt.receiptDigest}\``,
      `- Original request digest: \`${requestDigest}\``,
      `- Source commit: \`${state.sourceCommit}\``,
      `- Catalog version: \`${input.catalogVersion}\``,
      `- Artifact kind: \`${phase.artifactKind}\``,
      `- Artifact digest: \`${artifact?.artifactDigest ?? 'not-accepted'}\``,
      `- Patch digest: \`${artifact?.patchDigest ?? 'none'}\``,
      `- Changed paths: ${artifact?.changedPaths.length > 0 ? artifact.changedPaths.map((item) => `\`${item}\``).join('、') : '无'}`, '',
      '### Accepted upstream artifacts', '', upstreamLines.length === 0 ? '- 无' : upstreamLines.join('\n'), '',
      '### Host receipts', '', hostLines.length === 0 ? '- 无' : hostLines.join('\n'), '',
      ...(reuseLines.length === 0 ? [] : ['### 已接受上游验证复用', '', reuseLines.join('\n'), '']),
      '### 完整结构化结果', '', '```json', resultPayload, '```', '',
      '### 未决业务决定', '', bulletList(unresolved, '无'), '',
      '</details>', '',
    ].join('\n'),
    '02-process.md': [
      ...heading('02 可观察执行过程与最佳实践', identity),
      '## 可观察过程', '',
      `1. Controller 载入 \`${phase.id}\` 的固定顺序、最小 Skills、owner、路径和验证档案。`,
      '2. Harness 在同一持久会话中只执行当前阶段；模型返回一个结构化 proposal。',
      `3. Operator 观察当前阶段 changed paths：${artifact?.changedPaths.length > 0 ? artifact.changedPaths.map((item) => `\`${item}\``).join('、') : '无'}。`,
      `4. Operator 固定 Host profiles：${phase.hostVerificationProfiles.length === 0 ? '本阶段不要求 Host Runner' : phase.hostVerificationProfiles.map((item) => `\`${item}\``).join('、')}。`,
      ...(reuseLines.length === 0 ? [] : [reuseLines.join('\n')]),
      `5. Controller 于 \`${receipt.completedAt}\` 作出 \`${decision}\` 决定并绑定 receipt digest。`, '',
      '> 这里只记录可复核动作、输入、决定和回执，不记录或要求模型暴露隐藏推理过程。', '',
      '## 本阶段最佳实践', '', bulletList(guidance), '',
      '## 维护规则', '',
      '- 经验必须绑定本次事实源；没有证据的通用建议进入待评审区，不能改写当前结论。',
      '- 最后一次源码、配置或测试写入会使此前相关验证过期，必须重新取得回执。',
      '- 失败和纠偏同样归档；不得删除失败样本或把候选状态改名为通过。', '',
    ].join('\n'),
    '03-verification.md': [
      ...heading('03 验证记录', identity),
      '## 预期验证', '',
      bulletList(phase.hostVerificationProfiles.map((item) => `Host Runner profile \`${item}\``), '本阶段无 Host Runner profile；仍执行 schema、上游摘要、路径和状态机门禁。'), '',
      '## 实际受控回执', '',
      hostLines.length === 0 ? '- 无 Host Runner 回执；不得据此宣称编译、测试、数据库集成或运行时行为通过。' : hostLines.join('\n'), '',
      ...(reuseLines.length === 0 ? [] : ['## 本轮有限复用', '', reuseLines.join('\n'), '']),
      '## Controller 判定', '',
      `- Phase receipt: \`${receipt.receiptDigest}\``,
      `- Decision: \`${decision}\``,
      `- Reason code: \`${receipt.reasonCode ?? 'none'}\``,
      '- AI 的自然语言声明不是验证证据；只有受信 controller/Runner 回执覆盖其职责范围。', '',
      '## 不可扩大声明', '',
      '- 静态或 schema 通过不等于编译、数据库迁移、浏览器、业务语义、发布或长期健康通过。',
      '- 未运行、失败、过期或对象不一致的验证必须原样保留。', '',
    ].join('\n'),
    '04-handoff.md': [
      ...heading('04 交接与归档', identity),
      '## 交接结论', '',
      `- 下一阶段: \`${decision === 'accepted' ? (nextPhaseId ?? 'workflow-completed') : 'blocked'}\``,
      `- 本阶段 artifact: \`${artifact?.artifactDigest ?? 'none'}\``,
      `- 本阶段 receipt: \`${receipt.receiptDigest}\``,
      `- 工作流状态: \`${input.workflowStatus}\``, '',
      '## 下一位同事只需携带', '',
      '- 本目录 `manifest.json` 与六份 Markdown；机器侧继续携带 manifest 指向的 JSON artifact/receipt。',
      '- 当前 candidate/source commit、上游 artifact digests、patch digest 和受控验证回执。',
      '- 未决业务决定、失败项、cannot-claim 和明确的 owner/路径边界。', '',
      '## 归档规则', '',
      '- 归档后不得原地改写；需要修订时创建新 attempt，并保留旧目录和 manifest。',
      '- 文件名、目录存在或 Markdown 文字不能代替 manifest 的 SHA-256 完整性验证。', '',
    ].join('\n'),
    '05-memory-candidate.md': [
      ...heading('05 Memory Candidate', identity),
      '## 候选状态', '',
      '- Status: `draft-review-required`',
      '- Promotion: `owner-confirmed-only`',
      '- 本文件不是 active Memory，也不会触发 MCP Memory 写入。', '',
      '## 候选正文', '',
      '- 待人工从已验证且可跨任务复用的结论中提炼；本次运行不自动生成长期记忆。', '',
      '## 来源', '',
      `- Phase artifact: \`${artifact?.artifactDigest ?? 'none'}\``,
      `- Phase receipt: \`${receipt.receiptDigest}\``, '',
      '## 适用范围', '',
      `- Workflow \`${state.workflowId}\` / phase \`${phase.id}\`；扩大到其他项目或阶段前必须复核。`, '',
      '## 不确定性与冲突', '',
      '- 只覆盖当前 candidate、当前规范版本和已执行验证；不能替代 active policy、项目文档或 owner 决策。',
      '- 晋升前必须与现有 active Memory、项目事实和更新后的规范做冲突检查。', '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(documents)) assertPortableText(text, name);
  return documents;
}

function buildManifest(input, documents) {
  const encoded = DOCUMENT_NAMES.map((name) => {
    const bytes = Buffer.from(documents[name], 'utf8');
    return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = {
    schemaVersion: FORGE_PHASE_WORK_PACKAGE_SCHEMA,
    workPackageVersion: FORGE_PHASE_WORK_PACKAGE_VERSION,
    workflowId: input.state.workflowId,
    phaseId: input.phase.id,
    phaseIndex: input.phase.index,
    artifactKind: input.phase.artifactKind,
    attemptId: input.receipt.attemptId,
    taskId: input.state.taskId,
    sourceCommit: input.state.sourceCommit,
    catalogVersion: input.catalogVersion,
    decision: input.receipt.decision,
    canonicalArtifactDigest: input.artifact?.artifactDigest ?? null,
    controllerReceiptDigest: input.receipt.receiptDigest,
    patchDigest: input.artifact?.patchDigest ?? null,
    upstreamArtifactDigests: input.artifact?.upstreamArtifactDigests ?? {},
    hostReceiptDigests: input.hostReceipts.map((item) => item.receiptDigest),
    documents: encoded,
    archiveStatus: 'sealed',
    memoryStatus: 'candidate-only',
    createdAt: input.receipt.completedAt,
    packageDigest: '',
  };
  manifest.packageDigest = digestManifest(manifest);
  return manifest;
}

function validateBuildInput(input) {
  exactKeys(input, [
    'state', 'phase', 'proposal', 'artifact', 'receipt', 'hostReceipts', 'requestDigest',
    'catalogVersion', 'workflowStatus', 'nextPhaseId', 'phaseCount', 'humanResponse',
    'runtimeEvidenceReference',
  ], 'work package input');
  if (!isPlainObject(input.state) || !isPlainObject(input.phase) || !isPlainObject(input.proposal)
    || (input.artifact !== null && !isPlainObject(input.artifact)) || !isPlainObject(input.receipt)
    || !Array.isArray(input.hostReceipts) || !SHA256.test(input.requestDigest)
    || !Number.isSafeInteger(input.phaseCount) || input.phaseCount < 2 || input.phaseCount > 16
    || typeof input.phase.index !== 'number' || input.phase.index < 0 || input.phase.index >= input.phaseCount
    || input.receipt.phaseId !== input.phase.id || input.receipt.workflowId !== input.state.workflowId
    || !['accepted', 'blocked'].includes(input.receipt.decision)
    || (input.receipt.decision === 'accepted' && input.artifact === null)
    || (input.artifact !== null && input.artifact.artifactKind !== input.phase.artifactKind)
    || typeof input.catalogVersion !== 'string' || typeof input.workflowStatus !== 'string'
    || (input.nextPhaseId !== null && typeof input.nextPhaseId !== 'string')
    || (input.humanResponse !== null && typeof input.humanResponse !== 'string')) {
    fail('PHASE_WORK_PACKAGE_INVALID', 'Work package input identities are inconsistent.');
  }
  safeText(input.state.workflowId, 'workflowId');
  safeText(input.state.taskId, 'taskId');
  safeText(input.state.sourceCommit, 'sourceCommit');
  safeText(input.phase.id, 'phaseId');
  safeText(input.phase.artifactKind, 'artifactKind');
  safeText(input.receipt.attemptId, 'attemptId');
  if (input.humanResponse !== null) safeText(input.humanResponse, 'humanResponse');
  if (!SHA256.test(input.receipt.receiptDigest ?? '')) {
    fail('PHASE_WORK_PACKAGE_INVALID', 'Controller receipt digest is invalid.');
  }
  validateRuntimeEvidenceReference(input);
}

export function createForgePhaseWorkPackage(input) {
  const normalized = normalizeBuildInput(input);
  validateBuildInput(normalized);
  const documents = buildDocuments(normalized);
  const manifest = buildManifest(normalized, documents);
  return Object.freeze({ documents: Object.freeze(documents), manifest: Object.freeze(manifest) });
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function validateForgePhaseWorkPackageDirectory(directory, expected = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('PHASE_WORK_PACKAGE_PATH_INVALID', 'Work package directory must be absolute.');
  }
  const metadata = await lstat(directory).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('PHASE_WORK_PACKAGE_PATH_INVALID', 'Work package must be an ordinary directory.');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(actualNames) !== JSON.stringify([...DIRECTORY_NAMES].sort())) {
    fail('PHASE_WORK_PACKAGE_FILE_SET_INVALID', 'Work package file set is missing, extra, or non-regular.');
  }
  const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
  if (manifestBytes.length < 2 || manifestBytes.length > MAX_DOCUMENT_BYTES) {
    fail('PHASE_WORK_PACKAGE_INVALID', 'Work package manifest is empty or oversized.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('PHASE_WORK_PACKAGE_INVALID', 'Work package manifest is not valid JSON.');
  }
  exactKeys(manifest, [
    'schemaVersion', 'workPackageVersion', 'workflowId', 'phaseId', 'phaseIndex', 'artifactKind',
    'attemptId', 'taskId', 'sourceCommit', 'catalogVersion', 'decision', 'canonicalArtifactDigest',
    'controllerReceiptDigest', 'patchDigest', 'upstreamArtifactDigests', 'hostReceiptDigests',
    'documents', 'archiveStatus', 'memoryStatus', 'createdAt', 'packageDigest',
  ], 'work package manifest');
  if (manifest.schemaVersion !== FORGE_PHASE_WORK_PACKAGE_SCHEMA
    || (manifest.workPackageVersion !== FORGE_PHASE_WORK_PACKAGE_VERSION
      && !LEGACY_FORGE_PHASE_WORK_PACKAGE_VERSIONS.has(manifest.workPackageVersion))
    || manifest.archiveStatus !== 'sealed' || manifest.memoryStatus !== 'candidate-only'
    || !['accepted', 'blocked'].includes(manifest.decision)
    || !SHA256.test(manifest.controllerReceiptDigest ?? '')
    || !SHA256.test(manifest.packageDigest ?? '')
    || manifest.packageDigest !== digestManifest(manifest)
    || !Array.isArray(manifest.documents) || manifest.documents.length !== DOCUMENT_NAMES.length
    || !Array.isArray(manifest.hostReceiptDigests)
    || manifest.hostReceiptDigests.some((value) => !SHA256.test(value))) {
    fail('PHASE_WORK_PACKAGE_INVALID', 'Work package manifest identity or digest is invalid.');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) fail('PHASE_WORK_PACKAGE_STALE', `Work package ${key} is stale.`);
  }
  const declaredNames = manifest.documents.map((entry) => entry?.path);
  if (JSON.stringify(declaredNames) !== JSON.stringify(DOCUMENT_NAMES)) {
    fail('PHASE_WORK_PACKAGE_FILE_SET_INVALID', 'Manifest document order or names are invalid.');
  }
  for (const document of manifest.documents) {
    exactKeys(document, ['path', 'bytes', 'sha256'], `manifest document ${document?.path ?? 'unknown'}`);
    if (!DOCUMENT_NAMES.includes(document.path) || !Number.isSafeInteger(document.bytes)
      || document.bytes < 1 || document.bytes > MAX_DOCUMENT_BYTES || !SHA256.test(document.sha256 ?? '')) {
      fail('PHASE_WORK_PACKAGE_INVALID', `Manifest document ${document.path} is invalid.`);
    }
    const file = path.join(directory, document.path);
    const fileMetadata = await lstat(file);
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.size !== document.bytes) {
      fail('PHASE_WORK_PACKAGE_DIGEST_MISMATCH', `Document ${document.path} metadata differs from manifest.`);
    }
    const bytes = await readFile(file);
    const text = bytes.toString('utf8');
    if (sha256(bytes) !== document.sha256 || !text.startsWith('<!-- FORGE_PHASE_WORK_PACKAGE_V1 -->\n')) {
      fail('PHASE_WORK_PACKAGE_DIGEST_MISMATCH', `Document ${document.path} differs from manifest.`);
    }
    assertPortableText(text, document.path);
  }
  return Object.freeze(JSON.parse(JSON.stringify(manifest)));
}

export async function writeForgePhaseWorkPackage({ directory, ...input }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('PHASE_WORK_PACKAGE_PATH_INVALID', 'Work package directory must be absolute.');
  }
  const built = createForgePhaseWorkPackage(input);
  const existing = await lstat(directory).catch(() => undefined);
  if (existing !== undefined) {
    const manifest = await validateForgePhaseWorkPackageDirectory(directory, {
      packageDigest: built.manifest.packageDigest,
    });
    return Object.freeze({ created: false, idempotent: true, manifest });
  }
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(directory)}.${crypto.randomUUID()}.staging`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const name of DOCUMENT_NAMES) {
      await writeExclusive(path.join(staging, name), Buffer.from(built.documents[name], 'utf8'));
    }
    await writeExclusive(path.join(staging, 'manifest.json'), Buffer.from(`${JSON.stringify(built.manifest, null, 2)}\n`, 'utf8'));
    await validateForgePhaseWorkPackageDirectory(staging, { packageDigest: built.manifest.packageDigest });
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const manifest = await validateForgePhaseWorkPackageDirectory(directory, {
    packageDigest: built.manifest.packageDigest,
  });
  return Object.freeze({ created: true, idempotent: false, manifest });
}
