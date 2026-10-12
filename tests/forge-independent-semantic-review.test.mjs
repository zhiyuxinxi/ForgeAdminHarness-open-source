import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildSemanticReviewInput, createCodexSemanticReviewer, createConfiguredSemanticReviewer, createDeepSeekSemanticReviewer, projectSemanticReviewFailureDiagnostic, semanticReviewDigest, validateSemanticReviewResult } from '../docker/harness/forge-independent-semantic-review.mjs';
import { HostVerificationRunner } from '../docker/harness/host-verification-runner.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';
import { validateForgeDualReviewEvidence } from '../docker/harness/forge-change-contract.mjs';

const report = () => ({ decision: 'approved', summary: '当前变更保持API错误与鉴权边界；仅静态审查。',
  checks: { apiErrors: 'checked', authorization: 'checked', tenantIsolation: 'checked', changeScope: 'checked' }, findings: [] });
const changeEvidence = (changedPath) => ({ path: changedPath, side: 'after', line: 1,
  explanation: '本次改动改变了传入既有处理链的字段，须核对当前调用是否保持权限边界。' });

async function reviewFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-independent-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const changed = 'forge-server/app/src/main/java/example/order/domain/OrderQueryDTO.java';
  const controller = 'forge-server/app/src/main/java/example/order/controller/OrderController.java';
  const dependency = 'forge-server/base/src/main/java/example/security/Principal.java';
  const wiring = ['SaTokenConfig', 'TenantAutoConfiguration', 'MybatisPlusConfig'].map((name) => `forge-server/base/src/main/java/example/framework/${name}.java`);
  const mapper = 'forge-server/app/src/main/java/example/order/mapper/OrderMapper.java';
  const mapperXml = 'forge-server/app/src/main/resources/mapper/OrderMapper.xml';
  const contents = {
    [changed]: 'package example.order.domain; public class OrderQueryDTO { String status; }',
    [controller]: 'package example.order.controller;\nimport example.security.Principal;\npublic class OrderController {}',
    [dependency]: 'package example.security; public class Principal {}',
    [mapper]: 'package example.order.mapper; public interface OrderMapper {}',
    [mapperXml]: '<mapper namespace="example.order.mapper.OrderMapper"><select id="page">select 1</select></mapper>',
    ...Object.fromEntries(wiring.map((relative) => [relative, 'package example.framework; // framework registration entry'])),
  };
  const files = [];
  for (const [relative, content] of Object.entries(contents)) {
    const absolute = path.join(workspace, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    files.push({ relative, absolute, bytes: Buffer.byteLength(content), sha256: semanticReviewDigest(content) });
  }
  const source = { workspace, reviewBase: 'a'.repeat(40), inventory: { head: 'b'.repeat(40), workspaceFingerprint: 'c'.repeat(64), files },
    readGit: async (argv) => ({ exitCode: 0, timedOut: false, truncated: false,
      stdout: argv.includes('--name-only') ? `${changed}\0` : argv[0] === 'ls-files' ? ''
        : argv.includes('--unified=0') ? '@@ -1 +1 @@\n-old\n+new\n' : '+ String status;' }) };
  const context = { schemaVersion: 1, contextType: 'forge-independent-semantic-review/v1', status: 'ready',
    projectSlug: 'forge-test', taskId: 'task-one', contractId: 'd'.repeat(64), contractFingerprint: `sha256:${'e'.repeat(64)}`,
    source: { head: source.inventory.head, fingerprint: source.inventory.workspaceFingerprint },
    expiresAt: new Date(Date.now() + 300_000).toISOString(), candidateDiffSha256: `sha256:${'f'.repeat(64)}`,
    reviewerId: 'reviewer-one', obligations: ['api-error-and-auth-contract'] };
  return { root, source, context, changed, controller, dependency, wiring, mapper, mapperXml };
}

async function dualReviewFixture(t) {
  const f = await reviewFixture(t);
  const execute = promisify(execFile);
  const git = async argv => (await execute('git', ['-c', 'core.autocrlf=false', ...argv],
    { cwd: f.source.workspace, encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout;
  const deleted = 'forge-server/app/src/main/java/example/Old.java';
  const added = 'forge-server/app/src/main/java/example/New.java';
  const sourcePath = 'forge-server/review-contract.json';
  await writeFile(path.join(f.source.workspace, deleted), 'package example;\nclass Old {}\n');
  await git(['init', '--quiet']); await git(['add', '--', 'forge-server']);
  await git(['-c', 'user.name=Review fixture', '-c', 'user.email=review-fixture@example.invalid',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'review baseline']);
  f.source.reviewBase = (await git(['rev-parse', 'HEAD'])).trim();
  const ownedPaths = [f.changed, deleted, added];
  const raw = { schemaVersion: 1, contractType: 'forge-change/what-how-task', contractId: 'review-fixture',
    projectSlug: f.context.projectSlug, revision: 1, source: { head: f.source.reviewBase, fingerprint: `sha256:${'1'.repeat(64)}` },
    what: { objective: 'Bounded fixture change', requirements: [{ requirementId: 'R1', statement: 'Replace old input',
      acceptanceCriteria: ['Only the declared input changes'] }], assumptions: [] },
    how: { decisions: [{ decisionId: 'D1', statement: 'Use the existing input type', rationale: 'Keep current API boundaries' }], risks: [] },
    tasks: [{ taskId: 'T1', summary: 'Update declared source', dependsOn: [], requirementIds: ['R1'], decisionIds: ['D1'], ownedPaths }] };
  const updates = { [f.changed]: 'package example.order.domain;\npublic class OrderQueryDTO { String updated; }\n',
    [added]: 'package example;\nclass New {}\n', [sourcePath]: JSON.stringify(raw, null, 2),
    'forge-server/unrelated.txt': 'Another task must not enter this review.\n' };
  await rm(path.join(f.source.workspace, deleted));
  for (const [relative, content] of Object.entries(updates)) {
    const absolute = path.join(f.source.workspace, relative);
    await writeFile(absolute, content);
    const file = { relative, absolute, bytes: Buffer.byteLength(content), sha256: semanticReviewDigest(content) };
    const index = f.source.inventory.files.findIndex(item => item.relative === relative);
    if (index < 0) f.source.inventory.files.push(file); else f.source.inventory.files[index] = file;
  }
  f.source.inventory.head = f.source.reviewBase;
  f.source.inventory.workspaceFingerprint = semanticReviewDigest(f.source.inventory.files.map(({ relative, sha256 }) => ({ relative, sha256 })));
  f.source.readGit = async argv => ({ stdout: await git(argv), exitCode: 0, timedOut: false, truncated: false });
  f.context.source = { head: f.source.inventory.head, fingerprint: f.source.inventory.workspaceFingerprint };
  f.context.dualReview = { sourcePath, sha256: semanticReviewDigest(updates[sourcePath]) };
  f.context.reviewOwnedPaths = ownedPaths;
  f.context.testReceipts = [{ receiptId: 'test-receipt', profile: 'backend-test-class', canonicalSha256: `sha256:${'2'.repeat(64)}`,
    logSha256: `sha256:${'3'.repeat(64)}` }];
  f.context.obligations = ['spec-and-quality-review'];
  const input = await buildSemanticReviewInput(f.source, f.context);
  return { ...f, input, sourcePath, added, deleted, git };
}

function dualReport(f) {
  const verdict = (relative, detail) => ({ status: 'pass', summary: detail, evidence: [{ path: relative, line: 1, detail }] });
  return { ...report(), specVerdict: verdict(f.sourcePath, 'Declared requirement checked.'),
    qualityVerdict: verdict(f.changed, 'Changed input and test references checked.'), findingResolutions: [] };
}

test('dual review producer binds real scoped Git changes, untracked contents, deleted base and hashed requirements', async t => {
  const f = await dualReviewFixture(t);
  assert.equal(f.input.schemaVersion, 4);
  assert.equal(f.input.reviewScope.kind, 'task');
  assert.deepEqual(new Set(f.input.changedFiles), new Set([f.changed, f.added, f.deleted, f.sourcePath]));
  assert.equal(f.input.files.some(file => file.path === 'forge-server/unrelated.txt'), false);
  assert.equal(f.input.diff.includes('unrelated.txt'), false);
  assert.equal(f.input.files.find(file => file.path === f.deleted).sourceVersion, 'base');
  assert.deepEqual(f.input.untrackedChanges.map(file => file.path).sort(), [f.added, f.sourcePath].sort());
  assert.equal(f.input.reviewPackage.diffSha256, `sha256:${semanticReviewDigest({ diff: f.input.diff, untrackedChanges: f.input.untrackedChanges })}`);
  assert.deepEqual(f.input.reviewPackage.testReceipts, f.context.testReceipts);
  assert.equal(f.input.reviewPackage.changeContractSource.sha256, semanticReviewDigest(await readFile(path.join(f.source.workspace, f.sourcePath))));
  const oldDigest = f.input.reviewPackage.diffSha256;
  const content = 'package example;\nclass New { int value; }\n';
  await writeFile(path.join(f.source.workspace, f.added), content);
  Object.assign(f.source.inventory.files.find(file => file.relative === f.added), { sha256: semanticReviewDigest(content), bytes: Buffer.byteLength(content) });
  assert.notEqual((await buildSemanticReviewInput(f.source, f.context)).reviewPackage.diffSha256, oldDigest, 'untracked change must affect exact diff digest');
  await assert.rejects(buildSemanticReviewInput(f.source, { ...f.context, reviewOwnedPaths: [f.changed] }), { code: 'VERIFY_REVIEW_SCOPE_UNSUPPORTED' });
  await writeFile(path.join(f.source.workspace, f.sourcePath), '{}');
  await assert.rejects(buildSemanticReviewInput(f.source, f.context), { code: 'VERIFY_REVIEW_SOURCE_CHANGED' });
});

test('dual review preserves its bound read-only contract without granting other task paths', async t => {
  const f = await dualReviewFixture(t);
  const file = f.source.inventory.files.find(item => item.relative === f.sourcePath);
  const raw = JSON.parse(await readFile(file.absolute, 'utf8'));
  const bind = async () => {
    const content = JSON.stringify(raw);
    await writeFile(file.absolute, content);
    Object.assign(file, { bytes: Buffer.byteLength(content), sha256: semanticReviewDigest(content) });
    f.context.dualReview.sha256 = file.sha256;
  };
  raw.tasks[0].ownedPaths.push(f.sourcePath);
  await bind();
  const input = await buildSemanticReviewInput(f.source, f.context);
  assert.equal(input.reviewScope.ownedPaths.includes(f.sourcePath), false);
  assert.equal(input.reviewPackage.changeContractSource.sha256, file.sha256);
  assert.equal(input.changedFiles.includes(f.sourcePath), true);
  raw.tasks[0].ownedPaths.push('forge-server/unrelated.txt');
  await bind();
  await assert.rejects(buildSemanticReviewInput(f.source, f.context), { code: 'VERIFY_REVIEW_SCOPE_UNSUPPORTED' });
});

test('dual review preserves complete inputs above 768 KiB with a matching bounded Codex consumer', async t => {
  const f = await dualReviewFixture(t);
  const file = f.source.inventory.files.find(item => item.relative === f.dependency);
  const replaceContent = async content => {
    await writeFile(file.absolute, content);
    Object.assign(file, { bytes: Buffer.byteLength(content), sha256: semanticReviewDigest(content) });
  };
  const content = `package example.security; /*${'x'.repeat(800 * 1024)}*/`;
  await replaceContent(content);
  const input = await buildSemanticReviewInput(f.source, f.context);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 768 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1024 * 1024);
  assert.equal(input.files.find(item => item.path === f.dependency).content, content);
  const provider = await codexReviewFixture(t); let calls = 0;
  const reviewer = createCodexSemanticReviewer({ tokenFile: provider.tokenFile, taskId: f.context.taskId }, async (_url, options) => {
    calls += 1;
    assert.equal(JSON.parse(JSON.parse(options.body).input[0].content[0].text).files.find(item => item.path === f.dependency).content, content);
    return provider.sse([provider.terminal(JSON.stringify(dualReport(f)))]);
  });
  assert.deepEqual((await reviewer(input)).review, dualReport(f));
  await replaceContent('x'.repeat(1024 * 1024));
  await assert.rejects(buildSemanticReviewInput(f.source, f.context), { code: 'VERIFY_REVIEW_INPUT_TOO_LARGE' });
  await replaceContent('"'.repeat(550 * 1024));
  await assert.rejects(buildSemanticReviewInput(f.source, f.context), { code: 'VERIFY_REVIEW_INPUT_TOO_LARGE' });
  await assert.rejects(reviewer({ ...input, excess: 'x'.repeat(1024 * 1024) }), { code: 'VERIFY_REVIEW_INPUT_TOO_LARGE' });
  assert.equal(calls, 1);
});

test('dual review result refuses legacy decisions, invented citations, conflicting verdicts and unsupported causal findings', async t => {
  const f = await dualReviewFixture(t); const passed = dualReport(f);
  assert.deepEqual(validateSemanticReviewResult(passed, f.input), passed);
  assert.throws(() => validateSemanticReviewResult(report(), f.input), error => error.reviewDiagnostic.reason === 'review-fields-invalid');
  for (const patch of [value => { delete value.qualityVerdict; }, value => { value.specVerdict.evidence[0].line = 9999; },
    value => { value.qualityVerdict.status = 'fail'; }, value => { value.findingResolutions = [{ findingSha256: `sha256:${'4'.repeat(64)}`, status: 'resolved', evidence: value.specVerdict.evidence }]; }]) {
    const invalid = structuredClone(passed); patch(invalid);
    assert.throws(() => validateSemanticReviewResult(invalid, f.input), { code: 'VERIFY_REVIEW_RESPONSE_INVALID' });
  }
  const rejected = { ...passed, decision: 'rejected', qualityVerdict: { ...passed.qualityVerdict, status: 'fail' }, findings: [
    { path: f.deleted, line: 2, severity: 'blocking', detail: 'Removed a required implementation.',
      changeEvidence: { path: f.deleted, side: 'before', line: 2, explanation: 'Current diff removes the implementation.' } },
  ] };
  assert.deepEqual(validateSemanticReviewResult(rejected, f.input), rejected);
  rejected.findings[0].changeEvidence.line = 99;
  assert.throws(() => validateSemanticReviewResult(rejected, f.input), error => error.reviewDiagnostic.reason === 'change-evidence-outside-diff');
});

test('dual review Host submits the complete provider-bound package and reuses it after an issuer disconnect', async t => {
  const f = await dualReviewFixture(t); const executable = process.execPath;
  const contract = { schemaVersion: 2, executionMode: 'host-toolchain', processIsolation: 'bubblewrap', independentReview: 'api-error-and-auth-contract',
    projectSlug: f.context.projectSlug, runnerRevision: 'test-dual-review', profileCatalogVersion: '2026.09.03.3',
    taskspacesRoot: path.join(f.root, 'taskspaces'), stateRoot: path.join(f.root, 'state'),
    toolchains: { java: executable, javaHome: path.dirname(executable), maven: executable, node: executable, pnpm: executable, git: executable, forgeGovernance: executable },
    profiles: [...VERIFY_PROFILE_NAMES], limits: { maxFiles: 1000, maxBytes: 1024 * 1024, maxLogBytes: 1024 * 1024, defaultTimeoutSeconds: 30, maxConcurrent: 2 } };
  let calls = 0; const submissions = [];
  const runner = new HostVerificationRunner({ projectSlug: f.context.projectSlug, contract,
    command: async () => assert.fail('review must reuse protected tests'),
    semanticReviewer: async input => { calls++; assert.deepEqual(input.reviewPackage, f.input.reviewPackage);
      return { provider: 'openai-codex', model: 'gpt-5.6-luna', providerRequestId: 'response-dual', review: dualReport(f) }; },
    acceptanceIssuerClient: async (route, body) => {
      if (route.endsWith('-context')) return f.context;
      submissions.push(body);
      validateForgeDualReviewEvidence(body.dualReview, { decision: body.decision, testReceipts: f.context.testReceipts,
        contract: { contractId: f.context.contractId, projectSlug: f.context.projectSlug, taskId: f.context.taskId,
          candidate: { source: f.context.source }, dualReview: f.context.dualReview } });
      if (submissions.length === 1) throw new Error('fixture issuer disconnected');
      return { status: 'passed', receiptId: body.reviewId };
    } });
  runner.source = async () => f.source;
  await assert.rejects(runner.reviewCandidate(f.context.taskId, f.context.contractId), /issuer disconnected/u);
  assert.equal((await runner.reviewCandidate(f.context.taskId, f.context.contractId)).status, 'passed');
  assert.equal(calls, 1); assert.deepEqual(submissions[0], submissions[1]);
  const directory = path.join(contract.stateRoot, 'independent-reviews', f.context.taskId);
  const reportFile = path.join(directory, (await readdir(directory)).find(name => name.startsWith('独立审查报告-')));
  const saved = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(saved.inputSchemaVersion, 4);
  saved.reviewPackage.diffSha256 = `sha256:${'9'.repeat(64)}`;
  await writeFile(reportFile, JSON.stringify(saved));
  await assert.rejects(runner.reviewCandidate(f.context.taskId, f.context.contractId), { code: 'VERIFY_REVIEW_RESULT_INVALID' });
  assert.equal(calls, 1); assert.equal(submissions.length, 2);
});

test('dual review Codex request selects the two-verdict instructions and validates the actual final envelope', async t => {
  const f = await dualReviewFixture(t); const provider = await codexReviewFixture(t); let request;
  const reviewer = createCodexSemanticReviewer({ tokenFile: provider.tokenFile, taskId: f.context.taskId }, async (_url, options) => {
    request = JSON.parse(options.body); return provider.sse([provider.terminal(JSON.stringify(dualReport(f)))]);
  });
  assert.deepEqual((await reviewer(f.input)).review, dualReport(f));
  assert.match(request.instructions, /specVerdict与qualityVerdict/u);
  assert.doesNotMatch(request.instructions, /当前输入schemaVersion为3/u);
  assert.deepEqual(request.tools, []);
  assert.deepEqual(JSON.parse(request.input[0].content[0].text).reviewPackage, f.input.reviewPackage);
});

test('independent review includes the committed change, related API and transitive Java context', async (t) => {
  const fixture = await reviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  assert.equal(input.reviewBase, 'a'.repeat(40));
  assert.deepEqual(input.changedFiles, [fixture.changed]);
  assert.deepEqual(new Set(input.files.map((file) => file.path)), new Set([fixture.changed, fixture.controller, fixture.dependency,
    ...fixture.wiring, fixture.mapper, fixture.mapperXml]));
  await writeFile(fixture.source.inventory.files[0].absolute, 'drifted content');
  await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context), (error) => error.code === 'VERIFY_REVIEW_SOURCE_CHANGED');
});

test('independent review retains complete inputs above 512 KiB and rejects the bounded 768 KiB limit', async (t) => {
  const fixture = await reviewFixture(t);
  const file = fixture.source.inventory.files.find((item) => item.relative === fixture.changed);
  const replaceContent = async (content) => {
    await writeFile(file.absolute, content);
    file.bytes = Buffer.byteLength(content);
    file.sha256 = semanticReviewDigest(content);
  };
  const content = `package example.order.domain; /*${'x'.repeat(640 * 1024)}*/`;
  await replaceContent(content);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 512 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 768 * 1024);
  assert.equal(input.files.find((item) => item.path === fixture.changed).content, content);
  assert.ok(input.files.some((item) => item.path === fixture.dependency), 'transitive dependencies remain complete');
  await replaceContent('x'.repeat(768 * 1024));
  await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context),
    (error) => error.code === 'VERIFY_REVIEW_INPUT_TOO_LARGE');
  // JSON escaping also consumes the bound, even when the raw source fits.
  await replaceContent('"'.repeat(400 * 1024));
  await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context),
    (error) => error.code === 'VERIFY_REVIEW_INPUT_TOO_LARGE');
});

async function realChangeFixture(t) {
  const fixture = await reviewFixture(t);
  const workspace = path.join(fixture.root, 'real-workspace');
  await mkdir(workspace);
  const execute = promisify(execFile);
  const git = async (argv) => (await execute('git', ['-c', 'core.autocrlf=false', ...argv], { cwd: workspace, encoding: 'utf8', maxBuffer: 512 * 1024 })).stdout;
  await git(['init', '--quiet']);
  await git(['config', 'diff.interHunkContext', '12']);
  const changed = 'forge-admin-ui/src/views/页面 名称.vue';
  const deleted = 'forge-admin-ui/src/views/Removed.vue';
  const added = 'forge-admin-ui/src/views/New.vue';
  const dependency = 'forge-server/core/src/main/java/example/AuthInterceptor.java';
  const baseline = {
    [changed]: '<template>\n<div>old</div>\n<p>same-a</p>\n<p>same-b</p>\n<p>same-c</p>\n<em>remove</em>\n<footer>keep</footer>\n</template>\n',
    [deleted]: '<template>old</template>\n',
    [dependency]: 'package example;\nclass AuthInterceptor {\n}\n',
  };
  for (const [relative, content] of Object.entries(baseline)) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), content);
  }
  await git(['add', '--', ...Object.keys(baseline)]);
  await git(['-c', 'user.name=Review fixture', '-c', 'user.email=review-fixture@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'baseline']);
  const reviewBase = (await git(['rev-parse', 'HEAD'])).trim();
  const current = { [changed]: baseline[changed].replace('<div>old</div>', '<div>new</div>').replace('<em>remove</em>\n', ''),
    [dependency]: baseline[dependency], [added]: '<template>\nnew</template>' };
  await rm(path.join(workspace, deleted));
  const files = [];
  for (const [relative, content] of Object.entries(current)) {
    const absolute = path.join(workspace, relative);
    await writeFile(absolute, content);
    files.push({ relative, absolute, sha256: semanticReviewDigest(content), bytes: Buffer.byteLength(content) });
  }
  const source = { workspace, reviewBase, inventory: { head: reviewBase, workspaceFingerprint: semanticReviewDigest(current), files },
    readGit: async (argv) => ({ stdout: await git(argv), exitCode: 0, timedOut: false, truncated: false }) };
  const input = await buildSemanticReviewInput(source, { ...fixture.context,
    source: { head: reviewBase, fingerprint: source.inventory.workspaceFingerprint } });
  return { input, changed, deleted, added, dependency };
}

test('versioned review ranges use actual Git changed and deleted lines without quoted-path or inter-hunk ambiguity', async (t) => {
  const { input, changed, deleted, added, dependency } = await realChangeFixture(t);
  assert.equal(input.schemaVersion, 3);
  assert.deepEqual(input.changeRanges.find((range) => range.path === changed), {
    path: changed, before: [{ start: 2, count: 1 }, { start: 6, count: 1 }], after: [{ start: 2, count: 1 }, { start: 5, count: 0 }],
  });
  assert.deepEqual(input.changeRanges.find((range) => range.path === deleted), {
    path: deleted, before: [{ start: 1, count: 1 }], after: [{ start: 0, count: 0 }],
  });
  assert.deepEqual(input.changeRanges.find((range) => range.path === added), { path: added, before: [], after: [{ start: 1, count: 2 }] });
  assert.ok(input.files.some((file) => file.path === dependency));
  assert.equal(input.changeRanges.some((range) => range.path === dependency), false);
});

test('versioned review requires actual change evidence without downgrading impacted unchanged dependencies or rewriting legacy findings', async (t) => {
  const { input, changed, deleted, dependency } = await realChangeFixture(t);
  const legacy = { ...report(), decision: 'rejected', findings: [
    { path: dependency, line: 2, severity: 'blocking', detail: '旧依赖存在风险，须说明是否被本次变化触发。' },
  ] };
  const legacyBytes = JSON.stringify(legacy);
  assert.deepEqual(validateSemanticReviewResult(legacy, { ...input, schemaVersion: 1 }), legacy);
  assert.throws(() => validateSemanticReviewResult(legacy, input), (error) => error.reviewDiagnostic.reason === 'change-evidence-required');
  assert.equal(JSON.stringify(legacy), legacyBytes);
  for (const schemaVersion of [undefined, 0, 4]) assert.throws(() => validateSemanticReviewResult(report(), { ...input, schemaVersion }),
    (error) => error.reviewDiagnostic.reason === 'input-schema-invalid');
  const blocking = { ...legacy, findings: [{ ...legacy.findings[0], changeEvidence: {
    path: changed, side: 'after', line: 2, explanation: '当前修改的调用路径可触发该依赖中的已有缺陷；位置可核对，因果仍须独审判断。',
  } }] };
  assert.deepEqual(validateSemanticReviewResult(blocking, input), blocking);
  assert.throws(() => validateSemanticReviewResult({ ...blocking, decision: 'approved' }, input),
    (error) => error.reviewDiagnostic.reason === 'approval-inconsistent');
  for (const patch of [{ path: dependency }, { line: 4 }, { path: deleted, side: 'after', line: 1 }]) {
    const incorrect = { ...blocking, findings: [{ ...blocking.findings[0], changeEvidence: { ...blocking.findings[0].changeEvidence, ...patch } }] };
    assert.throws(() => validateSemanticReviewResult(incorrect, input), (error) => error.reviewDiagnostic.reason === 'change-evidence-outside-diff');
  }
  for (const evidence of [null, { ...blocking.findings[0].changeEvidence, explanation: '' }]) {
    assert.throws(() => validateSemanticReviewResult({ ...blocking, findings: [{ ...blocking.findings[0], changeEvidence: evidence }] }, input),
      (error) => ['change-evidence-required', 'change-evidence-invalid'].includes(error.reviewDiagnostic.reason));
  }
  const deletion = { ...blocking, findings: [{ ...blocking.findings[0], changeEvidence: { ...blocking.findings[0].changeEvidence, path: deleted, side: 'before', line: 1 } }] };
  assert.equal(validateSemanticReviewResult(deletion, input).decision, 'rejected');
  const advisory = { ...report(), findings: [{ ...legacy.findings[0], severity: 'advisory', changeEvidence: null }] };
  assert.deepEqual(validateSemanticReviewResult(advisory, input), advisory);
});

test('v3 rejects unsupported insufficient decisions while retaining v2 history and genuine missing-static-material rejections', async (t) => {
  const fixture = await reviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  const historical = { ...report(), decision: 'rejected', summary: '历史依赖未变；运行态验证尚未进行。',
    checks: { apiErrors: 'insufficient', authorization: 'insufficient', tenantIsolation: 'insufficient', changeScope: 'checked' },
    findings: [{ path: fixture.controller, line: 3, severity: 'advisory', changeEvidence: null, detail: '历史路径未因当前改动扩大，仅作记录。' }] };
  const historicalBytes = JSON.stringify(historical);
  assert.deepEqual(validateSemanticReviewResult(historical, { ...input, schemaVersion: 2 }), historical);
  assert.throws(() => validateSemanticReviewResult(historical, input), (error) => {
    assert.deepEqual(error.reviewDiagnostic, { stage: 'final-schema', reason: 'rejection-inconsistent', field: 'decision' });
    return error.code === 'VERIFY_REVIEW_RESPONSE_INVALID';
  });
  assert.equal(JSON.stringify(historical), historicalBytes, 'the rejected historical report is neither rewritten nor approved');
  const missingMaterial = { ...historical, summary: '当前新增字段缺少必要的权限映射静态材料。',
    findings: [{ path: fixture.changed, line: 1, severity: 'blocking', detail: '需提供新增查询字段的权限映射实现，才能判断该字段的当前可见性。',
      changeEvidence: { path: fixture.changed, side: 'after', line: 1,
        explanation: '当前差异新增查询字段，缺少该字段进入处理链后的权限映射实现，阻碍本次字段可见性的静态判断。' } }] };
  assert.deepEqual(validateSemanticReviewResult(missingMaterial, input), missingMaterial);
  assert.throws(() => validateSemanticReviewResult({ ...historical, decision: 'approved' }, input),
    (error) => error.reviewDiagnostic.reason === 'approval-inconsistent');
});

async function sqlReviewFixture(t, sql = 'forge-server/app/src/main/resources/db/migration/V1__update_task_menu.sql') {
  const fixture = await reviewFixture(t);
  const javaTest = 'forge-server/app/src/test/java/example/menu/TaskMenuMigrationTest.java';
  const contents = {
    [sql]: 'UPDATE task_menu SET enabled = 1 WHERE tenant_id = 2;\n',
    [javaTest]: 'package example.menu;\nclass TaskMenuMigrationTest {}\n',
  };
  for (const [relative, content] of Object.entries(contents)) {
    const absolute = path.join(fixture.source.workspace, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    fixture.source.inventory.files.push({ relative, absolute, bytes: Buffer.byteLength(content), sha256: semanticReviewDigest(content) });
  }
  const diff = Object.entries(contents).map(([relative, content]) => `diff --git a/${relative} b/${relative}\n+++ b/${relative}\n+${content}`).join('');
  fixture.source.readGit = async (argv) => ({ exitCode: argv[0] === 'grep' ? 1 : 0, timedOut: false, truncated: false,
    stdout: argv.includes('--name-only') ? `${sql}\0${javaTest}\0` : ['ls-files', 'grep'].includes(argv[0]) ? ''
      : argv.includes('--unified=0') ? '@@ -1 +1 @@\n-old\n+new\n' : diff });
  return { ...fixture, sql, javaTest, contents, diff };
}

test('independent review includes complete SQL migration and Java test content, diff and digests', async (t) => {
  const fixture = await sqlReviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  assert.deepEqual(input.changedFiles, [fixture.sql, fixture.javaTest].sort());
  assert.equal(input.diff, fixture.diff);
  for (const relative of [fixture.sql, fixture.javaTest]) {
    const file = input.files.find((item) => item.path === relative);
    assert.deepEqual(file, { path: relative, content: fixture.contents[relative], sha256: semanticReviewDigest(fixture.contents[relative]) });
  }
});

test('SQL review retains source path, secret and candidate drift rejection', async (t) => {
  for (const relative of ['ops/migrations/V1.sql', 'forge-server/../V1.sql', 'forge-server/target/V1.sql']) {
    await t.test(`rejects disallowed SQL path ${relative}`, async (t) => {
      const fixture = await sqlReviewFixture(t);
      const readGit = fixture.source.readGit;
      fixture.source.readGit = async (argv) => argv.includes('--name-only')
        ? { exitCode: 0, timedOut: false, truncated: false, stdout: `${relative}\0` } : readGit(argv);
      await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context),
        (error) => error.code === 'VERIFY_REVIEW_SCOPE_UNSUPPORTED');
    });
  }
  await t.test('rejects credential-shaped SQL content before sending model input', async (t) => {
    const fixture = await sqlReviewFixture(t);
    const file = fixture.source.inventory.files.find((item) => item.relative === fixture.sql);
    const content = `-- fixture credential sk-${'a'.repeat(24)}\n${fixture.contents[fixture.sql]}`;
    await writeFile(file.absolute, content);
    file.bytes = Buffer.byteLength(content);
    file.sha256 = semanticReviewDigest(content);
    await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context),
      (error) => error.code === 'VERIFY_REVIEW_INPUT_SENSITIVE');
  });
  await t.test('rejects SQL content changed after candidate inventory', async (t) => {
    const fixture = await sqlReviewFixture(t);
    const file = fixture.source.inventory.files.find((item) => item.relative === fixture.sql);
    await writeFile(file.absolute, `${fixture.contents[fixture.sql]}-- changed after inventory\n`);
    await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context),
      (error) => error.code === 'VERIFY_REVIEW_SOURCE_CHANGED');
  });
});

async function flywayReviewFixture(t, migrationChanged = true) {
  const fixture = migrationChanged ? await sqlReviewFixture(t, 'forge-server/db/migration/V1__update_task_menu.sql') : await reviewFixture(t);
  const parentPom = 'forge-server/pom.xml';
  const adminPom = 'forge-server/forge-admin-server/pom.xml';
  const application = 'forge-server/forge-admin-server/src/main/java/example/AdminApplication.java';
  const initializer = 'forge-server/base/src/main/java/example/database/MigrationConfiguration.java';
  const configuration = 'forge-server/forge-admin-server/src/main/resources/application.yml';
  const privateValue = 'synthetic-database-password-not-for-model';
  const contents = {
    [parentPom]: '<project><properties><flyway.version>10.20.1</flyway.version></properties></project>',
    [adminPom]: '<project><dependencies><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-mysql</artifactId></dependency></dependencies></project>',
    [application]: 'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class AdminApplication {}',
    [initializer]: 'package example.database;\nimport org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;\npublic class MigrationConfiguration {}',
    [configuration]: `spring:\n  datasource:\n    password: ${privateValue}\n  flyway:\n    enabled: \${FORGE_FLYWAY_ENABLED:true}\n    locations: \${FORGE_FLYWAY_LOCATIONS:filesystem:./db/migration,filesystem:../db/migration,filesystem:forge-server/db/migration}\n    password: sk-${'b'.repeat(24)}\n`,
  };
  for (const [relative, content] of Object.entries(contents)) {
    const absolute = path.join(fixture.source.workspace, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    fixture.source.inventory.files.push({ relative, absolute, bytes: Buffer.byteLength(content), sha256: semanticReviewDigest(content) });
  }
  const readGit = fixture.source.readGit;
  fixture.source.readGit = async (argv) => {
    if (argv[0] !== 'grep') return readGit(argv);
    assert.equal(migrationChanged, true, 'non-SQL input must not start Flyway source discovery');
    return { exitCode: 0, timedOut: false, truncated: false,
      stdout: `${argv.includes('@SpringBootApplication') ? application : initializer}\0` };
  };
  return { ...fixture, parentPom, adminPom, application, initializer, configuration, privateValue, flywayContents: contents };
}

test('SQL migration review carries candidate Flyway sources and safe unresolved configuration facts', async (t) => {
  const fixture = await flywayReviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  assert.equal(input.diff, fixture.diff);
  for (const relative of [fixture.sql, fixture.javaTest, fixture.parentPom, fixture.adminPom, fixture.application, fixture.initializer]) {
    const file = input.files.find((item) => item.path === relative);
    const content = fixture.contents[relative] ?? fixture.flywayContents[relative];
    assert.deepEqual(file, { path: relative, sha256: semanticReviewDigest(content), content });
  }
  assert.deepEqual(input.sqlMigrationContext.dependencyFiles, [fixture.parentPom, fixture.adminPom]);
  assert.deepEqual(input.sqlMigrationContext.applicationEntrypoints, [fixture.application]);
  assert.deepEqual(input.sqlMigrationContext.initializationSources, [fixture.initializer]);
  const configuration = input.sqlMigrationContext.configuration[0];
  assert.equal(configuration.path, fixture.configuration);
  assert.equal(configuration.sourceSha256, semanticReviewDigest(fixture.flywayContents[fixture.configuration]));
  assert.equal(configuration.runtimeEnvironmentResolved, false);
  assert.deepEqual(configuration.fields, [
    { key: 'spring.flyway.enabled', line: 5, kind: 'environment-placeholder', variable: 'FORGE_FLYWAY_ENABLED', defaultValue: true, resolved: false },
    { key: 'spring.flyway.locations', line: 6, kind: 'environment-placeholder', variable: 'FORGE_FLYWAY_LOCATIONS',
      defaultValue: ['filesystem:./db/migration', 'filesystem:../db/migration', 'filesystem:forge-server/db/migration'], resolved: false },
  ]);
  assert.equal(input.files.some((file) => file.path === fixture.configuration), false);
  assert.equal(JSON.stringify(input).includes(fixture.privateValue), false);
  assert.equal(JSON.stringify(input).includes(`sk-${'b'.repeat(24)}`), false);
  const rejected = { ...report(), decision: 'rejected', findings: [
    { path: fixture.configuration, line: 5, severity: 'blocking', detail: 'Runtime environment override needs confirmation.', changeEvidence: changeEvidence(fixture.sql) },
  ] };
  assert.deepEqual(validateSemanticReviewResult(rejected, input), rejected);
});

test('Flyway configuration projection withholds sensitive or complex values and rejects candidate drift', async (t) => {
  const fixture = await flywayReviewFixture(t);
  const file = fixture.source.inventory.files.find((item) => item.relative === fixture.configuration);
  const sensitive = 'synthetic-unresolved-secret';
  const content = `spring:\n  flyway:\n    enabled: \${DATABASE_PASSWORD:${sensitive}}\n    locations: |\n      ${sensitive}\n`;
  await writeFile(file.absolute, content);
  file.bytes = Buffer.byteLength(content);
  file.sha256 = semanticReviewDigest(content);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  assert.deepEqual(input.sqlMigrationContext.configuration[0].fields, [
    { key: 'spring.flyway.enabled', line: 3, kind: 'unresolved', valueWithheld: true },
    { key: 'spring.flyway.locations', line: 4, kind: 'unresolved', valueWithheld: true },
  ]);
  assert.equal(JSON.stringify(input).includes(sensitive), false);
  assert.equal(JSON.stringify(input).includes('DATABASE_PASSWORD'), false);
  await writeFile(file.absolute, `${content}# changed after inventory\n`);
  await assert.rejects(buildSemanticReviewInput(fixture.source, fixture.context), (error) => error.code === 'VERIFY_REVIEW_SOURCE_CHANGED');
});

test('non-SQL review retains its original input boundary and missing Flyway source is not invented', async (t) => {
  const unchanged = await flywayReviewFixture(t, false);
  const input = await buildSemanticReviewInput(unchanged.source, unchanged.context);
  assert.equal(Object.hasOwn(input, 'sqlMigrationContext'), false);
  for (const relative of [unchanged.parentPom, unchanged.adminPom, unchanged.application, unchanged.initializer, unchanged.configuration]) {
    assert.equal(input.files.some((file) => file.path === relative), false);
  }
  const missing = await sqlReviewFixture(t, 'forge-server/db/migration/V1__update_task_menu.sql');
  const withoutFlywayFiles = await buildSemanticReviewInput(missing.source, missing.context);
  assert.deepEqual(withoutFlywayFiles.sqlMigrationContext.dependencyFiles, []);
  assert.deepEqual(withoutFlywayFiles.sqlMigrationContext.applicationEntrypoints, []);
  assert.deepEqual(withoutFlywayFiles.sqlMigrationContext.initializationSources, []);
  assert.deepEqual(withoutFlywayFiles.sqlMigrationContext.configuration, []);
});

test('invalid review envelope identifies its field without disclosing provider content', async (t) => {
  const fixture = await reviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  const cases = [
    [[], 'review-root-invalid', 'review'],
    [{ ...report(), extra: 'private-provider-value' }, 'review-fields-invalid', 'review'],
    [{ ...report(), decision: 'private-provider-value' }, 'decision-invalid', 'decision'],
    [{ ...report(), summary: {} }, 'summary-invalid', 'summary'],
    [{ ...report(), findings: {} }, 'findings-invalid', 'findings'],
    [{ ...report(), checks: {} }, 'checks-fields-invalid', 'checks'],
    ...['apiErrors', 'authorization', 'tenantIsolation', 'changeScope'].map((field) => [
      { ...report(), checks: { ...report().checks, [field]: { status: 'checked', detail: 'private-provider-value' } } },
      `checks-${field}-invalid`, `checks.${field}`,
    ]),
  ];
  for (const [value, reason, field] of cases) {
    assert.throws(() => validateSemanticReviewResult(value, input), (error) => {
      assert.equal(error.code, 'VERIFY_REVIEW_RESPONSE_INVALID');
      assert.deepEqual(error.reviewDiagnostic, { stage: 'final-schema', reason, field });
      assert.doesNotMatch(error.message, /private-provider-value/u);
      const diagnostic = { ...error.reviewDiagnostic, finalTextSha256: semanticReviewDigest(value) };
      assert.deepEqual(projectSemanticReviewFailureDiagnostic(diagnostic), diagnostic);
      return true;
    });
  }
});

test('independent provider uses fixed endpoint, no tools, and retains only validated final content', async (t) => {
  const fixture = await reviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  const keyFile = path.join(fixture.root, 'synthetic-credential');
  await writeFile(keyFile, 'test-only-model-credential-1234', { mode: 0o600 });
  let calls = 0;
  const reviewer = createDeepSeekSemanticReviewer(keyFile, async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'deepseek-v4-pro');
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.length, 2);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.max_tokens, 16384);
    const examplesMatch = body.messages[0].content.match(/BEGIN_REVIEW_FORMAT_EXAMPLES\n([^\n]+)\nEND_REVIEW_FORMAT_EXAMPLES/u);
    assert.ok(examplesMatch, 'JSON mode receives concrete examples of both possible decisions');
    const examples = JSON.parse(examplesMatch[1]);
    assert.deepEqual(examples.map((value) => value.decision), ['approved', 'rejected']);
    for (const example of examples) {
      const bound = structuredClone(example);
      for (const finding of bound.findings) {
        finding.path = fixture.changed;
        finding.changeEvidence.path = fixture.changed;
      }
      assert.deepEqual(validateSemanticReviewResult(bound, input), bound);
    }
    return new Response(JSON.stringify({ id: 'test-provider-id', model: 'deepseek-v4-pro', choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify(report()), reasoning_content: 'synthetic-reasoning-not-to-save' } }] }), { status: 200 });
  });
  const response = await reviewer(input);
  assert.equal(calls, 1);
  assert.equal(response.model, 'deepseek-v4-pro');
  assert.equal(response.review.decision, 'approved');
  assert.doesNotMatch(JSON.stringify(response), /synthetic-reasoning|credential/u);
  const invalid = report(); invalid.checks.authorization = 'insufficient';
  assert.throws(() => validateSemanticReviewResult(invalid, input), (error) => error.code === 'VERIFY_REVIEW_RESPONSE_INVALID');
  const finding = { path: fixture.controller, line: 1, severity: 'advisory', detail: 'review note', changeEvidence: null };
  for (const [patch, field, reason] of [
    [{ unexpected: 'private-extra-field' }, 'finding', 'finding-fields-invalid'],
    [{ path: 'private-path-outside-input' }, 'path', 'path-outside-input'],
    [{ line: '1' }, 'line', 'line-not-positive-integer'],
    [{ severity: 'private-severity' }, 'severity', 'severity-invalid'],
    [{ detail: '' }, 'detail', 'detail-invalid'],
  ]) {
    assert.throws(() => validateSemanticReviewResult({ ...report(), findings: [{ ...finding, ...patch }] }, input), (error) => {
      assert.deepEqual(error.reviewDiagnostic, { stage: 'final-schema', reason, field, findingIndex: 0 });
      assert.notEqual(error.definitiveFailure, true, 'field validation alone does not prove a completed provider response');
      assert.doesNotMatch(error.message, /private-/u);
      return true;
    });
  }
  const invalidJsonFinal = 'private-invalid-final-json';
  const invalidJsonReviewer = createDeepSeekSemanticReviewer(keyFile, async () => new Response(JSON.stringify({
    id: 'test-invalid-json', model: 'deepseek-v4-pro', choices: [{ finish_reason: 'stop', message: { content: invalidJsonFinal } }],
  })));
  await assert.rejects(invalidJsonReviewer(input), (error) => {
    assert.equal(error.definitiveFailure, true);
    assert.deepEqual(error.reviewDiagnostic, { stage: 'final-json', reason: 'json-invalid', field: 'review',
      finalTextSha256: semanticReviewDigest(invalidJsonFinal) });
    assert.doesNotMatch(error.message, /private-/u);
    return true;
  });
  const diagnostic = { stage: 'final-schema', reason: 'line-not-positive-integer', field: 'line',
    findingIndex: 0, finalTextSha256: 'a'.repeat(64) };
  assert.deepEqual(projectSemanticReviewFailureDiagnostic(diagnostic), diagnostic);
  for (const extra of [{ rawResponse: 'private-provider-output' }, { reason: 'private-provider-reason' },
    { field: 'private-provider-field' }, { findingIndex: 20 }, { stage: 'unknown' }]) {
    assert.equal(projectSemanticReviewFailureDiagnostic({ ...diagnostic, ...extra }), null);
  }
  let failedCalls = 0;
  const unavailable = createDeepSeekSemanticReviewer(keyFile, async () => { failedCalls += 1; return new Response('private-provider-debug', { status: 503 }); });
  await assert.rejects(unavailable(input), (error) => error.code === 'VERIFY_REVIEW_PROVIDER_FAILED' && !error.message.includes('private-provider-debug'));
  assert.equal(failedCalls, 1, 'a provider failure does not automatically retry');
  const cancellationFailure = createDeepSeekSemanticReviewer(keyFile, async () => ({ ok: false, status: 503,
    body: { cancel: async () => { throw new Error('fixture errored body'); } } }));
  await assert.rejects(cancellationFailure(input), (error) => error.code === 'VERIFY_REVIEW_PROVIDER_FAILED' && error.definitiveFailure === true);
});

test('DeepSeek independent review rejects missing and mismatched returned model identities', async (t) => {
  const fixture = await reviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  const keyFile = path.join(fixture.root, 'synthetic-credential');
  await writeFile(keyFile, 'test-only-model-credential-1234', { mode: 0o600 });
  for (const [name, model] of [['missing', undefined], ['mismatched', 'private-unexpected-model']]) {
    await t.test(name, async () => {
      let calls = 0;
      const reviewer = createDeepSeekSemanticReviewer(keyFile, async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: 'test-model-identity', model,
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(report()) } }] }));
      });
      await assert.rejects(reviewer(input), (error) => {
        assert.equal(error.code, 'VERIFY_REVIEW_RESPONSE_INVALID');
        assert.doesNotMatch(error.message, /private-unexpected-model/u);
        return true;
      });
      assert.equal(calls, 1, 'a model identity failure must not retry the provider');
    });
  }
});

async function codexReviewFixture(t) {
  const fixture = await reviewFixture(t);
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  const tokenFile = path.join(fixture.root, 'synthetic-codex-credential');
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = (exp = expiresAt) =>
    `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp,
      'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.testSignature`;
  await writeFile(tokenFile, token(), { mode: 0o600 });
  const terminal = (finalText = JSON.stringify(report())) => ({ type: 'response.completed', response: {
    id: 'resp_test_review', model: 'gpt-5.6-luna', status: 'completed', output: [
      { type: 'reasoning', encrypted_content: 'synthetic-reasoning-not-to-save' },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: finalText }] },
    ],
  } });
  const sse = (events, chunkBytes = 31) => {
    const bytes = Buffer.from(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  };
  return { ...fixture, input, tokenFile, token, terminal, sse };
}

test('Codex provider transport diagnostics preserve failure phase without exposing secrets or allowing retries', async t => {
  const f = await codexReviewFixture(t);
  const sensitive = 'https://user:synthetic-password@example.invalid/private-token';
  const reset = Object.assign(new Error(sensitive), { cause: { code: 'ECONNRESET', headers: sensitive } });
  const cancelled = new AbortController(); cancelled.abort(new Error(sensitive));
  const cases = [
    { fetch: async () => { throw reset; }, reason: 'network', transportCode: 'ECONNRESET', field: 'request' },
    { fetch: async () => new Response(new ReadableStream({ start(c) { c.error(reset); } })),
      reason: 'network', transportCode: 'ECONNRESET', field: 'response' },
    { fetch: async (_url, options) => { await new Promise(resolve => setTimeout(resolve, 30)); options.signal.throwIfAborted(); },
      options: { timeoutMs: 5 }, reason: 'timeout', field: 'request' },
    { fetch: async (_url, options) => { options.signal.throwIfAborted(); },
      options: { signal: cancelled.signal }, reason: 'cancelled', field: 'request' },
    { fetch: async () => { throw Object.assign(new Error(sensitive), { code: sensitive }); }, reason: 'unknown', field: 'request' },
  ];
  for (const item of cases) {
    let calls = 0;
    const review = createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async (...args) => {
      calls++; return item.fetch(...args);
    });
    await assert.rejects(review(f.input, item.options), error => {
      assert.equal(error.code, 'VERIFY_REVIEW_PROVIDER_FAILED');
      assert.notEqual(error.definitiveFailure, true);
      assert.deepEqual(error.reviewDiagnostic, { stage: 'provider-transport', reason: item.reason, field: item.field,
        ...(item.transportCode ? { transportCode: item.transportCode } : {}) });
      assert.deepEqual(projectSemanticReviewFailureDiagnostic(error.reviewDiagnostic), error.reviewDiagnostic);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-password|private-token|testSignature/u);
      assert.equal(projectSemanticReviewFailureDiagnostic({ ...error.reviewDiagnostic, message: sensitive }), null);
      assert.equal(projectSemanticReviewFailureDiagnostic({ ...error.reviewDiagnostic, transportCode: sensitive }), null);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Codex provider HTTP and event failures retain only bounded terminal diagnostics', async t => {
  const f = await codexReviewFixture(t);
  const cases = [
    { response: () => new Response('private-provider-body', { status: 503 }),
      diagnostic: { stage: 'provider-http', reason: 'http-error', field: 'status', httpStatus: 503 } },
    ...['response.failed', 'response.incomplete', 'error'].map(type => ({
      response: () => f.sse([{ type, error: { message: 'private-provider-body' } }]),
      diagnostic: { stage: 'provider-event', reason: type, field: 'event' },
    })),
  ];
  for (const item of cases) {
    const review = createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => item.response());
    await assert.rejects(review(f.input), error => {
      assert.equal(error.definitiveFailure, true);
      assert.deepEqual(error.reviewDiagnostic, item.diagnostic);
      assert.deepEqual(projectSemanticReviewFailureDiagnostic(error.reviewDiagnostic), item.diagnostic);
      assert.equal(projectSemanticReviewFailureDiagnostic({ ...error.reviewDiagnostic, raw: 'private-provider-body' }), null);
      assert.doesNotMatch(JSON.stringify(error), /private-provider-body/u);
      return true;
    });
  }
});

test('Codex independent review settles on the completed response without waiting for transport EOF', async t => {
  const f = await codexReviewFixture(t);
  let calls = 0; let cancelled = false; let timer;
  t.after(() => clearTimeout(timer));
  const reviewer = createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify(f.terminal())}\n\n`));
        // The provider has finished its response; the transport remains open.
        timer = setTimeout(() => controller.error(new Error('fixture transport stayed open after completion')), 150);
      },
      cancel() { cancelled = true; clearTimeout(timer); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.deepEqual((await reviewer(f.input)).review, report());
  assert.equal(calls, 1);
  assert.equal(cancelled, true, 'release the response body after its authoritative terminal event');
});

test('Codex independent review makes one scoped tool-free request and saves only a complete final report', async (t) => {
  const f = await codexReviewFixture(t); let calls = 0; let request;
  const review = createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId,
    proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:12345', NO_PROXY: 'localhost', PRIVATE_ENV: 'not-forwarded' } }, async (url, options, proxyEnv) => {
    calls++;
    request = { url, options, proxyEnv };
    return f.sse([{ type: 'response.output_text.delta', delta: 'untrusted-partial' }, f.terminal()], 1);
  });
  const result = await review(f.input);
  const { url, options, proxyEnv } = request;
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, `Bearer ${f.token()}`);
  assert.equal(options.headers['chatgpt-account-id'], 'synthetic-account');
  assert.deepEqual(proxyEnv, { HTTPS_PROXY: 'http://127.0.0.1:12345', NO_PROXY: 'localhost' });
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'gpt-5.6-luna'); assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(JSON.parse(body.input[0].content[0].text), f.input);
  assert.deepEqual(result, { provider: 'openai-codex', model: 'gpt-5.6-luna', providerRequestId: 'resp_test_review', review: report() });
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-reasoning|testSignature|untrusted-partial/u);
  await assert.rejects(review({ ...f.input, taskId: 'foreign-task' }), { code: 'VERIFY_REVIEW_UNAVAILABLE' });
  assert.equal(calls, 1, 'foreign task fails before credential use or network');
});

test('Codex independent review uses a protected task proxy file without changing other transports', async t => {
  const f = await codexReviewFixture(t); let calls = 0;
  const proxyFile = path.join(f.root, 'synthetic-private-proxy');
  const proxy = 'http://synthetic-user:synthetic-password@127.0.0.1:17897';
  await writeFile(proxyFile, proxy + '\n', { mode: 0o600 });
  const env = { HOST_SEMANTIC_REVIEW_CODEX_TOKEN_FILE: f.tokenFile,
    HOST_SEMANTIC_REVIEW_CODEX_TASK_ID: f.input.taskId, HOST_SEMANTIC_REVIEW_CODEX_PROXY_FILE: proxyFile,
    HTTPS_PROXY: 'http://127.0.0.1:12345', NO_PROXY: '*' };
  const originalEnv = { ...env };
  const reviewer = createConfiguredSemanticReviewer(env, async (_url, _options, transportEnv) => {
    calls += 1;
    assert.deepEqual(transportEnv, { HTTPS_PROXY: proxy, NO_PROXY: '' });
    return f.sse([f.terminal()]);
  });
  assert.deepEqual((await reviewer(f.input)).review, report());
  assert.deepEqual(env, originalEnv);
  assert.throws(() => reviewer({ ...f.input, taskId: 'foreign-task' }), { code: 'VERIFY_REVIEW_UNAVAILABLE' });
  await writeFile(proxyFile, proxy + '/unsupported-path');
  await assert.rejects(reviewer(f.input), error => error.code === 'VERIFY_REVIEW_CONFIG_INVALID'
    && error.definitiveFailure === true && !error.message.includes('synthetic-password'));
  if (process.platform !== 'win32') {
    await writeFile(proxyFile, proxy); await chmod(proxyFile, 0o644);
    await assert.rejects(reviewer(f.input), { code: 'VERIFY_REVIEW_CONFIG_INVALID' });
  }
  assert.equal(calls, 1, 'foreign task and unsafe proxy fail before transport');
  assert.throws(() => createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId,
    proxyFile: 'relative-proxy' }), { code: 'VERIFY_REVIEW_CONFIG_INVALID' });
});

test('Codex independent review requires complete SSE rather than an advisory media type', async t => {
  const f = await codexReviewFixture(t); let calls = 0;
  const invoke = (body, mediaType) => createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => {
    calls += 1;
    return new Response(body, { headers: mediaType === null ? {} : { 'content-type': mediaType } });
  })(f.input);
  for (const mediaType of [null, 'application/octet-stream', 'application/json', 'text/event-stream; charset=utf-8']) {
    assert.deepEqual((await invoke(f.sse([f.terminal()]).body, mediaType)).review, report());
  }
  for (const [body, mediaType] of [
    [JSON.stringify(f.terminal()), 'application/json'],
    ['<html>Not a review</html>', 'text/event-stream'],
    [f.sse([{ type: 'response.output_text.delta', delta: JSON.stringify(report()) }]).body, 'application/octet-stream'],
  ]) await assert.rejects(invoke(body, mediaType), { code: 'VERIFY_REVIEW_RESPONSE_INVALID' });
  const wrongModel = f.terminal(); wrongModel.response.model = 'other-model';
  await assert.rejects(invoke(f.sse([wrongModel]).body, 'application/octet-stream'), { code: 'VERIFY_REVIEW_RESPONSE_INVALID' });
  assert.equal(calls, 8, 'each explicit request runs once with no retry');
});

test('Codex independent review consumes completed output items when the terminal envelope omits them', async t => {
  const f = await codexReviewFixture(t); let calls = 0;
  const final = { ...f.terminal().response.output[1], id: 'msg_review_final', phase: 'final_answer' };
  const done = { type: 'response.output_item.done', output_index: 0, item: final };
  const empty = f.terminal(); empty.response.output = [];
  const invoke = events => createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => {
    calls++; return f.sse(events);
  })(f.input);
  const created = { type: 'response.created', response: { id: empty.response.id } };
  assert.deepEqual((await invoke([created, done, empty])).review, report());
  const full = f.terminal(); full.response.output = [final];
  assert.deepEqual((await invoke([done, full])).review, report());
  const reasoning = { type: 'response.output_item.done', output_index: 0,
    item: { type: 'reasoning', id: 'reason_review', encrypted_content: 'private-reasoning' } };
  assert.deepEqual((await invoke([reasoning, { ...done, output_index: 1 }, empty])).review, report());
  const changed = structuredClone(full); changed.response.output[0].content[0].text = 'private-conflicting-final';
  const cases = [
    [done], [empty], [{ type: 'response.output_text.delta', delta: JSON.stringify(report()) }, empty],
    [done, done, empty], [{ ...done, output_index: 1 }, empty], [done, changed],
    [{ ...created, response: { id: 'different_response' } }, done, empty],
    [{ ...done, item: { id: 'tool_attempt', type: 'function_call', name: 'private-tool' } }, empty],
    [{ type: 'response.output_item.added', output_index: 0, item: { ...final, status: 'in_progress' } }, empty],
    [empty, done], [{ ...done, item: { ...final, status: 'in_progress' } }, empty],
  ];
  for (const events of cases) await assert.rejects(invoke(events), error =>
    error.code === 'VERIFY_REVIEW_RESPONSE_INVALID' && !error.message.includes('private-'));
  assert.equal(calls, 14);
});

test('Codex independent review selects the unique final phase without accepting commentary or ambiguous messages', async t => {
  const f = await codexReviewFixture(t); let calls = 0;
  const invoke = output => createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => {
    calls++;
    const terminal = f.terminal(); terminal.response.output = output;
    return f.sse([terminal]);
  })(f.input);
  const final = { ...f.terminal().response.output[1], phase: 'final_answer' };
  const commentary = { ...final, phase: 'commentary', content: [{ type: 'output_text', text: 'private-preamble-not-a-verdict' }] };
  assert.deepEqual((await invoke([commentary, final])).review, report());
  assert.deepEqual((await invoke([final])).review, report());
  const cases = [
    [commentary], [final, final], [final, commentary],
    [{ ...final, phase: undefined }, final], [{ ...commentary, phase: 'private-unknown-phase' }, final],
    [{ ...commentary, status: 'in_progress' }, final], [{ ...commentary, role: 'user' }, final],
    [{ ...commentary, content: [{ type: 'refusal', refusal: 'private-refusal' }] }, final],
    [{ ...final, status: undefined }], [{ ...final, content: [] }],
    [{ ...final, content: [{ type: 'output_text', text: 'x'.repeat(128 * 1024 + 1) }] }],
  ];
  for (const output of cases) await assert.rejects(invoke(output), error =>
    error.code === 'VERIFY_REVIEW_RESPONSE_INVALID' && !/private-|synthetic-/u.test(error.message));
  assert.equal(calls, 13, 'one call per explicit case; never silently retry a rejected response');
});

test('Codex independent review rejects expired credentials and incomplete, tool-bearing or wrong-model responses', async (t) => {
  const f = await codexReviewFixture(t); let calls = 0;
  const run = (events) => createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => { calls++; return f.sse(events); })(f.input);
  await writeFile(f.tokenFile, f.token(1));
  await assert.rejects(run([f.terminal()]), { code: 'VERIFY_REVIEW_CONFIG_INVALID', definitiveFailure: true });
  assert.equal(calls, 0);
  await writeFile(f.tokenFile, f.token());
  const tool = f.terminal(); tool.response.output.push({ type: 'function_call', name: 'write_file', arguments: '{}' });
  const wrongModel = f.terminal(); wrongModel.response.model = 'other-model';
  const wrongRole = f.terminal(); wrongRole.response.output[1].role = 'user';
  for (const events of [[{ type: 'response.output_text.delta', delta: JSON.stringify(report()) }], [tool], [wrongModel], [wrongRole], [f.terminal(), f.terminal()]]) {
    await assert.rejects(run(events), { code: 'VERIFY_REVIEW_RESPONSE_INVALID' });
  }
  assert.equal(calls, 5, 'no failure is automatically retried');
});

test('Codex independent review bounds events and preserves sanitized terminal failure diagnostics', async (t) => {
  const f = await codexReviewFixture(t); let calls = 0;
  const reviewer = (response) => createCodexSemanticReviewer({ tokenFile: f.tokenFile, taskId: f.input.taskId }, async () => { calls++; return response; });
  await assert.rejects(reviewer(new Response('private-provider-error', { status: 429 }))(f.input), (e) =>
    e.code === 'VERIFY_REVIEW_PROVIDER_FAILED' && e.definitiveFailure === true && !e.message.includes('private-provider'));
  await assert.rejects(reviewer(f.sse([{ type: 'response.failed', response: { error: { message: 'private-provider-error' } } }]))(f.input),
    { code: 'VERIFY_REVIEW_PROVIDER_FAILED', definitiveFailure: true });
  const invalid = report(); delete invalid.checks;
  await assert.rejects(reviewer(f.sse([f.terminal(JSON.stringify(invalid))]))(f.input), (e) =>
    e.code === 'VERIFY_REVIEW_RESPONSE_INVALID' && e.definitiveFailure === true && e.reviewDiagnostic.reason === 'review-fields-invalid');
  await assert.rejects(reviewer(f.sse([f.terminal('private-invalid-json')]))(f.input), (e) =>
    e.code === 'VERIFY_REVIEW_RESPONSE_INVALID' && e.definitiveFailure === true && e.reviewDiagnostic.reason === 'json-invalid'
      && !e.message.includes('private-invalid'));
  await assert.rejects(reviewer(f.sse([{ type: 'response.reasoning.delta', delta: 'x'.repeat(4 * 1024 * 1024) }], 65536))(f.input),
    { code: 'VERIFY_REVIEW_RESPONSE_INVALID' });
  await assert.rejects(reviewer(new Response(JSON.stringify(report()), { headers: { 'content-type': 'application/json' } }))(f.input),
    { code: 'VERIFY_REVIEW_RESPONSE_INVALID' });
  assert.equal(calls, 6);
});

test('Codex independent review configuration routes only the named task and preserves other tasks', async (t) => {
  const f = await codexReviewFixture(t);
  const legacyFile = path.join(f.root, 'synthetic-legacy-credential');
  await writeFile(legacyFile, 'test-only-model-credential-1234', { mode: 0o600 });
  const calls = [];
  const configured = createConfiguredSemanticReviewer({ HOST_SEMANTIC_REVIEW_KEY_FILE: legacyFile,
    HOST_SEMANTIC_REVIEW_CODEX_TOKEN_FILE: f.tokenFile, HOST_SEMANTIC_REVIEW_CODEX_TASK_ID: f.input.taskId }, async (url) => {
    calls.push(url);
    return url.includes('chatgpt.com') ? f.sse([f.terminal()])
      : new Response(JSON.stringify({ id: 'legacy-request', model: 'deepseek-v4-pro', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(report()) } }] }));
  });
  assert.equal((await configured(f.input)).provider, 'openai-codex');
  assert.equal((await configured({ ...f.input, taskId: 'unchanged-task' })).provider, 'deepseek');
  assert.deepEqual(configured.bindingForTask(f.input.taskId), { provider: 'openai-codex', model: 'gpt-5.6-luna' });
  assert.equal(configured.bindingForTask('unchanged-task'), null);
  assert.equal(configured.availableForTask('unchanged-task'), true, 'existing reviewer remains available');
  const scopedOnly = createConfiguredSemanticReviewer({ HOST_SEMANTIC_REVIEW_CODEX_TOKEN_FILE: f.tokenFile,
    HOST_SEMANTIC_REVIEW_CODEX_TASK_ID: f.input.taskId });
  assert.equal(scopedOnly.availableForTask(f.input.taskId), true);
  assert.equal(scopedOnly.availableForTask('unconfigured-task'), false);
  assert.equal(calls.length, 2);
  assert.equal(createConfiguredSemanticReviewer({}), null);
  for (const env of [{ HOST_SEMANTIC_REVIEW_CODEX_TOKEN_FILE: f.tokenFile }, { HOST_SEMANTIC_REVIEW_CODEX_TASK_ID: f.input.taskId }]) {
    assert.throws(() => createConfiguredSemanticReviewer(env), { code: 'VERIFY_REVIEW_CONFIG_INVALID' });
  }
});

test('Host preserves review results, exposes complete rejection, and distinguishes explicit retry from unknown requests', async (t) => {
  const fixture = await reviewFixture(t);
  const executable = process.execPath;
  const contract = { schemaVersion: 2, executionMode: 'host-toolchain', processIsolation: 'bubblewrap', independentReview: 'api-error-and-auth-contract',
    projectSlug: 'forge-test', runnerRevision: 'test-review', profileCatalogVersion: '2026.09.03.3', taskspacesRoot: path.join(fixture.root, 'taskspaces'), stateRoot: path.join(fixture.root, 'state'),
    toolchains: { java: executable, javaHome: path.dirname(executable), maven: executable, node: executable, pnpm: executable, git: executable, forgeGovernance: executable },
    profiles: [...VERIFY_PROFILE_NAMES], limits: { maxFiles: 1000, maxBytes: 1024 * 1024, maxLogBytes: 1024 * 1024, defaultTimeoutSeconds: 30, maxConcurrent: 2 } };
  let models = 0; let submissions = 0; const submitted = [];
  const runner = new HostVerificationRunner({ projectSlug: 'forge-test', contract,
    command: async () => { assert.fail('semantic review must not rerun business tests'); },
    semanticReviewer: async () => { models += 1; return { provider: 'deepseek', model: 'deepseek-v4-pro', providerRequestId: 'test-provider-1', review: report() }; },
    acceptanceIssuerClient: async (route, body) => {
      if (route.endsWith('-context')) return fixture.context;
      submissions += 1; submitted.push(body);
      if (submissions === 1) throw Object.assign(new Error('fixture issuer disconnected'), { code: 'VERIFY_ACCEPTANCE_ISSUER_UNAVAILABLE' });
      return { receiptId: body.reviewId, status: 'passed' };
    } });
  runner.source = async () => fixture.source;
  const request = { action: 'semantic-review', taskId: fixture.context.taskId, acceptanceContractId: fixture.context.contractId };
  await assert.rejects(runner.execute({ ...request, decision: 'approved' }), (error) => error.code === 'VERIFY_REQUEST_INVALID');
  await assert.rejects(runner.execute(request), /issuer disconnected/u);
  const result = await runner.execute(request);
  assert.equal(result.status, 'passed');
  assert.equal(models, 1);
  assert.equal(submissions, 2);
  assert.deepEqual(submitted[0], submitted[1]);
  const directory = path.join(contract.stateRoot, 'independent-reviews', fixture.context.taskId);
  const names = await readdir(directory);
  const stored = JSON.parse(await readFile(path.join(directory, names.find((name) => name.startsWith('独立审查报告-'))), 'utf8'));
  assert.equal(stored.providerRequestId, 'test-provider-1');
  assert.equal(stored.reviewSha256, semanticReviewDigest(stored.review));
  assert.equal(runner.activeByTask.size, 0);

  let codexCalls = 0;
  runner.semanticReviewer = async () => {
    codexCalls++;
    return { provider: 'openai-codex', model: 'gpt-5.6-luna', providerRequestId: 'test-codex-provider', review: report() };
  };
  runner.semanticReviewer.bindingForTask = () => ({ provider: 'openai-codex', model: 'gpt-5.6-luna' });
  const codexResult = await runner.execute(request);
  assert.equal(codexResult.status, 'passed');
  assert.notEqual(codexResult.reviewId, result.reviewId, 'changing model cannot reuse an older provider report');
  assert.equal((await runner.execute(request)).reviewId, codexResult.reviewId);
  assert.equal(codexCalls, 1, 'same model and source reuse the validated report');
  const beforeUnavailable = await readdir(directory);
  runner.semanticReviewer.availableForTask = () => false;
  await assert.rejects(runner.execute(request), { code: 'VERIFY_REVIEW_UNAVAILABLE' });
  assert.deepEqual(await readdir(directory), beforeUnavailable, 'unconfigured tasks cannot leave a pending provider request');
  assert.equal(codexCalls, 1);
  delete runner.semanticReviewer.availableForTask;

  fixture.context.contractFingerprint = `sha256:${'1'.repeat(64)}`;
  let rejectedCalls = 0;
  let rejectedId;
  runner.semanticReviewer = async () => {
    rejectedCalls += 1;
    return { provider: 'deepseek', model: 'deepseek-v4-pro', providerRequestId: 'test-rejected',
      review: { ...report(), decision: 'rejected', summary: '审查发现权限问题。'.repeat(160),
        findings: [{ path: fixture.controller, line: 3, severity: 'blocking', detail: '未授权访问必须被拒绝。', changeEvidence: changeEvidence(fixture.changed) }] } };
  };
  runner.acceptanceIssuerClient = async (route, body) => {
    if (route.endsWith('-context')) return rejectedId
      ? { ...fixture.context, status: 'blocked', reasonCode: 'EXISTING_REVIEW_BLOCKED', existingReviewId: rejectedId } : fixture.context;
    rejectedId = body.reviewId;
    return { receiptId: body.reviewId, status: 'failed' };
  };
  let rejectedJobId;
  await assert.rejects(runner.execute(request), (error) => {
    assert.equal(error.code, 'VERIFY_REVIEW_REJECTED');
    rejectedJobId = /forge-verify status --job-id ([a-f0-9-]+)/u.exec(error.message.slice(0, 1000))?.[1];
    return Boolean(rejectedJobId);
  });
  const rejection = await runner.execute({ action: 'status', taskId: request.taskId, jobId: rejectedJobId });
  assert.equal(rejection.review.findings[0].detail, '未授权访问必须被拒绝。');
  assert.ok(rejection.review.summary.length > 1000);
  await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_REJECTED' && error.message.includes(rejectedJobId));
  assert.equal(rejectedCalls, 1, 'a real rejection reuses its report and is not reviewed again');

  fixture.context.contractFingerprint = `sha256:${'2'.repeat(64)}`;
  runner.acceptanceIssuerClient = async (route, body) => route.endsWith('-context') ? fixture.context : { receiptId: body.reviewId, status: 'passed' };
  let retries = 0;
  runner.semanticReviewer = async () => {
    retries += 1;
    if (retries === 1) throw Object.assign(new Error('fixture HTTP 503'), { code: 'VERIFY_REVIEW_PROVIDER_FAILED', definitiveFailure: true });
    return { provider: 'deepseek', model: 'deepseek-v4-pro', providerRequestId: 'test-explicit-retry', review: report() };
  };
  await assert.rejects(runner.execute(request), /HTTP 503/u);
  assert.equal(retries, 1);
  assert.equal((await runner.execute(request)).status, 'passed');
  assert.equal(retries, 2, 'an explicit subsequent call can retry a confirmed failure');
  const preserved = await readdir(directory);
  assert.equal(preserved.filter((name) => name.startsWith('独立审查失败-')).length, 1);

  fixture.context.contractFingerprint = `sha256:${'3'.repeat(64)}`;
  let ambiguousCalls = 0;
  const transportDiagnostic = { stage: 'provider-transport', reason: 'network', field: 'response', transportCode: 'ECONNRESET' };
  runner.semanticReviewer = async () => { ambiguousCalls += 1; throw Object.assign(new Error('fixture connection lost'), {
    code: 'VERIFY_REVIEW_PROVIDER_FAILED', reviewDiagnostic: transportDiagnostic,
  }); };
  await assert.rejects(runner.execute(request), /connection lost/u);
  await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_RESULT_UNAVAILABLE');
  assert.equal(ambiguousCalls, 1, 'an unknown provider outcome must not be silently replayed');
  const failures = await Promise.all((await readdir(directory)).filter(name => name.startsWith('独立审查失败-'))
    .map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  const failedTransport = failures.find(value => value.diagnostic?.stage === 'provider-transport');
  assert.deepEqual(failedTransport.diagnostic, transportDiagnostic);
  assert.equal(failedTransport.automaticRetry, false);
  assert.equal(failedTransport.explicitRetryAllowed, false);
});

test('Host binds explicit review feedback to the original rejection without changing its verdict or retrying it', async (t) => {
  for (const originalInputSchemaVersion of [1, 2]) for (const nextDecision of ['approved', 'rejected']) await t.test(`v${originalInputSchemaVersion} to v3 ${nextDecision}`, async (t) => {
    const fixture = await reviewFixture(t);
    const executable = process.execPath;
    const contract = { schemaVersion: 2, executionMode: 'host-toolchain', processIsolation: 'bubblewrap', independentReview: 'api-error-and-auth-contract',
      projectSlug: 'forge-test', runnerRevision: 'test-review', profileCatalogVersion: '2026.09.03.3',
      taskspacesRoot: path.join(fixture.root, 'taskspaces'), stateRoot: path.join(fixture.root, 'state'),
      toolchains: { java: executable, javaHome: path.dirname(executable), maven: executable, node: executable, pnpm: executable, git: executable, forgeGovernance: executable },
      profiles: [...VERIFY_PROFILE_NAMES], limits: { maxFiles: 1000, maxBytes: 1024 * 1024, maxLogBytes: 1024 * 1024, defaultTimeoutSeconds: 30, maxConcurrent: 2 } };
    const legacyInput = { ...await buildSemanticReviewInput(fixture.source, fixture.context), schemaVersion: originalInputSchemaVersion };
    if (originalInputSchemaVersion === 1) delete legacyInput.changeRanges;
    const inputs = [legacyInput]; const submissions = [];
    let blocked = true;
    let modelCalls = 0;
    const rejected = { ...report(), decision: 'rejected', summary: '历史依赖的权限风险需要解释。',
      ...(originalInputSchemaVersion === 2 ? { checks: { apiErrors: 'insufficient', authorization: 'insufficient', tenantIsolation: 'insufficient', changeScope: 'checked' } } : {}),
      findings: [{ path: fixture.controller, line: 3, severity: originalInputSchemaVersion === 1 ? 'blocking' : 'advisory',
        detail: '请核实本次变更是否扩大既有风险。', ...(originalInputSchemaVersion === 2 ? { changeEvidence: null } : {}) }] };
    const originalInputSha256 = semanticReviewDigest(legacyInput);
    const originalIdentity = semanticReviewDigest({ contractFingerprint: fixture.context.contractFingerprint, inputSha256: originalInputSha256 });
    const original = {
      schemaVersion: 1, reviewId: `review-${originalIdentity}`, jobId: '11111111-1111-4111-8111-111111111111',
      projectSlug: fixture.context.projectSlug, taskId: fixture.context.taskId,
      contractId: fixture.context.contractId, contractFingerprint: fixture.context.contractFingerprint,
      source: fixture.context.source, candidateDiffSha256: fixture.context.candidateDiffSha256,
      ...(originalInputSchemaVersion === 1 ? {} : { inputSchemaVersion: originalInputSchemaVersion }),
      inputSha256: originalInputSha256, reviewBase: legacyInput.reviewBase, changedFiles: legacyInput.changedFiles,
      inputManifest: legacyInput.files.map(({ path, sha256 }) => ({ path, sha256 })),
      provider: 'deepseek', model: 'deepseek-v4-pro', providerRequestId: 'fixture-legacy-provider',
      review: rejected, reviewSha256: semanticReviewDigest(rejected), completedAt: new Date().toISOString(),
    };
    const originalSummary = JSON.stringify({ provider: original.provider, model: original.model, providerRequestId: original.providerRequestId,
      inputSha256: original.inputSha256, reviewSha256: original.reviewSha256, review: original.review });
    submissions.push({ reviewId: original.reviewId, summary: originalSummary, decision: 'rejected' });
    const originalFile = path.join(contract.stateRoot, 'independent-reviews', fixture.context.taskId, `独立审查报告-${originalIdentity}.json`);
    await mkdir(path.dirname(originalFile), { recursive: true });
    const originalBytes = `${JSON.stringify(original)}\n`;
    await writeFile(originalFile, originalBytes);
    const rejectedCurrent = { ...rejected, findings: rejected.findings.map((finding) => ({ ...finding, severity: 'blocking', changeEvidence: changeEvidence(fixture.changed) })) };
    const runner = new HostVerificationRunner({ projectSlug: 'forge-test', contract,
      command: async () => { assert.fail('review feedback must not rerun business tests'); },
      semanticReviewer: async (input) => {
        modelCalls += 1;
        inputs.push(input);
        return { provider: 'deepseek', model: 'deepseek-v4-pro', providerRequestId: `fixture-${inputs.length}`,
          review: nextDecision === 'rejected' ? rejectedCurrent : report() };
      },
      acceptanceIssuerClient: async (route, body) => {
        if (route.endsWith('-context')) return blocked
          ? { ...fixture.context, status: 'blocked', reasonCode: 'EXISTING_REVIEW_BLOCKED', existingReviewId: submissions[0].reviewId }
          : fixture.context;
        submissions.push(body);
        return { receiptId: body.reviewId, status: body.decision === 'approved' ? 'passed' : 'failed' };
      } });
    runner.source = async () => fixture.source;
    const request = { action: 'semantic-review', taskId: fixture.context.taskId, acceptanceContractId: fixture.context.contractId };
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_REJECTED');
    const first = submissions[0];
    const feedback = { reviewId: first.reviewId, summarySha256: semanticReviewDigest(first.summary),
      explanation: '本次仅修改查询字段；请根据完整差异确认历史依赖中的问题是否由本次修改引入或扩大，不预设批准。' };
    fixture.context.reviewFeedback = feedback;
    blocked = true;
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_REJECTED');
    assert.equal(inputs.length, 1, 'feedback cannot erase an existing rejection in a still-current contract');
    assert.equal(modelCalls, 0, 'the archived rejection is not redrawn through the new reviewer');

    // The protected service, not Host, owns natural-expiry continuation and
    // checks the current user authority before returning this new context.
    blocked = false;
    fixture.context.contractFingerprint = `sha256:${'9'.repeat(64)}`;
    fixture.context.contractId = 'f'.repeat(64);
    request.acceptanceContractId = fixture.context.contractId;
    fixture.context.reviewFeedback = { ...feedback, summarySha256: '0'.repeat(64) };
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_FEEDBACK_INVALID');
    fixture.context.reviewFeedback = feedback;
    await writeFile(originalFile, JSON.stringify({ ...original, source: { ...original.source, head: '0'.repeat(40) } }));
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_FEEDBACK_INVALID');
    await writeFile(originalFile, originalBytes);
    fixture.context.reviewFeedback = { ...feedback, explanation: `sk-${'z'.repeat(24)}` };
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_INPUT_TOO_LARGE');
    assert.equal(inputs.length, 1, 'invalid or sensitive feedback never reaches the model');
    fixture.context.reviewFeedback = feedback;
    if (nextDecision === 'approved') assert.equal((await runner.execute(request)).status, 'passed');
    else await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_REJECTED');
    assert.equal(inputs.length, 2);
    assert.equal(modelCalls, 1);
    assert.equal(inputs[1].schemaVersion, 3);
    assert.equal(inputs[1].reviewFeedback.originalInputSchemaVersion, originalInputSchemaVersion);
    assert.equal(inputs[1].reviewFeedback.explanation, feedback.explanation);
    assert.deepEqual(inputs[1].reviewFeedback.originalReview, rejected);
    assert.deepEqual(inputs[1].files, inputs[0].files);
    assert.equal(inputs[1].diff, inputs[0].diff);
    assert.notEqual(semanticReviewDigest(inputs[1]), semanticReviewDigest(inputs[0]));
    assert.equal(await readFile(originalFile, 'utf8'), originalBytes);
    if (nextDecision === 'approved') assert.equal((await runner.execute(request)).status, 'passed');
    else await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_REJECTED');
    assert.equal(inputs.length, 2, 'same authorized feedback and current contract reuse the saved result');
    assert.equal(modelCalls, 1);
    const corrected = submissions[1];
    assert.equal(corrected.decision, nextDecision);
    fixture.context.contractFingerprint = `sha256:${'8'.repeat(64)}`;
    fixture.context.reviewFeedback = { ...feedback, reviewId: corrected.reviewId, summarySha256: semanticReviewDigest(corrected.summary) };
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_FEEDBACK_INVALID');
    assert.equal(inputs.length, 2, 'a correction result cannot become a recursive review retry');
  });
});

test('complete invalid provider findings are archived safely and recover on a later explicit request', async (t) => {
  const fixture = await reviewFixture(t);
  const executable = process.execPath;
  const contract = { schemaVersion: 2, executionMode: 'host-toolchain', processIsolation: 'bubblewrap', independentReview: 'api-error-and-auth-contract',
    projectSlug: 'forge-test', runnerRevision: 'test-review', profileCatalogVersion: '2026.09.03.3', taskspacesRoot: path.join(fixture.root, 'taskspaces'), stateRoot: path.join(fixture.root, 'state'),
    toolchains: { java: executable, javaHome: path.dirname(executable), maven: executable, node: executable, pnpm: executable, git: executable, forgeGovernance: executable },
    profiles: [...VERIFY_PROFILE_NAMES], limits: { maxFiles: 1000, maxBytes: 1024 * 1024, maxLogBytes: 1024 * 1024, defaultTimeoutSeconds: 30, maxConcurrent: 2 } };
  const key = 'test-only-model-credential-1234';
  const keyFile = path.join(fixture.root, 'synthetic-credential');
  await writeFile(keyFile, key, { mode: 0o600 });
  const invalidFinal = JSON.stringify({ ...report(), decision: 'rejected',
    checks: { apiErrors: 'insufficient', authorization: 'insufficient', tenantIsolation: 'insufficient', changeScope: 'checked' }, findings: [
    { path: fixture.controller, line: 3, severity: 'advisory', changeEvidence: null, detail: 'private-invalid-detail-not-to-save' },
  ] });
  let calls = 0; let submissions = 0; let mode = 'invalid';
  const reviewer = createDeepSeekSemanticReviewer(keyFile, async () => {
    calls += 1;
    if (mode === 'timeout') throw new DOMException('private-timeout-diagnostic', 'TimeoutError');
    if (mode === 'oversize') return new Response('private-oversize-output'.repeat(7000));
    if (mode === 'disconnect') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('private-partial-response'));
      controller.error(new Error('private-stream-diagnostic'));
    } }));
    return new Response(JSON.stringify({ id: 'test-final-response', choices: [{ finish_reason: 'stop',
      message: { content: mode === 'invalid' ? invalidFinal : JSON.stringify(report()),
        reasoning_content: 'private-reasoning-not-to-save' } }] }));
  });
  const runner = new HostVerificationRunner({ projectSlug: 'forge-test', contract, semanticReviewer: reviewer,
    command: async () => { assert.fail('format recovery must not run business tests'); },
    acceptanceIssuerClient: async (route, body) => {
      if (route.endsWith('-context')) return fixture.context;
      submissions += 1; return { receiptId: body.reviewId, status: 'passed' };
    } });
  runner.source = async () => fixture.source;
  const request = { action: 'semantic-review', taskId: fixture.context.taskId, acceptanceContractId: fixture.context.contractId };
  await assert.rejects(runner.execute(request), (error) => {
    assert.equal(error.code, 'VERIFY_REVIEW_RESPONSE_INVALID');
    assert.equal(error.definitiveFailure, true);
    assert.match(error.message, /decision/u);
    assert.match(error.message, /显式/u);
    return true;
  });
  assert.equal(calls, 1, 'a completed invalid result never retries automatically');
  assert.equal(submissions, 0, 'invalid findings never reach the acceptance issuer');
  const directory = path.join(contract.stateRoot, 'independent-reviews', fixture.context.taskId);
  const initialNames = await readdir(directory);
  const failureName = initialNames.find((name) => name.startsWith('独立审查失败-'));
  const originalFailure = await readFile(path.join(directory, failureName), 'utf8');
  const failure = JSON.parse(originalFailure);
  assert.equal(failure.explicitRetryAllowed, true);
  assert.deepEqual(failure.diagnostic, { stage: 'final-schema', reason: 'rejection-inconsistent', field: 'decision',
    finalTextSha256: semanticReviewDigest(invalidFinal) });
  const input = await buildSemanticReviewInput(fixture.source, fixture.context);
  const identity = semanticReviewDigest({ contractFingerprint: fixture.context.contractFingerprint, inputSha256: semanticReviewDigest(input) });
  assert.equal(initialNames.includes(`独立审查请求-${identity}.json`), false);
  assert.equal(initialNames.some((name) => name.startsWith(`独立审查请求-${identity}-`)), true);
  mode = 'valid';
  assert.equal((await runner.execute(request)).status, 'passed');
  assert.equal(calls, 2);
  assert.equal(submissions, 1);
  assert.equal(await readFile(path.join(directory, failureName), 'utf8'), originalFailure);

  for (const [index, unknownMode] of ['timeout', 'disconnect', 'oversize'].entries()) {
    fixture.context.contractFingerprint = `sha256:${String(index + 3).repeat(64)}`;
    mode = unknownMode;
    const beforeCalls = calls;
    await assert.rejects(runner.execute(request), (error) => {
      assert.ok(['VERIFY_REVIEW_PROVIDER_FAILED', 'VERIFY_REVIEW_RESPONSE_INVALID'].includes(error.code));
      assert.notEqual(error.definitiveFailure, true);
      return true;
    });
    await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_RESULT_UNAVAILABLE');
    assert.equal(calls, beforeCalls + 1, `${mode} keeps the request lock and never silently replays`);
  }
  const saved = await Promise.all((await readdir(directory)).map((name) => readFile(path.join(directory, name), 'utf8')));
  assert.doesNotMatch(saved.join('\n'), /private-|test-only-model-credential|reasoning_content/u);
  const failures = saved.map((text) => JSON.parse(text)).filter((value) => Object.hasOwn(value, 'explicitRetryAllowed'));
  assert.equal(failures.filter((value) => value.explicitRetryAllowed === false).length, 3);

  fixture.context.contractFingerprint = `sha256:${'6'.repeat(64)}`;
  runner.semanticReviewer = async () => { throw Object.assign(new Error('private-diagnostic-error'), {
    code: 'VERIFY_REVIEW_RESPONSE_INVALID', reviewDiagnostic: { ...failure.diagnostic, rawResponse: 'private-provider-output' },
  }); };
  await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_REVIEW_RESPONSE_INVALID');
  const finalFailures = await Promise.all((await readdir(directory)).filter((name) => name.startsWith('独立审查失败-'))
    .map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  assert.equal(finalFailures.filter((value) => value.explicitRetryAllowed === false && value.diagnostic === undefined).length, 4);
  assert.doesNotMatch(JSON.stringify(finalFailures), /private-|rawResponse/u);
});
