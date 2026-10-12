import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = await readFile(path.join(repoRoot, 'scripts', 'refresh-harness-runtime-lock.sh'), 'utf8');
const packager = await readFile(path.join(repoRoot, 'scripts', 'package-portable-toolkit.sh'), 'utf8');

test('portable toolkit requires the vpn71 protected execution runtime and local evidence closure', () => {
  for (const required of [
    'docker/harness/forge-governance-runtime.patch.yml',
    'docker/harness/forge-governance-prompt-guard.mjs',
    'docker/harness/forge-completion-claim-guard.mjs',
    'docker/harness/forge-controlled-command.mjs',
    'docker/harness/forge-host-verification-receipt.mjs',
    'docker/harness/forge-task-execution-contract.mjs',
    'docker/harness/forge-phase-work-package.mjs',
    'docker/harness/forge-execution-context.mjs',
    'docker/harness/forge-execution-policy.json',
    'docker/harness/forge-prepare-headless-execution.mjs',
    'docker/harness/forge-recover-headless-execution.mjs',
    'scripts/run-forge-protected-headless-recovery.mjs',
    'docker/harness/forge-protected-headless-runner.mjs',
    'docker/harness/forge-execution-capability-registry.json',
    'docker/harness/forge-execution-capability-registry.mjs',
    'docker/harness/forge-capability-negotiator.mjs',
    'docker/harness/forge-execution-pack.mjs',
    'docker/harness/forge-execution-store.mjs',
    'docker/harness/forge-execution-orchestrator.mjs',
    'docker/harness/forge-progress-detector.mjs',
    'docker/harness/forge-change-contract.mjs',
    'docker/harness/forge-business-data-approval.mjs',
    'docker/harness/forge-business-object-mutation.mjs',
    'docker/harness/forge-semantic-resource-lease.mjs',
    'docker/harness/forge-workflow-migration-safety.mjs',
    'docker/harness/forge-ui-edit-session.mjs',
    'docker/harness/forge-behavior-qualification.mjs',
    'docker/harness/forge-reference-adoption-coverage.mjs',
    'docker/harness/forge-reference-adoption-coverage.json',
    'docker/harness/forge-acceptance-aggregator.mjs',
    'docker/harness/forge-protected-issuer-adapter.mjs',
    'docker/harness/forge-production-task-grant.mjs',
    'docker/harness/forge-protected-acceptance-service.mjs',
    'docker/harness/forge-quality-capability-registry.mjs',
    'docker/harness/forge-quality-capability-registry.json',
    'docker/harness/forge-phase-budget-guard.mjs',
    'docker/harness/forge-ui-contract.mjs',
    'docker/harness/forge-ui-contract.json',
    'docker/harness/forge-agent-preset-policy.mjs',
    'docker/harness/forge-agent-preset-prompt-probe.mjs',
    'docker/harness/forge-agent-preset-prompt-probe.patch.yml',
    'docker/harness/forge-verify',
    'docker/harness/verify-policy.mjs',
    'docker/harness/verification-runner.mjs',
    'docker/harness/verification-cache-tool.mjs',
    'docker/harness/maven-verification-policy.mjs',
    'docker/harness/maven-verification-settings.xml',
    'docker/harness/maven-verification-exec.sh',
    'docker/harness/taskspace-policy.mjs',
    'docker/harness/taskspace-broker.mjs',
    'scripts/prepare-forge-verification-cache.sh',
    'scripts/prepare-local-forge-harness-eval-cache.sh',
    'templates/project/verification-contract.json.tpl',
    'templates/project/acceptance-service.json.tpl',
    'tests/forge-phase-budget-guard.test.mjs',
    'tests/forge-controlled-command.test.mjs',
    'tests/forge-task-execution-contract.test.mjs',
    'tests/forge-phase-work-package.test.mjs',
    'tests/forge-execution-context.test.mjs',
    'tests/forge-recover-headless-execution.test.mjs',
    'tests/forge-protected-headless-recovery-host.test.mjs',
    'tests/forge-execution-capability-negotiation.test.mjs',
    'tests/forge-execution-store.test.mjs',
    'tests/forge-execution-orchestrator.test.mjs',
    'tests/forge-progress-detector.test.mjs',
    'tests/forge-change-contract.test.mjs',
    'tests/fixtures/forge-change-contract/valid.json',
    'tests/forge-business-data-approval.test.mjs',
    'tests/fixtures/forge-business-data-approval/valid.json',
    'tests/forge-business-object-mutation.test.mjs',
    'tests/fixtures/forge-business-object-mutation/valid.json',
    'tests/forge-semantic-resource-lease.test.mjs',
    'tests/fixtures/forge-semantic-resource-lease/valid.json',
    'tests/forge-workflow-migration-safety.test.mjs',
    'tests/fixtures/forge-workflow-migration-safety/valid.json',
    'tests/forge-ui-edit-session.test.mjs',
    'tests/fixtures/forge-ui-edit-session/valid.json',
    'tests/forge-behavior-qualification.test.mjs',
    'tests/fixtures/forge-behavior-qualification/suite.json',
    'tests/fixtures/forge-behavior-qualification/prompts/feasibility-readonly.v1.md',
    'tests/fixtures/forge-behavior-qualification/prompts/small-fix-routing.v1.md',
    'tests/forge-reference-adoption-coverage.test.mjs',
    'tests/forge-acceptance-aggregator.test.mjs',
    'tests/forge-protected-issuer-adapter.test.mjs',
    'tests/forge-production-task-grant.test.mjs',
    'tests/forge-protected-acceptance-service.test.mjs',
    'tests/forge-protected-acceptance-deployment.test.mjs',
    'tests/forge-quality-capability-registry.test.mjs',
    'tests/forge-ui-contract.test.mjs',
    'tests/forge-verification-runner.test.mjs',
    'tests/forge-verification-upgrade.test.mjs',
    'tests/local-forge-verification-cache-prep.test.mjs',
    'tests/taskspace-broker.test.mjs',
    'tests/forge-governance-runtime-instructions.test.mjs',
    'docs/validation-evidence/2026-09-01-forge-delivery-toolkit-vpn71-local.md',
  ]) {
    assert.ok(packager.includes(required), `portable package is missing ${required}`);
  }
  assert.match(packager, /forge-delivery-toolkit-vpn71-local\.tar\.gz/u);
  assert.match(packager, /forge-verify\)\|\.\+\\\.sh/u);
  assert.match(packager, /forge_verify_mode=.*tar --list --verbose/u);
  assert.match(packager, /git archive --format=tar --output=.*HEAD/u);
  assert.match(packager, /source_date_epoch=.*git show -s --format=%ct HEAD/u);
  assert.match(packager, /--numeric-owner --owner=0 --group=0/u);
  assert.match(packager, /--mtime="@\$\{source_date_epoch\}"/u);
  assert.match(packager, /Portable package refuses tracked symbolic links/u);
  assert.match(packager, /forge_verify_mode.*-rwxr-xr-x/us);
  assert.doesNotMatch(packager, /forge-delivery-toolkit-vpn57-local/u);
  assert.doesNotMatch(packager, /forge-delivery-toolkit-vpn53-local/u);
});

function position(fragment) {
  const found = script.indexOf(fragment);
  assert.notEqual(found, -1, `missing ordered fragment: ${fragment}`);
  return found;
}

test('refresh starts from a clean temporary workspace and the digest-pinned Node base', () => {
  assert.match(script, /HARNESS_NODE_BASE_IMAGE=.*node_base_rows/u);
  assert.match(script, /\^node:\[A-Za-z0-9\._-\]\+@sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(script, /docker image inspect[\s\S]*HARNESS_NODE_BASE_IMAGE/u);
  assert.match(script, /EXPECTED_NPM_VERSION='11\.19\.0'/u);
  assert.match(script, /temp_root=.*TMPDIR:-\/tmp/u);
  assert.match(script, /mktemp -d "\$\{temp_root\}\/forge-harness-runtime-lock-inputs\.XXXXXX"/u);
  assert.match(script, /mktemp -d "\$\{temp_root\}\/forge-harness-runtime-lock-refresh\.XXXXXX"/u);
  assert.match(script, /cp -- "\$\{REVIEWED_PACKAGE_JSON\}" "\$\{input_snapshot_root\}\/package\.json"/u);
  assert.match(script, /cp -- "\$\{input_snapshot_root\}\/package\.json" "\$\{scratch_root\}\/package\.json"/u);
  assert.match(script, /! -e "\$\{scratch_root\}\/node_modules"/u);
  assert.match(script, /! -e "\$\{scratch_root\}\/package-lock\.json"/u);
  assert.doesNotMatch(script, /cp -- "\$\{REVIEWED_PACKAGE_LOCK\}" "\$\{scratch_root\}/u);
  assert.match(script, /--env NODE_PATH=/u);
  assert.match(script, /NPM_CONFIG_USERCONFIG=\/work\/\.npmrc/u);
  assert.match(script, /NPM_CONFIG_CACHE=\/work\/\.npm-cache/u);
  assert.match(script, /--pull never/u);
});

test('candidate resolution and download cannot execute lifecycle scripts', () => {
  const lockOnly = position('npm install --package-lock-only --ignore-scripts');
  const sourceValidation = position('node /validator.mjs --mode source --root /work --json');
  const advisoryAudit = position('npm audit --omit=dev --package-lock-only');
  const install = position('npm ci --omit=dev --ignore-scripts');
  const rebuild = position('npm rebuild --no-audit --no-fund --strict-allow-scripts');
  assert.ok(lockOnly < sourceValidation);
  assert.ok(sourceValidation < advisoryAudit);
  assert.ok(advisoryAudit < install);
  assert.ok(install < rebuild);
  assert.match(script, /run_in_fresh_workspace bridge \\\n+  npm install --package-lock-only --ignore-scripts/u);
  assert.match(script, /run_in_fresh_workspace bridge \\\n+  npm ci --omit=dev --ignore-scripts/u);
});

test('candidate publication is gated by a point-in-time production advisory audit', () => {
  const audit = position('npm audit --omit=dev --package-lock-only');
  const highGate = position('counts.high !== 0 || counts.critical !== 0');
  const install = position('npm ci --omit=dev --ignore-scripts');
  const publish = position('mv -- "${candidate_publish_temp}" "${candidate_dir}"');
  assert.ok(audit < highGate);
  assert.ok(highGate < install);
  assert.ok(install < publish);
  assert.match(script, /NPM_CONFIG_AUDIT=true npm audit/u);
  assert.match(script, /--audit-level=high --json/u);
  assert.match(script, /advisory-audit-receipt\.json/u);
  assert.match(script, /blockingSeverities: \["high", "critical"\]/u);
  assert.match(script, /vulnerabilityCounts: advisoryCounts/u);
  assert.match(script, /advisoryDatabaseIsPinned: false/u);
  assert.match(script, /advisoryResultIsPointInTime: true/u);
  assert.match(script, /advisoryResultDoesNotGuaranteeFutureAbsence: true/u);
});

test('approved lifecycle scripts rebuild only non-root and without a network', () => {
  assert.match(script, /runtime_uid.*-eq 0[\s\S]*runtime_uid='65532'/u);
  assert.match(script, /numeric non-root container identity is required/u);
  assert.match(script, /--network "\$\{network_mode\}"[\s\S]*--user "\$\{runtime_identity\}"/u);
  assert.match(script, /run_in_fresh_workspace none sh -euc '[\s\S]*--strict-allow-scripts/u);
  assert.match(script, /npm install-scripts ls --json/u);
  assert.match(script, /value\.allowScripts\.length !== 0/u);
});

test('schema 3 source and installed smoke receipts gate candidate publication', () => {
  const source = position('node /validator.mjs --mode source --root /work --json');
  const installed = position('node /validator.mjs --mode installed --root /work --smoke --json');
  const schema3 = position('Installed validator did not emit a schema 3 receipt.');
  const publish = position('mv -- "${candidate_publish_temp}" "${candidate_dir}"');
  assert.ok(source < installed);
  assert.ok(installed < schema3);
  assert.ok(schema3 < publish);
  assert.match(script, /source-receipt\.json/u);
  assert.match(script, /installed-smoke-receipt\.json/u);
  assert.match(script, /sourceReceiptDigest: source\.digest/u);
  assert.match(script, /installedReceiptDigest: installed\.digest/u);
  assert.match(script, /candidateSmokeEnvironment: "digest-pinned Debian Node linux\/amd64 base"/u);
  assert.match(script, /candidateSmokeIsFinalHarnessImageEvidence: false/u);
  assert.match(script, /requiredFinalEvidence: "schema 3 --smoke inside the final Maven\/Ubuntu Harness image"/u);
});

test('all source inputs are hash-snapshotted and rechecked before publication and apply', () => {
  const versionsHash = position('versions_env_sha256_before="$(sha256_file "${VERSIONS_FILE}")"');
  const packageHash = position('package_json_sha256_before="$(sha256_file "${REVIEWED_PACKAGE_JSON}")"');
  const validatorHash = position('validator_sha256_before="$(sha256_file "${VALIDATOR}")"');
  const dependencyResolution = position("assert_source_inputs_unchanged 'dependency resolution'");
  const candidateRecheck = position("assert_source_inputs_unchanged 'candidate publication'");
  const candidateRenameRecheck = position("assert_source_inputs_unchanged 'candidate directory rename'");
  const candidatePublish = position('mv -- "${candidate_publish_temp}" "${candidate_dir}"');
  const applyRecheck = position("assert_source_inputs_unchanged 'reviewed lock replacement'");
  const atomicRecheck = position("assert_source_inputs_unchanged 'atomic reviewed lock rename'");
  const atomicRename = position('mv -- "${reviewed_lock_temp}" "${REVIEWED_PACKAGE_LOCK}"');
  assert.ok(versionsHash < dependencyResolution);
  assert.ok(packageHash < dependencyResolution);
  assert.ok(validatorHash < dependencyResolution);
  assert.ok(candidateRecheck < candidateRenameRecheck);
  assert.ok(candidateRenameRecheck < candidatePublish);
  assert.ok(candidatePublish < applyRecheck);
  assert.ok(applyRecheck < atomicRecheck);
  assert.ok(atomicRecheck < atomicRename);
  assert.match(script, /Source input drifted before \$\{phase\}: config\/versions\.env/u);
  assert.match(script, /Source input drifted before \$\{phase\}: runtime-dependencies\/package\.json/u);
  assert.match(script, /Source input drifted before \$\{phase\}: validate-runtime-dependencies\.mjs/u);
  assert.match(script, /versionsEnvSha256: versionsEnvSha/u);
  assert.match(script, /validatorSha256: validatorSha/u);
});

test('default mode cannot overwrite the reviewed lock', () => {
  const defaultExit = position('if [[ "${APPLY_REVIEWED_LOCK}" -eq 0 ]]');
  const atomicStage = position('reviewed_lock_temp="$(mktemp');
  const atomicMove = position('mv -- "${reviewed_lock_temp}" "${REVIEWED_PACKAGE_LOCK}"');
  assert.ok(defaultExit < atomicStage);
  assert.ok(atomicStage < atomicMove);
  assert.match(script, /reviewed_lock_updated=false/u);
  assert.match(script, /The default run creates an ignored, reviewable candidate and receipts only/u);
});

test('replacement requires exact old and candidate hashes plus CAS and atomic rename', () => {
  assert.match(script, /--apply-reviewed-lock/u);
  assert.match(script, /--confirm-current-sha256/u);
  assert.match(script, /--confirm-candidate-sha256/u);
  assert.match(script, /CONFIRM_CURRENT_SHA256.*reviewed_lock_sha256_before/u);
  assert.match(script, /CONFIRM_CANDIDATE_SHA256.*candidate_lock_sha256/u);
  assert.match(script, /reviewed lock changed after candidate generation; no replacement was made/iu);
  assert.match(script, /reviewed lock changed before the atomic rename; no replacement was made/iu);
  assert.match(script, /mktemp "\$\{RUNTIME_DEPENDENCY_ROOT\}\/\.package-lock\.refresh\.XXXXXX"/u);
  assert.match(script, /mv -- "\$\{reviewed_lock_temp\}" "\$\{REVIEWED_PACKAGE_LOCK\}"/u);
  assert.match(script, /atomicSameDirectoryRename: true/u);
});

test('a sibling nonblocking advisory writer lock encloses CAS and rename', () => {
  const acquire = position('flock --exclusive --nonblock "${reviewed_lock_fd}"');
  const lockedCas = position('The reviewed lock changed after candidate generation; no replacement was made.');
  const lockedInputRecheck = position("assert_source_inputs_unchanged 'reviewed lock replacement'");
  const atomicRename = position('mv -- "${reviewed_lock_temp}" "${REVIEWED_PACKAGE_LOCK}"');
  const unlock = script.lastIndexOf('flock --unlock "${reviewed_lock_fd}"');
  assert.notEqual(unlock, -1);
  assert.ok(acquire < lockedCas);
  assert.ok(lockedCas < lockedInputRecheck);
  assert.ok(lockedInputRecheck < atomicRename);
  assert.ok(atomicRename < unlock);
  assert.match(script, /REVIEWED_LOCK_GUARD="\$\{RUNTIME_DEPENDENCY_ROOT\}\/package-lock\.json\.lock\.local"/u);
  assert.match(script, /Another runtime lock writer holds the sibling advisory lock/u);
  assert.match(script, /stat -Lc '%d:%i' "\/proc\/\$\$\/fd\/\$\{reviewed_lock_fd\}"/u);
  assert.doesNotMatch(script, /rm -f -- "\$\{REVIEWED_LOCK_GUARD\}"/u);
  assert.match(script, /siblingAdvisoryWriterLock: "package-lock\.json\.lock\.local"/u);
});

test('portable toolkit requires the refresh entrypoint', () => {
  assert.match(packager, /scripts\/refresh-harness-runtime-lock\.sh/u);
});
