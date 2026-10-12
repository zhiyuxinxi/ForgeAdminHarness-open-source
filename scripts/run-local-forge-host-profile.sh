#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly REQUIRED_SOURCE_COMMIT="908e13bdc08ec2cbb071d355a2c33a77c970bdd3"
readonly EXPECTED_PROFILE_CATALOG_VERSION="2026.09.03.22"
readonly EXPECTED_HOST_RUNNER_BUNDLE_VERSION="2026.09.14.2"
PROJECT_SLUG="forge-local-matrix"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

SOURCE=""
PATCH=""
CASE_ID=""
PHASE=""
PROFILES=()
IMAGE=""
RUNNER_BUNDLE=""
RUNNER_MANIFEST_SHA256=""
EVIDENCE_DIR=""
RUNTIME_ROOT=""
RUNTIME_ROOT_OWNER=""
PERSISTENT_STATE_ROOT=""

die() { printf 'forge-local-host-profile: %s\n' "$1" >&2; exit 2; }
require_tool() { command -v "$1" >/dev/null 2>&1 || die "required tool is missing: $1"; }
sha256_file() { sha256sum -- "$1" | awk '{print $1}'; }

usage() {
  cat <<'EOF'
Usage: scripts/run-local-forge-host-profile.sh \
  --source ABSOLUTE_CLEAN_FORGE_ADMIN_CHECKOUT \
  --patch ABSOLUTE_COMPLETE_WORKSPACE_PATCH \
  --case crud-complete|edge-pagination-shared-owner|frontend-aicrudpage-api-contract|adversarial-shortcuts \
  --phase REVIEWED_PHASE_ID \
  --profile REVIEWED_HOST_PROFILE [--profile REVIEWED_HOST_PROFILE ...] \
  --image LOCAL_HARNESS_IMAGE \
  --runner-bundle ABSOLUTE_VERSIONED_RUNNER_BUNDLE \
  --runner-manifest-sha256 REVIEWED_SHA256 \
  --runtime-root ABSOLUTE_RUN_OWNED_HOST_RUNTIME \
  --runtime-root-owner RUN_TOKEN \
  [--state-root EXISTING_PROJECT_HOST_STATE] \
  [--project-slug PROJECT_SLUG] \
  --evidence-dir NEW_ABSOLUTE_DIRECTORY
EOF
}
trap 'exit 130' INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --patch) PATCH="$2"; shift 2 ;;
    --case) CASE_ID="$2"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    --profile) PROFILES+=("$2"); shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --runner-bundle) RUNNER_BUNDLE="$2"; shift 2 ;;
    --runner-manifest-sha256) RUNNER_MANIFEST_SHA256="$2"; shift 2 ;;
    --runtime-root) RUNTIME_ROOT="$2"; shift 2 ;;
    --runtime-root-owner) RUNTIME_ROOT_OWNER="$2"; shift 2 ;;
    --state-root) PERSISTENT_STATE_ROOT="$2"; shift 2 ;;
    --project-slug) PROJECT_SLUG="$2"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unsupported option: $1" ;;
  esac
done

for tool in git java mvn node pnpm realpath sha256sum awk; do require_tool "${tool}"; done
case "${CASE_ID}" in crud-complete|edge-pagination-shared-owner|frontend-aicrudpage-api-contract|adversarial-shortcuts) ;; *) die '--case is invalid' ;; esac
[[ "${PHASE}" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || die '--phase is invalid'
[[ "${#PROFILES[@]}" -gt 0 ]] || die 'at least one --profile is required'
declare -A seen_profiles=()
for requested_profile in "${PROFILES[@]}"; do
  [[ "${requested_profile}" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || die '--profile is invalid'
  [[ -z "${seen_profiles[${requested_profile}]+x}" ]] || die '--profile must not be repeated'
  seen_profiles["${requested_profile}"]=1
done
profiles=("${PROFILES[@]}")
[[ "${RUNNER_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die '--runner-manifest-sha256 is invalid'
[[ "${RUNTIME_ROOT_OWNER}" =~ ^[0-9a-f]{16}$ ]] || die '--runtime-root-owner is invalid'
[[ "${PROJECT_SLUG}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ ]] || die '--project-slug is invalid'
SOURCE="$(realpath -e -- "${SOURCE}")"
PATCH="$(realpath -e -- "${PATCH}")"
RUNNER_BUNDLE="$(realpath -e -- "${RUNNER_BUNDLE}")"
RUNTIME_ROOT="$(realpath -m -- "${RUNTIME_ROOT}")"
EVIDENCE_DIR="$(realpath -m -- "${EVIDENCE_DIR}")"
if [[ -n "${PERSISTENT_STATE_ROOT}" ]]; then
  [[ "${PERSISTENT_STATE_ROOT}" = /* && -d "${PERSISTENT_STATE_ROOT}" && ! -L "${PERSISTENT_STATE_ROOT}" ]] \
    || die '--state-root must be an existing absolute ordinary directory'
  [[ "$(realpath -e -- "${PERSISTENT_STATE_ROOT}")" == "${PERSISTENT_STATE_ROOT}" ]] \
    || die '--state-root must be canonical'
  [[ "${PERSISTENT_STATE_ROOT}" != '/' ]] || die '--state-root must not be the filesystem root'
  [[ "${PERSISTENT_STATE_ROOT}" != "${SOURCE}" && "${PERSISTENT_STATE_ROOT}" != "${SOURCE}/"* ]] \
    || die '--state-root must not be inside the source checkout'
  if [[ "${SOURCE}" == "${PERSISTENT_STATE_ROOT}/"* ]]; then
    [[ "${SOURCE}" == "${PERSISTENT_STATE_ROOT}/.eval-runs/"*/baseline ]] \
      || die 'a source below --state-root must be an outer-eval baseline copy'
  fi
  for isolated_path in "${RUNNER_BUNDLE}"; do
    [[ "${PERSISTENT_STATE_ROOT}" != "${isolated_path}" \
      && "${PERSISTENT_STATE_ROOT}" != "${isolated_path}/"* \
      && "${isolated_path}" != "${PERSISTENT_STATE_ROOT}/"* ]] \
      || die '--state-root must not overlap source or Runner bundle'
  done
  for temporary_path in "${RUNTIME_ROOT}" "${EVIDENCE_DIR}"; do
    [[ "${PERSISTENT_STATE_ROOT}" != "${temporary_path}" \
      && "${PERSISTENT_STATE_ROOT}" != "${temporary_path}/"* ]] \
      || die '--state-root must not be inside disposable runtime or evidence'
  done
fi
java_path="$(realpath -e -- "$(command -v java)")"
java_home="$(dirname -- "$(dirname -- "${java_path}")")"
maven_path="$(realpath -e -- "$(command -v mvn)")"
node_path="$(realpath -e -- "$(command -v node)")"
pnpm_path="$(realpath -e -- "$(command -v pnpm)")"
git_path="$(realpath -e -- "$(command -v git)")"
governance_path="$(realpath -e -- "${RUNNER_BUNDLE}/bin/forge-governance")"
[[ -d "${SOURCE}/.git" && ! -L "${SOURCE}" && ! -L "${SOURCE}/.git" ]] || die '--source must be a normal checkout'
[[ -f "${PATCH}" && ! -L "${PATCH}" && -s "${PATCH}" ]] || die '--patch must be a non-empty ordinary file'
[[ -d "${RUNNER_BUNDLE}" && ! -L "${RUNNER_BUNDLE}" && -f "${RUNNER_BUNDLE}/runner.manifest.json" ]] || die '--runner-bundle is invalid'
[[ ! -e "${EVIDENCE_DIR}" && ! -L "${EVIDENCE_DIR}" ]] || die '--evidence-dir must not exist'
[[ "${RUNTIME_ROOT}" = /* && ! -L "${RUNTIME_ROOT}" ]] || die '--runtime-root must be an absolute non-symlink path'
[[ "$(${git_path} -C "${SOURCE}" rev-parse HEAD)" == "${REQUIRED_SOURCE_COMMIT}" ]] || die 'source HEAD mismatch'
[[ -z "$(${git_path} -C "${SOURCE}" status --porcelain=v1 --untracked-files=all)" ]] || die 'source checkout must be clean'
[[ "$(sha256_file "${RUNNER_BUNDLE}/runner.manifest.json")" == "${RUNNER_MANIFEST_SHA256}" ]] || die 'Runner manifest SHA-256 mismatch'
node_major="$(${node_path} -p 'process.versions.node.split(".")[0]')"
case "${node_major}" in 22|24) ;; *) die 'host Node major is not supported by the Runner bundle' ;; esac
"${node_path}" "${RUNNER_BUNDLE}/bin/forge-host-runner-bundle.mjs" validate \
  --bundle "${RUNNER_BUNDLE}" --profile-catalog-version "${EXPECTED_PROFILE_CATALOG_VERSION}" \
  --node-major "${node_major}" >/dev/null || die 'Runner bundle validation failed'
runner_bundle_version="$("${node_path}" -e '
const manifest = require(process.argv[1]);
if (manifest.bundleVersion !== process.argv[2]) process.exit(1);
process.stdout.write(manifest.bundleVersion);
' "${RUNNER_BUNDLE}/runner.manifest.json" "${EXPECTED_HOST_RUNNER_BUNDLE_VERSION}")" \
  || die 'Runner bundle version mismatch'

if [[ "${IMAGE}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  # The outer eval already verifies its Harness. Host jobs only record that
  # immutable association and must not receive Docker access to inspect it.
  image_id="${IMAGE}"
  image_identity_source='outer-eval-immutable-id'
else
  require_tool docker
  image_id="$(docker image inspect --format '{{.Id}}' "${IMAGE}" 2>/dev/null)" || die 'local image is unavailable'
  image_identity_source='local-docker-inspect'
fi
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'image identity is invalid'
task_id="eval-${CASE_ID}"
mkdir -p -- "${EVIDENCE_DIR}"

"${node_path}" - "${RUNTIME_ROOT}" "${RUNTIME_ROOT_OWNER}" "${CASE_ID}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, owner, caseId] = process.argv.slice(2);
const root = path.resolve(rootInput);
const markerPath = path.join(root, '.forge-host-runtime-owner.json');
if (!fs.existsSync(root)) {
  const parent = fs.realpathSync(path.dirname(root));
  if (path.dirname(root) !== parent) throw new Error('host runtime parent identity changed');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 1, owner, caseId })}\n`, { flag: 'wx', mode: 0o600 });
} else {
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('host runtime root is not an ordinary canonical directory');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.schemaVersion !== 1 || marker.owner !== owner || marker.caseId !== caseId) throw new Error('host runtime owner marker mismatch');
}
NODE
RUNTIME_ROOT="$(realpath -e -- "${RUNTIME_ROOT}")"
taskspaces_root="${RUNTIME_ROOT}/taskspaces"
state_root="${PERSISTENT_STATE_ROOT:-${RUNTIME_ROOT}/state}"
workspace="${taskspaces_root}/${task_id}/workspace"

"${node_path}" - "${RUNTIME_ROOT}" "${workspace}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, workspaceInput] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const workspace = path.resolve(workspaceInput);
const relative = path.relative(root, workspace);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('host workspace escaped the run-owned runtime root');
if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: false, maxRetries: 2 });
fs.mkdirSync(path.dirname(workspace), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'state'), { recursive: true, mode: 0o700 });
NODE

GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${git_path}" clone --no-hardlinks --no-checkout -- "${SOURCE}" "${workspace}" \
  >"${EVIDENCE_DIR}/seed.stdout.txt" 2>"${EVIDENCE_DIR}/seed.stderr.txt" \
  || die 'candidate reconstruction clone failed'
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${git_path}" -C "${workspace}" checkout --force "${REQUIRED_SOURCE_COMMIT}" \
  >>"${EVIDENCE_DIR}/seed.stdout.txt" 2>>"${EVIDENCE_DIR}/seed.stderr.txt" \
  || die 'candidate reconstruction checkout failed'
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${git_path}" -C "${workspace}" apply --binary --whitespace=nowarn "${PATCH}" \
  >>"${EVIDENCE_DIR}/seed.stdout.txt" 2>>"${EVIDENCE_DIR}/seed.stderr.txt" \
  || die 'candidate reconstruction patch failed'
[[ -n "$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${git_path}" -C "${workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
  || die 'candidate reconstruction produced no change'

# Host-only TaskSpace identity lives beside the workspace, outside candidate writes.
reconstructed_head="$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${git_path}" -C "${workspace}" rev-parse HEAD)"
"${node_path}" - "${taskspaces_root}" "${task_id}" "${PROJECT_SLUG}" "${CASE_ID}" \
  "${RUNTIME_ROOT_OWNER}" "${REQUIRED_SOURCE_COMMIT}" "${reconstructed_head}" \
  "${RUNNER_BUNDLE}/lib/taskspace-policy.mjs" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
(async () => {
  const [taskspacesRoot, taskId, projectSlug, caseId, owner, sourceCommit, head, validatorFile] = process.argv.slice(2);
  if (head !== sourceCommit) throw new Error('reconstructed HEAD differs from the fixed source commit');
  const { validateTaskspaceMetadata } = await import(pathToFileURL(validatorFile).href);
  const taskRoot = path.join(taskspacesRoot, taskId);
  const metadataFile = path.join(taskRoot, 'metadata.json');
  const rootInfo = fs.lstatSync(taskRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || fs.realpathSync(taskRoot) !== taskRoot
    || (process.platform !== 'win32' && (rootInfo.mode & 0o077) !== 0)) throw new Error('TaskSpace control directory is not protected');
  const identity = {
    projectSlug, taskId, actorId: 'host-operator', conversationId: `host-${caseId}`,
    branch: `task/host-operator/${taskId}`, baseCommit: sourceCommit,
    accessTokenHash: crypto.createHash('sha256').update(`host-operator:${owner}:${projectSlug}:${taskId}`).digest('hex'),
  };
  if (fs.existsSync(metadataFile)) {
    const info = fs.lstatSync(metadataFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('existing TaskSpace metadata is not protected');
    const existing = validateTaskspaceMetadata(JSON.parse(fs.readFileSync(metadataFile, 'utf8')), projectSlug);
    if (existing.schemaVersion !== 1 || existing.status !== 'active' || existing.accessMode !== 'token'
      || existing.harnessPort !== 1 || existing.lastCandidate !== null || existing.lastRelease !== null
      || Object.entries(identity).some(([key, value]) => existing[key] !== value)) {
      throw new Error('existing TaskSpace metadata identity or source baseline differs from this run');
    }
    return;
  }
  const now = new Date().toISOString();
  const metadata = {
    schemaVersion: 1, ...identity, status: 'active', createdAt: now, updatedAt: now,
    harnessPort: 1, accessMode: 'token', lastCandidate: null, lastRelease: null,
  };
  validateTaskspaceMetadata(metadata, projectSlug);
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE

"${node_path}" - "${EVIDENCE_DIR}/contract.json" "${EXPECTED_PROFILE_CATALOG_VERSION}" "${runner_bundle_version}" "${PROJECT_SLUG}" \
  "${taskspaces_root}" "${state_root}" "${java_path}" "${java_home}" "${maven_path}" \
  "${node_path}" "${pnpm_path}" "${git_path}" "${governance_path}" <<'NODE'
const fs = require('node:fs');
const [file, profileCatalogVersion, runnerBundleVersion, projectSlug, taskspacesRoot, stateRoot,
  java, javaHome, maven, node, pnpm, git, forgeGovernance] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  schemaVersion: 2,
  executionMode: 'host-toolchain',
  projectSlug,
  runnerRevision: `forge-host-runner-${runnerBundleVersion}`,
  profileCatalogVersion,
  taskspacesRoot,
  stateRoot,
  toolchains: { java, javaHome, maven, node, pnpm, git, forgeGovernance },
  profiles: ['governance', 'backend-red-test', 'frontend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build', 'changed-safe', 'full-regression'],
  limits: { maxFiles: 250000, maxBytes: 4294967296, maxLogBytes: 8388608, defaultTimeoutSeconds: 900, maxConcurrent: 1 },
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE

runner_exit=0
completed_profiles=()
for requested_profile in "${profiles[@]}"; do
  profile_dir="${EVIDENCE_DIR}/${requested_profile}"
  mkdir -p -- "${profile_dir}"
  case "${requested_profile}" in
    backend-module-compile|backend-module-test)
      printf '{"modules":["forge-server/forge-business/forge-business-core"]}\n' >"${profile_dir}/selectors.json"
      ;;
    *) printf '{}\n' >"${profile_dir}/selectors.json" ;;
  esac
  set +e
  "${node_path}" "${SCRIPT_DIR}/run-host-verification-once.mjs" \
      --bundle-root "${RUNNER_BUNDLE}" \
      --manifest-sha256 "${RUNNER_MANIFEST_SHA256}" \
      --contract "${EVIDENCE_DIR}/contract.json" \
      --task-id "${task_id}" --profile "${requested_profile}" \
      --selectors "${profile_dir}/selectors.json" \
      --output "${profile_dir}/host-profile.receipt.json" \
    >"${profile_dir}/runner.stdout.txt" 2>"${profile_dir}/runner.stderr.txt"
  profile_exit=$?
  set -e
  if [[ "${profile_exit}" -ne 0 ]]; then
    runner_exit="${profile_exit}"
    break
  fi
  completed_profiles+=("${requested_profile}")
done

"${node_path}" - "${EVIDENCE_DIR}" "${CASE_ID}" "${PHASE}" "${image_id}" "${RUNNER_MANIFEST_SHA256}" \
  "$(sha256_file "${PATCH}")" "${runner_exit}" \
  "$(IFS=,; printf '%s' "${profiles[*]}")" "$(IFS=,; printf '%s' "${completed_profiles[*]}")" \
  "${node_major}" "${image_identity_source}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, caseId, phaseId, imageId, runnerManifestSha256, patchSha256, runnerExit,
  requestedCsv, completedCsv, nodeMajor, imageIdentitySource] = process.argv.slice(2);
const requestedProfiles = requestedCsv.split(',').filter(Boolean);
const completedProfiles = completedCsv.split(',').filter(Boolean);
const projectedReceipts = requestedProfiles.flatMap((profile) => {
  const receiptFile = path.join(root, profile, 'host-profile.receipt.json');
  if (!fs.existsSync(receiptFile)) return [];
  const bytes = fs.readFileSync(receiptFile);
  const envelope = JSON.parse(bytes);
  return [{
    profile,
    status: envelope.receipt?.status ?? 'failed',
    receiptDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
    patchDigest: patchSha256,
  }];
});
fs.writeFileSync(path.join(root, 'phase-host-receipts.json'), `${JSON.stringify(projectedReceipts, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const files = fs.readdirSync(root).filter((name) => name !== 'manifest.json').sort().map((name) => {
  const file = path.join(root, name);
  const info = fs.statSync(file);
  return { path: name, bytes: info.isFile() ? info.size : null, sha256: info.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null, type: info.isDirectory() ? 'directory' : 'file' };
});
fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  evidenceType: 'forge-local-matrix/host-profile-execution',
  caseId,
  phaseId,
  sourceHead: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
  completePatchSha256: patchSha256,
  imageId,
  imageIdentitySource,
  runnerManifestSha256,
  requestedProfiles,
  completedProfiles,
  runnerExitCode: Number.parseInt(runnerExit, 10),
  receiptStatuses: Object.fromEntries(projectedReceipts.map((receipt) => [receipt.profile, receipt.status])),
  executionMode: 'host-toolchain',
  hostNodeMajor: Number.parseInt(nodeMajor, 10),
  harnessImageUsedForHostProcess: false,
  arbitraryShellGranted: false,
  requestControlledEnvironment: false,
  dependencyNetworkIsolationProven: false,
  runtimeRootOwnedByOuterEval: true,
  artifacts: files,
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE

[[ "${runner_exit}" -eq 0 ]] || exit "${runner_exit}"
printf 'Forge local Host Runner profile evidence: %s\n' "${EVIDENCE_DIR}"
