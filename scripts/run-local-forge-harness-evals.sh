#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly RUNNER_VERSION="1.19.86"
readonly REQUIRED_SOURCE_COMMIT="908e13bdc08ec2cbb071d355a2c33a77c970bdd3"
readonly CREDENTIAL_PROXY_IMAGE_REFERENCE="node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
readonly CREDENTIAL_PROXY_REPO_DIGEST="node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
readonly CREDENTIAL_PROXY_OFFLINE_PLATFORM_IMAGE_ID="sha256:275148c9f565f4c61bd08433561a136d27518e27e6d83fb616b222245a21717a"
readonly VERIFICATION_DOCKER_CLI_IMAGE_REFERENCE="docker/desktop-cloud-provider-kind:v0.6.0"
readonly VERIFICATION_DOCKER_CLI_IMAGE_ID="sha256:d05c7d20a0f0d4b2a52ffdf99a8ae8dfa81985d7684212e03aae7a228e59c671"
readonly VERIFICATION_DOCKER_CLI_REPO_DIGEST="docker/desktop-cloud-provider-kind@sha256:46d51b990e97493119aac0907bcf50fd69660dc8637765a517642f1677acdb76"
readonly VERIFICATION_DOCKER_CLI_SHA256="ada0716bf566f41b6824f894a9af6a7ba71a19f855c0a4a5fc6e5fd3fd0fa00a"
readonly MODEL_CREDENTIAL_PLACEHOLDER="forge-eval-proxy-placeholder"
readonly EXPECTED_CONFIGURED_PROVIDER="deepseek-official"
readonly EXPECTED_REQUEST_MODEL="deepseek-v4-pro"
readonly EXPECTED_UPSTREAM_ORIGIN="https://api.deepseek.com"
readonly EXPECTED_SUITE_SHA256="0d90af4cccaeb5374ec992f3ba5cf2f9ca9fa56db07cff5a3d5253cf9ff14a8e"
# Re-pin this digest whenever analyze-forge-harness-session.mjs changes. The
# snapshot helper refuses to create a runtime closure from any other bytes.
readonly EXPECTED_ANALYZER_SHA256="b2173598a19657c15deb625a80bcb69c316a17428179eb87c77c578be9578c4e"
readonly EXPECTED_INPUT_SNAPSHOT_HELPER_SHA256="0477492e5841c394fdd9da3629fa0ab6de09b59a4c1a617e0a5418d48f324f5a"
readonly EXPECTED_SECRET_SNAPSHOT_HELPER_SHA256="9d71a2e2d02421c95994fef13fdf4da51a41d1ca3da7d2a5e354b4d4e277bc72"
readonly EXPECTED_RUNTIME_LOCK_VERIFIER_SHA256="df72d4dcb5fa57b59e8c46bf52287320b2459a06316230fa01f36ac6acf1ec2a"
readonly EXPECTED_PHASE_BUDGET_GUARD_SHA256="6a6707c0e82e71050070911934f7568333f14cfa129310f2fb606fa8e17b40df"
readonly EXPECTED_PROGRESS_DETECTOR_SHA256="9b2eb9e417754cc1765344a2694d0ccac43b6f851fc558712e27bb47828b4dbc"
readonly EXPECTED_PRODUCTION_TASK_GRANT_SHA256="8f51ee3007ca30b20b418490ec1cbcd31930f388d1095817bebc879b99d35f01"
readonly EXPECTED_EXECUTION_CONTEXT_SHA256="f0084b1e2af467cded6f4d4f465b739c56cb9c150fe988206565120ecd835159"
readonly EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256="0ee1aa9b5cb08b1a11853b660b774d90675027829c4824b2027e6cb132c3252f"
readonly EXPECTED_PHASE_CONTROLLER_SHA256="cc2896ee9d1c010e906b4e5f801ed79a0612b14029fad7c87c98d6fe4a64a6b8"
readonly EXPECTED_CROSS_LAYER_RUNTIME_EVIDENCE_SHA256="7d87af7ba446fb1622de50d540dd21401baab357cffe74ee1a884217dd433853"
readonly EXPECTED_PHASE_WORK_PACKAGE_SHA256="5dbbaec0f3ae9335c0d1e3751035783658f97b274efda851fec9be83e56e9ba8"
readonly EXPECTED_PHASE_RUNTIME_SHA256="78b7f6cbbf5eea5b21142475bf77d756b4bff7ff3b4a15de460dd87a69a315c0"
readonly EXPECTED_TASK_EXECUTION_CONTRACT_SHA256="c90d04f59b1489ee0e719496645ec526a7051ef866e07e0f0224fae8ef25d4f9"
readonly EXPECTED_PHASE_RESPONSE_SHA256="4d982a5f4d00b080deccff2339e4b3d5ae2e7fe857f2b6193c5cd1de9c69a7c0"
readonly EXPECTED_PHASE_OBSERVER_SHA256="940b03bbc588b21381adba94d8c657febc9fea4b9d2968eb1d37c50fc13ebfa8"
readonly EXPECTED_RUNTIME_PACKAGE_ID="forge-admin-harness/forge-harness-behavior-eval-runtime"
readonly EXPECTED_RUNTIME_PACKAGE_VERSION="2026.09.14.3"
readonly EXPECTED_HARNESS_IMAGE_REVISION="vpn-forge-delivery-toolkit-78"
readonly EXPECTED_HARNESS_SKILL_BUNDLE_VERSION="2026.09.22.6"
readonly EXPECTED_EXTERNAL_SKILLS_BUNDLE_VERSION="2026.09.22.6"
readonly EXPECTED_PHASE_CATALOG_VERSION="2026.09.03.22"
readonly EXPECTED_HOST_RUNNER_BUNDLE_VERSION="2026.09.14.2"
readonly EXPECTED_HARNESS_RUNTIME_PROFILE="vpn-trusted-host"
readonly EXPECTED_HARNESS_DSH_VERSION="0.1.1-rc.2"
readonly MAX_OUTPUT_TOKENS_PER_REQUEST=32768
readonly MAX_PROXY_REQUEST_BYTES=4194304
readonly MAX_PROXY_TOTAL_REQUEST_BYTES=134217728
readonly DEFAULT_MAX_MODEL_REQUESTS=256
readonly MAX_ALLOWED_MODEL_REQUESTS=256
readonly DEFAULT_MODEL_TIMEOUT_SECONDS=3600
readonly MIN_MODEL_TIMEOUT_SECONDS=60
readonly MAX_MODEL_TIMEOUT_SECONDS=7200
readonly PHASE_STEP_BUDGET=80
readonly MODEL_STOP_GRACE_SECONDS=15
readonly MAX_CASE_EVIDENCE_FILES=20000
readonly MAX_CASE_EVIDENCE_BYTES=536870912
readonly MAX_RUN_EVIDENCE_FILES=70000
readonly MAX_RUN_EVIDENCE_BYTES=2147483648
readonly EXPECTED_RUNTIME_PACKAGE_ENTRY_COUNT=89
readonly TEST_SHADOW_CANDIDATE_WRITE_RUNTIME_MODE="candidate-only-v1"
readonly PHASE_EVIDENCE_CONSUMER_GID="1000"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly FIXTURE_ROOT="${REPOSITORY_ROOT}/tests/fixtures/forge-harness-behavior-evals"
readonly SUITE_FILE="${FIXTURE_ROOT}/suite.json"
readonly ANALYZER_FILE="${SCRIPT_DIR}/analyze-forge-harness-session.mjs"
readonly SECRET_SNAPSHOT_HELPER="${SCRIPT_DIR}/snapshot-local-secret.mjs"
readonly INPUT_SNAPSHOT_HELPER="${SCRIPT_DIR}/snapshot-forge-harness-eval-inputs.mjs"
readonly RUNTIME_LOCK_VERIFIER="${SCRIPT_DIR}/verify-forge-harness-eval-runtime-lock.mjs"
readonly RUNNER_FILE="${SCRIPT_DIR}/run-local-forge-harness-evals.sh"
readonly RUNTIME_PACKAGE_LOCK="${FIXTURE_ROOT}/runtime-trust-lock.json"
readonly PHASE_BUDGET_GUARD_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-phase-budget-guard.mjs"
readonly PROGRESS_DETECTOR_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-progress-detector.mjs"
readonly PRODUCTION_TASK_GRANT_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-production-task-grant.mjs"
readonly EXECUTION_CONTEXT_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-execution-context.mjs"
readonly PROTECTED_HEADLESS_RUNNER_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-protected-headless-runner.mjs"
readonly PHASE_CONTROLLER_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-delivery-phase-controller.mjs"
readonly CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-cross-layer-runtime-evidence.mjs"
readonly PHASE_WORK_PACKAGE_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-phase-work-package.mjs"
readonly PHASE_RUNTIME_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-delivery-phase-runtime.mjs"
readonly TASK_EXECUTION_CONTRACT_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-task-execution-contract.mjs"
readonly PHASE_RESPONSE_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-delivery-phase-response.mjs"
readonly PHASE_OBSERVER_SOURCE="${REPOSITORY_ROOT}/docker/harness/forge-delivery-phase-workspace-observer.mjs"
readonly LOCAL_HOST_PROFILE_RUNNER="${SCRIPT_DIR}/run-local-forge-host-profile.sh"
readonly HOST_PROFILE_DRIVER="${SCRIPT_DIR}/run-host-verification-once.mjs"
readonly EXPECTED_LOCAL_HOST_PROFILE_RUNNER_SHA256="749fa2f5ff2b8d6b1c2350ae687a0a4facba34ba2f3e18cedccb56ebb52d029b"
readonly EXPECTED_HOST_PROFILE_DRIVER_SHA256="5148fc728f2652045941b7c3ff16c7c78593ecbbda536535ade05b09623c08aa"

SOURCE_PATH=""
IMAGE_REFERENCE=""
KEY_FILE=""
EVIDENCE_ROOT=""
EXTERNAL_SKILLS_BUNDLE=""
EXTERNAL_SKILLS_MANIFEST_SHA256=""
HOST_RUNNER_BUNDLE=""
HOST_RUNNER_MANIFEST_SHA256=""
HOST_STATE_ROOT=""
HOST_RUNTIME_ROOT=""
HOST_IPC_ROOT=""
HOST_RUNNER_PID=""
HOST_RUNNER_STARTTIME=""
HOST_RUNNER_CASE_DIR=""
declare -a HOST_USER_COMMAND=()
CASE_FILTER="all"
CONFIRM_LOCAL_MODEL_COST=0
PREFLIGHT_ONLY=0
PREFLIGHT_COMPLETED=0
RETAIN_VOLUMES=0
DATABASE_CONTINUATION_SOURCE=""
DATABASE_CONTINUATION_STATE_SHA256=""
DATABASE_CONTINUATION_PATCH=""
DATABASE_CONTINUATION_PATCH_SHA256=""
BACKEND_CONTINUATION_SOURCE=""
BACKEND_CONTINUATION_BINDINGS=""
BACKEND_CONTINUATION_BINDINGS_SHA256=""
BACKEND_CONTINUATION_PATCH_SHA256=""
FRONTEND_RETRY_SOURCE=""
FRONTEND_RETRY_BINDINGS=""
FRONTEND_RETRY_BINDINGS_SHA256=""
FRONTEND_RETRY_PATCH_SHA256=""
ACCESS_WIRING_CONTINUATION_SOURCE=""
ACCESS_WIRING_CONTINUATION_BINDINGS=""
ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256=""
ACCESS_WIRING_CONTINUATION_PATCH_SHA256=""
CROSS_LAYER_CONTINUATION_SOURCE=""
CROSS_LAYER_CONTINUATION_BINDINGS=""
CROSS_LAYER_CONTINUATION_BINDINGS_SHA256=""
CROSS_LAYER_CONTINUATION_PATCH_SHA256=""
VERIFICATION_MODE="cache-miss"
TEST_SHADOW_CANDIDATE_WRITE=""
VERIFICATION_CACHE_PACK=""
VERIFICATION_CACHE_MANIFEST_SHA256=""
CONFIRM_LOCAL_VERIFICATION_EXECUTION=""
VERIFICATION_CACHE_FINGERPRINT=""
VERIFICATION_RUNTIME_ROOT=""
VERIFICATION_RUNTIME_DAEMON_ROOT=""
VERIFICATION_DOCKER_SOCKET_GID=""
HOST_NODE_MAJOR=""
MAX_MODEL_REQUESTS="${DEFAULT_MAX_MODEL_REQUESTS}"
INDEPENDENT_SEMANTIC_REVIEW=0
readonly SEMANTIC_REVIEW_TIMEOUT_SECONDS=900
MODEL_TIMEOUT_SECONDS="${DEFAULT_MODEL_TIMEOUT_SECONDS}"
run_token=""
run_id=""
run_stage=""
run_dir=""
SECRET_SNAPSHOT_FILE=""
SECRET_SNAPSHOT_DOCKER_PATH=""
BROKER_TOKEN_SNAPSHOT_FILE=""
BROKER_TOKEN_SNAPSHOT_DOCKER_PATH=""
INPUT_SNAPSHOT_DIR=""
ACTIVE_SUITE_FILE=""
ACTIVE_ANALYZER_FILE=""
ACTIVE_FIXTURE_ROOT=""
ACTIVE_PATCH_FILE=""
ACTIVE_EXECUTION_POLICY_FILE=""
INPUT_CLOSURE_DIGEST=""
INPUT_LOCK_SHA256=""
RUNTIME_TOOLS_DIR=""
RUNTIME_TOOLS_LOCK_SHA256=""
RUNTIME_PACKAGE_LOCK_SHA256=""
RUNTIME_PACKAGE_LOCK_BYTES=""
RUNTIME_PACKAGE_ENTRY_COUNT=""
EXPECTED_RUNTIME_PACKAGE_LOCK_SHA256_INPUT=""
ACTIVE_INPUT_SNAPSHOT_HELPER=""
ACTIVE_SECRET_SNAPSHOT_HELPER=""
ACTIVE_RUNTIME_LOCK_VERIFIER=""
ACTIVE_RUNTIME_PACKAGE_LOCK=""
ACTIVE_PHASE_BUDGET_GUARD=""
PHASE_BUDGET_GUARD_SNAPSHOT_DOCKER_PATH=""
ACTIVE_PROGRESS_DETECTOR=""
PROGRESS_DETECTOR_SNAPSHOT_DOCKER_PATH=""
ACTIVE_PROTECTED_HEADLESS_RUNNER=""
PROTECTED_HEADLESS_RUNNER_SNAPSHOT_DOCKER_PATH=""
ACTIVE_PHASE_CONTROLLER=""
ACTIVE_PHASE_RUNTIME=""
ACTIVE_PHASE_RESPONSE=""
ACTIVE_PHASE_OBSERVER=""
RUNTIME_TOOLS_DOCKER_PATH=""
RUNNER_OBSERVED_SHA256=""
candidate_image_receipt=""
RUN_PUBLISHED=0
declare -a OWNED_CONTAINERS=()
declare -a OWNED_VOLUMES=()
declare -a OWNED_NETWORKS=()
ACTIVE_PROXY_CONTAINER=""
ACTIVE_PROXY_CASE_DIR=""

usage() {
  cat <<'EOF'
Usage:
  scripts/run-local-forge-harness-evals.sh \
    --source /absolute/local/forge-admin-v1.1.2 \
    --image LOCAL_CANDIDATE_IMAGE \
    --key-file /absolute/local/deepseek-key \
    --evidence-root /absolute/local/evidence \
    --external-skills-bundle /absolute/local/versioned-skill-bundle \
    --external-skills-manifest-sha256 REVIEWED_EXTERNAL_SHA256 \
    --host-runner-bundle /absolute/local/versioned-host-runner-bundle \
    --host-runner-manifest-sha256 REVIEWED_HOST_RUNNER_SHA256 \
    --runtime-lock-sha256 REVIEWED_EXTERNAL_SHA256 \
    --confirm-local-model-cost \
    [--preflight-only] \
    [--case all|crud-complete|edge-pagination-shared-owner|frontend-aicrudpage-api-contract|adversarial-shortcuts] \
    [--max-model-requests 1..256] \
    [--model-timeout-seconds 60..7200] \
    [--independent-semantic-review] \
    [--verification-mode cache-miss|cache-ready|host-toolchain] \
    [--host-state-root /absolute/operator-owned/project-host-state] \
    [--test-shadow-candidate-write candidate-only] \
    [--verification-cache-pack /absolute/local/content-addressed-pack] \
    [--verification-cache-manifest-sha256 REVIEWED_MANIFEST_SHA256] \
    [--confirm-local-verification-execution cache-ready] \
    [--retain-volumes]

Database continuation (crud-complete, host-toolchain, independent review only):
    --database-continuation-source /absolute/retained/run/crud-complete \
    --database-continuation-state-sha256 REVIEWED_PARENT_STATE_SHA256 \
    --database-continuation-patch /absolute/reviewed/database-candidate.patch \
    --database-continuation-patch-sha256 REVIEWED_PATCH_SHA256
Backend Host-finalized continuation (same fixed scope only):
    --backend-continuation-source /absolute/retained/run/crud-complete \
    --backend-continuation-bindings /absolute/reviewed/backend-finalize-bindings.json \
    --backend-continuation-bindings-sha256 REVIEWED_BINDINGS_SHA256
Frontend FE01 semantic-retry continuation (same fixed scope only):
    --frontend-retry-source /absolute/retained/run/crud-complete \
    --frontend-retry-bindings /absolute/reviewed/frontend-retry-bindings.json \
    --frontend-retry-bindings-sha256 REVIEWED_BINDINGS_SHA256
Accepted frontend to access-wiring continuation (same fixed scope only):
    --access-wiring-continuation-source /absolute/reviewed/run/crud-complete \
    --access-wiring-continuation-bindings /absolute/reviewed/access-wiring-bindings.json \
    --access-wiring-continuation-bindings-sha256 REVIEWED_BINDINGS_SHA256
Accepted access-wiring to cross-layer continuation (same fixed scope only):
    --cross-layer-continuation-source /absolute/reviewed/run/crud-complete \
    --cross-layer-continuation-bindings /absolute/reviewed/cross-layer-bindings.json \
    --cross-layer-continuation-bindings-sha256 REVIEWED_BINDINGS_SHA256

This runner performs paid local DeepSeek model calls unless --preflight-only is
selected. Preflight-only stages the prompt through a run-owned Docker volume,
proves it readable by the fixed model uid with no network or secret, then stops
after the complete model-created/not-started boundary. It accepts local filesystem paths only, never pulls an image, never
accepts a host/server/SSH destination, and never publishes ports. Evidence is
retained by default. Generated Docker volumes are removed by exact name unless
--retain-volumes is supplied.
The external Skill bundle is mandatory, validated as an exact versioned bundle,
mounted read-only only into the model, and selected through the fixed
DSH_BUNDLED_SKILL_DIR container path. The proxy and Broker do not receive it.
The versioned Host Runner bundle is also mandatory. The operator invokes only
the phase catalog's fixed profiles; the model cannot supply profiles, argv,
cwd, environment, image, database identifiers, or verification success.
The runtime-lock SHA-256 is mandatory out-of-band reviewed identity input; the
runner does not derive, default, or embed that value.
The candidate-only switch is a local, single-case test-shadow exception. It
permits an isolated workspace patch after a trusted cache-miss admission, but
does not prove verification, semantic correctness, database behavior,
completion, release, image integration, or production writer authority.
Each case has a hard upstream-request budget (default 256) and a host-side
Docker-attach deadline (default 3600 seconds) followed by explicit owned-container
quiescence checks. Neither limit can be disabled. The deadline is not represented
as a proven end-to-end wall-clock bound when Docker daemon calls stall.
EOF
}

die() {
  printf 'forge-harness-eval: %s\n' "$1" >&2
  exit 2
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required local tool is missing: $1"
}

require_bounded_integer() {
  local label="$1" value="$2" minimum="$3" maximum="$4"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] \
    || die "${label} must be an integer from ${minimum} to ${maximum}"
  (( value >= minimum && value <= maximum )) \
    || die "${label} must be an integer from ${minimum} to ${maximum}"
}

reject_remote_syntax() {
  local label="$1" value="$2"
  [[ -n "${value}" ]] || die "${label} is required"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "${label} contains a line break"
  [[ "${value}" != //* && "${value}" != \\\\* ]] || die "${label} must not use a network-share path"
  [[ ! "${value}" =~ ^[A-Za-z][A-Za-z0-9+.-]*:// ]] || die "${label} must be a local path, not a URI"
  [[ ! "${value}" =~ ^[^/@[:space:]]+@[^:[:space:]]+: ]] || die "${label} must not use a remote-shell target"
  [[ "${value}" != *','* ]] || die "${label} must not contain a comma because Docker --mount is CSV encoded"
}

require_absolute_local_path() {
  local label="$1" value="$2"
  [[ "${value}" == /* || "${value}" =~ ^[A-Za-z]:[\\/] ]] \
    || die "${label} must be an absolute local path"
}

canonical_existing_path() {
  local label="$1" value="$2"
  reject_remote_syntax "${label}" "${value}"
  [[ ! -L "${value}" ]] || die "${label} must not be a symbolic link"
  realpath -e -- "${value}" 2>/dev/null || die "${label} does not resolve to an existing local path"
}

canonical_directory() {
  local label="$1" value="$2" canonical
  canonical="$(canonical_existing_path "${label}" "${value}")"
  [[ -d "${canonical}" ]] || die "${label} must be a directory"
  printf '%s\n' "${canonical}"
}

canonical_regular_file() {
  local label="$1" value="$2" canonical
  canonical="$(canonical_existing_path "${label}" "${value}")"
  [[ -f "${canonical}" && ! -L "${canonical}" ]] || die "${label} must be an ordinary regular file"
  printf '%s\n' "${canonical}"
}

canonical_future_directory() {
  local label="$1" value="$2" canonical
  reject_remote_syntax "${label}" "${value}"
  [[ ! -L "${value}" ]] || die "${label} must not be a symbolic link"
  canonical="$(realpath -m -- "${value}" 2>/dev/null)" || die "${label} cannot be resolved as a local path"
  [[ "${canonical}" != "/" ]] || die "${label} must not be the filesystem root"
  printf '%s\n' "${canonical}"
}

paths_overlap() {
  local left="$1" right="$2"
  [[ "${left}" == "${right}" || "${left}" == "${right}/"* || "${right}" == "${left}/"* ]]
}

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

stable_regular_file_sha256() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = process.argv[2];
const identity = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.nlink].join(':');
const before = fs.lstatSync(file);
if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
  throw new Error('runtime trust-root input must be one ordinary regular file');
}
const first = fs.readFileSync(file);
const middle = fs.lstatSync(file);
const second = fs.readFileSync(file);
const after = fs.lstatSync(file);
if (identity(before) !== identity(middle) || identity(middle) !== identity(after)
  || !first.equals(second) || first.length !== after.size) {
  throw new Error('runtime trust-root input changed during stable double read');
}
process.stdout.write(`${crypto.createHash('sha256').update(first).digest('hex')}\n`);
NODE
}

verify_runner_unchanged() {
  local observed
  [[ -n "${RUNNER_OBSERVED_SHA256}" ]] || return 1
  observed="$(stable_regular_file_sha256 "${RUNNER_FILE}")" || return 1
  [[ "${observed}" == "${RUNNER_OBSERVED_SHA256}" ]]
}

verify_external_skills_bundle() {
  local observed
  [[ -n "${EXTERNAL_SKILLS_BUNDLE}" && -d "${EXTERNAL_SKILLS_BUNDLE}" \
    && ! -L "${EXTERNAL_SKILLS_BUNDLE}" ]] || return 1
  observed="$(stable_regular_file_sha256 "${EXTERNAL_SKILLS_BUNDLE}/bundle.manifest.json")" \
    || return 1
  [[ "${observed}" == "${EXTERNAL_SKILLS_MANIFEST_SHA256}" ]] || return 1
  node -e 'const m=require(process.argv[1]);if(m.bundleVersion!==process.argv[2])process.exit(1)' \
    "${EXTERNAL_SKILLS_BUNDLE}/bundle.manifest.json" "${EXPECTED_EXTERNAL_SKILLS_BUNDLE_VERSION}" \
    || return 1
  node "${REPOSITORY_ROOT}/scripts/forge-skill-bundle.mjs" validate \
    --bundle "${EXTERNAL_SKILLS_BUNDLE}" --dsh-version "${EXPECTED_HARNESS_DSH_VERSION}" >/dev/null
}

verify_host_runner_bundle() {
  local observed
  [[ -n "${HOST_RUNNER_BUNDLE}" && -d "${HOST_RUNNER_BUNDLE}" \
    && ! -L "${HOST_RUNNER_BUNDLE}" ]] || return 1
  observed="$(stable_regular_file_sha256 "${HOST_RUNNER_BUNDLE}/runner.manifest.json")" \
    || return 1
  [[ "${observed}" == "${HOST_RUNNER_MANIFEST_SHA256}" ]] || return 1
  node -e 'const m=require(process.argv[1]);if(m.bundleVersion!==process.argv[2])process.exit(1)' \
    "${HOST_RUNNER_BUNDLE}/runner.manifest.json" "${EXPECTED_HOST_RUNNER_BUNDLE_VERSION}" \
    || return 1
  node "${HOST_RUNNER_BUNDLE}/bin/forge-host-runner-bundle.mjs" validate \
    --bundle "${HOST_RUNNER_BUNDLE}" --profile-catalog-version "${EXPECTED_PHASE_CATALOG_VERSION}" \
    --node-major "${HOST_NODE_MAJOR}" >/dev/null
}

verify_host_profile_adapter() {
  [[ "$(stable_regular_file_sha256 "${LOCAL_HOST_PROFILE_RUNNER}")" == "${EXPECTED_LOCAL_HOST_PROFILE_RUNNER_SHA256}" \
    && "$(stable_regular_file_sha256 "${HOST_PROFILE_DRIVER}")" == "${EXPECTED_HOST_PROFILE_DRIVER_SHA256}" ]]
}

verify_runtime_package_lock() {
  local verifier lock_file verifier_sha receipt
  verifier="${ACTIVE_RUNTIME_LOCK_VERIFIER:-${RUNTIME_LOCK_VERIFIER}}"
  lock_file="${ACTIVE_RUNTIME_PACKAGE_LOCK:-${RUNTIME_PACKAGE_LOCK}}"
  verifier_sha="$(stable_regular_file_sha256 "${verifier}")" || return 1
  [[ "${verifier_sha}" == "${EXPECTED_RUNTIME_LOCK_VERIFIER_SHA256}" ]] || return 1
  receipt="$(node "${verifier}" verify \
    --repository-root "${REPOSITORY_ROOT}" \
    --lock "${lock_file}" \
    --expected-runner-sha256 "${RUNNER_OBSERVED_SHA256}")" || return 1
  node - "${receipt}" "${EXPECTED_RUNTIME_PACKAGE_ID}" "${EXPECTED_RUNTIME_PACKAGE_VERSION}" \
    "${RUNNER_OBSERVED_SHA256}" "${EXPECTED_RUNTIME_PACKAGE_LOCK_SHA256_INPUT}" \
    "${RUNTIME_PACKAGE_LOCK_BYTES:-}" "${EXPECTED_RUNTIME_PACKAGE_ENTRY_COUNT}" <<'NODE'
const [serialized, packageId, packageVersion, runnerSha256, expectedLockSha256,
  expectedLockBytes, expectedEntryCount] = process.argv.slice(2);
const receipt = JSON.parse(serialized);
if (receipt.schemaVersion !== 'forge-harness-eval-runtime-trust-receipt/v1'
  || receipt.packageId !== packageId || receipt.packageVersion !== packageVersion
  || receipt.runnerSha256 !== runnerSha256
  || receipt.entryCount !== Number.parseInt(expectedEntryCount, 10)
  || receipt.contentAddressed !== true || receipt.gitCommitIdentityProven !== false
  || receipt.signedAttestation !== false || receipt.sameHostMaliciousTamperingExcluded !== false
  || !/^[0-9a-f]{64}$/.test(receipt.lockSha256)
  || !Number.isSafeInteger(receipt.lockBytes) || receipt.lockBytes < 1
  || (expectedLockSha256.length > 0 && receipt.lockSha256 !== expectedLockSha256)
  || (expectedLockBytes.length > 0 && receipt.lockBytes !== Number.parseInt(expectedLockBytes, 10))) {
  throw new Error('external runtime package content lock receipt mismatch');
}
process.stdout.write(`${receipt.lockSha256}\n${receipt.lockBytes}\n${receipt.entryCount}\n`);
NODE
}

verify_runtime_tools_snapshot() {
  [[ -n "${RUNTIME_TOOLS_DIR}" && -d "${RUNTIME_TOOLS_DIR}" && ! -L "${RUNTIME_TOOLS_DIR}" ]] || return 1
  node - "${RUNTIME_TOOLS_DIR}" "${RUNNER_OBSERVED_SHA256}" \
    "${EXPECTED_INPUT_SNAPSHOT_HELPER_SHA256}" "${EXPECTED_SECRET_SNAPSHOT_HELPER_SHA256}" \
    "${EXPECTED_RUNTIME_LOCK_VERIFIER_SHA256}" "${EXPECTED_PHASE_BUDGET_GUARD_SHA256}" \
    "${EXPECTED_PROGRESS_DETECTOR_SHA256}" "${EXPECTED_PRODUCTION_TASK_GRANT_SHA256}" \
    "${EXPECTED_EXECUTION_CONTEXT_SHA256}" \
    "${EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256}" \
    "${EXPECTED_PHASE_CONTROLLER_SHA256}" "${EXPECTED_CROSS_LAYER_RUNTIME_EVIDENCE_SHA256}" \
    "${EXPECTED_PHASE_WORK_PACKAGE_SHA256}" \
    "${EXPECTED_PHASE_RUNTIME_SHA256}" \
    "${EXPECTED_TASK_EXECUTION_CONTRACT_SHA256}" \
    "${EXPECTED_PHASE_RESPONSE_SHA256}" "${EXPECTED_PHASE_OBSERVER_SHA256}" \
    "${RUNTIME_PACKAGE_LOCK_SHA256}" \
    "${RUNTIME_TOOLS_LOCK_SHA256}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, runnerSha256, inputHelperSha256, secretHelperSha256, verifierSha256,
  phaseGuardSha256, progressDetectorSha256, productionTaskGrantSha256, executionContextSha256,
  protectedRunnerSha256,
  phaseControllerSha256, crossLayerRuntimeEvidenceSha256, phaseWorkPackageSha256,
  phaseRuntimeSha256, taskExecutionContractSha256,
  phaseResponseSha256, phaseObserverSha256,
  packageLockSha256, expectedLockSha256] = process.argv.slice(2);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = new Map([
  ['input-snapshot-helper.mjs', inputHelperSha256],
  ['secret-snapshot-helper.mjs', secretHelperSha256],
  ['runtime-lock-verifier.mjs', verifierSha256],
  ['phase-budget-guard.mjs', phaseGuardSha256],
  ['progress-detector.mjs', progressDetectorSha256],
  ['forge-production-task-grant.mjs', productionTaskGrantSha256],
  ['forge-execution-context.mjs', executionContextSha256],
  ['protected-headless-runner.mjs', protectedRunnerSha256],
  ['forge-delivery-phase-controller.mjs', phaseControllerSha256],
  ['forge-cross-layer-runtime-evidence.mjs', crossLayerRuntimeEvidenceSha256],
  ['forge-phase-work-package.mjs', phaseWorkPackageSha256],
  ['forge-delivery-phase-runtime.mjs', phaseRuntimeSha256],
  ['forge-task-execution-contract.mjs', taskExecutionContractSha256],
  ['forge-delivery-phase-response.mjs', phaseResponseSha256],
  ['forge-delivery-phase-workspace-observer.mjs', phaseObserverSha256],
  ['package-runtime-trust-lock.json', packageLockSha256],
]);
const rootInfo = fs.lstatSync(root);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('runtime-tools root is invalid');
const observed = fs.readdirSync(root).sort();
const expectedNames = [...expected.keys(), 'runtime-tools-lock.json'].sort();
if (JSON.stringify(observed) !== JSON.stringify(expectedNames)) throw new Error('runtime-tools exact file closure mismatch');
for (const [name, expectedSha256] of expected) {
  const target = path.join(root, name);
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`invalid runtime tool: ${name}`);
  if (hash(fs.readFileSync(target)) !== expectedSha256) throw new Error(`runtime tool hash mismatch: ${name}`);
}
const lockPath = path.join(root, 'runtime-tools-lock.json');
const lockInfo = fs.lstatSync(lockPath);
if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.nlink !== 1) throw new Error('runtime-tools lock is invalid');
const lockBytes = fs.readFileSync(lockPath);
if (hash(lockBytes) !== expectedLockSha256) throw new Error('runtime-tools lock hash mismatch');
const lock = JSON.parse(lockBytes.toString('utf8'));
if (lock.schemaVersion !== 'forge-harness-runtime-tools-lock/v1'
  || lock.runnerObservedSha256 !== runnerSha256
  || !Array.isArray(lock.entries) || lock.entries.length !== expected.size) {
  throw new Error('runtime-tools lock identity mismatch');
}
const entries = new Map(lock.entries.map((entry) => [entry?.path, entry]));
if (entries.size !== expected.size) throw new Error('runtime-tools lock contains duplicate paths');
for (const [name, expectedSha256] of expected) {
  const info = fs.statSync(path.join(root, name));
  const entry = entries.get(name);
  if (entry?.sha256 !== expectedSha256 || entry?.bytes !== info.size) {
    throw new Error(`runtime-tools lock receipt mismatch: ${name}`);
  }
}
NODE
}

verify_input_snapshot() {
  local snapshot="${1:-${INPUT_SNAPSHOT_DIR}}"
  [[ -n "${snapshot}" && -d "${snapshot}" && ! -L "${snapshot}" ]] || return 1
  verify_runtime_tools_snapshot || return 1
  node "${ACTIVE_INPUT_SNAPSHOT_HELPER}" verify \
    --snapshot "${snapshot}" \
    --suite-sha256 "${EXPECTED_SUITE_SHA256}" \
    --analyzer-sha256 "${EXPECTED_ANALYZER_SHA256}"
}

# Capture the candidate's immutable provenance before any paid model call. The
# receipt is deliberately a projection: it contains no environment values or
# arbitrary image metadata, but binds the executed image ID to the reviewed
# vpn65 labels, its immutable base layer prefix, and the two receipts embedded
# by the image build. This gives semantic reviewers a run-level identity
# anchor instead of requiring them to infer provenance from one case's inspect
# artifact.
create_candidate_image_admission_receipt() {
  local target_inspect="${run_stage}/.candidate-image.inspect.json"
  local base_inspect="${run_stage}/.candidate-base.inspect.json"
  local build_receipt="${run_stage}/.candidate-build-input.receipt.json"
  local runtime_receipt="${run_stage}/.candidate-runtime.receipt.json"
  local base_image_id
  candidate_image_receipt="${run_stage}/candidate-image-admission.receipt.json"

  docker image inspect "${image_id}" >"${target_inspect}" \
    || die 'candidate image inspect failed before paid execution'
  docker run --rm --network none --read-only --entrypoint cat "${image_id}" \
    /usr/local/share/forge-image-build/receipt.json >"${build_receipt}" \
    || die 'candidate image has no readable embedded build-input receipt'
  docker run --rm --network none --read-only --entrypoint cat "${image_id}" \
    /usr/local/share/forge-image-build/runtime-dependency-receipt.json >"${runtime_receipt}" \
    || die 'candidate image has no readable embedded runtime-dependency receipt'
  base_image_id="$(node - "${target_inspect}" <<'NODE'
const fs = require('node:fs');
const image = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const id = image?.Config?.Labels?.['com.forge-delivery.harness-base-image-id'];
if (!/^sha256:[0-9a-f]{64}$/.test(id ?? '')) throw new Error('candidate base image label is not immutable');
process.stdout.write(`${id}\n`);
NODE
)" || die 'candidate image base identity could not be read'
  docker image inspect "${base_image_id}" >"${base_inspect}" \
    || die 'candidate image base content is unavailable locally'

  node - "${target_inspect}" "${base_inspect}" "${build_receipt}" "${runtime_receipt}" \
    "${candidate_image_receipt}" "${IMAGE_REFERENCE}" "${image_id}" \
    "${EXPECTED_HARNESS_IMAGE_REVISION}" "${EXPECTED_HARNESS_SKILL_BUNDLE_VERSION}" \
    "${EXPECTED_HARNESS_RUNTIME_PROFILE}" "${EXPECTED_HARNESS_DSH_VERSION}" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [targetPath, basePath, buildPath, runtimePath, outputPath, reference,
  expectedImageId, expectedRevision, expectedSkillBundle, expectedRuntimeProfile,
  expectedDshVersion] = process.argv.slice(2);
const decodeSingleInspect = (path) => {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error('candidate image inspect must contain exactly one image');
    return parsed[0];
  }
  if (parsed && typeof parsed === 'object') return parsed;
  throw new Error('candidate image inspect must contain one object');
};
const image = decodeSingleInspect(targetPath);
const parent = decodeSingleInspect(basePath);
const labels = image.Config?.Labels ?? {};
const baseLabels = parent.Config?.Labels ?? {};
if (image.Id !== expectedImageId || !/^sha256:[0-9a-f]{64}$/.test(image.Id ?? '')) {
  throw new Error('candidate image ID changed during admission');
}
const baseImageId = labels['com.forge-delivery.harness-base-image-id'];
if (parent.Id !== baseImageId || !/^sha256:[0-9a-f]{64}$/.test(baseImageId ?? '')) {
  throw new Error(`candidate base image ID does not match its inspected content: label=${JSON.stringify(baseImageId)} inspected=${JSON.stringify(parent.Id)}`);
}
if (labels['org.opencontainers.image.revision'] !== expectedRevision
  || labels['org.opencontainers.image.version'] !== expectedDshVersion
  || labels['com.forge-delivery.harness-skill-bundle'] !== expectedSkillBundle
  || labels['com.forge-delivery.harness-runtime-profile'] !== expectedRuntimeProfile
  || image.Os !== 'linux' || parent.Os !== 'linux'
  || image.Architecture !== parent.Architecture
  || image.Config?.User !== '1000:1000'
  || image.Config?.WorkingDir !== '/workspace'
  || (image.Config?.Entrypoint ?? null) !== null
  || JSON.stringify(image.Config?.Cmd) !== JSON.stringify(['/usr/local/bin/start-harness'])) {
  throw new Error('candidate image provenance/profile contract is invalid');
}
const targetLayers = image.RootFS?.Layers;
const baseLayers = parent.RootFS?.Layers;
if (!Array.isArray(targetLayers) || !Array.isArray(baseLayers) || baseLayers.length < 1
  || targetLayers.length > 124 || targetLayers.length <= baseLayers.length
  || !baseLayers.every((layer, index) => targetLayers[index] === layer)) {
  throw new Error('candidate image exceeds the layer budget or does not strictly extend the immutable base layer prefix');
}
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
if (!build || typeof build !== 'object' || build.schemaVersion !== 1 || typeof build.digest !== 'string'
  || !/^sha256:[0-9a-f]{64}$/.test(build.digest)
  || !runtime || typeof runtime !== 'object' || runtime.schemaVersion !== 3 || typeof runtime.digest !== 'string'
  || !/^sha256:[0-9a-f]{64}$/.test(runtime.digest)) {
  throw new Error('candidate embedded receipts have no valid content digest');
}
const selectedLabels = Object.fromEntries([
  'org.opencontainers.image.revision',
  'org.opencontainers.image.version',
  'com.forge-delivery.harness-skill-bundle',
  'com.forge-delivery.harness-runtime-profile',
  'com.forge-delivery.harness-base-image-id',
].map((key) => [key, labels[key]]));
const config = {
  os: image.Os,
  architecture: image.Architecture,
  user: image.Config?.User,
  workingDir: image.Config?.WorkingDir,
  entrypoint: image.Config?.Entrypoint ?? null,
  cmd: image.Config?.Cmd,
  labels: selectedLabels,
};
const payload = {
  schemaVersion: 'forge-harness-candidate-image-admission/v1',
  reference,
  imageId: image.Id,
  target: {
    os: image.Os,
    architecture: image.Architecture,
    config: {
      user: image.Config?.User,
      workingDir: image.Config?.WorkingDir,
      entrypoint: image.Config?.Entrypoint ?? null,
      cmd: image.Config?.Cmd,
    },
    labels: selectedLabels,
    rootFs: { type: image.RootFS?.Type, layers: targetLayers },
  },
  base: {
    imageId: parent.Id,
    os: parent.Os,
    architecture: parent.Architecture,
    labels: {
      revision: baseLabels['org.opencontainers.image.revision'],
      skillBundle: baseLabels['com.forge-delivery.harness-skill-bundle'],
      runtimeProfile: baseLabels['com.forge-delivery.harness-runtime-profile'],
    },
    rootFs: { type: parent.RootFS?.Type, layers: baseLayers },
  },
  embeddedReceipts: {
    buildInputs: { schemaVersion: build.schemaVersion, digest: build.digest },
    runtimeDependencies: { schemaVersion: runtime.schemaVersion, digest: runtime.digest },
  },
  configProjectionSha256: hash(Buffer.from(JSON.stringify(stable(config)))),
  verification: {
    localImageIdStableAtAdmission: true,
    baseImageAvailableAndImmutable: true,
    inheritedBaseLayerPrefixMatches: true,
    layerBudget: { maximum: 124, target: targetLayers.length, base: baseLayers.length, strictExtension: true },
    embeddedBuildInputReceiptPresent: true,
    embeddedRuntimeDependencyReceiptPresent: true,
    externalSignatureAttestation: false,
  },
};
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
  rm -f -- "${target_inspect}" "${base_inspect}" "${build_receipt}" "${runtime_receipt}"
  [[ -f "${candidate_image_receipt}" && ! -L "${candidate_image_receipt}" ]] \
    || die 'candidate image admission receipt was not created'
}

RESOURCE_STATE="unknown"
probe_resource_state() {
  local kind="$1" name="$2" output
  RESOURCE_STATE="unknown"
  if output="$(docker "${kind}" inspect "${name}" 2>&1)"; then
    RESOURCE_STATE="present"
    return 0
  fi
  case "${kind}" in
    container)
      [[ "${output}" == *"No such container: ${name}"* ]] || {
        printf 'forge-harness-eval: Docker container state inspection failed closed: %s\n' "${name}" >&2
        return 1
      }
      ;;
    volume)
      [[ "${output}" == *"get ${name}: no such volume"* ]] || {
        printf 'forge-harness-eval: Docker volume state inspection failed closed: %s\n' "${name}" >&2
        return 1
      }
      ;;
    network)
      [[ "${output}" == *"network ${name} not found"* ]] || {
        printf 'forge-harness-eval: Docker network state inspection failed closed: %s\n' "${name}" >&2
        return 1
      }
      ;;
    *)
      printf 'forge-harness-eval: unsupported Docker resource kind: %s\n' "${kind}" >&2
      return 1
      ;;
  esac
  RESOURCE_STATE="absent"
}

remove_owned_container() {
  local name="$1" owner
  probe_resource_state container "${name}" || return 1
  if [[ "${RESOURCE_STATE}" == "present" ]]; then
    owner="$(docker container inspect --format '{{ index .Config.Labels "com.forge.hbe.run" }}' "${name}" 2>/dev/null)"
    [[ -n "${run_token}" && "${owner}" == "${run_token}" ]] || {
      printf 'forge-harness-eval: refusing to remove unowned container: %s\n' "${name}" >&2
      return 1
    }
    docker container rm --force "${name}" >/dev/null
  fi
}

stop_owned_container() {
  local name="$1" owner
  probe_resource_state container "${name}" || return 1
  if [[ "${RESOURCE_STATE}" == "present" ]]; then
    owner="$(docker container inspect --format '{{ index .Config.Labels "com.forge.hbe.run" }}' "${name}" 2>/dev/null)"
    [[ -n "${run_token}" && "${owner}" == "${run_token}" ]] || {
      printf 'forge-harness-eval: refusing to stop unowned container: %s\n' "${name}" >&2
      return 1
    }
    docker container stop --time "${MODEL_STOP_GRACE_SECONDS}" "${name}"
  fi
}

remove_owned_volume() {
  local name="$1" owner
  probe_resource_state volume "${name}" || return 1
  if [[ "${RESOURCE_STATE}" == "present" ]]; then
    owner="$(docker volume inspect --format '{{ index .Labels "com.forge.hbe.run" }}' "${name}" 2>/dev/null)"
    [[ -n "${run_token}" && "${owner}" == "${run_token}" ]] || {
      printf 'forge-harness-eval: refusing to remove unowned volume: %s\n' "${name}" >&2
      return 1
    }
    docker volume rm "${name}" >/dev/null
  fi
}

remove_owned_network() {
  local name="$1" owner
  probe_resource_state network "${name}" || return 1
  if [[ "${RESOURCE_STATE}" == "present" ]]; then
    owner="$(docker network inspect --format '{{ index .Labels "com.forge.hbe.run" }}' "${name}" 2>/dev/null)"
    [[ -n "${run_token}" && "${owner}" == "${run_token}" ]] || {
      printf 'forge-harness-eval: refusing to remove unowned network: %s\n' "${name}" >&2
      return 1
    }
    docker network rm "${name}" >/dev/null
  fi
}

verify_owned_evidence_path() {
  local target="$1"
  node - "${EVIDENCE_ROOT}" "${target}" "${run_token}" "${run_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [evidenceRootInput, targetInput, runToken, runId] = process.argv.slice(2);
const evidenceRoot = fs.realpathSync(evidenceRootInput);
const targetInfo = fs.lstatSync(targetInput);
if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('owned evidence path is not one ordinary directory');
const target = fs.realpathSync(targetInput);
const allowedNames = new Set([
  `.${runId}.staging`,
  runId,
  `${runId}-incomplete`,
  `${runId}-preflight-completed`,
]);
if (path.dirname(target) !== evidenceRoot || !allowedNames.has(path.basename(target))) {
  throw new Error('refusing to operate on evidence outside the exact generated run paths');
}

const markerPath = path.join(target, '.forge-hbe-owner.json');
const markerInfo = fs.lstatSync(markerPath);
if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('invalid staging owner marker');
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
if (marker.runToken !== runToken || marker.runId !== runId || marker.schemaVersion !== 'forge-harness-staging-owner/v1') {
  throw new Error('refusing to operate on evidence without the exact run owner token and id');
}
NODE
}

remove_owned_evidence_path() {
  local target="$1"
  [[ -n "${target}" && -e "${target}" ]] || return 0
  verify_owned_evidence_path "${target}" || return 1
  node - "${target}" <<'NODE'
const fs = require('node:fs');
const target = process.argv[2];
fs.rmSync(target, { recursive: true, force: false });
NODE
}

remove_run_owned_verification_cache_copy() {
  local evidence_path="$1"
  [[ "${VERIFICATION_MODE}" == 'cache-ready' ]] || return 0
  node - "${evidence_path}" "${VERIFICATION_CACHE_FINGERPRINT}" \
    "${VERIFICATION_CACHE_PACK}" "${run_token}" "${run_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [evidenceInput, fingerprint, callerPackInput, runToken, runId] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new Error('verification cache fingerprint is invalid');
const evidence = fs.realpathSync(evidenceInput);
const ownerFile = path.join(evidence, '.forge-hbe-owner.json');
const ownerInfo = fs.lstatSync(ownerFile);
if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1) {
  throw new Error('verification cache cleanup owner marker is invalid');
}
const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
if (owner.schemaVersion !== 'forge-harness-staging-owner/v1'
  || owner.runToken !== runToken || owner.runId !== runId) {
  throw new Error('verification cache cleanup owner marker mismatch');
}
const runtime = path.join(evidence, '.verification-runtime');
const cacheRoot = path.join(runtime, 'cache-packs');
const target = path.join(cacheRoot, fingerprint);
const callerPack = fs.realpathSync(callerPackInput);
const overlaps = (left, right) => left === right || left.startsWith(`${right}${path.sep}`)
  || right.startsWith(`${left}${path.sep}`);
if (overlaps(path.resolve(target), callerPack)) {
  throw new Error('refusing to remove the caller-owned final verification cache pack');
}
const optionalLstat = (entryPath) => {
  try { return fs.lstatSync(entryPath); } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};
const runtimeInfo = optionalLstat(runtime);
if (runtimeInfo === undefined) process.exit(0);
const cacheRootInfo = optionalLstat(cacheRoot);
if (cacheRootInfo === undefined) process.exit(0);
const targetInfo = optionalLstat(target);
if (targetInfo === undefined) process.exit(0);
for (const [label, entryPath, info] of [
  ['runtime', runtime, runtimeInfo], ['cache root', cacheRoot, cacheRootInfo], ['cache copy', target, targetInfo],
]) {
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(entryPath) !== path.resolve(entryPath)) {
    throw new Error(`run-owned verification ${label} boundary is invalid`);
  }
}
const makeRemovable = (directory) => {
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const info = fs.lstatSync(entryPath);
    if (info.isSymbolicLink()) throw new Error('run-owned verification cache copy contains a symbolic link');
    if (info.isDirectory()) makeRemovable(entryPath);
    else if (info.isFile() && info.nlink === 1) fs.chmodSync(entryPath, 0o600);
    else throw new Error('run-owned verification cache copy contains a special or linked node');
  }
};
makeRemovable(target);
fs.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
if (optionalLstat(target) !== undefined) throw new Error('run-owned verification cache copy still exists after cleanup');
NODE
}

remove_owned_verification_runtime() {
  [[ -n "${VERIFICATION_RUNTIME_ROOT}" ]] || return 0
  node - "${run_stage}" "${VERIFICATION_RUNTIME_ROOT}" "${run_token}" "${run_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [stageInput, runtimeInput, runToken, runId] = process.argv.slice(2);
const stage = fs.realpathSync(stageInput);
const runtime = fs.realpathSync(runtimeInput);
if (path.dirname(runtime) !== stage || path.basename(runtime) !== '.verification-runtime') {
  throw new Error('refusing to remove a verification runtime outside the exact run staging root');
}
const ownerFile = path.join(stage, '.forge-hbe-owner.json');
const ownerInfo = fs.lstatSync(ownerFile);
const runtimeInfo = fs.lstatSync(runtime);
if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1
  || !runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
  throw new Error('verification runtime ownership boundary is invalid');
}
const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
if (owner.schemaVersion !== 'forge-harness-staging-owner/v1'
  || owner.runToken !== runToken || owner.runId !== runId) {
  throw new Error('verification runtime owner marker mismatch');
}
fs.rmSync(runtime, { recursive: true, force: false, maxRetries: 2 });
NODE
  VERIFICATION_RUNTIME_ROOT=""
}

remove_owned_staging() {
  remove_owned_evidence_path "${run_stage}"
}

move_owned_evidence_to_terminal() {
  local source="$1" suffix="$2" target
  [[ "${suffix}" == 'incomplete' || "${suffix}" == 'preflight-completed' ]] || return 1
  target="${EVIDENCE_ROOT}/${run_id}-${suffix}"
  verify_owned_evidence_path "${source}" || return 1
  [[ ! -e "${target}" && ! -L "${target}" ]] || {
    printf 'forge-harness-eval: generated incomplete evidence path already exists; refusing to collide: %s\n' "${target}" >&2
    return 1
  }
  mv -T --no-clobber -- "${source}" "${target}" || return 1
  [[ ! -e "${source}" && ! -L "${source}" && -d "${target}" && ! -L "${target}" ]] || return 1
  verify_owned_evidence_path "${target}"
}

remove_secret_snapshot() {
  local target="$1" expected_suffix="$2"
  [[ -n "${target}" ]] || return 0
  node - "${EVIDENCE_ROOT}" "${target}" "${run_id}" "${expected_suffix}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, targetInput, runId, expectedSuffix] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
if (!['credential', 'broker-token'].includes(expectedSuffix)) throw new Error('invalid generated secret suffix');
const expected = path.join(root, `.${runId}.${expectedSuffix}`);
if (path.resolve(targetInput) !== expected || path.dirname(expected) !== root) {
  throw new Error('refusing to remove a secret snapshot outside its exact generated path');
}

let info;
try {
  info = fs.lstatSync(expected);
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0);
  throw error;
}
if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
  throw new Error('refusing to remove an invalid secret snapshot inode');
}
fs.unlinkSync(expected);
NODE
}

scrub_all_bearer_secrets() {
  local root="$1" report_prefix="$2" aggregate="$3" first_report second_report
  first_report="${report_prefix}.model-api.json"
  second_report="${report_prefix}.broker-token.json"
  node "${ACTIVE_ANALYZER_FILE}" scrub-secret --root "${root}" --secret-file "${SECRET_SNAPSHOT_FILE}" --report "${first_report}" \
    && node "${ACTIVE_ANALYZER_FILE}" scrub-secret --root "${root}" --secret-file "${BROKER_TOKEN_SNAPSHOT_FILE}" --report "${second_report}" \
    && node - "${first_report}" "${second_report}" "${aggregate}" <<'NODE'
const fs = require('node:fs');
const [firstPath, secondPath, target] = process.argv.slice(2);
const scans = [firstPath, secondPath].map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
if (scans.some((scan) => scan.secretRetained !== false)) throw new Error('a bearer secret remains in evidence');
const payload = {
  schemaVersion: 'forge-harness-multi-secret-scrub/v1',
  secretClasses: ['model-api-key', 'taskspace-broker-token'],
  passes: scans.map((scan, index) => ({
    secretClass: index === 0 ? 'model-api-key' : 'taskspace-broker-token',
    filesChecked: scan.filesChecked,
    filesRechecked: scan.filesRechecked,
    filesRedacted: scan.filesRedacted,
    replacementCount: scan.replacementCount,
    secretRetained: scan.secretRetained,
  })),
  filesChecked: Math.max(...scans.map((scan) => scan.filesChecked)),
  filesRechecked: Math.max(...scans.map((scan) => scan.filesRechecked)),
  filesRedacted: [...new Set(scans.flatMap((scan) => scan.filesRedacted))].sort(),
  replacementCount: scans.reduce((total, scan) => total + scan.replacementCount, 0),
  secretRetained: false,
};
fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
}

prepare_native_host_runtime() {
  HOST_RUNTIME_ROOT="${HOST_STATE_ROOT}/.eval-runs/${run_id}"
  HOST_IPC_ROOT="/tmp/forge-hbe-${run_token}"
  node - "${HOST_STATE_ROOT}" "${HOST_RUNTIME_ROOT}" "${HOST_IPC_ROOT}" "${run_token}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [state, runtime, ipc, token] = process.argv.slice(2);
const parent = path.join(state, '.eval-runs');
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
for (const root of [state, parent]) {
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('Host state root is not an ordinary canonical directory');
  if (process.getuid() === 0) fs.chownSync(root, 1000, 1000);
  fs.chmodSync(root, 0o700);
}
for (const root of [runtime, ipc]) {
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.forge-host-eval-owner.json'), JSON.stringify({ token }), { flag: 'wx', mode: 0o400 });
  if (process.getuid() === 0) fs.chownSync(root, 1000, 1000);
}
NODE
}

start_native_host_runner() {
  local entrypoint
  entrypoint="$(node -e 'const p=require("node:path"),m=require(process.argv[1]+"/runner.manifest.json");process.stdout.write(p.join(process.argv[1],m.entrypoint))' "${HOST_RUNNER_BUNDLE}")"
  "${HOST_USER_COMMAND[@]}" env -i PATH="${PATH}" "$(command -v node)" -e '
const fs = require("node:fs");
for (const root of process.argv.slice(1, 4)) fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
fs.accessSync(process.argv[1], fs.constants.W_OK);
fs.accessSync(process.argv[4], fs.constants.R_OK);
' "${HOST_STATE_ROOT}" "${HOST_RUNNER_BUNDLE}" "${HOST_RUNTIME_ROOT}/baseline" "${LOCAL_HOST_PROFILE_RUNNER}" \
    || die 'uid/gid 1000 cannot access the Host state, bundle, baseline or adapter; operator must grant exact ancestor traversal'
  HOST_RUNNER_CASE_DIR="${case_dir}"
  "${HOST_USER_COMMAND[@]}" env -i PATH="${PATH}" HOME="${HOST_STATE_ROOT}" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    VERIFICATION_PROJECT_SLUG="${eval_project_slug}" VERIFICATION_CONTRACT="${case_runtime_host}/verification/contract.json" \
    VERIFICATION_RUNNER_SOCKET="${verification_runner_socket}" VERIFICATION_SOURCE_SOCKET="${verification_source_socket}" \
    "$(command -v node)" --input-type=module - "${entrypoint}" "${run_token}" <<'NODE' \
    >"${case_dir}/verification-runner.stdout.txt" 2>"${case_dir}/verification-runner.stderr.txt" &
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [entrypoint, runToken] = process.argv.slice(2);
if (process.getuid() !== 1000 || process.getgid() !== 1000) throw new Error('Native verification must run as uid/gid 1000');
let dockerSocketAccessible = false;
try { fs.accessSync('/var/run/docker.sock', fs.constants.W_OK); dockerSocketAccessible = true; } catch {}
if (dockerSocketAccessible) throw new Error('Native verification user can access the Docker socket');
const { HostVerificationRunner } = await import(pathToFileURL(entrypoint).href);
const { createVerificationRunnerServer, createVerificationSourceObserverServer } = await import(pathToFileURL(path.join(path.dirname(entrypoint), 'verification-runner.mjs')).href);
const contract = JSON.parse(fs.readFileSync(process.env.VERIFICATION_CONTRACT, 'utf8'));
const runner = new HostVerificationRunner({ projectSlug: process.env.VERIFICATION_PROJECT_SLUG, contract });
fs.mkdirSync(runner.stateRoot, { recursive: true, mode: 0o700 });
const servers = [createVerificationRunnerServer(runner), createVerificationSourceObserverServer(runner)];
const sockets = [process.env.VERIFICATION_RUNNER_SOCKET, process.env.VERIFICATION_SOURCE_SOCKET];
await Promise.all(servers.map((server, index) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(sockets[index], () => { fs.chmodSync(sockets[index], 0o660); resolve(); });
})));
const startTime = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
process.stdout.write(`${JSON.stringify({ event: 'ready', runToken, pid: process.pid, startTime, uid: process.getuid(), gid: process.getgid(), supplementaryGroups: process.getgroups(), environmentNames: Object.keys(process.env).sort(), dockerSocketAccessible: false, executionMode: 'host-toolchain', dependencyNetworkIsolationProven: false })}\n`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) { server.close(); server.closeAllConnections(); }
  const deadline = Date.now() + 20000;
  while (runner.activeByTask.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (runner.activeByTask.size > 0) {
    process.stderr.write('Native Host Runner could not prove job quiescence; retained state requires operator recovery\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify({ event: 'stopped', runToken, pid: process.pid, startTime, activeJobs: 0, processQuiescenceProvenBeforeEvidence: true })}\n`);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
NODE
  HOST_RUNNER_PID=$!
  HOST_RUNNER_STARTTIME="$(node - "${HOST_RUNNER_PID}" <<'NODE'
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(`/proc/${process.argv[2]}/stat`, 'utf8').split(') ')[1].split(' ')[19]);
NODE
  )" || return 1
}

stop_native_host_runner() {
  [[ -n "${HOST_RUNNER_PID}" ]] || return 0
  local native_exit=0
  node - "${HOST_RUNNER_PID}" "${HOST_RUNNER_STARTTIME}" <<'NODE' || return 1
const fs = require('node:fs');
const [pid, startTime] = process.argv.slice(2);
try {
  const observed = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  if (observed !== startTime) throw new Error('Native Host Runner PID ownership changed');
  process.kill(Number(pid), 'SIGTERM');
} catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
NODE
  timeout 30s tail --pid="${HOST_RUNNER_PID}" -f /dev/null || return 1
  wait "${HOST_RUNNER_PID}" || native_exit=$?
  node - "${HOST_RUNNER_CASE_DIR}/verification-runner.stdout.txt" \
    "${HOST_RUNNER_CASE_DIR}/verification-runner.supervision.json" "${run_token}" \
    "${HOST_RUNNER_PID}" "${HOST_RUNNER_STARTTIME}" "${native_exit}" <<'NODE' || return 1
const fs = require('node:fs');
const [log, output, token, pid, startTime, exitCode] = process.argv.slice(2);
const records = fs.readFileSync(log, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const ready = records.find((item) => item.event === 'ready');
const stopped = records.find((item) => item.event === 'stopped');
if (!ready && !stopped && Number(exitCode) !== 0) {
  // No server became ready and the owned child has exited. Preserve its startup
  // stderr as incomplete evidence without attributing a successful Host run.
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 'forge-harness-host-runner-supervision/v1',
    role: 'verification-runner', executionMode: 'host-toolchain', pid: Number(pid), startTime,
    startupCompleted: false, processExitCode: Number(exitCode), processQuiescenceProvenBeforeEvidence: true,
    dependencyNetworkIsolationProven: false }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.exit(0);
}
if (!ready || !stopped || Number(exitCode) !== 0 || ready.runToken !== token || stopped.runToken !== token
  || ready.pid !== Number(pid) || stopped.pid !== Number(pid) || ready.startTime !== startTime || stopped.startTime !== startTime
  || ready.uid !== 1000 || ready.gid !== 1000 || ready.dockerSocketAccessible !== false || stopped.activeJobs !== 0) {
  throw new Error('Native Host Runner lifecycle was not proven');
}
fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 'forge-harness-host-runner-supervision/v1', role: 'verification-runner', executionMode: 'host-toolchain', pid: Number(pid), startTime, uid: 1000, gid: 1000, processExitCode: Number(exitCode), processQuiescenceProvenBeforeEvidence: true, dockerSocketAccessible: false, dependencyNetworkIsolationProven: false }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
  HOST_RUNNER_PID=""
}

remove_native_host_runtime() {
  [[ -n "${HOST_RUNTIME_ROOT}" ]] || return 0
  [[ -z "${HOST_RUNNER_PID}" ]] || return 1
  node - "${HOST_STATE_ROOT}" "${HOST_RUNTIME_ROOT}" "${HOST_IPC_ROOT}" "${run_id}" "${run_token}" <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const [state, runtime, ipc, runId, token] = process.argv.slice(2);
if (runtime !== path.join(state, '.eval-runs', runId) || ipc !== `/tmp/forge-hbe-${token}`) throw new Error('Native runtime cleanup path mismatch');
for (const root of [runtime, ipc]) {
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(root) !== root
    || JSON.parse(fs.readFileSync(path.join(root, '.forge-host-eval-owner.json'), 'utf8')).token !== token) throw new Error('Native runtime cleanup owner mismatch');
  fs.rmSync(root, { recursive: true, force: false });
}
NODE
  HOST_RUNTIME_ROOT=""
  HOST_IPC_ROOT=""
}

cleanup_owned_resources() {
  local original_exit="$1" index cleanup_failed=0 containers_quiesced=1 abort_report pending_evidence incomplete_dir protected_secret publication_suffix
  local abort_proxy_stop_exit abort_proxy_logs_exit abort_proxy_inspect_exit
  trap - EXIT
  set +e
  if [[ "${original_exit}" -ne 0 && -n "${ACTIVE_PROXY_CONTAINER}" && -n "${ACTIVE_PROXY_CASE_DIR}" \
    && -d "${ACTIVE_PROXY_CASE_DIR}" ]] && docker info >/dev/null 2>&1; then
    probe_resource_state container "${ACTIVE_PROXY_CONTAINER}"
    if [[ "${RESOURCE_STATE}" == "present" ]]; then
      stop_owned_container "${ACTIVE_PROXY_CONTAINER}" \
        >"${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort-stop.stdout.txt" \
        2>"${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort-stop.stderr.txt"
      abort_proxy_stop_exit=$?
      docker logs "${ACTIVE_PROXY_CONTAINER}" \
        >"${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort.stdout.txt" \
        2>"${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort.stderr.txt"
      abort_proxy_logs_exit=$?
      docker container inspect "${ACTIVE_PROXY_CONTAINER}" \
        >"${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort.inspect.json" \
        2>"${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort.inspect.stderr.txt"
      abort_proxy_inspect_exit=$?
      node - "${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort.stdout.txt" \
        "${ACTIVE_PROXY_CASE_DIR}/credential-proxy.abort-supervision.json" \
        "${abort_proxy_stop_exit}" "${abort_proxy_logs_exit}" "${abort_proxy_inspect_exit}" <<'NODE'
const fs = require('node:fs');
const [logFile, output, stopExit, logsExit, inspectExit] = process.argv.slice(2);
let records = [];
try {
  records = fs.readFileSync(logFile, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
} catch {}
const stopped = records.findLast((entry) => entry?.event === 'stopped' && entry?.service === 'forge-credential-proxy');
const counter = (name) => Number.isSafeInteger(stopped?.[name]) && stopped[name] >= 0 ? stopped[name] : null;
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 'forge-harness-credential-proxy-abort-supervision/v1',
  stopExitCode: Number(stopExit), logsCollectionExitCode: Number(logsExit),
  inspectionExitCode: Number(inspectExit), terminalCounterProven: stopped !== undefined,
  acceptedRequests: counter('acceptedRequests'), forwardedRequests: counter('forwardedRequests'),
  forwardedRequestBytes: counter('forwardedRequestBytes'), rejectedByLimit: counter('rejectedByLimit'),
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
      if [[ "${abort_proxy_stop_exit}" -ne 0 || "${abort_proxy_logs_exit}" -ne 0 \
        || "${abort_proxy_inspect_exit}" -ne 0 ]]; then cleanup_failed=1; fi
    fi
  fi
  if [[ ${#OWNED_CONTAINERS[@]} -eq 0 && ${#OWNED_NETWORKS[@]} -eq 0 && ${#OWNED_VOLUMES[@]} -eq 0 ]]; then
    :
  elif docker info >/dev/null 2>&1; then
    for ((index=${#OWNED_CONTAINERS[@]}-1; index>=0; index-=1)); do
      remove_owned_container "${OWNED_CONTAINERS[index]}" || { cleanup_failed=1; containers_quiesced=0; }
    done
  else
    cleanup_failed=1
    containers_quiesced=0
  fi
  if ! stop_native_host_runner; then cleanup_failed=1; containers_quiesced=0; fi
  if [[ "${containers_quiesced}" -eq 1 ]]; then remove_native_host_runtime || cleanup_failed=1; fi
  pending_evidence=""
  if [[ "${RUN_PUBLISHED}" -eq 0 ]]; then
    if [[ -n "${run_stage}" && -d "${run_stage}" && ! -L "${run_stage}" ]]; then
      pending_evidence="${run_stage}"
    elif [[ -n "${run_dir}" && -d "${run_dir}" && ! -L "${run_dir}" ]]; then
      pending_evidence="${run_dir}"
    fi
  fi
  if [[ -n "${pending_evidence}" ]]; then
    abort_report="${pending_evidence}/abort-secret-scan.json"
    if [[ "${containers_quiesced}" -eq 1 ]] \
      && [[ -n "${SECRET_SNAPSHOT_FILE}" && -n "${BROKER_TOKEN_SNAPSHOT_FILE}" ]] \
      && [[ ! -e "${SECRET_SNAPSHOT_FILE}" && ! -L "${SECRET_SNAPSHOT_FILE}" \
        && ! -e "${BROKER_TOKEN_SNAPSHOT_FILE}" && ! -L "${BROKER_TOKEN_SNAPSHOT_FILE}" ]]; then
      printf 'forge-harness-eval: credential snapshot was not created; removing exact incomplete evidence without invoking secret scrub\n' >&2
      remove_owned_evidence_path "${pending_evidence}" || cleanup_failed=1
    elif [[ "${containers_quiesced}" -eq 1 ]] \
      && [[ -n "${ACTIVE_ANALYZER_FILE}" ]] \
      && [[ -f "${SECRET_SNAPSHOT_FILE}" && ! -L "${SECRET_SNAPSHOT_FILE}" \
        && -f "${BROKER_TOKEN_SNAPSHOT_FILE}" && ! -L "${BROKER_TOKEN_SNAPSHOT_FILE}" ]] \
      && verify_input_snapshot; then
      if remove_run_owned_verification_cache_copy "${pending_evidence}" \
        && scrub_all_bearer_secrets "${pending_evidence}" "${pending_evidence}/abort-secret-scan" "${abort_report}" \
        && verify_input_snapshot; then
        if [[ "${PREFLIGHT_COMPLETED}" -eq 1 ]]; then
          incomplete_dir="${EVIDENCE_ROOT}/${run_id}-preflight-completed"
          publication_suffix='preflight-completed'
        else
          incomplete_dir="${EVIDENCE_ROOT}/${run_id}-incomplete"
          publication_suffix='incomplete'
        fi
        if move_owned_evidence_to_terminal "${pending_evidence}" "${publication_suffix}"; then
          printf 'forge-harness-eval: scrubbed %s evidence retained at %s\n' "${publication_suffix}" "${incomplete_dir}" >&2
        else
          printf 'forge-harness-eval: incomplete evidence could not be published; removing exact owned evidence\n' >&2
          remove_owned_evidence_path "${pending_evidence}" || cleanup_failed=1
        fi
      else
        printf 'forge-harness-eval: run-owned cache-copy cleanup or secret scrub failed; removing exact owned evidence\n' >&2
        remove_owned_evidence_path "${pending_evidence}" || cleanup_failed=1
      fi
    else
      printf 'forge-harness-eval: containers were not proven quiescent or secret scrub failed; removing exact owned evidence instead of retaining unsafe or completed-looking evidence\n' >&2
      remove_owned_evidence_path "${pending_evidence}" || cleanup_failed=1
    fi
  fi
  if [[ "${containers_quiesced}" -ne 1 ]]; then
    for protected_secret in "${SECRET_SNAPSHOT_FILE}" "${BROKER_TOKEN_SNAPSHOT_FILE}"; do
      if [[ -n "${protected_secret}" && -f "${protected_secret}" && ! -L "${protected_secret}" ]]; then
        printf 'forge-harness-eval: SAFETY HOLD: a protected bearer snapshot remains at %s because every exact run-owned container was not proven stopped or absent. Do not copy, inspect, or broadly delete it. Restore Docker control, verify each container bearing com.forge.hbe.run=%s is stopped or absent, then remove only this exact ordinary non-symlink single-link snapshot path. The bearer value is never printed by this runner.\n' \
          "${protected_secret}" "${run_token}" >&2
      fi
    done
  fi
  if [[ "${containers_quiesced}" -eq 1 ]]; then
    for ((index=${#OWNED_NETWORKS[@]}-1; index>=0; index-=1)); do
      remove_owned_network "${OWNED_NETWORKS[index]}" || cleanup_failed=1
    done
    if [[ "${RETAIN_VOLUMES}" -eq 0 ]]; then
      for ((index=${#OWNED_VOLUMES[@]}-1; index>=0; index-=1)); do
        remove_owned_volume "${OWNED_VOLUMES[index]}" || cleanup_failed=1
      done
    fi
    remove_secret_snapshot "${SECRET_SNAPSHOT_FILE}" credential || cleanup_failed=1
    remove_secret_snapshot "${BROKER_TOKEN_SNAPSHOT_FILE}" broker-token || cleanup_failed=1
  fi
  if [[ "${original_exit}" -eq 0 && "${cleanup_failed}" -ne 0 ]]; then original_exit=3; fi
  exit "${original_exit}"
}

trap 'cleanup_owned_resources $?' EXIT
trap 'exit 130' INT TERM

create_owned_volume() {
  probe_resource_state volume "$1" || die "generated volume name could not be proven absent: $1"
  [[ "${RESOURCE_STATE}" == "absent" ]] || die "generated volume name already exists: $1"
  docker volume create --label "com.forge.hbe.run=${run_token}" "$1" >/dev/null
  OWNED_VOLUMES+=("$1")
}

create_owned_network() {
  local name="$1" mode="$2"
  probe_resource_state network "${name}" || die "generated network name could not be proven absent: ${name}"
  [[ "${RESOURCE_STATE}" == "absent" ]] || die "generated network name already exists: ${name}"
  if [[ "${mode}" == "internal" ]]; then
    docker network create --driver bridge --internal --label "com.forge.hbe.run=${run_token}" "${name}" >/dev/null
  elif [[ "${mode}" == "egress" ]]; then
    docker network create --driver bridge --label "com.forge.hbe.run=${run_token}" "${name}" >/dev/null
  else
    die "unknown generated network mode: ${mode}"
  fi
  OWNED_NETWORKS+=("${name}")
}

create_owned_container() {
  local name="$1"
  shift
  probe_resource_state container "${name}" || die "generated container name could not be proven absent: ${name}"
  [[ "${RESOURCE_STATE}" == "absent" ]] || die "generated container name already exists: ${name}"
  docker create --name "${name}" --label "com.forge.hbe.run=${run_token}" "$@" >/dev/null
  OWNED_CONTAINERS+=("${name}")
}

start_capture() {
  local container="$1" stdout_file="$2" stderr_file="$3" exit_code
  set +e
  docker start --attach "${container}" >"${stdout_file}" 2>"${stderr_file}"
  exit_code=$?
  set -e
  printf '%s\n' "${exit_code}"
}

stop_controlled_verification_service_with_evidence() {
  local container="$1" prefix="$2" role="$3" stop_exit logs_exit inspect_exit
  set +e
  stop_owned_container "${container}" >"${prefix}.stop.stdout.txt" 2>"${prefix}.stop.stderr.txt"
  stop_exit=$?
  docker logs "${container}" >"${prefix}.stdout.txt" 2>"${prefix}.stderr.txt"
  logs_exit=$?
  docker container inspect "${container}" >"${prefix}.container.inspect.json" 2>"${prefix}.inspect.stderr.txt"
  inspect_exit=$?
  set -e
  [[ "${stop_exit}" -eq 0 && "${logs_exit}" -eq 0 && "${inspect_exit}" -eq 0 ]] || return 1
  node - "${prefix}.container.inspect.json" "${prefix}.supervision.json" "${container}" "${role}" \
    "${stop_exit}" "${logs_exit}" "${inspect_exit}" <<'NODE'
const fs = require('node:fs');
const [inspectFile, output, expectedName, role, stopExit, logsExit, inspectExit] = process.argv.slice(2);
const inspections = JSON.parse(fs.readFileSync(inspectFile, 'utf8'));
if (!Array.isArray(inspections) || inspections.length !== 1) throw new Error('service inspection closure mismatch');
const item = inspections[0];
if (String(item.Name ?? '').replace(/^\//u, '') !== expectedName || item.State?.Running !== false
  || Number(stopExit) !== 0 || Number(logsExit) !== 0 || Number(inspectExit) !== 0) {
  throw new Error('controlled verification service did not stop cleanly');
}
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 'forge-harness-capability-service-supervision/v1',
  role, containerName: expectedName, requestedStopSucceeded: true,
  containerQuiescenceProvenBeforeEvidence: true,
  stopExitCode: Number(stopExit), logsCollectionExitCode: Number(logsExit),
  inspectionExitCode: Number(inspectExit), containerExitCode: item.State.ExitCode,
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
}

MODEL_ATTACH_EXIT=255
MODEL_TIMEOUT_STATUS="not-started"
MODEL_ELAPSED_SECONDS=0
MODEL_SUPERVISION_STARTED_SECONDS=0

start_capture_with_timeout() {
  local container="$1" stdout_file="$2" stderr_file="$3" timeout_seconds="$4"
  local supervisor_exit started_seconds

  started_seconds="${SECONDS}"
  MODEL_SUPERVISION_STARTED_SECONDS="${started_seconds}"
  set +e
  if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
    MSYS2_ARG_CONV_EXCL='*' timeout --signal=TERM --kill-after="${MODEL_STOP_GRACE_SECONDS}s" \
      "${timeout_seconds}s" docker start --attach "${container}" >"${stdout_file}" 2>"${stderr_file}"
  else
    timeout --signal=TERM --kill-after="${MODEL_STOP_GRACE_SECONDS}s" \
      "${timeout_seconds}s" docker start --attach "${container}" >"${stdout_file}" 2>"${stderr_file}"
  fi
  supervisor_exit=$?
  set -e

  MODEL_ATTACH_EXIT="${supervisor_exit}"
  MODEL_ELAPSED_SECONDS=$((SECONDS - started_seconds))
  case "${supervisor_exit}" in
    124|137)
      if (( MODEL_ELAPSED_SECONDS >= timeout_seconds )); then
        MODEL_TIMEOUT_STATUS="timed-out"
      else
        MODEL_TIMEOUT_STATUS="completed"
      fi
      ;;
    125|126|127) MODEL_TIMEOUT_STATUS="supervisor-failed" ;;
    *) MODEL_TIMEOUT_STATUS="completed" ;;
  esac
}

start_archive_seed() {
  local container="$1" stdout_file="$2" stderr_file="$3" archive_stderr_file="$4"
  local seed_source_path="${5:-${SOURCE_PATH}}"
  local git_exit docker_exit
  local -a pipeline_status
  set +e
  git -c safe.directory="${seed_source_path}" -c core.autocrlf=false -c core.eol=lf -C "${seed_source_path}" \
    archive --format=tar "${REQUIRED_SOURCE_COMMIT}" 2>"${archive_stderr_file}" \
    | docker start --attach --interactive "${container}" >"${stdout_file}" 2>"${stderr_file}"
  pipeline_status=("${PIPESTATUS[@]}")
  git_exit="${pipeline_status[0]:-255}"
  docker_exit="${pipeline_status[1]:-255}"
  set -e
  if [[ "${git_exit}" -eq 0 && "${docker_exit}" -eq 0 ]]; then printf '0\n'; else printf '1\n'; fi
}

create_readonly_workspace_container() {
  local name="$1" workspace_volume="$2" git_metadata_volume="$3" entrypoint="$4"
  shift 4
  local workspace_mount git_mount
  if [[ "${VERIFICATION_MODE}" != 'cache-miss' ]]; then
    workspace_mount="type=bind,src=${workspace_volume},dst=/workspace,readonly"
    git_mount="type=bind,src=${git_metadata_volume},dst=/workspace/.git,readonly"
  else
    workspace_mount="type=volume,src=${workspace_volume},dst=/workspace,readonly,volume-nocopy"
    git_mount="type=volume,src=${git_metadata_volume},dst=/workspace/.git,readonly,volume-nocopy"
  fi
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 256 \
    --user 1000:1000 --workdir /workspace --env GIT_OPTIONAL_LOCKS=0 \
    --mount "${workspace_mount}" \
    --mount "${git_mount}" \
    --entrypoint "${entrypoint}" "${image_id}" "$@"
}

prepare_model_prompt_volume() {
  local stage_name="$1" probe_name="$2" prompt_source_docker="$3" expected_prompt_sha256="$4"
  local stage_receipt="$5" stage_stderr="$6" access_receipt="$7" access_stderr="$8"
  local stage_exit access_exit

  [[ "${expected_prompt_sha256}" =~ ^[0-9a-f]{64}$ ]] || return 1
  create_owned_container "${stage_name}" \
    --network none --read-only --cap-drop ALL --cap-add CHOWN \
    --security-opt no-new-privileges:true --pids-limit 64 --user 0:0 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m,uid=0,gid=0,mode=0700 \
    --env "EXPECTED_PROMPT_SHA256=${expected_prompt_sha256}" \
    --mount "type=bind,src=${prompt_source_docker},dst=/source/prompt.md,readonly" \
    --mount "type=volume,src=${prompt_volume},dst=/prompt,volume-nocopy" \
    --entrypoint /bin/sh "${image_id}" -c '
set -eu
source_sha="$(sha256sum /source/prompt.md | awk '\''{print $1}'\'')"
test "${source_sha}" = "${EXPECTED_PROMPT_SHA256}"
rm -f /prompt/.prompt.md.staging /prompt/prompt.md
umask 077
cp /source/prompt.md /prompt/.prompt.md.staging
destination_sha="$(sha256sum /prompt/.prompt.md.staging | awk '\''{print $1}'\'')"
test "${destination_sha}" = "${EXPECTED_PROMPT_SHA256}"
chmod 0400 /prompt/.prompt.md.staging
chown 1000:1000 /prompt/.prompt.md.staging
mv /prompt/.prompt.md.staging /prompt/prompt.md
test "$(stat -c %u /prompt/prompt.md)" = 1000
test "$(stat -c %g /prompt/prompt.md)" = 1000
test "$(stat -c %a /prompt/prompt.md)" = 400
printf '\''{"schemaVersion":"forge-harness-prompt-stage/v1","transport":"run-owned-docker-volume","sourceSha256":"%s","destinationSha256":"%s","ownerUid":1000,"ownerGid":1000,"mode":"0400"}\n'\'' "${source_sha}" "${destination_sha}"
'
  stage_exit="$(start_capture "${stage_name}" "${stage_receipt}" "${stage_stderr}")"
  remove_owned_container "${stage_name}"
  [[ "${stage_exit}" -eq 0 ]] || return 1

  node - "${stage_receipt}" "${expected_prompt_sha256}" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
if (receipt.schemaVersion !== 'forge-harness-prompt-stage/v1'
  || receipt.transport !== 'run-owned-docker-volume'
  || receipt.sourceSha256 !== expected || receipt.destinationSha256 !== expected
  || receipt.ownerUid !== 1000 || receipt.ownerGid !== 1000 || receipt.mode !== '0400') {
  throw new Error('prompt staging receipt mismatch');
}
NODE

  create_owned_container "${probe_name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --env "EXPECTED_PROMPT_SHA256=${expected_prompt_sha256}" \
    --mount "type=volume,src=${prompt_volume},dst=/eval-prompt,readonly,volume-nocopy" \
    --entrypoint /bin/sh "${image_id}" -c '
set -eu
test -s /eval-prompt/prompt.md
test -r /eval-prompt/prompt.md
actual_sha="$(sha256sum /eval-prompt/prompt.md | awk '\''{print $1}'\'')"
test "${actual_sha}" = "${EXPECTED_PROMPT_SHA256}"
test "$(stat -c %u /eval-prompt/prompt.md)" = 1000
test "$(stat -c %g /eval-prompt/prompt.md)" = 1000
test "$(stat -c %a /eval-prompt/prompt.md)" = 400
printf '\''{"schemaVersion":"forge-harness-prompt-access/v1","network":"none","containerUser":"1000:1000","mountReadOnly":true,"readable":true,"nonEmpty":true,"digestMatches":true,"promptSha256":"%s","hostPathExposedToModel":false}\n'\'' "${actual_sha}"
'
  access_exit="$(start_capture "${probe_name}" "${access_receipt}" "${access_stderr}")"
  remove_owned_container "${probe_name}"
  [[ "${access_exit}" -eq 0 ]] || return 1

  node - "${access_receipt}" "${expected_prompt_sha256}" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
if (receipt.schemaVersion !== 'forge-harness-prompt-access/v1'
  || receipt.network !== 'none' || receipt.containerUser !== '1000:1000'
  || receipt.mountReadOnly !== true || receipt.readable !== true || receipt.nonEmpty !== true
  || receipt.digestMatches !== true || receipt.promptSha256 !== expected
  || receipt.hostPathExposedToModel !== false) {
  throw new Error('prompt access receipt mismatch');
}
NODE
}

inspect_database_continuation_source() {
  node - "${DATABASE_CONTINUATION_SOURCE}" "${DATABASE_CONTINUATION_STATE_SHA256}" \
    "${prompt_file}" "${prompt_relative}" "${REQUIRED_SOURCE_COMMIT}" "${eval_task_id}" \
    "${DATABASE_CONTINUATION_PATCH}" "${DATABASE_CONTINUATION_PATCH_SHA256}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [parentCase, expectedStateSha256, currentPrompt, promptRelative, sourceCommit, taskId, patchFile, patchSha256] = process.argv.slice(2);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function read(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) {
    throw new Error('Database continuation input must be an ordinary bounded file');
  }
  return fs.readFileSync(file);
}


if (fs.realpathSync(parentCase) !== parentCase || path.basename(parentCase) !== 'crud-complete') {
  throw new Error('Database continuation requires the retained original crud-complete case directory');
}
const parentRun = path.dirname(parentCase);
const owner = JSON.parse(read(path.join(parentRun, '.forge-hbe-owner.json')));
const stateBytes = read(path.join(parentCase, 'phase-control/state.json'));
const state = JSON.parse(stateBytes);
const lock = JSON.parse(read(path.join(parentRun, 'inputs/input-lock.json')));
const entry = lock.entries?.find(item => item.path === `suite/${promptRelative}`);
const originalPrompt = read(path.join(parentRun, 'inputs/suite', promptRelative));
if (digest(stateBytes) !== expectedStateSha256 || state.sourceCommit !== sourceCommit
  || state.taskId !== taskId || state.caseFamily !== 'crud-complete'
  || !/^session-[0-9a-f-]{36}$/.test(state.sessionId)
  || owner.schemaVersion !== 'forge-harness-staging-owner/v1' || !/^[0-9a-f]{16}$/.test(owner.runToken)
  || lock.schemaVersion !== 'forge-harness-eval-input-lock/v1' || lock.sourceCommit !== sourceCommit
  || !entry || entry.sha256 !== digest(originalPrompt) || entry.bytes !== originalPrompt.length
  || !originalPrompt.equals(read(currentPrompt)) || digest(read(patchFile)) !== patchSha256) {
  throw new Error('Database continuation source, original request or reviewed patch binding differs');
}
process.stdout.write([state.sessionId, owner.runToken,
  `forge-hbe-${owner.runToken}-crud-complete-dsh-home`].join('\n') + '\n');
NODE
}

inspect_backend_continuation_source() {
  node - "${BACKEND_CONTINUATION_SOURCE}" "${BACKEND_CONTINUATION_BINDINGS}" \
    "${BACKEND_CONTINUATION_BINDINGS_SHA256}" "${prompt_file}" "${prompt_relative}" \
    "${REQUIRED_SOURCE_COMMIT}" "${eval_task_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [parentCase, bindingsFile, expectedBindingsSha, currentPrompt, promptRelative, sourceCommit, taskId] = process.argv.slice(2);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function read(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) {
    throw new Error('Backend continuation input must be an ordinary bounded file');
  }
  return fs.readFileSync(file);
}
if (fs.realpathSync(parentCase) !== parentCase || path.basename(parentCase) !== 'crud-complete') {
  throw new Error('Backend continuation requires the original retained crud-complete case');
}
const parentRun = path.dirname(parentCase);
const owner = JSON.parse(read(path.join(parentRun, '.forge-hbe-owner.json')));
const stateBytes = read(path.join(parentCase, 'phase-control/state.json'));
const state = JSON.parse(stateBytes);
const bindingsBytes = read(bindingsFile);
const bindings = JSON.parse(bindingsBytes);
const lock = JSON.parse(read(path.join(parentRun, 'inputs/input-lock.json')));
const originalPrompt = read(path.join(parentRun, 'inputs/suite', promptRelative));
const entry = lock.entries?.find(item => item.path === `suite/${promptRelative}`);
if (digest(bindingsBytes) !== expectedBindingsSha || digest(stateBytes) !== bindings.sourceStateSha256
  || digest(originalPrompt) !== bindings.originalRequestSha256
  || !originalPrompt.equals(read(currentPrompt))
  || state.sourceCommit !== sourceCommit || state.taskId !== taskId || state.caseFamily !== 'crud-complete'
  || state.currentPhaseId !== 'backend' || state.currentPhaseIndex !== 4
  || !/^session-[0-9a-f-]{36}$/.test(state.sessionId)
  || owner.schemaVersion !== 'forge-harness-staging-owner/v1' || !/^[0-9a-f]{16}$/.test(owner.runToken)
  || lock.schemaVersion !== 'forge-harness-eval-input-lock/v1' || lock.sourceCommit !== sourceCommit
  || !entry || entry.sha256 !== digest(originalPrompt) || entry.bytes !== originalPrompt.length
  || !/^[0-9a-f]{64}$/.test(bindings.evidenceSha256?.['cumulative.patch'])
  || digest(read(path.join(parentCase, 'phases/05-backend/attempts/02/cumulative.patch')))
    !== bindings.evidenceSha256['cumulative.patch']) {
  throw new Error('Backend continuation source, original request or reviewed Host patch binding differs');
}
process.stdout.write([state.sessionId, owner.runToken,
  `forge-hbe-${owner.runToken}-crud-complete-dsh-home`, bindings.evidenceSha256['cumulative.patch']].join('\n') + '\n');
NODE
}
inspect_access_wiring_continuation_source() {
  node - "${ACCESS_WIRING_CONTINUATION_SOURCE}" "${ACCESS_WIRING_CONTINUATION_BINDINGS}" \
    "${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}" "${prompt_file}" "${prompt_relative}" \
    "${REQUIRED_SOURCE_COMMIT}" "${eval_task_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [parentCase, bindingsFile, expectedBindingsSha, currentPrompt, promptRelative, sourceCommit, taskId] = process.argv.slice(2);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, maximum = 16 * 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) {
    throw new Error('Access wiring continuation requires ordinary bounded input files');
  }
  return fs.readFileSync(file);
}
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
if (fs.realpathSync(parentCase) !== parentCase || path.basename(parentCase) !== 'crud-complete') {
  throw new Error('Access wiring continuation requires a retained crud-complete input snapshot');
}
const parentRun = path.dirname(parentCase);
const owner = JSON.parse(read(path.join(parentRun, '.forge-hbe-owner.json')));
const lock = JSON.parse(read(path.join(parentRun, 'inputs/input-lock.json')));
const requestBytes = read(path.join(parentRun, 'inputs/suite', promptRelative));
const entry = lock.entries?.find(item => item.path === `suite/${promptRelative}`);
const stateBytes = read(path.join(parentCase, 'phase-control/state.json'));
const state = JSON.parse(stateBytes);
const bindingsBytes = read(bindingsFile);
const bindings = JSON.parse(bindingsBytes);
const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
  'ui-interaction-contract', 'backend-implementation', 'frontend-implementation'];
const profiles = ['governance', 'frontend-admin-lint', 'frontend-admin-test',
  'frontend-admin-typecheck', 'frontend-admin-build'];
const evidenceNames = ['model.stdout.txt', 'controller-preflight-receipt.json',
  'independent-semantic-review.json', 'all-changed-paths.json', 'phase-changed-paths.json',
  'phase.patch', 'cumulative.patch', 'phase-host-receipts.json', 'controller-cli-receipt.json',
  ...profiles.map(profile => `host-runner/${profile}/host-profile.receipt.json`)];
if (!exact(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
  'artifactSha256', 'evidenceSha256', 'currentPromptSha256'])
  || bindings.schemaVersion !== 'forge-delivery-access-wiring-continuation-bindings/v1'
  || !exact(bindings.artifactSha256, kinds) || !exact(bindings.evidenceSha256, evidenceNames)
  || digest(bindingsBytes) !== expectedBindingsSha
  || digest(stateBytes) !== bindings.sourceStateSha256
  || digest(requestBytes) !== bindings.originalRequestSha256
  || !requestBytes.equals(read(currentPrompt))
  || digest(read(path.join(parentCase, 'phase-control/current-prompt.md'))) !== bindings.currentPromptSha256
  || owner.schemaVersion !== 'forge-harness-staging-owner/v1' || !/^[0-9a-f]{16}$/.test(owner.runToken)
  || lock.schemaVersion !== 'forge-harness-eval-input-lock/v1' || lock.sourceCommit !== sourceCommit
  || !entry || entry.sha256 !== digest(requestBytes) || entry.bytes !== requestBytes.length
  || state.sourceCommit !== sourceCommit || state.taskId !== taskId || state.caseFamily !== 'crud-complete'
  || state.status !== 'active' || state.currentPhaseId !== 'access-wiring' || state.currentPhaseIndex !== 6
  || state.activeAttempt !== null || state.lastExecutionGeneration !== 12
  || Object.keys(state.acceptedArtifacts ?? {}).length !== 6
  || state.history?.filter(item => item.decision === 'accepted').length !== 6
  || state.history?.at(-1)?.phaseId !== 'frontend' || state.history.at(-1).decision !== 'accepted'
  || state.history.at(-1).executionGeneration !== 12
  || !/^session-[0-9a-f-]{36}$/.test(state.sessionId)) {
  throw new Error('Access wiring source, original request, six accepted phases or binding differs');
}
for (const kind of kinds) {
  if (digest(read(path.join(parentCase, 'phase-control/artifacts', `${kind}.json`))) !== bindings.artifactSha256[kind]) {
    throw new Error(`Access wiring inherited artifact differs: ${kind}`);
  }
}
for (const name of evidenceNames) {
  if (digest(read(path.join(parentCase, 'candidate-lint-fixed', name), 256 * 1024 * 1024))
    !== bindings.evidenceSha256[name]) {
    throw new Error(`Access wiring accepted frontend evidence differs: ${name}`);
  }
}
if (process.platform === 'linux') {
  const patchInfo = fs.lstatSync(path.join(parentCase, 'candidate-lint-fixed/cumulative.patch'));
  if (patchInfo.uid !== 0 || (patchInfo.mode & 0o777) !== 0o644) {
    throw new Error('Reviewed cumulative patch must be root-owned and readable only through its bounded model bind');
  }
}
process.stdout.write([state.sessionId, owner.runToken,
  `forge-hbe-${owner.runToken}-crud-complete-dsh-home`, bindings.evidenceSha256['cumulative.patch']].join('\n') + '\n');
NODE
}
inspect_cross_layer_continuation_source() {
  node - "${CROSS_LAYER_CONTINUATION_SOURCE}" "${CROSS_LAYER_CONTINUATION_BINDINGS}" \
    "${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" "${prompt_file}" "${prompt_relative}" \
    "${REQUIRED_SOURCE_COMMIT}" "${eval_task_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [parentCase, bindingsFile, expectedBindingsSha, currentPrompt, promptRelative, sourceCommit, taskId] = process.argv.slice(2);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, maximum = 16 * 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) {
    throw new Error('Cross layer continuation requires ordinary bounded input files');
  }
  return fs.readFileSync(file);
}
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
if (fs.realpathSync(parentCase) !== parentCase || path.basename(parentCase) !== 'crud-complete') {
  throw new Error('Cross layer continuation requires a retained crud-complete input snapshot');
}
const parentRun = path.dirname(parentCase);
const owner = JSON.parse(read(path.join(parentRun, '.forge-hbe-owner.json')));
const lock = JSON.parse(read(path.join(parentRun, 'inputs/input-lock.json')));
const requestBytes = read(path.join(parentRun, 'inputs/suite', promptRelative));
const entry = lock.entries?.find(item => item.path === `suite/${promptRelative}`);
const stateBytes = read(path.join(parentCase, 'phase-control/state.json'));
const state = JSON.parse(stateBytes);
const bindingsBytes = read(bindingsFile);
const bindings = JSON.parse(bindingsBytes);
const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
  'ui-interaction-contract', 'backend-implementation', 'frontend-implementation',
  'access-wiring-implementation'];
const profiles = ['governance', 'backend-module-test'];
const evidenceNames = ['model.stdout.txt', 'controller-preflight-receipt.json',
  'independent-semantic-review.json', 'all-changed-paths.json', 'phase-changed-paths.json',
  'phase.patch', 'cumulative.patch', 'phase-host-receipts.json', 'controller-cli-receipt.json',
  ...profiles.map(profile => `host-runner/${profile}/host-profile.receipt.json`)];
if (!exact(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
  'artifactSha256', 'evidenceSha256', 'currentPromptSha256'])
  || bindings.schemaVersion !== 'forge-delivery-cross-layer-continuation-bindings/v1'
  || !exact(bindings.artifactSha256, kinds) || !exact(bindings.evidenceSha256, evidenceNames)
  || digest(bindingsBytes) !== expectedBindingsSha
  || digest(stateBytes) !== bindings.sourceStateSha256
  || digest(requestBytes) !== bindings.originalRequestSha256
  || !requestBytes.equals(read(currentPrompt))
  || digest(read(path.join(parentCase, 'phase-control/current-prompt.md'))) !== bindings.currentPromptSha256
  || owner.schemaVersion !== 'forge-harness-staging-owner/v1' || !/^[0-9a-f]{16}$/.test(owner.runToken)
  || lock.schemaVersion !== 'forge-harness-eval-input-lock/v1' || lock.sourceCommit !== sourceCommit
  || !entry || entry.sha256 !== digest(requestBytes) || entry.bytes !== requestBytes.length
  || state.sourceCommit !== sourceCommit || state.taskId !== taskId || state.caseFamily !== 'crud-complete'
  || state.status !== 'active' || state.currentPhaseId !== 'cross-layer-acceptance' || state.currentPhaseIndex !== 7
  || state.activeAttempt !== null || state.lastExecutionGeneration !== 14
  || Object.keys(state.acceptedArtifacts ?? {}).length !== 7
  || state.history?.filter(item => item.decision === 'accepted').length !== 7
  || state.history?.at(-1)?.phaseId !== 'access-wiring' || state.history.at(-1).decision !== 'accepted'
  || state.history.at(-1).executionGeneration !== 14
  || !/^session-[0-9a-f-]{36}$/.test(state.sessionId)) {
  throw new Error('Cross layer source, original request, seven accepted phases or binding differs');
}
for (const kind of kinds) {
  if (digest(read(path.join(parentCase, 'phase-control/artifacts', `${kind}.json`))) !== bindings.artifactSha256[kind]) {
    throw new Error(`Cross layer inherited artifact differs: ${kind}`);
  }
}
for (const name of evidenceNames) {
  if (digest(read(path.join(parentCase, 'phases/07-access-wiring/attempts/02', name), 256 * 1024 * 1024))
    !== bindings.evidenceSha256[name]) {
    throw new Error(`Cross layer accepted access wiring evidence differs: ${name}`);
  }
}
if (process.platform === 'linux') {
  const patchInfo = fs.lstatSync(path.join(parentCase, 'phases/07-access-wiring/attempts/02/cumulative.patch'));
  if (patchInfo.uid !== 0 || (patchInfo.mode & 0o777) !== 0o644) {
    throw new Error('Reviewed cumulative patch must be root-owned and readable only through its bounded model bind');
  }
}
process.stdout.write([state.sessionId, owner.runToken,
  `forge-hbe-${owner.runToken}-crud-complete-dsh-home`, bindings.evidenceSha256['cumulative.patch']].join('\n') + '\n');
NODE
}
inspect_frontend_retry_source() {
  node - "${FRONTEND_RETRY_SOURCE}" "${FRONTEND_RETRY_BINDINGS}" \
    "${FRONTEND_RETRY_BINDINGS_SHA256}" "${prompt_file}" "${prompt_relative}" \
    "${REQUIRED_SOURCE_COMMIT}" "${eval_task_id}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [parentCase, bindingsFile, expectedBindingsSha, currentPrompt, promptRelative, sourceCommit, taskId] = process.argv.slice(2);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, maximum = 16 * 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) {
    throw new Error('Frontend retry input must be an ordinary bounded file');
  }
  return fs.readFileSync(file);
}
if (fs.realpathSync(parentCase) !== parentCase || path.basename(parentCase) !== 'crud-complete') {
  throw new Error('Frontend retry requires the retained original crud-complete case');
}
const parentRun = path.dirname(parentCase);
const owner = JSON.parse(read(path.join(parentRun, '.forge-hbe-owner.json')));
const lock = JSON.parse(read(path.join(parentRun, 'inputs/input-lock.json')));
const requestBytes = read(path.join(parentRun, 'inputs/suite', promptRelative));
const entry = lock.entries?.find(item => item.path === `suite/${promptRelative}`);
const stateBytes = read(path.join(parentCase, 'phase-control/state.json'));
const state = JSON.parse(stateBytes);
const bindingsBytes = read(bindingsFile);
const bindings = JSON.parse(bindingsBytes);
const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
  'ui-interaction-contract', 'backend-implementation'];
const evidenceNames = ['model.stdout.txt', 'controller-preflight-receipt.json',
  'independent-semantic-review.json', 'before-snapshot.json', 'all-changed-paths.json',
  'phase-changed-paths.json', 'phase.patch', 'cumulative.patch'];
const evidenceDir = path.join(parentCase, 'phases/06-frontend/attempts/01');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
if (!exact(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
  'artifactSha256', 'currentPromptSha256', 'evidenceSha256'])
  || bindings.schemaVersion !== 'forge-delivery-frontend-retry-bindings/v1'
  || !exact(bindings.artifactSha256, kinds) || !exact(bindings.evidenceSha256, evidenceNames)
  || digest(bindingsBytes) !== expectedBindingsSha
  || digest(stateBytes) !== bindings.sourceStateSha256
  || digest(requestBytes) !== bindings.originalRequestSha256
  || !requestBytes.equals(read(currentPrompt))
  || digest(read(path.join(parentCase, 'phase-control/current-prompt.md'))) !== bindings.currentPromptSha256
  || owner.schemaVersion !== 'forge-harness-staging-owner/v1' || !/^[0-9a-f]{16}$/.test(owner.runToken)
  || lock.schemaVersion !== 'forge-harness-eval-input-lock/v1' || lock.sourceCommit !== sourceCommit
  || !entry || entry.sha256 !== digest(requestBytes) || entry.bytes !== requestBytes.length
  || state.sourceCommit !== sourceCommit || state.taskId !== taskId || state.caseFamily !== 'crud-complete'
  || state.status !== 'active' || state.currentPhaseId !== 'frontend' || state.currentPhaseIndex !== 5
  || state.activeAttempt?.phaseId !== 'frontend' || state.activeAttempt?.phaseIndex !== 5
  || state.history?.filter(item => item.decision === 'accepted').length !== 5
  || state.history?.some(item => item.decision === 'rejected' && item.phaseId === 'frontend')
  || !/^session-[0-9a-f-]{36}$/.test(state.sessionId)) {
  throw new Error('Frontend retry source, original request, active FE01 or binding differs');
}
for (const kind of kinds) {
  if (digest(read(path.join(parentCase, 'phase-control/artifacts', `${kind}.json`))) !== bindings.artifactSha256[kind]) {
    throw new Error(`Frontend retry upstream artifact differs: ${kind}`);
  }
}
for (const name of evidenceNames) {
  if (digest(read(path.join(evidenceDir, name), 256 * 1024 * 1024)) !== bindings.evidenceSha256[name]) {
    throw new Error(`Frontend retry FE01 evidence differs: ${name}`);
  }
}
if (process.platform === 'linux') {
  const patchInfo = fs.lstatSync(path.join(evidenceDir, 'cumulative.patch'));
  if (patchInfo.uid !== 0 || (patchInfo.mode & 0o777) !== 0o644) {
    throw new Error('Reviewed FE01 patch must be root-owned and readable only through its bounded model bind');
  }
}
const review = JSON.parse(read(path.join(evidenceDir, 'independent-semantic-review.json')));
const preflight = JSON.parse(read(path.join(evidenceDir, 'controller-preflight-receipt.json')));
if (review.verdict !== 'reject' || review.subject?.phaseId !== 'frontend'
  || review.subject.responseSha256 !== bindings.evidenceSha256['model.stdout.txt']
  || review.subject.candidateArtifactDigest !== preflight.candidateArtifactDigest
  || preflight.phaseAttemptId !== state.activeAttempt.attemptId) {
  throw new Error('Frontend retry requires the original rejected FE01 review and preflight');
}
process.stdout.write([state.sessionId, owner.runToken,
  `forge-hbe-${owner.runToken}-crud-complete-dsh-home`,
  bindings.evidenceSha256['cumulative.patch']].join('\n') + '\n');
NODE
}
copy_database_continuation_session() {
  local name="${resource_prefix}-session-copy"
  [[ "$(docker volume inspect --format '{{index .Labels "com.forge.hbe.run"}}' "${database_parent_dsh_volume}")" == "${database_parent_run_token}" ]] \
    || die 'database continuation parent session volume ownership differs'
  # Only the one retained session crosses to the new run. The original volume is read-only.
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true --pids-limit 64 --user 0:0 \
    --mount "type=volume,src=${database_parent_dsh_volume},dst=/parent-dsh,readonly,volume-nocopy" \
    --mount "type=volume,src=${dsh_home_volume},dst=/new-dsh,volume-nocopy" \
    --env "CONTINUATION_SESSION_ID=${eval_headless_session_id}" \
    --entrypoint /usr/local/bin/node "${image_id}" -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sessionId = process.env.CONTINUATION_SESSION_ID;
if (!/^session-[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid retained session identity");
const relative = "sessions/--workspace--/" + sessionId;
const source = "/parent-dsh/" + relative;
const target = "/new-dsh/" + relative;
function inventory(root) {
  const files = [];
  let total = 0;
  function walk(directory) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Session directory must be ordinary");
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const item = fs.lstatSync(file);
      if (item.isDirectory() && !item.isSymbolicLink()) walk(file);
      else {
        total += item.size;
        if (!item.isFile() || item.nlink !== 1 || files.length >= 1000 || total > 128 * 1024 * 1024) throw new Error("Invalid retained session file");
        files.push({ path: path.relative(root, file), bytes: item.size,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
      }
    }
  }
  walk(root);
  if (!files.some(file => file.path === "session.jsonl" && file.bytes > 0)) throw new Error("Retained session.jsonl is missing");
  return files;
}
const files = inventory(source);
if (fs.existsSync(target)) throw new Error("Destination session already exists");
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
for (const file of files) {
  const destination = path.join(target, file.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, fs.readFileSync(path.join(source, file.path)), { flag: "wx", mode: 0o600 });
}
if (JSON.stringify(inventory(source)) !== JSON.stringify(files)
  || JSON.stringify(inventory(target)) !== JSON.stringify(files)) throw new Error("Session changed during copy");
process.stdout.write(JSON.stringify({ schemaVersion: "forge-harness-database-session-copy/v1",
  sessionId, files, sourceReadOnly: true, sourceUnchanged: true, copiedToNewRun: true }) + "\n");
'
  local exit_code
  exit_code="$(start_capture "${name}" "${case_dir}/database-session-copy.json" "${case_dir}/database-session-copy.stderr.txt")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

restore_database_continuation_patch() {
  local name="${resource_prefix}-database-patch"
  local patch_copy="${phase_dir}/database-candidate.patch"
  node - "${DATABASE_CONTINUATION_PATCH}" "${DATABASE_CONTINUATION_PATCH_SHA256}" "${patch_copy}" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [source, expected, destination] = process.argv.slice(2);
const bytes = fs.readFileSync(source);
if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Reviewed database patch changed');
fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
if (process.getuid?.() === 0) fs.chownSync(destination, 1000, 1000);
NODE
  [[ "$?" -eq 0 ]] || return 1
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --mount "${model_workspace_mount}" --mount "${model_git_mount}" \
    --mount "type=bind,src=$(docker_host_path "${patch_copy}"),dst=/database.patch,readonly" \
    --entrypoint /usr/bin/git "${image_id}" -C /workspace apply --whitespace=error /database.patch
  local exit_code
  exit_code="$(start_capture "${name}" "${phase_dir}/database-patch.stdout.txt" "${phase_dir}/database-patch.stderr.txt")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]] || return 1
  [[ "$(sha256_file "${DATABASE_CONTINUATION_PATCH}")" == "${DATABASE_CONTINUATION_PATCH_SHA256}" ]] || return 1
  node - "${phase_dir}/database-patch-restored.json" "${DATABASE_CONTINUATION_PATCH_SHA256}" <<'NODE'
const fs = require('node:fs');
const [file, patchSha256] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'forge-harness-database-patch-restore/v1',
  patchSha256, restoredAfterPhaseBaselineSnapshot: true, operatorRestoredCandidate: true,
  newlyGeneratedByCurrentModel: false, phaseAccepted: false }) + '\n', { flag: 'wx', mode: 0o600 });
NODE
}

restore_backend_continuation_patch() {
  local patch_file="${BACKEND_CONTINUATION_SOURCE}/phases/05-backend/attempts/02/cumulative.patch"
  local name="${resource_prefix}-backend-patch"
  [[ "$(sha256_file "${patch_file}")" == "${BACKEND_CONTINUATION_PATCH_SHA256}" ]] || return 1
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --mount "${model_workspace_mount}" --mount "${model_git_mount}" \
    --mount "type=bind,src=$(docker_host_path "${patch_file}"),dst=/backend.patch,readonly" \
    --entrypoint /usr/bin/git "${image_id}" -C /workspace apply --whitespace=error /backend.patch
  local exit_code
  exit_code="$(start_capture "${name}" "${phase_dir}/backend-patch.stdout.txt" "${phase_dir}/backend-patch.stderr.txt")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]] || return 1
  [[ "$(sha256_file "${patch_file}")" == "${BACKEND_CONTINUATION_PATCH_SHA256}" ]] || return 1
  node - "${phase_dir}/backend-patch-restored.json" "${BACKEND_CONTINUATION_PATCH_SHA256}" <<'NODE'
const fs = require('node:fs');
const [file, patchSha256] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'forge-harness-backend-patch-restore/v1',
  patchSha256, restoredBeforeFrontendBaselineSnapshot: true, operatorRestoredAcceptedCandidate: true,
  newlyGeneratedByCurrentModel: false }) + '\n', { flag: 'wx', mode: 0o600 });
NODE
}
restore_access_wiring_continuation_patch() {
  local patch_file="${ACCESS_WIRING_CONTINUATION_SOURCE}/candidate-lint-fixed/cumulative.patch"
  local name="${resource_prefix}-access-wiring-patch"
  [[ "$(sha256_file "${patch_file}")" == "${ACCESS_WIRING_CONTINUATION_PATCH_SHA256}" ]] || return 1
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --mount "${model_workspace_mount}" --mount "${model_git_mount}" \
    --mount "type=bind,src=$(docker_host_path "${patch_file}"),dst=/accepted.patch,readonly" \
    --entrypoint /usr/bin/git "${image_id}" -C /workspace apply --whitespace=error /accepted.patch
  local exit_code
  exit_code="$(start_capture "${name}" "${phase_dir}/accepted-patch.stdout.txt" "${phase_dir}/accepted-patch.stderr.txt")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]] || return 1
  [[ "$(sha256_file "${patch_file}")" == "${ACCESS_WIRING_CONTINUATION_PATCH_SHA256}" ]] || return 1
  node - "${phase_dir}/accepted-patch-restored.json" "${ACCESS_WIRING_CONTINUATION_PATCH_SHA256}" <<'NODE'
const fs = require('node:fs');
const [file, patchSha256] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'forge-harness-access-wiring-patch-restore/v1',
  patchSha256, restoredBeforeAccessWiringBaselineSnapshot: true, operatorRestoredAcceptedCandidate: true,
  newlyGeneratedByCurrentModel: false }) + '\n', { flag: 'wx', mode: 0o600 });
NODE
}
restore_cross_layer_continuation_patch() {
  local patch_file="${CROSS_LAYER_CONTINUATION_SOURCE}/phases/07-access-wiring/attempts/02/cumulative.patch"
  local name="${resource_prefix}-cross-layer-patch"
  [[ "$(sha256_file "${patch_file}")" == "${CROSS_LAYER_CONTINUATION_PATCH_SHA256}" ]] || return 1
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --mount "${model_workspace_mount}" --mount "${model_git_mount}" \
    --mount "type=bind,src=$(docker_host_path "${patch_file}"),dst=/accepted.patch,readonly" \
    --entrypoint /usr/bin/git "${image_id}" -C /workspace apply --whitespace=error /accepted.patch
  local exit_code
  exit_code="$(start_capture "${name}" "${phase_dir}/accepted-patch.stdout.txt" "${phase_dir}/accepted-patch.stderr.txt")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]] || return 1
  [[ "$(sha256_file "${patch_file}")" == "${CROSS_LAYER_CONTINUATION_PATCH_SHA256}" ]] || return 1
  node - "${phase_dir}/accepted-patch-restored.json" "${CROSS_LAYER_CONTINUATION_PATCH_SHA256}" <<'NODE'
const fs = require('node:fs');
const [file, patchSha256] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'forge-harness-cross-layer-patch-restore/v1',
  patchSha256, restoredBeforeCrossLayerBaselineSnapshot: true, operatorRestoredAcceptedCandidate: true,
  newlyGeneratedByCurrentModel: false }) + '\n', { flag: 'wx', mode: 0o600 });
NODE
}
restore_frontend_retry_patch() {
  local patch_file="${FRONTEND_RETRY_SOURCE}/phases/06-frontend/attempts/01/cumulative.patch"
  local name="${resource_prefix}-frontend-retry-patch"
  [[ "$(sha256_file "${patch_file}")" == "${FRONTEND_RETRY_PATCH_SHA256}" ]] || return 1
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --mount "${model_workspace_mount}" --mount "${model_git_mount}" \
    --mount "type=bind,src=$(docker_host_path "${patch_file}"),dst=/frontend-retry.patch,readonly" \
    --entrypoint /usr/bin/git "${image_id}" -C /workspace apply --whitespace=error /frontend-retry.patch
  local exit_code
  exit_code="$(start_capture "${name}" "${phase_dir}/frontend-retry-patch.stdout.txt" "${phase_dir}/frontend-retry-patch.stderr.txt")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]] || return 1
  [[ "$(sha256_file "${patch_file}")" == "${FRONTEND_RETRY_PATCH_SHA256}" ]] || return 1
  node - "${phase_dir}/frontend-retry-patch-restored.json" "${FRONTEND_RETRY_PATCH_SHA256}" <<'NODE'
const fs = require('node:fs');
const [file, patchSha256] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'forge-harness-frontend-retry-patch-restore/v1',
  patchSha256, restoredBeforeFE02Model: true, inheritedFE01SourceEdits: true,
  newlyGeneratedByCurrentModel: false }) + '\n', { flag: 'wx', mode: 0o600 });
NODE
}

run_phase_controller_initialize() {
  local name="$1" stdout_file="$2" stderr_file="$3"
  local -a controller_mounts controller_args
  if [[ -n "${DATABASE_CONTINUATION_SOURCE}" ]]; then
    controller_mounts=(
      --mount "type=bind,src=$(docker_host_path "${DATABASE_CONTINUATION_SOURCE}"),dst=/parent-case,readonly"
      --mount "type=bind,src=$(docker_host_path "${case_dir}"),dst=/case-evidence"
    )
    controller_args=(prepare-database-continuation
      --catalog-file /phase-catalog.json --source-commit "${REQUIRED_SOURCE_COMMIT}"
      --source-state-file /parent-case/phase-control/state.json
      --expected-source-state-sha256 "${DATABASE_CONTINUATION_STATE_SHA256}"
      --source-artifacts-directory /parent-case/phase-control/artifacts
      --original-request-file /original-request.md --output-directory /case-evidence/phase-control)
  elif [[ -n "${BACKEND_CONTINUATION_SOURCE}" ]]; then
    controller_mounts=(
      --mount "type=bind,src=$(docker_host_path "${BACKEND_CONTINUATION_SOURCE}"),dst=/parent-case,readonly"
      --mount "type=bind,src=$(docker_host_path "${BACKEND_CONTINUATION_BINDINGS}"),dst=/backend-bindings.json,readonly"
      --mount "type=bind,src=$(docker_host_path "${case_dir}"),dst=/case-evidence"
    )
    controller_args=(prepare-backend-finalized-continuation
      --catalog-file /phase-catalog.json --source-commit "${REQUIRED_SOURCE_COMMIT}"
      --source-case-directory /parent-case --bindings-file /backend-bindings.json
      --expected-bindings-sha256 "${BACKEND_CONTINUATION_BINDINGS_SHA256}"
      --original-request-file /original-request.md --output-directory /case-evidence)
  elif [[ -n "${FRONTEND_RETRY_SOURCE}" ]]; then
    controller_mounts=(
      --mount "type=bind,src=$(docker_host_path "${FRONTEND_RETRY_SOURCE}"),dst=/parent-case,readonly"
      --mount "type=bind,src=$(docker_host_path "${FRONTEND_RETRY_BINDINGS}"),dst=/frontend-retry-bindings.json,readonly"
      --mount "type=bind,src=$(docker_host_path "${case_dir}"),dst=/case-evidence"
    )
    controller_args=(prepare-frontend-retry-continuation
      --catalog-file /phase-catalog.json --source-commit "${REQUIRED_SOURCE_COMMIT}"
      --source-case-directory /parent-case --bindings-file /frontend-retry-bindings.json
      --expected-bindings-sha256 "${FRONTEND_RETRY_BINDINGS_SHA256}"
      --original-request-file /original-request.md --output-directory /case-evidence)
  elif [[ -n "${ACCESS_WIRING_CONTINUATION_SOURCE}" ]]; then
    controller_mounts=(
      --mount "type=bind,src=$(docker_host_path "${ACCESS_WIRING_CONTINUATION_SOURCE}"),dst=/parent-case,readonly"
      --mount "type=bind,src=$(docker_host_path "${ACCESS_WIRING_CONTINUATION_BINDINGS}"),dst=/access-wiring-bindings.json,readonly"
      --mount "type=bind,src=$(docker_host_path "${case_dir}"),dst=/case-evidence"
    )
    controller_args=(prepare-access-wiring-continuation
      --catalog-file /phase-catalog.json --source-commit "${REQUIRED_SOURCE_COMMIT}"
      --source-case-directory /parent-case --bindings-file /access-wiring-bindings.json
      --expected-bindings-sha256 "${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}"
      --original-request-file /original-request.md --output-directory /case-evidence)
  elif [[ -n "${CROSS_LAYER_CONTINUATION_SOURCE}" ]]; then
    controller_mounts=(
      --mount "type=bind,src=$(docker_host_path "${CROSS_LAYER_CONTINUATION_SOURCE}"),dst=/parent-case,readonly"
      --mount "type=bind,src=$(docker_host_path "${CROSS_LAYER_CONTINUATION_BINDINGS}"),dst=/cross-layer-bindings.json,readonly"
      --mount "type=bind,src=$(docker_host_path "${case_dir}"),dst=/case-evidence"
    )
    controller_args=(prepare-cross-layer-continuation
      --catalog-file /phase-catalog.json --source-commit "${REQUIRED_SOURCE_COMMIT}"
      --source-case-directory /parent-case --bindings-file /cross-layer-bindings.json
      --expected-bindings-sha256 "${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}"
      --original-request-file /original-request.md --output-directory /case-evidence)
  else
    controller_mounts=(--mount "type=bind,src=${phase_control_docker_path},dst=/phase-control")
    controller_args=(initialize --catalog-file /phase-catalog.json --workflow-id "${phase_workflow_id}"
      --case-family "${case_id}" --task-id "${eval_task_id}"
      --session-id "${eval_headless_session_id}" --source-commit "${REQUIRED_SOURCE_COMMIT}"
      --original-request-file /original-request.md --state-file /phase-control/state.json
      --artifacts-directory /phase-control/artifacts --prompt-file /phase-control/current-prompt.md
      --receipt-file /phase-control/initialize-receipt.json)
  fi
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 0:0 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=0,gid=0,mode=0700 \
    --mount "type=bind,src=${RUNTIME_TOOLS_DOCKER_PATH},dst=/forge-runtime,readonly" \
    --mount "type=bind,src=${phase_catalog_docker_path},dst=/phase-catalog.json,readonly" \
    --mount "type=bind,src=${prompt_file_docker},dst=/original-request.md,readonly" \
    "${controller_mounts[@]}" \
    --entrypoint /usr/local/bin/node "${image_id}" /forge-runtime/forge-delivery-phase-controller.mjs "${controller_args[@]}"
  local exit_code
  exit_code="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

run_phase_prepare() {
  local name="$1" phase_id="$2" rpc_id="$3" phase_dir_docker="$4" stdout_file="$5" stderr_file="$6"
  local prepare_policy_file="${stdout_file%/*}/prepare-execution-policy.json"
  local prepare_policy_docker="${phase_dir_docker}/prepare-execution-policy.json"
  # Only this non-secret policy copy crosses into the TaskSpace owner's prepare process.
  node - "${ACTIVE_EXECUTION_POLICY_FILE}" "${prepare_policy_file}" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [source, destination] = process.argv.slice(2);
const bytes = fs.readFileSync(source);
fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
const digest = value => createHash('sha256').update(value).digest('hex');
if (digest(fs.readFileSync(destination)) !== digest(bytes)
  || digest(fs.readFileSync(source)) !== digest(bytes)) {
  throw new Error('phase prepare policy copy does not match the frozen input');
}
NODE
  [[ "$?" -eq 0 ]] || return 1
  # Pre-create both narrowly mounted helpers before handing off any control state.
  create_owned_container "${name}-owner-handoff" \
    --network none --read-only --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
    --pids-limit 64 --user 0:0 \
    --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control" \
    --mount "type=bind,src=${prepare_policy_docker},dst=/prepare-execution-policy.json" \
    --env "FORGE_EVAL_PHASE_ID=${phase_id}" \
    --entrypoint /usr/local/bin/node "${image_id}" -e '
const fs = require("node:fs");
const directory = "/phase-control";
const files = [directory + "/state.json", directory + "/current-prompt.md"];
const info = fs.lstatSync(directory);
if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o700) throw new Error("phase control owner or mode mismatch");
for (const file of files) {
  const item = fs.lstatSync(file);
  if (!item.isFile() || item.nlink !== 1 || item.uid !== 0 || item.gid !== 0 || (item.mode & 0o777) !== 0o600) throw new Error("phase control file owner or mode mismatch");
}
const state = JSON.parse(fs.readFileSync(files[0], "utf8"));
const rejection = state.history?.at(-1);
if (state.status === "active" && state.activeAttempt === null
  && state.currentPhaseId === process.env.FORGE_EVAL_PHASE_ID
  && rejection?.decision === "rejected" && rejection.phaseId === state.currentPhaseId
  && (rejection.reasonCode?.startsWith("SEMANTIC_")
    || rejection.reasonCode === "FORMAT_UNEXPECTED_PAYLOAD_KEYS"
    || rejection.reasonCode === "FORMAT_INVALID_PROPOSAL_JSON")) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rejection.attemptId)) throw new Error("invalid rejected attempt id");
  files.push(directory + "/current-prompt.md." + rejection.attemptId + ".retry-receipt.json");
  const receipt = fs.lstatSync(files.at(-1));
  if (!receipt.isFile() || receipt.nlink !== 1 || receipt.uid !== 0 || receipt.gid !== 0 || (receipt.mode & 0o777) !== 0o600) throw new Error("phase retry receipt owner or mode mismatch");
}
const policy = "/prepare-execution-policy.json";
const policyInfo = fs.lstatSync(policy);
if (!policyInfo.isFile() || policyInfo.nlink !== 1) throw new Error("phase prepare policy must be an ordinary private copy");
fs.chownSync(policy, 0, 0);
fs.chmodSync(policy, 0o400);
fs.chownSync(policy, 1000, 1000);
for (const file of files) fs.chownSync(file, 1000, 1000);
fs.chownSync(directory, 1000, 1000);
'
  create_owned_container "${name}-owner-restore" \
    --network none --read-only --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
    --pids-limit 64 --user 0:0 \
    --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control" \
    --env "FORGE_EVAL_PHASE_ID=${phase_id}" \
    --entrypoint /usr/local/bin/node "${image_id}" -e '
const fs = require("node:fs");
const directory = "/phase-control";
const info = fs.lstatSync(directory);
if (!info.isDirectory() || ![0, 1000].includes(info.uid) || info.gid !== info.uid || (info.mode & 0o777) !== 0o700) throw new Error("phase control restore directory mismatch");
// Reclaim traversal first; state.json may have been atomically replaced by prepare.
fs.chownSync(directory, 0, 0);
const files = [directory + "/state.json", directory + "/current-prompt.md"];
for (const file of files) {
  const item = fs.lstatSync(file);
  if (!item.isFile() || item.nlink !== 1 || ![0, 1000].includes(item.uid) || item.gid !== item.uid || (item.mode & 0o777) !== 0o600) throw new Error("phase control restore file mismatch");
}
// Reclaim state before reading it under CHOWN-only capabilities.
fs.chownSync(files[0], 0, 0);
const state = JSON.parse(fs.readFileSync(files[0], "utf8"));
const rejection = state.history?.at(-1);
if (state.status === "active" && state.currentPhaseId === process.env.FORGE_EVAL_PHASE_ID
  && rejection?.decision === "rejected" && rejection.phaseId === state.currentPhaseId
  && (rejection.reasonCode?.startsWith("SEMANTIC_")
    || rejection.reasonCode === "FORMAT_UNEXPECTED_PAYLOAD_KEYS"
    || rejection.reasonCode === "FORMAT_INVALID_PROPOSAL_JSON")) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rejection.attemptId)) throw new Error("invalid rejected attempt id");
  files.push(directory + "/current-prompt.md." + rejection.attemptId + ".retry-receipt.json");
  const receipt = fs.lstatSync(files.at(-1));
  if (!receipt.isFile() || receipt.nlink !== 1 || ![0, 1000].includes(receipt.uid) || receipt.gid !== receipt.uid || (receipt.mode & 0o777) !== 0o600) throw new Error("phase retry receipt restore mismatch");
}
for (const file of files.slice(1)) fs.chownSync(file, 0, 0);
'
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 1000:1000 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700 \
    --mount "${seed_control_mount}" \
    --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control" \
    --mount "type=bind,src=${phase_catalog_docker_path},dst=/phase-catalog.json,readonly" \
    --mount "type=bind,src=${prepare_policy_docker},dst=/execution-policy.json,readonly" \
    --mount "type=bind,src=${phase_dir_docker},dst=/phase-evidence" \
    --env "FORGE_EVAL_PROJECT_ROOT=${case_runtime_daemon}" \
    --env "PROJECT_SLUG=${eval_project_slug}" \
    --env "FORGE_TASKSPACE_ID=${eval_task_id}" \
    --env "FORGE_TASKSPACE_ACTOR_ID=${eval_actor_id}" \
    --env "FORGE_TASKSPACE_ACTOR_USER_ID=${eval_actor_user_id}" \
    --env "FORGE_TASKSPACE_CONVERSATION_ID=${eval_conversation_id}" \
    --env "FORGE_PROTECTED_HEADLESS_SESSION_ID=${eval_headless_session_id}" \
    --env "FORGE_PROTECTED_HEADLESS_RPC_ID=${rpc_id}" \
    --env "FORGE_EVAL_SOURCE_COMMIT=${REQUIRED_SOURCE_COMMIT}" \
    --env "FORGE_EVAL_CASE_FAMILY=${case_id}" \
    --env FORGE_EVAL_PROMPT_FILE=/phase-control/current-prompt.md \
    --env FORGE_EXECUTION_POLICY_FILE=/execution-policy.json \
    --env "FORGE_EVAL_PHASE_WORKFLOW_ID=${phase_workflow_id}" \
    --env "FORGE_EVAL_PHASE_ID=${phase_id}" \
    --env FORGE_EVAL_PHASE_CATALOG_FILE=/phase-catalog.json \
    --env FORGE_EVAL_PHASE_STATE_FILE=/phase-control/state.json \
    --entrypoint /bin/sh "${image_id}" -c \
      'set -eu; node /usr/local/lib/forge-prepare-headless-execution.mjs > /phase-evidence/execution-receipt.json'
  docker container inspect "${name}-owner-handoff" "${name}-owner-restore" "${name}" >/dev/null || return 1
  # The scoped EXIT handler also restores ownership on prepare failure or interruption.
  # Containers are already registered in the parent shell for normal run cleanup.
  (
    trap '
      prepare_exit=$?
      trap - EXIT
      trap "" INT TERM
      remove_owned_container "${name}-owner-handoff" || exit 1
      remove_owned_container "${name}" || exit 1
      restore_exit="$(start_capture "${name}-owner-restore" "${stdout_file}.owner-restore" "${stderr_file}.owner-restore")" || exit 1
      remove_owned_container "${name}-owner-restore" || exit 1
      [[ "${restore_exit}" -eq 0 ]] || exit "${restore_exit}"
      exit "${prepare_exit}"
    ' EXIT
    trap 'exit 130' INT TERM
    handoff_exit="$(start_capture "${name}-owner-handoff" "${stdout_file}.owner-handoff" "${stderr_file}.owner-handoff")" || exit 1
    [[ "${handoff_exit}" -eq 0 ]] || exit "${handoff_exit}"
    prepare_exit="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")" || exit 1
    exit "${prepare_exit}"
  )
}

run_phase_workspace_snapshot() {
  local name="$1" phase_dir_docker="$2" stdout_file="$3" stderr_file="$4"
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 1000:1000 --workdir /workspace --env GIT_OPTIONAL_LOCKS=0 \
    --mount "${observer_workspace_mount}" --mount "${observer_git_mount}" \
    --mount "type=bind,src=${RUNTIME_TOOLS_DOCKER_PATH},dst=/forge-runtime,readonly" \
    --mount "type=bind,src=${phase_dir_docker},dst=/phase-evidence" \
    --entrypoint /usr/local/bin/node "${image_id}" \
      /forge-runtime/forge-delivery-phase-workspace-observer.mjs snapshot \
      --workspace /workspace --base-commit "${REQUIRED_SOURCE_COMMIT}" \
      --output /phase-evidence/before-snapshot.json
  local exit_code
  exit_code="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

run_phase_workspace_observation() {
  local name="$1" phase_dir_docker="$2" stdout_file="$3" stderr_file="$4"
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 1000:1000 --workdir /workspace --env GIT_OPTIONAL_LOCKS=0 \
    --mount "${observer_workspace_mount}" --mount "${observer_git_mount}" \
    --mount "type=bind,src=${RUNTIME_TOOLS_DOCKER_PATH},dst=/forge-runtime,readonly" \
    --mount "type=bind,src=${phase_dir_docker},dst=/phase-evidence" \
    --entrypoint /usr/local/bin/node "${image_id}" \
      /forge-runtime/forge-delivery-phase-workspace-observer.mjs observe \
      --workspace /workspace --base-commit "${REQUIRED_SOURCE_COMMIT}" \
      --before /phase-evidence/before-snapshot.json \
      --output /phase-evidence/after-snapshot.json \
      --all-changed-paths /phase-evidence/all-changed-paths.json \
      --phase-changed-paths /phase-evidence/phase-changed-paths.json \
      --phase-patch /phase-evidence/phase.patch \
      --cumulative-patch /phase-evidence/cumulative.patch
  local exit_code
  exit_code="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

run_phase_controller_preflight() {
  local name="$1" phase_dir_docker="$2" stdout_file="$3" stderr_file="$4"
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 0:0 --group-add "${PHASE_EVIDENCE_CONSUMER_GID}" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=0,gid=0,mode=0700 \
    --mount "type=bind,src=${RUNTIME_TOOLS_DOCKER_PATH},dst=/forge-runtime,readonly" \
    --mount "type=bind,src=${phase_catalog_docker_path},dst=/phase-catalog.json,readonly" \
    --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control" \
    --mount "type=bind,src=${phase_dir_docker},dst=/phase-evidence" \
    --entrypoint /usr/local/bin/node "${image_id}" /forge-runtime/forge-delivery-phase-controller.mjs preflight \
      --catalog-file /phase-catalog.json --state-file /phase-control/state.json \
      --artifacts-directory /phase-control/artifacts \
      --response-file /phase-evidence/model.stdout.txt \
      --all-changed-paths-file /phase-evidence/all-changed-paths.json \
      --phase-changed-paths-file /phase-evidence/phase-changed-paths.json \
      --phase-patch-file /phase-evidence/phase.patch \
      --cumulative-patch-file /phase-evidence/cumulative.patch \
      --receipt-file /phase-evidence/controller-preflight-receipt.json
  local exit_code
  exit_code="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

run_phase_controller_finalize() {
  local name="$1" phase_dir_docker="$2" stdout_file="$3" stderr_file="$4"
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 0:0 --group-add "${PHASE_EVIDENCE_CONSUMER_GID}" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=0,gid=0,mode=0700 \
    --mount "type=bind,src=${RUNTIME_TOOLS_DOCKER_PATH},dst=/forge-runtime,readonly" \
    --mount "type=bind,src=${phase_catalog_docker_path},dst=/phase-catalog.json,readonly" \
    --mount "type=bind,src=${prompt_file_docker},dst=/original-request.md,readonly" \
    --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control" \
    --mount "type=bind,src=${phase_dir_docker},dst=/phase-evidence" \
    --entrypoint /usr/local/bin/node "${image_id}" /forge-runtime/forge-delivery-phase-controller.mjs finalize \
      --catalog-file /phase-catalog.json --state-file /phase-control/state.json \
      --artifacts-directory /phase-control/artifacts --original-request-file /original-request.md \
      --response-file /phase-evidence/model.stdout.txt \
      --all-changed-paths-file /phase-evidence/all-changed-paths.json \
      --phase-changed-paths-file /phase-evidence/phase-changed-paths.json \
      --phase-patch-file /phase-evidence/phase.patch \
      --cumulative-patch-file /phase-evidence/cumulative.patch \
      --host-receipts-file /phase-evidence/phase-host-receipts.json \
      --output-directory /phase-evidence/controller \
      --next-prompt-file /phase-control/current-prompt.md \
      --receipt-file /phase-evidence/controller-cli-receipt.json
  local exit_code
  exit_code="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

run_phase_controller_review_command() {
  local name="$1" command="$2" phase_dir_docker="$3" stdout_file="$4" stderr_file="$5"
  shift 5
  create_owned_container "${name}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --user 0:0 --group-add "${PHASE_EVIDENCE_CONSUMER_GID}" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=0,gid=0,mode=0700 \
    --mount "type=bind,src=${RUNTIME_TOOLS_DOCKER_PATH},dst=/forge-runtime,readonly" \
    --mount "type=bind,src=${phase_catalog_docker_path},dst=/phase-catalog.json,readonly" \
    --mount "type=bind,src=${prompt_file_docker},dst=/original-request.md,readonly" \
    --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control" \
    --mount "type=bind,src=${phase_dir_docker},dst=/phase-evidence" \
    --entrypoint /usr/local/bin/node "${image_id}" /forge-runtime/forge-delivery-phase-controller.mjs "${command}" \
      --catalog-file /phase-catalog.json --state-file /phase-control/state.json "$@"
  local exit_code
  exit_code="$(start_capture "${name}" "${stdout_file}" "${stderr_file}")"
  remove_owned_container "${name}"
  [[ "${exit_code}" -eq 0 ]]
}

wait_for_independent_semantic_review() {
  local review_file="$1" deadline=$((SECONDS + SEMANTIC_REVIEW_TIMEOUT_SECONDS))
  while [[ ! -e "${review_file}" && ! -L "${review_file}" ]]; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
  [[ -f "${review_file}" && ! -L "${review_file}" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) [[ $# -ge 2 ]] || die '--source requires a value'; SOURCE_PATH="$2"; shift 2 ;;
    --image) [[ $# -ge 2 ]] || die '--image requires a value'; IMAGE_REFERENCE="$2"; shift 2 ;;
    --key-file) [[ $# -ge 2 ]] || die '--key-file requires a value'; KEY_FILE="$2"; shift 2 ;;
    --evidence-root) [[ $# -ge 2 ]] || die '--evidence-root requires a value'; EVIDENCE_ROOT="$2"; shift 2 ;;
    --external-skills-bundle) [[ $# -ge 2 ]] || die '--external-skills-bundle requires a value'; EXTERNAL_SKILLS_BUNDLE="$2"; shift 2 ;;
    --external-skills-manifest-sha256) [[ $# -ge 2 ]] || die '--external-skills-manifest-sha256 requires a value'; EXTERNAL_SKILLS_MANIFEST_SHA256="$2"; shift 2 ;;
    --host-runner-bundle) [[ $# -ge 2 ]] || die '--host-runner-bundle requires a value'; HOST_RUNNER_BUNDLE="$2"; shift 2 ;;
    --host-runner-manifest-sha256) [[ $# -ge 2 ]] || die '--host-runner-manifest-sha256 requires a value'; HOST_RUNNER_MANIFEST_SHA256="$2"; shift 2 ;;
    --runtime-lock-sha256) [[ $# -ge 2 ]] || die '--runtime-lock-sha256 requires a value'; EXPECTED_RUNTIME_PACKAGE_LOCK_SHA256_INPUT="$2"; shift 2 ;;
    --case) [[ $# -ge 2 ]] || die '--case requires a value'; CASE_FILTER="$2"; shift 2 ;;
    --max-model-requests) [[ $# -ge 2 ]] || die '--max-model-requests requires a value'; MAX_MODEL_REQUESTS="$2"; shift 2 ;;
    --model-timeout-seconds) [[ $# -ge 2 ]] || die '--model-timeout-seconds requires a value'; MODEL_TIMEOUT_SECONDS="$2"; shift 2 ;;
    --independent-semantic-review) INDEPENDENT_SEMANTIC_REVIEW=1; shift ;;
    --host-state-root) [[ $# -ge 2 ]] || die '--host-state-root requires a value'; HOST_STATE_ROOT="$2"; shift 2 ;;
    --verification-mode) [[ $# -ge 2 ]] || die '--verification-mode requires a value'; VERIFICATION_MODE="$2"; shift 2 ;;
    --test-shadow-candidate-write) [[ $# -ge 2 ]] || die '--test-shadow-candidate-write requires a value'; TEST_SHADOW_CANDIDATE_WRITE="$2"; shift 2 ;;
    --verification-cache-pack) [[ $# -ge 2 ]] || die '--verification-cache-pack requires a value'; VERIFICATION_CACHE_PACK="$2"; shift 2 ;;
    --verification-cache-manifest-sha256) [[ $# -ge 2 ]] || die '--verification-cache-manifest-sha256 requires a value'; VERIFICATION_CACHE_MANIFEST_SHA256="$2"; shift 2 ;;
    --confirm-local-verification-execution) [[ $# -ge 2 ]] || die '--confirm-local-verification-execution requires a value'; CONFIRM_LOCAL_VERIFICATION_EXECUTION="$2"; shift 2 ;;
    --confirm-local-model-cost) CONFIRM_LOCAL_MODEL_COST=1; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --retain-volumes) RETAIN_VOLUMES=1; shift ;;
    --database-continuation-source) [[ $# -ge 2 ]] || die '--database-continuation-source requires a value'; DATABASE_CONTINUATION_SOURCE="$2"; shift 2 ;;
    --database-continuation-state-sha256) [[ $# -ge 2 ]] || die '--database-continuation-state-sha256 requires a value'; DATABASE_CONTINUATION_STATE_SHA256="$2"; shift 2 ;;
    --database-continuation-patch) [[ $# -ge 2 ]] || die '--database-continuation-patch requires a value'; DATABASE_CONTINUATION_PATCH="$2"; shift 2 ;;
    --database-continuation-patch-sha256) [[ $# -ge 2 ]] || die '--database-continuation-patch-sha256 requires a value'; DATABASE_CONTINUATION_PATCH_SHA256="$2"; shift 2 ;;
    --backend-continuation-source) [[ $# -ge 2 ]] || die '--backend-continuation-source requires a value'; BACKEND_CONTINUATION_SOURCE="$2"; shift 2 ;;
    --backend-continuation-bindings) [[ $# -ge 2 ]] || die '--backend-continuation-bindings requires a value'; BACKEND_CONTINUATION_BINDINGS="$2"; shift 2 ;;
    --backend-continuation-bindings-sha256) [[ $# -ge 2 ]] || die '--backend-continuation-bindings-sha256 requires a value'; BACKEND_CONTINUATION_BINDINGS_SHA256="$2"; shift 2 ;;
    --frontend-retry-source) [[ $# -ge 2 ]] || die '--frontend-retry-source requires a value'; FRONTEND_RETRY_SOURCE="$2"; shift 2 ;;
    --frontend-retry-bindings) [[ $# -ge 2 ]] || die '--frontend-retry-bindings requires a value'; FRONTEND_RETRY_BINDINGS="$2"; shift 2 ;;
    --frontend-retry-bindings-sha256) [[ $# -ge 2 ]] || die '--frontend-retry-bindings-sha256 requires a value'; FRONTEND_RETRY_BINDINGS_SHA256="$2"; shift 2 ;;
    --access-wiring-continuation-source) [[ $# -ge 2 ]] || die '--access-wiring-continuation-source requires a value'; ACCESS_WIRING_CONTINUATION_SOURCE="$2"; shift 2 ;;
    --access-wiring-continuation-bindings) [[ $# -ge 2 ]] || die '--access-wiring-continuation-bindings requires a value'; ACCESS_WIRING_CONTINUATION_BINDINGS="$2"; shift 2 ;;
    --access-wiring-continuation-bindings-sha256) [[ $# -ge 2 ]] || die '--access-wiring-continuation-bindings-sha256 requires a value'; ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256="$2"; shift 2 ;;
    --cross-layer-continuation-source) [[ $# -ge 2 ]] || die '--cross-layer-continuation-source requires a value'; CROSS_LAYER_CONTINUATION_SOURCE="$2"; shift 2 ;;
    --cross-layer-continuation-bindings) [[ $# -ge 2 ]] || die '--cross-layer-continuation-bindings requires a value'; CROSS_LAYER_CONTINUATION_BINDINGS="$2"; shift 2 ;;
    --cross-layer-continuation-bindings-sha256) [[ $# -ge 2 ]] || die '--cross-layer-continuation-bindings-sha256 requires a value'; CROSS_LAYER_CONTINUATION_BINDINGS_SHA256="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ -n "${DATABASE_CONTINUATION_SOURCE}${DATABASE_CONTINUATION_STATE_SHA256}${DATABASE_CONTINUATION_PATCH}${DATABASE_CONTINUATION_PATCH_SHA256}" ]]; then
  [[ -z "${BACKEND_CONTINUATION_SOURCE}${BACKEND_CONTINUATION_BINDINGS}${BACKEND_CONTINUATION_BINDINGS_SHA256}${FRONTEND_RETRY_SOURCE}${FRONTEND_RETRY_BINDINGS}${FRONTEND_RETRY_BINDINGS_SHA256}${ACCESS_WIRING_CONTINUATION_SOURCE}${ACCESS_WIRING_CONTINUATION_BINDINGS}${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}${CROSS_LAYER_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_BINDINGS}${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" ]] \
    || die 'database continuation cannot be combined with another continuation'
  [[ "${CASE_FILTER}" == crud-complete && "${VERIFICATION_MODE}" == host-toolchain
    && "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]] \
    || die 'database continuation requires crud-complete, host-toolchain and independent semantic review'
  require_absolute_local_path '--database-continuation-source' "${DATABASE_CONTINUATION_SOURCE}"
  reject_remote_syntax '--database-continuation-source' "${DATABASE_CONTINUATION_SOURCE}"
  [[ "${DATABASE_CONTINUATION_STATE_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
    || die 'database continuation requires the reviewed parent state SHA-256'
  require_absolute_local_path '--database-continuation-patch' "${DATABASE_CONTINUATION_PATCH}"
  reject_remote_syntax '--database-continuation-patch' "${DATABASE_CONTINUATION_PATCH}"
  [[ "${DATABASE_CONTINUATION_PATCH_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
    || die 'database continuation requires the reviewed candidate patch SHA-256'
fi
if [[ -n "${BACKEND_CONTINUATION_SOURCE}${BACKEND_CONTINUATION_BINDINGS}${BACKEND_CONTINUATION_BINDINGS_SHA256}" ]]; then
  [[ -z "${FRONTEND_RETRY_SOURCE}${FRONTEND_RETRY_BINDINGS}${FRONTEND_RETRY_BINDINGS_SHA256}${ACCESS_WIRING_CONTINUATION_SOURCE}${ACCESS_WIRING_CONTINUATION_BINDINGS}${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}${CROSS_LAYER_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_BINDINGS}${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" ]] \
    || die 'backend and frontend retry continuation cannot be combined'
  [[ -n "${BACKEND_CONTINUATION_SOURCE}" && -n "${BACKEND_CONTINUATION_BINDINGS}" \
    && "${BACKEND_CONTINUATION_BINDINGS_SHA256}" =~ ^[0-9a-f]{64}$ \
    && "${CASE_FILTER}" == crud-complete && "${VERIFICATION_MODE}" == host-toolchain \
    && "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]] \
    || die 'backend continuation requires reviewed bindings, crud-complete, host-toolchain and independent semantic review'
  require_absolute_local_path '--backend-continuation-source' "${BACKEND_CONTINUATION_SOURCE}"
  reject_remote_syntax '--backend-continuation-source' "${BACKEND_CONTINUATION_SOURCE}"
  require_absolute_local_path '--backend-continuation-bindings' "${BACKEND_CONTINUATION_BINDINGS}"
  reject_remote_syntax '--backend-continuation-bindings' "${BACKEND_CONTINUATION_BINDINGS}"
fi
if [[ -n "${FRONTEND_RETRY_SOURCE}${FRONTEND_RETRY_BINDINGS}${FRONTEND_RETRY_BINDINGS_SHA256}" ]]; then
  [[ -z "${ACCESS_WIRING_CONTINUATION_SOURCE}${ACCESS_WIRING_CONTINUATION_BINDINGS}${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}${CROSS_LAYER_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_BINDINGS}${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" ]] \
    || die 'frontend retry and access wiring continuation cannot be combined'
  [[ -n "${FRONTEND_RETRY_SOURCE}" && -n "${FRONTEND_RETRY_BINDINGS}" \
    && "${FRONTEND_RETRY_BINDINGS_SHA256}" =~ ^[0-9a-f]{64}$ \
    && "${CASE_FILTER}" == crud-complete && "${VERIFICATION_MODE}" == host-toolchain \
    && "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]] \
    || die 'frontend retry continuation requires reviewed bindings, crud-complete, host-toolchain and independent semantic review'
  require_absolute_local_path '--frontend-retry-source' "${FRONTEND_RETRY_SOURCE}"
  reject_remote_syntax '--frontend-retry-source' "${FRONTEND_RETRY_SOURCE}"
  require_absolute_local_path '--frontend-retry-bindings' "${FRONTEND_RETRY_BINDINGS}"
  reject_remote_syntax '--frontend-retry-bindings' "${FRONTEND_RETRY_BINDINGS}"
fi
if [[ -n "${ACCESS_WIRING_CONTINUATION_SOURCE}${ACCESS_WIRING_CONTINUATION_BINDINGS}${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}" ]]; then
  [[ -z "${CROSS_LAYER_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_BINDINGS}${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" ]] \
    || die 'access wiring and cross-layer continuation cannot be combined'
  [[ -n "${ACCESS_WIRING_CONTINUATION_SOURCE}" && -n "${ACCESS_WIRING_CONTINUATION_BINDINGS}" \
    && "${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}" =~ ^[0-9a-f]{64}$ \
    && "${CASE_FILTER}" == crud-complete && "${VERIFICATION_MODE}" == host-toolchain \
    && "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]] \
    || die 'access wiring continuation requires reviewed bindings, crud-complete, host-toolchain and independent semantic review'
  require_absolute_local_path '--access-wiring-continuation-source' "${ACCESS_WIRING_CONTINUATION_SOURCE}"
  reject_remote_syntax '--access-wiring-continuation-source' "${ACCESS_WIRING_CONTINUATION_SOURCE}"
  require_absolute_local_path '--access-wiring-continuation-bindings' "${ACCESS_WIRING_CONTINUATION_BINDINGS}"
  reject_remote_syntax '--access-wiring-continuation-bindings' "${ACCESS_WIRING_CONTINUATION_BINDINGS}"
fi
if [[ -n "${CROSS_LAYER_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_BINDINGS}${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" ]]; then
  [[ -n "${CROSS_LAYER_CONTINUATION_SOURCE}" && -n "${CROSS_LAYER_CONTINUATION_BINDINGS}" \
    && "${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" =~ ^[0-9a-f]{64}$ \
    && "${CASE_FILTER}" == crud-complete && "${VERIFICATION_MODE}" == host-toolchain \
    && "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]] \
    || die 'cross-layer continuation requires reviewed bindings, crud-complete, host-toolchain and independent semantic review'
  require_absolute_local_path '--cross-layer-continuation-source' "${CROSS_LAYER_CONTINUATION_SOURCE}"
  reject_remote_syntax '--cross-layer-continuation-source' "${CROSS_LAYER_CONTINUATION_SOURCE}"
  require_absolute_local_path '--cross-layer-continuation-bindings' "${CROSS_LAYER_CONTINUATION_BINDINGS}"
  reject_remote_syntax '--cross-layer-continuation-bindings' "${CROSS_LAYER_CONTINUATION_BINDINGS}"
fi

# This matrix is intentionally checked before runtime/suite snapshots, image
# admission, secret snapshots, or any paid model request. cache-miss remains the
# default and must not accidentally inherit cache-ready authority from stray
# arguments.
case "${VERIFICATION_MODE}" in
  cache-miss)
    [[ -z "${VERIFICATION_CACHE_PACK}" ]] \
      || die '--verification-cache-pack is valid only with --verification-mode cache-ready'
    [[ -z "${VERIFICATION_CACHE_MANIFEST_SHA256}" ]] \
      || die '--verification-cache-manifest-sha256 is valid only with --verification-mode cache-ready'
    [[ -z "${CONFIRM_LOCAL_VERIFICATION_EXECUTION}" ]] \
      || die '--confirm-local-verification-execution is valid only with --verification-mode cache-ready'
    ;;
  cache-ready)
    [[ -n "${VERIFICATION_CACHE_PACK}" ]] \
      || die 'cache-ready requires --verification-cache-pack'
    require_absolute_local_path '--verification-cache-pack' "${VERIFICATION_CACHE_PACK}"
    reject_remote_syntax '--verification-cache-pack' "${VERIFICATION_CACHE_PACK}"
    [[ "${VERIFICATION_CACHE_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
      || die 'cache-ready requires --verification-cache-manifest-sha256 as one lowercase SHA-256 digest'
    [[ "${CONFIRM_LOCAL_VERIFICATION_EXECUTION}" == 'cache-ready' ]] \
      || die 'cache-ready requires --confirm-local-verification-execution cache-ready'
    ;;
  host-toolchain)
    [[ "${CASE_FILTER}" == 'crud-complete' || "${CASE_FILTER}" == 'adversarial-shortcuts' ]] \
      || die 'host-toolchain requires one explicit phased A9 case'
    [[ -n "${HOST_STATE_ROOT}" ]] || die 'host-toolchain requires --host-state-root'
    require_absolute_local_path '--host-state-root' "${HOST_STATE_ROOT}"
    reject_remote_syntax '--host-state-root' "${HOST_STATE_ROOT}"
    [[ -z "${VERIFICATION_CACHE_PACK}${VERIFICATION_CACHE_MANIFEST_SHA256}${CONFIRM_LOCAL_VERIFICATION_EXECUTION}" ]] \
      || die 'host-toolchain does not accept schema1 cache-pack execution arguments'
    ;;
  *) die '--verification-mode must be cache-miss, cache-ready or host-toolchain' ;;
esac
[[ "${VERIFICATION_MODE}" == 'host-toolchain' || -z "${HOST_STATE_ROOT}" ]] \
  || die '--host-state-root requires --verification-mode host-toolchain'

case "${CASE_FILTER}" in
  all|crud-complete|edge-pagination-shared-owner|frontend-aicrudpage-api-contract|adversarial-shortcuts) ;;
  *) die '--case does not name a versioned suite case' ;;
esac

case "${TEST_SHADOW_CANDIDATE_WRITE}" in
  '') ;;
  candidate-only)
    [[ "${VERIFICATION_MODE}" == 'cache-miss' ]] \
      || die '--test-shadow-candidate-write candidate-only requires --verification-mode cache-miss'
    [[ "${CASE_FILTER}" != 'all' ]] \
      || die '--test-shadow-candidate-write candidate-only requires one explicit --case'
    ;;
  *) die '--test-shadow-candidate-write must be candidate-only when supplied' ;;
esac

require_bounded_integer '--max-model-requests' "${MAX_MODEL_REQUESTS}" 1 "${MAX_ALLOWED_MODEL_REQUESTS}"
require_bounded_integer '--model-timeout-seconds' "${MODEL_TIMEOUT_SECONDS}" \
  "${MIN_MODEL_TIMEOUT_SECONDS}" "${MAX_MODEL_TIMEOUT_SECONDS}"
[[ "${EXPECTED_RUNTIME_PACKAGE_LOCK_SHA256_INPUT}" =~ ^[0-9a-f]{64}$ ]] \
  || die '--runtime-lock-sha256 must be one lowercase reviewed SHA-256 digest'
[[ "${EXTERNAL_SKILLS_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die '--external-skills-manifest-sha256 must be one lowercase reviewed SHA-256 digest'
[[ "${HOST_RUNNER_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die '--host-runner-manifest-sha256 must be one lowercase reviewed SHA-256 digest'
if [[ "${PREFLIGHT_ONLY}" -eq 1 ]]; then
  [[ "${CONFIRM_LOCAL_MODEL_COST}" -eq 0 ]] \
    || die '--preflight-only must not be combined with --confirm-local-model-cost'
  [[ "${CASE_FILTER}" != 'all' ]] || die '--preflight-only requires one explicit --case'
else
  [[ "${CONFIRM_LOCAL_MODEL_COST}" -eq 1 ]] || die 'paid model execution requires --confirm-local-model-cost'
fi
for tool in docker git node realpath sha256sum awk grep id timeout; do require_tool "${tool}"; done
if [[ "${PREFLIGHT_ONLY}" -eq 0 || "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
  for tool in java mvn pnpm; do require_tool "${tool}"; done
fi
HOST_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
case "${HOST_NODE_MAJOR}" in 22|24) ;; *) die 'the server Host Runner requires Node major 22 or 24' ;; esac
RUNNER_OBSERVED_SHA256="$(stable_regular_file_sha256 "${RUNNER_FILE}")" \
  || die 'the evaluation runner could not establish a stable startup identity'
[[ "${RUNNER_OBSERVED_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die 'the evaluation runner returned an invalid startup identity'
runtime_package_receipt="$(verify_runtime_package_lock)" \
  || die 'the external runtime package content lock could not be verified'
mapfile -t runtime_package_receipt_fields <<<"${runtime_package_receipt}"
[[ "${#runtime_package_receipt_fields[@]}" -eq 3 ]] \
  || die 'the external runtime package content lock returned an invalid receipt'
RUNTIME_PACKAGE_LOCK_SHA256="${runtime_package_receipt_fields[0]}"
RUNTIME_PACKAGE_LOCK_BYTES="${runtime_package_receipt_fields[1]}"
RUNTIME_PACKAGE_ENTRY_COUNT="${runtime_package_receipt_fields[2]}"
[[ "${RUNTIME_PACKAGE_LOCK_SHA256}" =~ ^[0-9a-f]{64}$ \
  && "${RUNTIME_PACKAGE_LOCK_BYTES}" =~ ^[1-9][0-9]*$ \
  && "${RUNTIME_PACKAGE_ENTRY_COUNT}" == "${EXPECTED_RUNTIME_PACKAGE_ENTRY_COUNT}" ]] \
  || die 'the external runtime package content lock returned an invalid identity'
[[ "${RUNTIME_PACKAGE_LOCK_SHA256}" == "${EXPECTED_RUNTIME_PACKAGE_LOCK_SHA256_INPUT}" ]] \
  || die 'the external runtime package content lock does not match the reviewed out-of-band digest'

# Git for Windows rewrites Linux-looking arguments before invoking native
# executables. Docker container paths must remain Linux paths, while bind-mount
# sources must be translated explicitly to Windows paths. Scope the exclusion to
# Docker only so host-side Node invocations keep their normal MSYS conversion.
case "${OSTYPE:-}" in
  msys*|cygwin*)
    require_tool cygpath
    docker() { MSYS2_ARG_CONV_EXCL='*' command docker "$@"; }
    docker_host_path() { cygpath -am -- "$1"; }
    ;;
  *)
    docker_host_path() { printf '%s\n' "$1"; }
    ;;
esac

local_uid="$(id -u)"
local_gid="$(id -g)"
if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
  [[ "${OSTYPE:-}" == linux* ]] || die 'host-toolchain requires a local Linux Host'
  for tool in setpriv tail; do require_tool "${tool}"; done
  if [[ "${local_uid}" -eq 0 ]]; then
    HOST_USER_COMMAND=(setpriv --reuid 1000 --regid 1000 --clear-groups --no-new-privs)
  elif [[ "${local_uid}" -eq 1000 && "${local_gid}" -eq 1000 ]]; then
    HOST_USER_COMMAND=(setpriv --no-new-privs)
  else
    die 'host-toolchain requires operator root or uid/gid 1000'
  fi
fi

SOURCE_PATH="$(canonical_directory '--source' "${SOURCE_PATH}")"
KEY_FILE="$(canonical_regular_file '--key-file' "${KEY_FILE}")"
EXTERNAL_SKILLS_BUNDLE="$(canonical_directory '--external-skills-bundle' "${EXTERNAL_SKILLS_BUNDLE}")"
HOST_RUNNER_BUNDLE="$(canonical_directory '--host-runner-bundle' "${HOST_RUNNER_BUNDLE}")"
[[ -f "${EXTERNAL_SKILLS_BUNDLE}/bundle.manifest.json" \
  && ! -L "${EXTERNAL_SKILLS_BUNDLE}/bundle.manifest.json" \
  && -d "${EXTERNAL_SKILLS_BUNDLE}/skills" \
  && ! -L "${EXTERNAL_SKILLS_BUNDLE}/skills" ]] \
  || die '--external-skills-bundle must contain ordinary bundle.manifest.json and skills entries'
observed_external_skills_manifest_sha256="$(stable_regular_file_sha256 "${EXTERNAL_SKILLS_BUNDLE}/bundle.manifest.json")" \
  || die 'the external Skill bundle manifest could not establish a stable identity'
[[ "${observed_external_skills_manifest_sha256}" == "${EXTERNAL_SKILLS_MANIFEST_SHA256}" ]] \
  || die 'the external Skill bundle manifest does not match the reviewed SHA-256 digest'
verify_external_skills_bundle \
  || die 'the external Skill bundle failed exact content and DSH compatibility validation'
verify_host_runner_bundle \
  || die 'the Host Runner bundle failed exact content and profile compatibility validation'
verify_host_profile_adapter \
  || die 'the Host Runner adapter or one-shot driver differs from the reviewed identity'
[[ -s "${KEY_FILE}" ]] || die '--key-file must not be empty'
[[ -r "${KEY_FILE}" ]] || die '--key-file must be readable by the local runner identity'
key_file_bytes="$(node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).size))' "${KEY_FILE}")"
[[ "${key_file_bytes}" -le 16384 ]] || die '--key-file exceeds the bounded local credential size'
[[ -d "${SOURCE_PATH}/.git" && ! -L "${SOURCE_PATH}/.git" ]] || die '--source must be a normal local Git checkout with a .git directory'
EVIDENCE_ROOT="$(canonical_future_directory '--evidence-root' "${EVIDENCE_ROOT}")"
paths_overlap "${SOURCE_PATH}" "${EVIDENCE_ROOT}" && die '--source and --evidence-root must not contain or overlap each other'
paths_overlap "${SOURCE_PATH}" "${KEY_FILE}" && die '--key-file must be outside the admitted source checkout'
paths_overlap "${EVIDENCE_ROOT}" "${KEY_FILE}" && die '--key-file must be outside the evidence root'
paths_overlap "${SOURCE_PATH}" "${EXTERNAL_SKILLS_BUNDLE}" \
  && die '--external-skills-bundle must not overlap the admitted source checkout'
paths_overlap "${KEY_FILE}" "${EXTERNAL_SKILLS_BUNDLE}" \
  && die '--external-skills-bundle must not overlap the model credential file'
paths_overlap "${EVIDENCE_ROOT}" "${EXTERNAL_SKILLS_BUNDLE}" \
  && die '--external-skills-bundle must not overlap the evidence root'
paths_overlap "${SOURCE_PATH}" "${HOST_RUNNER_BUNDLE}" \
  && die '--host-runner-bundle must not overlap the admitted source checkout'
paths_overlap "${KEY_FILE}" "${HOST_RUNNER_BUNDLE}" \
  && die '--host-runner-bundle must not overlap the model credential file'
paths_overlap "${EVIDENCE_ROOT}" "${HOST_RUNNER_BUNDLE}" \
  && die '--host-runner-bundle must not overlap the evidence root'
paths_overlap "${EXTERNAL_SKILLS_BUNDLE}" "${HOST_RUNNER_BUNDLE}" \
  && die 'the external Skill and Host Runner bundles must be independent directories'
if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
  HOST_STATE_ROOT="$(canonical_future_directory '--host-state-root' "${HOST_STATE_ROOT}")"
  for protected_path in "${SOURCE_PATH}" "${KEY_FILE}" "${EVIDENCE_ROOT}" "${HOST_RUNNER_BUNDLE}" "${EXTERNAL_SKILLS_BUNDLE}"; do
    paths_overlap "${HOST_STATE_ROOT}" "${protected_path}" && die '--host-state-root overlaps an input or evidence path'
  done
fi
if [[ "${VERIFICATION_MODE}" == 'cache-ready' ]]; then
  VERIFICATION_CACHE_PACK="$(canonical_directory '--verification-cache-pack' "${VERIFICATION_CACHE_PACK}")"
  paths_overlap "${SOURCE_PATH}" "${VERIFICATION_CACHE_PACK}" \
    && die '--verification-cache-pack must not overlap the admitted source checkout'
  paths_overlap "${EVIDENCE_ROOT}" "${VERIFICATION_CACHE_PACK}" \
    && die '--verification-cache-pack must not overlap the evidence root'
  paths_overlap "${KEY_FILE}" "${VERIFICATION_CACHE_PACK}" \
    && die '--verification-cache-pack must not overlap the model credential file'
  [[ -f "${VERIFICATION_CACHE_PACK}/manifest.json" \
    && ! -L "${VERIFICATION_CACHE_PACK}/manifest.json" ]] \
    || die '--verification-cache-pack must contain one ordinary manifest.json'
  observed_cache_manifest_sha256="$(stable_regular_file_sha256 "${VERIFICATION_CACHE_PACK}/manifest.json")" \
    || die 'the verification cache manifest could not establish a stable identity'
  [[ "${observed_cache_manifest_sha256}" == "${VERIFICATION_CACHE_MANIFEST_SHA256}" ]] \
    || die 'the verification cache manifest does not match the reviewed SHA-256 digest'
fi

SOURCE_GIT_DOCKER_PATH="$(docker_host_path "${SOURCE_PATH}/.git")"
EXTERNAL_SKILLS_DOCKER_PATH="$(docker_host_path "${EXTERNAL_SKILLS_BUNDLE}/skills")"
readonly EXTERNAL_SKILLS_CONTAINER_PATH="/opt/forge-external-skills"

source_head="$(git -C "${SOURCE_PATH}" rev-parse --verify 'HEAD^{commit}')"
[[ "${source_head}" == "${REQUIRED_SOURCE_COMMIT}" ]] || die "--source HEAD must equal ${REQUIRED_SOURCE_COMMIT}"
source_status="$(git -C "${SOURCE_PATH}" status --porcelain=v1 --untracked-files=all)"
[[ -z "${source_status}" ]] || die '--source must be clean, including untracked files'

mkdir -p -- "${EVIDENCE_ROOT}"
EVIDENCE_ROOT="$(canonical_directory '--evidence-root' "${EVIDENCE_ROOT}")"

reject_remote_syntax '--image' "${IMAGE_REFERENCE}"
[[ "${IMAGE_REFERENCE}" != -* ]] || die '--image must not begin with a dash'
image_prefix="${IMAGE_REFERENCE%%/*}"
if [[ "${IMAGE_REFERENCE}" == */* && ( "${image_prefix}" == "localhost" || "${image_prefix}" == *.* || "${image_prefix}" == *:* ) ]]; then
  die '--image must be a local image name or immutable id, not a registry/server-qualified reference'
fi
image_id="$(docker image inspect --format '{{.Id}}' "${IMAGE_REFERENCE}" 2>/dev/null)" \
  || die '--image must name an image already present in the local Docker engine'
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Docker returned a non-immutable image identifier'
readonly image_id
if [[ "${VERIFICATION_MODE}" == 'cache-ready' ]]; then
  VERIFICATION_CACHE_FINGERPRINT="$(node - "${VERIFICATION_CACHE_PACK}/manifest.json" \
    "${VERIFICATION_CACHE_PACK}" "${image_id}" "${EXPECTED_HARNESS_IMAGE_REVISION}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [manifestFile, packRoot, imageId, runnerRevision] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const fingerprint = manifest?.dependencyManifestFingerprint;
if (manifest?.schemaVersion !== 3 || manifest?.complete !== true
  || !/^[0-9a-f]{64}$/u.test(fingerprint ?? '')
  || path.basename(packRoot) !== fingerprint
  || manifest?.projectSlug !== 'forge-harness-eval'
  || manifest?.toolchainImage !== imageId || manifest?.runnerRevision !== runnerRevision
  || !Array.isArray(manifest?.dependencyManifestFiles) || !Array.isArray(manifest?.files)) {
  throw new Error('cache-ready manifest is not bound to the selected immutable toolchain and runner revision');
}
process.stdout.write(`${fingerprint}\n`);
NODE
)" || die 'the verification cache manifest identity is incompatible with this run'
fi
proxy_image_reference="${CREDENTIAL_PROXY_IMAGE_REFERENCE}"
if proxy_image_id="$(docker image inspect --format '{{.Id}}' "${proxy_image_reference}" 2>/dev/null)"; then
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${proxy_image_reference}" \
    | grep -Fx -- "${CREDENTIAL_PROXY_REPO_DIGEST}" >/dev/null \
    || die 'the local credential-proxy image does not retain the required repository digest identity'
else
  proxy_image_reference="${CREDENTIAL_PROXY_OFFLINE_PLATFORM_IMAGE_ID}"
  proxy_image_id="$(docker image inspect --format '{{.Id}}' "${proxy_image_reference}" 2>/dev/null)" \
    || die "the pinned credential-proxy image must already exist locally: ${CREDENTIAL_PROXY_REPO_DIGEST} or ${CREDENTIAL_PROXY_OFFLINE_PLATFORM_IMAGE_ID}"
  [[ "${proxy_image_id}" == "${CREDENTIAL_PROXY_OFFLINE_PLATFORM_IMAGE_ID}" ]] \
    || die 'the offline credential-proxy image differs from the pinned platform manifest identity'
  [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "${proxy_image_reference}")" == 'linux/amd64' ]] \
    || die 'the offline credential-proxy image must be the pinned linux/amd64 platform manifest'
fi
[[ "${proxy_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Docker returned a non-immutable credential-proxy image identifier'
[[ "${proxy_image_id}" != "${image_id}" ]] || die 'the candidate and credential-proxy images must be distinct immutable artifacts'
readonly proxy_image_reference
readonly proxy_image_id

run_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${run_token}"
run_dir="${EVIDENCE_ROOT}/${run_id}"
run_stage="${EVIDENCE_ROOT}/.${run_id}.staging"
SECRET_SNAPSHOT_FILE="${EVIDENCE_ROOT}/.${run_id}.credential"
BROKER_TOKEN_SNAPSHOT_FILE="${EVIDENCE_ROOT}/.${run_id}.broker-token"
[[ ! -e "${run_dir}" && ! -e "${run_stage}" && ! -e "${run_dir}-incomplete" \
  && ! -e "${SECRET_SNAPSHOT_FILE}" && ! -e "${BROKER_TOKEN_SNAPSHOT_FILE}" ]] \
  || die 'generated evidence or credential-snapshot path already exists'
mkdir -- "${run_stage}"
chmod 700 -- "${run_stage}"
node - "${run_stage}/.forge-hbe-owner.json" "${run_token}" "${run_id}" <<'NODE'
const fs = require('node:fs');
const [target, runToken, runId] = process.argv.slice(2);
fs.writeFileSync(target, `${JSON.stringify({
  schemaVersion: 'forge-harness-staging-owner/v1', runToken, runId,
})}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE

RUNTIME_TOOLS_DIR="${run_stage}/runtime-tools"
mkdir -- "${RUNTIME_TOOLS_DIR}"
chmod 700 -- "${RUNTIME_TOOLS_DIR}"
node - "${RUNTIME_TOOLS_DIR}" "${RUNNER_OBSERVED_SHA256}" \
  "${INPUT_SNAPSHOT_HELPER}" "${EXPECTED_INPUT_SNAPSHOT_HELPER_SHA256}" \
  "${SECRET_SNAPSHOT_HELPER}" "${EXPECTED_SECRET_SNAPSHOT_HELPER_SHA256}" \
  "${RUNTIME_LOCK_VERIFIER}" "${EXPECTED_RUNTIME_LOCK_VERIFIER_SHA256}" \
  "${PHASE_BUDGET_GUARD_SOURCE}" "${EXPECTED_PHASE_BUDGET_GUARD_SHA256}" \
  "${PROGRESS_DETECTOR_SOURCE}" "${EXPECTED_PROGRESS_DETECTOR_SHA256}" \
  "${PRODUCTION_TASK_GRANT_SOURCE}" "${EXPECTED_PRODUCTION_TASK_GRANT_SHA256}" \
  "${EXECUTION_CONTEXT_SOURCE}" "${EXPECTED_EXECUTION_CONTEXT_SHA256}" \
  "${PROTECTED_HEADLESS_RUNNER_SOURCE}" "${EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256}" \
  "${PHASE_CONTROLLER_SOURCE}" "${EXPECTED_PHASE_CONTROLLER_SHA256}" \
  "${CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE}" "${EXPECTED_CROSS_LAYER_RUNTIME_EVIDENCE_SHA256}" \
  "${PHASE_WORK_PACKAGE_SOURCE}" "${EXPECTED_PHASE_WORK_PACKAGE_SHA256}" \
  "${PHASE_RUNTIME_SOURCE}" "${EXPECTED_PHASE_RUNTIME_SHA256}" \
  "${TASK_EXECUTION_CONTRACT_SOURCE}" "${EXPECTED_TASK_EXECUTION_CONTRACT_SHA256}" \
  "${PHASE_RESPONSE_SOURCE}" "${EXPECTED_PHASE_RESPONSE_SHA256}" \
  "${PHASE_OBSERVER_SOURCE}" "${EXPECTED_PHASE_OBSERVER_SHA256}" \
  "${RUNTIME_PACKAGE_LOCK}" "${RUNTIME_PACKAGE_LOCK_SHA256}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [destination, runnerObservedSha256, inputSource, expectedInputSha256,
  secretSource, expectedSecretSha256, verifierSource, expectedVerifierSha256,
  phaseGuardSource, expectedPhaseGuardSha256,
  progressDetectorSource, expectedProgressDetectorSha256,
  productionTaskGrantSource, expectedProductionTaskGrantSha256,
  executionContextSource, expectedExecutionContextSha256,
  protectedRunnerSource, expectedProtectedRunnerSha256,
  phaseControllerSource, expectedPhaseControllerSha256,
  crossLayerRuntimeEvidenceSource, expectedCrossLayerRuntimeEvidenceSha256,
  phaseWorkPackageSource, expectedPhaseWorkPackageSha256,
  phaseRuntimeSource, expectedPhaseRuntimeSha256,
  taskExecutionContractSource, expectedTaskExecutionContractSha256,
  phaseResponseSource, expectedPhaseResponseSha256,
  phaseObserverSource, expectedPhaseObserverSha256,
  packageLockSource, expectedPackageLockSha256] = process.argv.slice(2);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.nlink].join(':');
const stableRead = (source, expectedSha256) => {
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('live runtime helper must be one ordinary regular file');
  }
  const first = fs.readFileSync(source);
  const middle = fs.lstatSync(source);
  const second = fs.readFileSync(source);
  const after = fs.lstatSync(source);
  if (identity(before) !== identity(middle) || identity(middle) !== identity(after)
    || !first.equals(second) || first.length !== after.size) {
    throw new Error('live runtime helper changed during stable double read');
  }
  if (hash(first) !== expectedSha256) throw new Error('live runtime helper does not match its pinned SHA-256');
  return first;
};
const inputs = [
  { path: 'input-snapshot-helper.mjs', bytes: stableRead(inputSource, expectedInputSha256), sha256: expectedInputSha256 },
  { path: 'secret-snapshot-helper.mjs', bytes: stableRead(secretSource, expectedSecretSha256), sha256: expectedSecretSha256 },
  { path: 'runtime-lock-verifier.mjs', bytes: stableRead(verifierSource, expectedVerifierSha256), sha256: expectedVerifierSha256 },
  { path: 'phase-budget-guard.mjs', bytes: stableRead(phaseGuardSource, expectedPhaseGuardSha256), sha256: expectedPhaseGuardSha256 },
  { path: 'progress-detector.mjs', bytes: stableRead(progressDetectorSource, expectedProgressDetectorSha256), sha256: expectedProgressDetectorSha256 },
  { path: 'forge-production-task-grant.mjs', bytes: stableRead(productionTaskGrantSource, expectedProductionTaskGrantSha256), sha256: expectedProductionTaskGrantSha256 },
  { path: 'forge-execution-context.mjs', bytes: stableRead(executionContextSource, expectedExecutionContextSha256), sha256: expectedExecutionContextSha256 },
  { path: 'protected-headless-runner.mjs', bytes: stableRead(protectedRunnerSource, expectedProtectedRunnerSha256), sha256: expectedProtectedRunnerSha256 },
  { path: 'forge-delivery-phase-controller.mjs', bytes: stableRead(phaseControllerSource, expectedPhaseControllerSha256), sha256: expectedPhaseControllerSha256 },
  { path: 'forge-cross-layer-runtime-evidence.mjs', bytes: stableRead(crossLayerRuntimeEvidenceSource, expectedCrossLayerRuntimeEvidenceSha256), sha256: expectedCrossLayerRuntimeEvidenceSha256 },
  { path: 'forge-phase-work-package.mjs', bytes: stableRead(phaseWorkPackageSource, expectedPhaseWorkPackageSha256), sha256: expectedPhaseWorkPackageSha256 },
  { path: 'forge-delivery-phase-runtime.mjs', bytes: stableRead(phaseRuntimeSource, expectedPhaseRuntimeSha256), sha256: expectedPhaseRuntimeSha256 },
  { path: 'forge-task-execution-contract.mjs', bytes: stableRead(taskExecutionContractSource, expectedTaskExecutionContractSha256), sha256: expectedTaskExecutionContractSha256 },
  { path: 'forge-delivery-phase-response.mjs', bytes: stableRead(phaseResponseSource, expectedPhaseResponseSha256), sha256: expectedPhaseResponseSha256 },
  { path: 'forge-delivery-phase-workspace-observer.mjs', bytes: stableRead(phaseObserverSource, expectedPhaseObserverSha256), sha256: expectedPhaseObserverSha256 },
  { path: 'package-runtime-trust-lock.json', bytes: stableRead(packageLockSource, expectedPackageLockSha256), sha256: expectedPackageLockSha256 },
];
for (const item of inputs) {
  const target = path.join(destination, item.path);
  fs.writeFileSync(target, item.bytes, { flag: 'wx', mode: 0o400 });
  const observed = fs.lstatSync(target);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1
    || observed.size !== item.bytes.length || hash(fs.readFileSync(target)) !== item.sha256) {
    throw new Error(`runtime helper snapshot verification failed: ${item.path}`);
  }
}
const lock = {
  schemaVersion: 'forge-harness-runtime-tools-lock/v1',
  runnerObservedSha256,
  runnerIdentityBoundary: 'stable-double-read-at-startup-and-before-publication',
  entries: inputs.map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes.length })),
};
fs.writeFileSync(path.join(destination, 'runtime-tools-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o400,
});
NODE
node - "${RUNTIME_TOOLS_DIR}" "${PHASE_EVIDENCE_CONSUMER_GID}" <<'NODE'
const fs = require('node:fs');
const [root, consumerGidText] = process.argv.slice(2);
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
  const consumerGid = Number.parseInt(consumerGidText, 10);
  const consumerSnapshots = [
    'forge-delivery-phase-workspace-observer.mjs',
    'protected-headless-runner.mjs',
    'phase-budget-guard.mjs',
    'progress-detector.mjs',
  ];
  fs.chownSync(root, 0, consumerGid);
  fs.chmodSync(root, 0o710);
  const rootInfo = fs.lstatSync(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || rootInfo.uid !== 0n || rootInfo.gid !== BigInt(consumerGid)
    || (rootInfo.mode & 0o7777n) !== 0o710n) {
    throw new Error('runtime-tools root is not traversable only by root and the fixed consumer gid');
  }
  for (const name of consumerSnapshots) {
    const snapshot = `${root}/${name}`;
    fs.chownSync(snapshot, 0, consumerGid);
    fs.chmodSync(snapshot, 0o440);
    const info = fs.lstatSync(snapshot, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || info.uid !== 0n || info.gid !== BigInt(consumerGid)
      || (info.mode & 0o7777n) !== 0o440n) {
      throw new Error(`runtime consumer snapshot is not readable only by root and the fixed consumer gid: ${name}`);
    }
  }
}
NODE
ACTIVE_INPUT_SNAPSHOT_HELPER="${RUNTIME_TOOLS_DIR}/input-snapshot-helper.mjs"
ACTIVE_SECRET_SNAPSHOT_HELPER="${RUNTIME_TOOLS_DIR}/secret-snapshot-helper.mjs"
ACTIVE_RUNTIME_LOCK_VERIFIER="${RUNTIME_TOOLS_DIR}/runtime-lock-verifier.mjs"
ACTIVE_RUNTIME_PACKAGE_LOCK="${RUNTIME_TOOLS_DIR}/package-runtime-trust-lock.json"
ACTIVE_PHASE_BUDGET_GUARD="${RUNTIME_TOOLS_DIR}/phase-budget-guard.mjs"
PHASE_BUDGET_GUARD_SNAPSHOT_DOCKER_PATH="$(docker_host_path "${ACTIVE_PHASE_BUDGET_GUARD}")"
ACTIVE_PROGRESS_DETECTOR="${RUNTIME_TOOLS_DIR}/progress-detector.mjs"
PROGRESS_DETECTOR_SNAPSHOT_DOCKER_PATH="$(docker_host_path "${ACTIVE_PROGRESS_DETECTOR}")"
ACTIVE_PRODUCTION_TASK_GRANT="${RUNTIME_TOOLS_DIR}/forge-production-task-grant.mjs"
ACTIVE_PROTECTED_HEADLESS_RUNNER="${RUNTIME_TOOLS_DIR}/protected-headless-runner.mjs"
ACTIVE_PHASE_CONTROLLER="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-controller.mjs"
ACTIVE_PHASE_WORK_PACKAGE="${RUNTIME_TOOLS_DIR}/forge-phase-work-package.mjs"
ACTIVE_PHASE_RUNTIME="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-runtime.mjs"
ACTIVE_PHASE_RESPONSE="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-response.mjs"
ACTIVE_PHASE_OBSERVER="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-workspace-observer.mjs"
RUNTIME_TOOLS_DOCKER_PATH="$(docker_host_path "${RUNTIME_TOOLS_DIR}")"
PROTECTED_HEADLESS_RUNNER_SNAPSHOT_DOCKER_PATH="$(docker_host_path "${ACTIVE_PROTECTED_HEADLESS_RUNNER}")"
RUNTIME_TOOLS_LOCK_SHA256="$(stable_regular_file_sha256 "${RUNTIME_TOOLS_DIR}/runtime-tools-lock.json")" \
  || die 'the runtime-tools lock could not establish a stable identity'
verify_runner_unchanged || die 'the evaluation runner changed while establishing its runtime trust root'
  verify_runtime_package_lock >/dev/null \
  || die 'the external runtime package content lock changed while establishing the runtime snapshot'
verify_runtime_tools_snapshot || die 'the pinned runtime-tools snapshot failed its initial verification'
create_candidate_image_admission_receipt

if [[ "${VERIFICATION_MODE}" == 'cache-ready' ]]; then
  VERIFICATION_RUNTIME_ROOT="${run_stage}/.verification-runtime"
  mkdir -- "${VERIFICATION_RUNTIME_ROOT}"
  chmod 700 -- "${VERIFICATION_RUNTIME_ROOT}"
  mkdir -- "${VERIFICATION_RUNTIME_ROOT}/cache-packs" "${VERIFICATION_RUNTIME_ROOT}/cases" \
    "${VERIFICATION_RUNTIME_ROOT}/bin"

  docker_cli_image_id="$(docker image inspect --format '{{.Id}}' "${VERIFICATION_DOCKER_CLI_IMAGE_REFERENCE}" 2>/dev/null)" \
    || die "the pinned local Docker CLI supplier image must already exist: ${VERIFICATION_DOCKER_CLI_REPO_DIGEST}"
  [[ "${docker_cli_image_id}" == "${VERIFICATION_DOCKER_CLI_IMAGE_ID}" ]] \
    || die 'the local Docker CLI supplier image ID differs from the pinned immutable identity'
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${VERIFICATION_DOCKER_CLI_IMAGE_REFERENCE}" \
    | grep -Fx -- "${VERIFICATION_DOCKER_CLI_REPO_DIGEST}" >/dev/null \
    || die 'the local Docker CLI supplier image does not retain its pinned repository digest'
  docker_cli_supplier="forge-hbe-${run_token}-docker-cli-supplier"
  create_owned_container "${docker_cli_supplier}" --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint /bin/true "${VERIFICATION_DOCKER_CLI_IMAGE_ID}"
  docker cp "${docker_cli_supplier}:/usr/local/bin/docker" \
    "$(docker_host_path "${VERIFICATION_RUNTIME_ROOT}/bin/docker")" \
    || die 'the pinned local Docker CLI could not be exported into the run-owned runtime root'
  remove_owned_container "${docker_cli_supplier}"
  [[ -f "${VERIFICATION_RUNTIME_ROOT}/bin/docker" && ! -L "${VERIFICATION_RUNTIME_ROOT}/bin/docker" ]] \
    || die 'the exported local Docker CLI is not one ordinary file'
  [[ "$(stable_regular_file_sha256 "${VERIFICATION_RUNTIME_ROOT}/bin/docker")" == "${VERIFICATION_DOCKER_CLI_SHA256}" ]] \
    || die 'the exported local Docker CLI does not match its pinned SHA-256 identity'
  chmod 555 -- "${VERIFICATION_RUNTIME_ROOT}/bin/docker"

  cache_admission_contract="${run_stage}/verification-cache-admission-contract.json"
  node - "${cache_admission_contract}" "${image_id}" "${EXPECTED_HARNESS_IMAGE_REVISION}" <<'NODE'
const fs = require('node:fs');
const [file, imageId, runnerRevision] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  schemaVersion: 1,
  projectSlug: 'forge-harness-eval',
  runnerRevision,
  toolchainImage: imageId,
  cacheRoot: '/cache-packs',
  stateRoot: '/verification-state',
  profiles: [
    'governance', 'backend-red-test', 'frontend-red-test',
    'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build',
    'changed-safe', 'full-regression',
  ],
  limits: { maxFiles: 250000, maxBytes: 4294967296, maxLogBytes: 8388608, defaultTimeoutSeconds: 900 },
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
  cache_admission_contract_docker="$(docker_host_path "${cache_admission_contract}")"
  source_cache_parent="$(dirname -- "${VERIFICATION_CACHE_PACK}")"
  source_cache_parent_docker="$(docker_host_path "${source_cache_parent}")"

  # Both validations execute in the immutable candidate with no network and no
  # Docker socket. The first admits caller-supplied bytes; the second admits the
  # independently copied run-owned pack that the Runner will actually consume.
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
    --mount "type=bind,src=${cache_admission_contract_docker},dst=/contract.json,readonly" \
    --mount "type=bind,src=${source_cache_parent_docker},dst=/cache-packs,readonly" \
    --mount "type=bind,src=$(docker_host_path "${SOURCE_PATH}"),dst=/workspace,readonly" \
    "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
      --workspace /workspace --contract /contract.json --fingerprint "${VERIFICATION_CACHE_FINGERPRINT}" >/dev/null \
    || die 'the caller-supplied verification cache pack failed networkless admission'

  imported_cache_pack="${VERIFICATION_RUNTIME_ROOT}/cache-packs/${VERIFICATION_CACHE_FINGERPRINT}"
  node - "${VERIFICATION_CACHE_PACK}" "${imported_cache_pack}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [sourceInput, targetInput] = process.argv.slice(2);
const source = fs.realpathSync(sourceInput);
const sourceInfo = fs.lstatSync(source);
if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('cache pack source is invalid');
  fs.mkdirSync(targetInput, { mode: 0o555 });
const copy = (from, to) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    const info = fs.lstatSync(sourcePath);
    if (info.isSymbolicLink()) throw new Error('cache pack contains a symbolic link');
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { mode: 0o555 });
      copy(sourcePath, targetPath);
    } else if (entry.isFile() && info.nlink === 1) {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(targetPath, 0o444);
    } else {
      throw new Error('cache pack contains a non-ordinary or linked node');
    }
  }
  fs.chmodSync(to, 0o555);
};
copy(source, targetInput);
NODE
  imported_cache_root_docker="$(docker_host_path "${VERIFICATION_RUNTIME_ROOT}/cache-packs")"
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
    --mount "type=bind,src=${cache_admission_contract_docker},dst=/contract.json,readonly" \
    --mount "type=bind,src=${imported_cache_root_docker},dst=/cache-packs,readonly" \
    --mount "type=bind,src=$(docker_host_path "${SOURCE_PATH}"),dst=/workspace,readonly" \
    "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
      --workspace /workspace --contract /contract.json --fingerprint "${VERIFICATION_CACHE_FINGERPRINT}" >/dev/null \
    || die 'the run-owned verification cache pack failed networkless admission'

  runtime_path_probe="forge-hbe-${run_token}-runtime-path"
  create_owned_container "${runtime_path_probe}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=$(docker_host_path "${VERIFICATION_RUNTIME_ROOT}"),dst=/forge-eval-runtime,readonly" \
    --entrypoint /bin/true "${image_id}"
  VERIFICATION_RUNTIME_DAEMON_ROOT="$(docker container inspect "${runtime_path_probe}" | node -e '
const fs = require("node:fs");
const items = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(items) || items.length !== 1) throw new Error("runtime bind inspection closure mismatch");
const mount = items[0]?.Mounts?.find((entry) => entry.Destination === "/forge-eval-runtime");
if (mount?.Type !== "bind" || mount.RW !== false || typeof mount.Source !== "string"
  || !mount.Source.startsWith("/") || mount.Source.includes(",") || mount.Source.includes("..")) {
  throw new Error("Docker daemon did not return one safe absolute runtime bind source");
}
process.stdout.write(`${mount.Source}\n`);
')" || die 'the Docker daemon-visible runtime path could not be established'
  remove_owned_container "${runtime_path_probe}"

  docker_socket_probe="forge-hbe-${run_token}-runner-socket-admission"
  create_owned_container "${docker_socket_probe}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock" \
    --entrypoint /usr/bin/stat "${image_id}" -c %g /var/run/docker.sock
  socket_probe_exit="$(start_capture "${docker_socket_probe}" \
    "${run_stage}/verification-runner-socket-gid.txt" \
    "${run_stage}/verification-runner-socket-gid.stderr.txt")"
  remove_owned_container "${docker_socket_probe}"
  [[ "${socket_probe_exit}" -eq 0 ]] || die 'the local Docker socket group identity could not be inspected'
  VERIFICATION_DOCKER_SOCKET_GID="$(tr -d '\r\n' <"${run_stage}/verification-runner-socket-gid.txt")"
  [[ "${VERIFICATION_DOCKER_SOCKET_GID}" =~ ^[0-9]+$ ]] \
    || die 'the local Docker socket returned an invalid numeric group identity'

  node - "${run_stage}/verification-cache-admission.json" "${VERIFICATION_CACHE_FINGERPRINT}" \
    "${VERIFICATION_CACHE_MANIFEST_SHA256}" "${image_id}" "${EXPECTED_HARNESS_IMAGE_REVISION}" \
    "container:${VERIFICATION_RUNTIME_DAEMON_ROOT}" <<'NODE'
const fs = require('node:fs');
const [file, fingerprint, manifestSha256, imageId, runnerRevision, daemonRootArg] = process.argv.slice(2);
if (!daemonRootArg.startsWith('container:/')) throw new Error('daemon runtime root must be one typed container path');
const daemonRoot = daemonRootArg.slice('container:'.length);
fs.writeFileSync(file, `${JSON.stringify({
  schemaVersion: 'forge-harness-verification-cache-admission/v1', mode: 'cache-ready',
  dependencyManifestFingerprint: fingerprint, manifestSha256, toolchainImage: imageId,
  runnerRevision, callerPackNetworklessVerified: true, runOwnedPackNetworklessVerified: true,
  importedPackMountedReadOnlyAtExecution: true, dockerDaemonVisibleRuntimeRoot: daemonRoot,
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
fi

INPUT_SNAPSHOT_DIR="${run_stage}/inputs"
node "${ACTIVE_INPUT_SNAPSHOT_HELPER}" create \
  --suite "${SUITE_FILE}" \
  --suite-sha256 "${EXPECTED_SUITE_SHA256}" \
  --analyzer "${ANALYZER_FILE}" \
  --analyzer-sha256 "${EXPECTED_ANALYZER_SHA256}" \
  --destination "${INPUT_SNAPSHOT_DIR}" \
  || die 'the fixed evaluation input closure could not be snapshotted'
verify_input_snapshot || die 'the snapshotted evaluation input closure failed its initial verification'
ACTIVE_SUITE_FILE="${INPUT_SNAPSHOT_DIR}/suite/suite.json"
ACTIVE_ANALYZER_FILE="${INPUT_SNAPSHOT_DIR}/analyzer.mjs"
ACTIVE_FIXTURE_ROOT="${INPUT_SNAPSHOT_DIR}/suite"
ANALYZER_DOCKER_PATH="$(docker_host_path "${ACTIVE_ANALYZER_FILE}")"

node - "${ACTIVE_SUITE_FILE}" "${ACTIVE_FIXTURE_ROOT}" "${REQUIRED_SOURCE_COMMIT}" \
  "${DEFAULT_MAX_MODEL_REQUESTS}" "${MAX_ALLOWED_MODEL_REQUESTS}" \
  "${DEFAULT_MODEL_TIMEOUT_SECONDS}" "${MIN_MODEL_TIMEOUT_SECONDS}" "${MAX_MODEL_TIMEOUT_SECONDS}" \
  "${MODEL_STOP_GRACE_SECONDS}" "${PHASE_STEP_BUDGET}" \
  "${EXPECTED_CONFIGURED_PROVIDER}" "${EXPECTED_REQUEST_MODEL}" "${EXPECTED_UPSTREAM_ORIGIN}" \
  "${MAX_OUTPUT_TOKENS_PER_REQUEST}" "${MAX_PROXY_REQUEST_BYTES}" "${MAX_PROXY_TOTAL_REQUEST_BYTES}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [suitePath, root, requiredCommit, defaultRequests, maxRequests, defaultTimeout, minTimeout, maxTimeout, stopGrace, phaseStepBudget,
  configuredProvider, requestModel, upstreamOrigin, maxOutputTokens, maxRequestBytes, maxTotalRequestBytes] = process.argv.slice(2);
const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (suite.schemaVersion !== 1 || suite.source?.commit !== requiredCommit) throw new Error('suite source contract mismatch');
if (suite.dsh?.profile !== 'headless') throw new Error('suite must use the headless profile');
if (suite.dsh?.sessionPersistence?.compression !== 'none' || suite.dsh?.sessionPersistence?.packChunks !== false) throw new Error('suite must preserve unpacked raw JSONL');
const modelContract = suite.dsh?.modelContract;
if (modelContract?.configuredProvider !== configuredProvider
  || modelContract?.requestModel !== requestModel
  || modelContract?.upstreamOrigin !== upstreamOrigin
  || modelContract?.maxOutputTokensPerRequest !== Number(maxOutputTokens)
  || modelContract?.maxRequestBytes !== Number(maxRequestBytes)
  || modelContract?.maxTotalRequestBytes !== Number(maxTotalRequestBytes)) {
  throw new Error('suite model contract mismatch');
}
if (suite.dsh?.credentialBoundary?.mode !== 'fixed-upstream-header-injecting-sidecar'
  || suite.dsh?.credentialBoundary?.modelContainerKeyMount !== false
  || suite.dsh?.credentialBoundary?.webToolsDisabled !== true) throw new Error('suite credential boundary mismatch');
const requestBudget = suite.dsh?.credentialBoundary?.requestBudgetPerCase;
if (requestBudget?.default !== Number(defaultRequests) || requestBudget?.minimum !== 1
  || requestBudget?.maximum !== Number(maxRequests) || requestBudget?.disableable !== false) {
  throw new Error('suite request budget mismatch');
}
const modelTimeout = suite.dsh?.executionBoundary?.modelAttachDeadlineSeconds;
if (modelTimeout?.default !== Number(defaultTimeout) || modelTimeout?.minimum !== Number(minTimeout)
  || modelTimeout?.maximum !== Number(maxTimeout) || modelTimeout?.disableable !== false) {
  throw new Error('suite model timeout mismatch');
}
if (suite.dsh?.executionBoundary?.phaseStepBudget !== Number(phaseStepBudget)
  || suite.dsh?.executionBoundary?.dockerStopGraceSeconds !== Number(stopGrace)
  || suite.dsh?.executionBoundary?.hostTotalDurationBoundProven !== false) {
  throw new Error('suite model supervision proof boundary mismatch');
}
const rootPath = path.resolve(root);
const patchPath = path.resolve(root, suite.dsh.patch);
if (!patchPath.startsWith(rootPath + path.sep) || hash(patchPath) !== suite.dsh.patchSha256) throw new Error('headless patch hash mismatch');
const executionPolicyPath = path.resolve(root, suite.dsh.executionPolicy);
if (!executionPolicyPath.startsWith(rootPath + path.sep)
  || hash(executionPolicyPath) !== suite.dsh.executionPolicySha256) {
  throw new Error('test-shadow execution policy hash mismatch');
}
const executionPolicy = JSON.parse(fs.readFileSync(executionPolicyPath, 'utf8'));
if (executionPolicy.schemaVersion !== 1 || executionPolicy.policyMode !== 'test-shadow'
  || executionPolicy.defaultActionCeiling !== 'read-only'
  || !Array.isArray(executionPolicy.writerRoutes) || executionPolicy.writerRoutes.length !== 4) {
  throw new Error('test-shadow execution policy boundary mismatch');
}
const expectedCaseIds = ['crud-complete', 'edge-pagination-shared-owner', 'frontend-aicrudpage-api-contract', 'adversarial-shortcuts'];
if (!Array.isArray(suite.cases)
  || JSON.stringify(suite.cases.map((item) => item.id)) !== JSON.stringify(expectedCaseIds)
  || new Set(suite.cases.map((item) => item.id)).size !== expectedCaseIds.length) {
  throw new Error('suite must contain the four reviewed cases in canonical order');
}
for (const item of suite.cases) {
  if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error('unsafe case id');
  const expectedWorkflow = ['crud-complete', 'adversarial-shortcuts'].includes(item.id)
    ? 'crud-production' : undefined;
  if (item.phaseWorkflowId !== expectedWorkflow) {
    throw new Error('case phase workflow contract mismatch: ' + item.id);
  }
  const skills = item.expectedTrace?.skillCallsAll;
  if (!Array.isArray(skills) || skills.length < 1 || new Set(skills).size !== skills.length
    || skills.some((skill) => typeof skill !== 'string' || !/^[a-z0-9-]+$/.test(skill))
    || item.expectedTrace?.skillCallsAny !== undefined
    || !skills.includes('forge-task-router')
    || !skills.includes('forge-testing-observability')
    || !skills.includes('forge-evidence-truth')) {
    throw new Error('case required Skill contract mismatch: ' + item.id);
  }
  if (JSON.stringify([...(item.expectedTrace?.mutationToolsAny ?? [])].sort())
      !== JSON.stringify(['edit', 'str_replace_editor', 'write'])) {
    throw new Error('case mutation tool contract mismatch: ' + item.id);
  }
  if (item.semanticReviewRequired !== true) throw new Error('case semantic review boundary is missing: ' + item.id);
  const promptPath = path.resolve(root, item.prompt);
  if (!promptPath.startsWith(rootPath + path.sep) || hash(promptPath) !== item.promptSha256) throw new Error('prompt hash mismatch: ' + item.id);
  const text = fs.readFileSync(promptPath, 'utf8');
  for (const marker of ['Prompt-Version:', 'Baseline:', 'Case-ID:', '## 完成边界', '## 验收闭环']) {
    if (!text.includes(marker)) throw new Error('prompt closure marker missing: ' + item.id + ': ' + marker);
  }
}
NODE

case_rows_text="$(node - "${ACTIVE_SUITE_FILE}" <<'NODE'
const fs = require('node:fs');
const suite = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const item of suite.cases) process.stdout.write([
  item.id, item.promptVersion, item.prompt, item.promptSha256, suite.suiteVersion,
  suite.dsh.patch, item.phaseWorkflowId ?? '-',
].join('\t') + '\n');
NODE
)" || die 'the snapshotted suite case closure could not be read'
mapfile -t CASE_ROWS < <(printf '%s\n' "${case_rows_text}")

patch_relative="$(node - "${ACTIVE_SUITE_FILE}" <<'NODE'
const fs = require('node:fs');
const suite = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (typeof suite.dsh?.patch !== 'string' || suite.dsh.patch.length < 1) throw new Error('suite patch path is missing');
process.stdout.write(suite.dsh.patch);
NODE
)" || die 'the snapshotted suite patch identity could not be read'
ACTIVE_PATCH_FILE="${ACTIVE_FIXTURE_ROOT}/${patch_relative}"
node - "${ACTIVE_PATCH_FILE}" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
if (process.platform !== 'win32') {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    fs.chownSync(file, 1000, 1000);
  }
  const info = fs.lstatSync(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
    || info.uid !== 1000n || info.gid !== 1000n || (info.mode & 0o7777n) !== 0o400n) {
    throw new Error('headless patch snapshot is not readable only by the fixed model uid');
  }
}
NODE
verify_input_snapshot || die 'the evaluation input closure changed while binding the headless patch to the fixed model uid'
ACTIVE_PATCH_DOCKER_PATH="$(docker_host_path "${ACTIVE_PATCH_FILE}")"

execution_policy_relative="$(node - "${ACTIVE_SUITE_FILE}" <<'NODE'
const fs = require('node:fs');
const suite = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (typeof suite.dsh?.executionPolicy !== 'string' || suite.dsh.executionPolicy.length < 1) {
  throw new Error('suite execution policy path is missing');
}
process.stdout.write(suite.dsh.executionPolicy);
NODE
)" || die 'the snapshotted test-shadow execution policy identity could not be read'
ACTIVE_EXECUTION_POLICY_FILE="${ACTIVE_FIXTURE_ROOT}/${execution_policy_relative}"
ACTIVE_EXECUTION_POLICY_DOCKER_PATH="$(docker_host_path "${ACTIVE_EXECUTION_POLICY_FILE}")"

input_lock_row="$(node - "${INPUT_SNAPSHOT_DIR}/input-lock.json" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = process.argv[2];
const bytes = fs.readFileSync(file);
const lock = JSON.parse(bytes.toString('utf8'));
if (lock.schemaVersion !== 'forge-harness-eval-input-lock/v1' || !/^[0-9a-f]{64}$/.test(lock.closureDigest)) {
  throw new Error('invalid evaluation input lock identity');
}
process.stdout.write(`${lock.closureDigest}\t${crypto.createHash('sha256').update(bytes).digest('hex')}\n`);
NODE
)" || die 'the snapshotted evaluation input lock could not be read'
IFS=$'\t' read -r INPUT_CLOSURE_DIGEST INPUT_LOCK_SHA256 <<<"${input_lock_row}"
[[ "${INPUT_CLOSURE_DIGEST}" =~ ^[0-9a-f]{64}$ && "${INPUT_LOCK_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die 'the snapshotted evaluation input lock returned an invalid digest'

# Paid execution is not admitted until the exact candidate image proves its
# immutable Web preset roster and assembled prompt contract without network.
agent_preset_admission_container="forge-hbe-${run_token}-agent-preset-admission"
verify_input_snapshot || die 'the evaluation input closure changed before agent-preset admission'
create_owned_container "${agent_preset_admission_container}" \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 \
  --user 1000:1000 --workdir /workspace \
  --entrypoint /bin/sh "${image_id}" \
    -lc 'set -eu; node /usr/local/lib/forge-agent-preset-policy.mjs verify --root /opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh/config/agent-presets; cat /usr/local/share/forge-image-build/agent-preset-prompt-contract.json'
agent_preset_admission_exit="$(start_capture "${agent_preset_admission_container}" \
  "${run_stage}/agent-preset-admission.stdout.txt" "${run_stage}/agent-preset-admission.stderr.txt")"
printf '%s\n' "${agent_preset_admission_exit}" >"${run_stage}/agent-preset-admission.exit-code.txt"
docker container inspect "${agent_preset_admission_container}" >"${run_stage}/agent-preset-admission.container.inspect.json"
node "${ACTIVE_ANALYZER_FILE}" prove-agent-presets \
  --input "${run_stage}/agent-preset-admission.stdout.txt" \
  --stderr "${run_stage}/agent-preset-admission.stderr.txt" \
  --container-inspect "${run_stage}/agent-preset-admission.container.inspect.json" \
  --expected-image-id "${image_id}" \
  --output "${run_stage}/agent-preset-admission.receipt.json"
remove_owned_container "${agent_preset_admission_container}"
[[ "${agent_preset_admission_exit}" -eq 0 ]] \
  || die 'candidate agent-preset admission exited nonzero; paid execution was not started'
verify_input_snapshot || die 'the evaluation input closure changed during agent-preset admission'

# Paid execution is also blocked until the exact candidate image proves its
# effective headless DSH configuration with only a non-secret placeholder.
config_admission_container="forge-hbe-${run_token}-dsh-config-admission"
verify_input_snapshot || die 'the evaluation input closure changed before DSH config admission'
create_owned_container "${config_admission_container}" \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 \
  --user 1000:1000 --workdir /workspace \
  --env DSH_PERMISSION_MODE=workspace-write --env DSH_TELEMETRY_MODE=DISABLED \
  --env "FORGE_EVAL_PROXY_CREDENTIAL=${MODEL_CREDENTIAL_PLACEHOLDER}" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700 \
  --tmpfs /home/node/.dsh:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${ACTIVE_PATCH_DOCKER_PATH},dst=/eval/headless-audit.patch.yml,readonly" \
  --entrypoint /usr/local/bin/dsh "${image_id}" \
    --profile headless --patch /eval/headless-audit.patch.yml --dump-config
config_admission_exit="$(start_capture "${config_admission_container}" \
  "${run_stage}/dsh-config-admission.stdout.txt" "${run_stage}/dsh-config-admission.stderr.txt")"
printf '%s\n' "${config_admission_exit}" >"${run_stage}/dsh-config-admission.exit-code.txt"
docker container inspect "${config_admission_container}" >"${run_stage}/dsh-config-admission.container.inspect.json"
node "${ACTIVE_ANALYZER_FILE}" prove-dsh-config \
  --input "${run_stage}/dsh-config-admission.stdout.txt" \
  --stderr "${run_stage}/dsh-config-admission.stderr.txt" \
  --container-inspect "${run_stage}/dsh-config-admission.container.inspect.json" \
  --expected-image-id "${image_id}" \
  --expected-patch-source "${ACTIVE_PATCH_FILE}" \
  --expected-provider "${EXPECTED_CONFIGURED_PROVIDER}" \
  --expected-model "${EXPECTED_REQUEST_MODEL}" \
  --expected-placeholder-env-name FORGE_EVAL_PROXY_CREDENTIAL \
  --expected-placeholder-env-value "${MODEL_CREDENTIAL_PLACEHOLDER}" \
  --expected-base-url http://credential-proxy:8080 \
  --expected-api-key-env FORGE_EVAL_PROXY_CREDENTIAL \
  --output "${run_stage}/dsh-config-admission.receipt.json"
remove_owned_container "${config_admission_container}"
[[ "${config_admission_exit}" -eq 0 ]] || die 'candidate DSH config admission exited nonzero; paid execution was not started'
verify_input_snapshot || die 'the evaluation input closure changed during DSH config admission'

verify_runtime_tools_snapshot || die 'the runtime-tools snapshot changed before credential snapshot creation'
node "${ACTIVE_SECRET_SNAPSHOT_HELPER}" --source "${KEY_FILE}" --destination "${SECRET_SNAPSHOT_FILE}" \
  || die 'the stable private credential snapshot could not be created'
node "${ACTIVE_SECRET_SNAPSHOT_HELPER}" --generate-bytes 32 --destination "${BROKER_TOKEN_SNAPSHOT_FILE}" \
  || die 'the protected TaskSpace Broker token snapshot could not be created'
node - "${BROKER_TOKEN_SNAPSHOT_FILE}" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
if (process.platform !== 'win32') {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    fs.chownSync(file, 1000, 1000);
  }
  const info = fs.lstatSync(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
    || info.uid !== 1000n || info.gid !== 1000n || (info.mode & 0o7777n) !== 0o600n) {
    throw new Error('protected Broker token snapshot is not readable only by the fixed runtime uid');
  }
}
NODE
SECRET_SNAPSHOT_DOCKER_PATH="$(docker_host_path "${SECRET_SNAPSHOT_FILE}")"
BROKER_TOKEN_SNAPSHOT_DOCKER_PATH="$(docker_host_path "${BROKER_TOKEN_SNAPSHOT_FILE}")"
declare -a COMPLETED_CASES=()

for row in "${CASE_ROWS[@]}"; do
  IFS=$'\t' read -r case_id prompt_version prompt_relative prompt_sha suite_version patch_relative phase_workflow_id <<<"${row}"
  [[ "${phase_workflow_id}" != '-' ]] || phase_workflow_id=""
  if [[ "${CASE_FILTER}" != "all" && "${CASE_FILTER}" != "${case_id}" ]]; then continue; fi
  verify_input_snapshot || die "the evaluation input closure changed before case execution: ${case_id}"

  case_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case_dir="${run_stage}/${case_id}"
  mkdir -p -- "${case_dir}/session"
  case_session_docker_path="$(docker_host_path "${case_dir}/session")"
  prompt_file="${ACTIVE_FIXTURE_ROOT}/${prompt_relative}"
  patch_file="${ACTIVE_FIXTURE_ROOT}/${patch_relative}"
  prompt_file_docker="$(docker_host_path "${prompt_file}")"
  patch_file_docker="$(docker_host_path "${patch_file}")"
  [[ "$(sha256_file "${prompt_file}")" == "${prompt_sha}" ]] || die "prompt changed after suite admission: ${case_id}"

  resource_prefix="forge-hbe-${run_token}-${case_id:0:24}"
  workspace_volume="${resource_prefix}-workspace"
  git_metadata_volume="${resource_prefix}-git-metadata"
  dsh_home_volume="${resource_prefix}-dsh-home"
  verification_control_volume="${resource_prefix}-verification-control"
  verification_ipc_volume="${resource_prefix}-verification-ipc"
  verification_source_ipc_volume="${resource_prefix}-verification-source-ipc"
  prompt_volume="${resource_prefix}-model-prompt"
  case_network="${resource_prefix}-model-internal"
  proxy_egress_network="${resource_prefix}-proxy-egress"
  seed_container="${resource_prefix}-seed"
  admission_container="${resource_prefix}-baseline-admission"
  proxy_container="${resource_prefix}-credential-proxy"
  proxy_probe_container="${resource_prefix}-proxy-probe"
  verification_runner_container="${resource_prefix}-verification-runner"
  verification_probe_container="${resource_prefix}-verification-probe"
  broker_container="${resource_prefix}-taskspace-broker"
  broker_probe_container="${resource_prefix}-broker-probe"
  model_container="${resource_prefix}-model"
  status_container="${resource_prefix}-status"
  diff_container="${resource_prefix}-diff"
  workspace_patch_container="${resource_prefix}-workspace-patch"
  audit_container="${resource_prefix}-audit"
  eval_project_slug="forge-harness-eval"
  eval_task_id="eval-${case_id:0:36}"
  eval_actor_id="hbe-agent"
  eval_actor_user_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  eval_conversation_id="hbe:${run_token}:${case_id}"
  eval_headless_session_id="session-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  eval_headless_rpc_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  initial_phase_index=0
  if [[ -n "${DATABASE_CONTINUATION_SOURCE}" ]]; then
    continuation_identity="$(inspect_database_continuation_source)" \
      || die 'database continuation source admission failed before model execution'
    mapfile -t continuation_identity_fields <<<"${continuation_identity}"
    [[ "${#continuation_identity_fields[@]}" -eq 3 ]] || die 'database continuation identity is incomplete'
    eval_headless_session_id="${continuation_identity_fields[0]}"
    database_parent_run_token="${continuation_identity_fields[1]}"
    database_parent_dsh_volume="${continuation_identity_fields[2]}"
    initial_phase_index=2
  elif [[ -n "${BACKEND_CONTINUATION_SOURCE}" ]]; then
    continuation_identity="$(inspect_backend_continuation_source)" \
      || die 'backend continuation source admission failed before model execution'
    mapfile -t continuation_identity_fields <<<"${continuation_identity}"
    [[ "${#continuation_identity_fields[@]}" -eq 4 ]] || die 'backend continuation identity is incomplete'
    eval_headless_session_id="${continuation_identity_fields[0]}"
    database_parent_run_token="${continuation_identity_fields[1]}"
    database_parent_dsh_volume="${continuation_identity_fields[2]}"
    BACKEND_CONTINUATION_PATCH_SHA256="${continuation_identity_fields[3]}"
    initial_phase_index=5
  elif [[ -n "${FRONTEND_RETRY_SOURCE}" ]]; then
    continuation_identity="$(inspect_frontend_retry_source)" \
      || die 'frontend retry source admission failed before model execution'
    mapfile -t continuation_identity_fields <<<"${continuation_identity}"
    [[ "${#continuation_identity_fields[@]}" -eq 4 ]] || die 'frontend retry identity is incomplete'
    eval_headless_session_id="${continuation_identity_fields[0]}"
    database_parent_run_token="${continuation_identity_fields[1]}"
    database_parent_dsh_volume="${continuation_identity_fields[2]}"
    FRONTEND_RETRY_PATCH_SHA256="${continuation_identity_fields[3]}"
    initial_phase_index=5
  elif [[ -n "${ACCESS_WIRING_CONTINUATION_SOURCE}" ]]; then
    continuation_identity="$(inspect_access_wiring_continuation_source)" \
      || die 'access wiring continuation source admission failed before model execution'
    mapfile -t continuation_identity_fields <<<"${continuation_identity}"
    [[ "${#continuation_identity_fields[@]}" -eq 4 ]] || die 'access wiring continuation identity is incomplete'
    eval_headless_session_id="${continuation_identity_fields[0]}"
    database_parent_run_token="${continuation_identity_fields[1]}"
    database_parent_dsh_volume="${continuation_identity_fields[2]}"
    ACCESS_WIRING_CONTINUATION_PATCH_SHA256="${continuation_identity_fields[3]}"
    initial_phase_index=6
  elif [[ -n "${CROSS_LAYER_CONTINUATION_SOURCE}" ]]; then
    continuation_identity="$(inspect_cross_layer_continuation_source)" \
      || die 'cross-layer continuation source admission failed before model execution'
    mapfile -t continuation_identity_fields <<<"${continuation_identity}"
    [[ "${#continuation_identity_fields[@]}" -eq 4 ]] || die 'cross-layer continuation identity is incomplete'
    eval_headless_session_id="${continuation_identity_fields[0]}"
    database_parent_run_token="${continuation_identity_fields[1]}"
    database_parent_dsh_volume="${continuation_identity_fields[2]}"
    CROSS_LAYER_CONTINUATION_PATCH_SHA256="${continuation_identity_fields[3]}"
    initial_phase_index=7
  fi
  verification_runner_socket=/run/forge-verify/runner.sock
  verification_source_socket=/run/forge-verify-source/source.sock
  case_seed_source_path="${SOURCE_PATH}"
  verification_ipc_mount="type=volume,src=${verification_ipc_volume},dst=/run/forge-verify,volume-nocopy"
  verification_source_ipc_mount="type=volume,src=${verification_source_ipc_volume},dst=/run/forge-verify-source,volume-nocopy"
  verification_ipc_readonly_mount="type=volume,src=${verification_ipc_volume},dst=/run/forge-verify,readonly,volume-nocopy"
  verification_source_ipc_readonly_mount="type=volume,src=${verification_source_ipc_volume},dst=/run/forge-verify-source,readonly,volume-nocopy"
  if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
    prepare_native_host_runtime
    case_runtime_host="${HOST_RUNTIME_ROOT}/cases/${case_id}"
    case_runtime_daemon="${case_runtime_host}"
    case_workspace_source="${case_runtime_host}/taskspaces/${eval_task_id}/workspace"
    case_git_source="${case_workspace_source}/.git"
    mkdir -p -- "${case_git_source}" "${case_runtime_host}/verification" "${case_runtime_host}/workspace" \
      "${HOST_IPC_ROOT}/runner" "${HOST_IPC_ROOT}/source"
    if [[ "${local_uid}" -eq 0 ]]; then chown -R 1000:1000 -- "${HOST_RUNTIME_ROOT}" "${HOST_IPC_ROOT}"; fi
    verification_contract_cache_root="${HOST_STATE_ROOT}/taskspaces/${eval_task_id}/cache"
    verification_contract_state_root="${HOST_STATE_ROOT}"
    host_profile_runtime_root="${HOST_RUNTIME_ROOT}/host-profile-runtime"
    verification_runner_socket="${HOST_IPC_ROOT}/runner/runner.sock"
    verification_source_socket="${HOST_IPC_ROOT}/source/source.sock"
    verification_ipc_mount="type=bind,src=${HOST_IPC_ROOT}/runner,dst=/run/forge-verify"
    verification_source_ipc_mount="type=bind,src=${HOST_IPC_ROOT}/source,dst=/run/forge-verify-source"
    verification_ipc_readonly_mount="type=bind,src=${HOST_IPC_ROOT}/runner,dst=${HOST_IPC_ROOT}/runner,readonly"
    verification_source_ipc_readonly_mount="type=bind,src=${HOST_IPC_ROOT}/source,dst=${HOST_IPC_ROOT}/source,readonly"
    "${HOST_USER_COMMAND[@]}" env -i PATH="${PATH}" HOME="${HOST_STATE_ROOT}" \
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      git clone --no-hardlinks -- "${SOURCE_PATH}" "${HOST_RUNTIME_ROOT}/baseline" \
      >"${case_dir}/host-baseline.stdout.txt" 2>"${case_dir}/host-baseline.stderr.txt"
    if [[ "${local_uid}" -eq 0 ]]; then chown -R 1000:1000 -- "${HOST_RUNTIME_ROOT}/baseline"; fi
    case_seed_source_path="${HOST_RUNTIME_ROOT}/baseline"
  elif [[ "${VERIFICATION_MODE}" == 'cache-ready' ]]; then
    case_runtime_host="${VERIFICATION_RUNTIME_ROOT}/cases/${case_id}"
    case_runtime_daemon="${VERIFICATION_RUNTIME_DAEMON_ROOT}/cases/${case_id}"
    mkdir -p -- "${case_runtime_host}/taskspaces/${eval_task_id}/workspace" \
      "${case_runtime_host}/taskspaces/${eval_task_id}/git-meta" \
      "${case_runtime_host}/verification/state" "${case_runtime_host}/workspace"
    case_workspace_source="$(docker_host_path "${case_runtime_host}/taskspaces/${eval_task_id}/workspace")"
    case_git_source="$(docker_host_path "${case_runtime_host}/taskspaces/${eval_task_id}/git-meta")"
    verification_contract_cache_root="${VERIFICATION_RUNTIME_DAEMON_ROOT}/cache-packs"
    verification_contract_state_root="${case_runtime_daemon}/verification/state"
    host_profile_runtime_root="${case_runtime_host}/host-profile-runtime"
  else
    case_runtime_host=""
    case_runtime_daemon="/eval-project"
    case_workspace_source="${workspace_volume}"
    case_git_source="${git_metadata_volume}"
    verification_contract_cache_root="/eval-project/verification/cache-packs"
    verification_contract_state_root="/eval-project/verification/state"
    host_profile_runtime_root=""
  fi
  if [[ "${VERIFICATION_MODE}" != 'cache-miss' ]]; then
    observer_workspace_mount="type=bind,src=${case_workspace_source},dst=/workspace,readonly"
    observer_git_mount="type=bind,src=${case_git_source},dst=/workspace/.git,readonly"
  else
    observer_workspace_mount="type=volume,src=${workspace_volume},dst=/workspace,readonly,volume-nocopy"
    observer_git_mount="type=volume,src=${git_metadata_volume},dst=/workspace/.git,readonly,volume-nocopy"
  fi
  phase_catalog_file="${EXTERNAL_SKILLS_BUNDLE}/skills/forge-task-router/references/phase-profiles.json"
  phase_catalog_docker_path="$(docker_host_path "${phase_catalog_file}")"
  phase_control_dir="${case_dir}/phase-control"
  phase_control_docker_path="$(docker_host_path "${phase_control_dir}")"
  seed_prompt_file_docker="${prompt_file_docker}"
  seed_phase_args=()
  phase_workflow_descriptor='null'
  MODEL_PHASE_IDS=(legacy-one-shot)
  if [[ -n "${phase_workflow_id}" ]]; then
    phase_workflow_descriptor="$(node - "${ACTIVE_PHASE_RUNTIME}" "${phase_catalog_file}" \
      "${phase_workflow_id}" "${case_id}" <<'NODE'
const { pathToFileURL } = require('node:url');
const [runtimeFile, catalogFile, workflowId, caseFamily] = process.argv.slice(2);
(async () => {
  const runtime = await import(pathToFileURL(runtimeFile).href);
  const loaded = await runtime.loadForgeDeliveryPhaseCatalog(catalogFile);
  const descriptor = runtime.describeForgeDeliveryPhaseWorkflow({
    catalog: loaded.catalog,
    workflowId,
    caseFamily,
  });
  process.stdout.write(JSON.stringify(descriptor));
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
NODE
    )" || die "phase workflow catalog admission failed for ${case_id}"
    phase_ids_text="$(node -e '
const descriptor = JSON.parse(process.argv[1]);
if (!Number.isSafeInteger(descriptor.phaseCount)
  || descriptor.phaseCount !== descriptor.orderedPhases?.length
  || descriptor.phaseCount !== descriptor.phases?.length) process.exit(1);
for (const phaseId of descriptor.orderedPhases) process.stdout.write(`${phaseId}\n`);
' "${phase_workflow_descriptor}")" || die "phase workflow descriptor is invalid for ${case_id}"
    mapfile -t MODEL_PHASE_IDS < <(printf '%s' "${phase_ids_text}")
    [[ "${#MODEL_PHASE_IDS[@]}" -ge 2 ]] || die "phase workflow contains too few stages for ${case_id}"
    if [[ "${PREFLIGHT_ONLY}" -eq 0 && "${VERIFICATION_MODE}" == 'cache-miss' ]]; then
      die "phased paid execution requires cache-ready mode so the Host Runner receives a run-owned host workspace: ${case_id}"
    fi
    if [[ -z "${DATABASE_CONTINUATION_SOURCE}${BACKEND_CONTINUATION_SOURCE}${FRONTEND_RETRY_SOURCE}${ACCESS_WIRING_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_SOURCE}" ]]; then
      mkdir -p -- "${phase_control_dir}"
      chmod 700 -- "${phase_control_dir}"
    fi
    phase_controller_init_container="${resource_prefix}-phase-init"
    run_phase_controller_initialize "${phase_controller_init_container}" \
      "${case_dir}/phase-controller-init.stdout.txt" "${case_dir}/phase-controller-init.stderr.txt" \
      || die "phase controller initialization failed for ${case_id}"
    seed_prompt_file_docker="$(docker_host_path "${phase_control_dir}/current-prompt.md")"
    seed_phase_args=(
      --mount "type=bind,src=${phase_control_docker_path},dst=/phase-control"
      --mount "type=bind,src=${phase_catalog_docker_path},dst=/phase-catalog.json,readonly"
      --env "FORGE_EVAL_PHASE_WORKFLOW_ID=${phase_workflow_id}"
      --env "FORGE_EVAL_PHASE_ID=${MODEL_PHASE_IDS[initial_phase_index]}"
      --env FORGE_EVAL_PHASE_CATALOG_FILE=/phase-catalog.json
      --env FORGE_EVAL_PHASE_STATE_FILE=/phase-control/state.json
    )
    if [[ -n "${FRONTEND_RETRY_SOURCE}${ACCESS_WIRING_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_SOURCE}" ]]; then
      seed_phase_args+=(--env FORGE_EVAL_PROMPT_FILE=/phase-control/current-prompt.md)
    fi
    if [[ -n "${DATABASE_CONTINUATION_SOURCE}" ]]; then
      seed_phase_args+=(--env FORGE_EVAL_DATABASE_CONTINUATION_RECEIPT_FILE=/phase-control/continuation-receipt.json)
    elif [[ -n "${BACKEND_CONTINUATION_SOURCE}" ]]; then
      seed_phase_args+=(--env FORGE_EVAL_BACKEND_CONTINUATION_RECEIPT_FILE=/phase-control/backend-continuation-receipt.json)
    elif [[ -n "${ACCESS_WIRING_CONTINUATION_SOURCE}" ]]; then
      seed_phase_args+=(--env FORGE_EVAL_ACCESS_WIRING_CONTINUATION_RECEIPT_FILE=/phase-control/access-wiring-continuation-receipt.json)
    elif [[ -n "${CROSS_LAYER_CONTINUATION_SOURCE}" ]]; then
      seed_phase_args+=(--env FORGE_EVAL_CROSS_LAYER_CONTINUATION_RECEIPT_FILE=/phase-control/cross-layer-continuation-receipt.json)
    fi
  fi
  broker_token_sha256="$(node - "${BROKER_TOKEN_SNAPSHOT_FILE}" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const token = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error('generated Broker token shape is invalid');
process.stdout.write(`${crypto.createHash('sha256').update(token, 'utf8').digest('hex')}\n`);
NODE
)" || die "generated Broker token hash could not be derived for ${case_id}"
  case_taskspace_metadata_file="${case_dir}/taskspace-metadata.json"
  case_verification_contract_file="${case_dir}/verification-contract.json"
  case_execution_receipt_file="${case_dir}/protected-execution.test-shadow.receipt.json"
  node - "${case_execution_receipt_file}" <<'NODE'
const fs = require('node:fs');
fs.closeSync(fs.openSync(process.argv[2], 'wx', 0o600));
NODE
  case_taskspace_metadata_docker="$(docker_host_path "${case_taskspace_metadata_file}")"
  case_verification_contract_docker="$(docker_host_path "${case_verification_contract_file}")"
  case_execution_receipt_docker="$(docker_host_path "${case_execution_receipt_file}")"
  node - "${case_taskspace_metadata_file}" "${case_verification_contract_file}" \
    "${eval_project_slug}" "${eval_task_id}" "${eval_actor_id}" "${eval_actor_user_id}" "${eval_conversation_id}" \
    "${broker_token_sha256}" "${case_started_at}" "${image_id}" "${EXPECTED_HARNESS_IMAGE_REVISION}" \
    "container:${verification_contract_cache_root}" "container:${verification_contract_state_root}" \
    "${VERIFICATION_MODE}" "${HOST_RUNNER_BUNDLE}" "${case_runtime_daemon}/taskspaces" "${EXPECTED_PHASE_CATALOG_VERSION}" <<'NODE'
const fs = require('node:fs');
const [metadataFile, contractFile, projectSlug, taskId, actorId, actorUserId, conversationId,
  accessTokenHash, createdAt, imageId, runnerRevision, cacheRootArg, stateRootArg, verificationMode, hostBundle, taskspacesRoot, profileCatalogVersion] = process.argv.slice(2);
const containerPath = (value, label) => {
  if (!value.startsWith('container:/')) throw new Error(`${label} must be one typed container path`);
  return value.slice('container:'.length);
};
const cacheRoot = containerPath(cacheRootArg, 'cache root');
const stateRoot = containerPath(stateRootArg, 'state root');
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
});
write(metadataFile, {
  schemaVersion: 2, projectSlug, taskId, actorId, actorUserId, conversationId,
  branch: `task/${actorId}/${taskId}`,
  baseCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
  status: 'active', createdAt, updatedAt: createdAt, accessTokenHash,
  harnessPort: 1, accessMode: 'conversation', lastCandidate: null, lastRelease: null,
});
let hostContract;
if (verificationMode === 'host-toolchain') {
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const executable = (name) => fs.realpathSync(execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'resolve-tool', name], { encoding: 'utf8' }).trim());
  const manifest = JSON.parse(fs.readFileSync(path.join(hostBundle, 'runner.manifest.json'), 'utf8'));
  const java = executable('java');
  hostContract = { schemaVersion: 2, executionMode: 'host-toolchain', projectSlug,
    runnerRevision: `forge-host-runner-${manifest.bundleVersion}`, profileCatalogVersion,
    taskspacesRoot, stateRoot,
    toolchains: { java, javaHome: path.dirname(path.dirname(java)), maven: executable('mvn'), node: executable('node'),
      pnpm: executable('pnpm'), git: executable('git'), forgeGovernance: fs.realpathSync(path.join(hostBundle, 'bin/forge-governance')) } };
}
write(contractFile, {
  ...(hostContract ?? { schemaVersion: 1, projectSlug, runnerRevision, toolchainImage: imageId, cacheRoot, stateRoot }),
  profiles: [
    'governance', 'backend-red-test', 'frontend-red-test',
    'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build',
    'changed-safe', 'full-regression',
  ],
  limits: { maxFiles: 250000, maxBytes: 4294967296, maxLogBytes: 8388608, defaultTimeoutSeconds: 900, ...(hostContract ? { maxConcurrent: 1 } : {}) },
});
NODE

  create_owned_network "${case_network}" internal
  create_owned_network "${proxy_egress_network}" egress
  if [[ "${VERIFICATION_MODE}" == 'cache-miss' ]]; then
    create_owned_volume "${workspace_volume}"
    create_owned_volume "${git_metadata_volume}"
    create_owned_volume "${verification_control_volume}"
  fi
  create_owned_volume "${dsh_home_volume}"
  if [[ -n "${DATABASE_CONTINUATION_SOURCE}${BACKEND_CONTINUATION_SOURCE}${FRONTEND_RETRY_SOURCE}${ACCESS_WIRING_CONTINUATION_SOURCE}${CROSS_LAYER_CONTINUATION_SOURCE}" ]]; then
    copy_database_continuation_session || die 'retained database session could not be copied unchanged'
  fi
  if [[ "${VERIFICATION_MODE}" != 'host-toolchain' ]]; then
    create_owned_volume "${verification_ipc_volume}"
    create_owned_volume "${verification_source_ipc_volume}"
  fi
  create_owned_volume "${prompt_volume}"
  if [[ "${VERIFICATION_MODE}" != 'cache-miss' ]]; then
    seed_workspace_mount="type=bind,src=${case_workspace_source},dst=/workspace"
    seed_git_mount="type=bind,src=${case_git_source},dst=/git-meta"
    seed_control_mount="type=bind,src=$(docker_host_path "${case_runtime_host}"),dst=${case_runtime_daemon}"
  else
    seed_workspace_mount="type=volume,src=${workspace_volume},dst=/workspace,volume-nocopy"
    seed_git_mount="type=volume,src=${git_metadata_volume},dst=/git-meta,volume-nocopy"
    seed_control_mount="type=volume,src=${verification_control_volume},dst=/eval-project,volume-nocopy"
  fi
  # shellcheck disable=SC2016
  create_owned_container "${seed_container}" \
    --network none --read-only --interactive --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true --pids-limit 128 --user 0:0 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=0,gid=0,mode=0700 \
    --mount "type=bind,src=$(docker_host_path "${case_seed_source_path}/.git"),dst=/source.git,readonly" \
    --mount "${seed_workspace_mount}" \
    --mount "${seed_git_mount}" \
    --mount "type=volume,src=${dsh_home_volume},dst=/dsh-home,volume-nocopy" \
    --mount "${seed_control_mount}" \
    --mount "${verification_ipc_mount}" \
    --mount "${verification_source_ipc_mount}" \
    --mount "type=bind,src=${case_taskspace_metadata_docker},dst=/eval/taskspace-metadata.json,readonly" \
    --mount "type=bind,src=${case_verification_contract_docker},dst=/eval/verification-contract.json,readonly" \
    --mount "type=bind,src=${seed_prompt_file_docker},dst=/eval/prompt.md,readonly" \
    --mount "type=bind,src=${ACTIVE_EXECUTION_POLICY_DOCKER_PATH},dst=/eval/execution-policy.json,readonly" \
    --mount "type=bind,src=${case_execution_receipt_docker},dst=/eval/execution-receipt.json" \
    --env "EVAL_VERIFICATION_MODE=${VERIFICATION_MODE}" \
    --env "EVAL_TASK_ID=${eval_task_id}" --env "EVAL_PROJECT_ROOT=${case_runtime_daemon}" \
    --env "FORGE_EVAL_PROJECT_ROOT=${case_runtime_daemon}" \
    --env "PROJECT_SLUG=${eval_project_slug}" \
    --env "FORGE_TASKSPACE_ID=${eval_task_id}" \
    --env "FORGE_TASKSPACE_ACTOR_ID=${eval_actor_id}" \
    --env "FORGE_TASKSPACE_ACTOR_USER_ID=${eval_actor_user_id}" \
    --env "FORGE_TASKSPACE_CONVERSATION_ID=${eval_conversation_id}" \
    --env "FORGE_PROTECTED_HEADLESS_SESSION_ID=${eval_headless_session_id}" \
    --env "FORGE_PROTECTED_HEADLESS_RPC_ID=${eval_headless_rpc_id}" \
    --env "FORGE_EVAL_SOURCE_COMMIT=${REQUIRED_SOURCE_COMMIT}" \
    --env "FORGE_EVAL_CASE_FAMILY=${case_id}" \
    --env FORGE_EVAL_PROMPT_FILE=/eval/prompt.md \
    --env FORGE_EXECUTION_POLICY_FILE=/eval/execution-policy.json \
    "${seed_phase_args[@]}" \
    --entrypoint /bin/sh "${image_id}" -c 'set -eu; chown 0:0 /workspace /git-meta /dsh-home /run/forge-verify /run/forge-verify-source; chown -Rh 0:0 "$EVAL_PROJECT_ROOT"; tar -x -C /workspace; if [ "$EVAL_VERIFICATION_MODE" = host-toolchain ]; then git -c init.defaultBranch=forge-eval-baseline init /workspace; else mkdir /workspace/.git; fi; if [ "$EVAL_VERIFICATION_MODE" != host-toolchain ]; then git -c init.defaultBranch=forge-eval-baseline init --bare /git-meta; fi; git --git-dir=/git-meta fetch --no-tags --update-shallow --upload-pack="git -c safe.directory=/source.git upload-pack" /source.git 908e13bdc08ec2cbb071d355a2c33a77c970bdd3; git --git-dir=/git-meta update-ref refs/heads/forge-eval-baseline 908e13bdc08ec2cbb071d355a2c33a77c970bdd3; git --git-dir=/git-meta config core.bare false; git --git-dir=/git-meta --work-tree=/workspace reset --mixed 908e13bdc08ec2cbb071d355a2c33a77c970bdd3; test "$(git --git-dir=/git-meta --work-tree=/workspace rev-parse HEAD)" = "908e13bdc08ec2cbb071d355a2c33a77c970bdd3"; test -z "$(git --git-dir=/git-meta --work-tree=/workspace status --porcelain=v1 --untracked-files=all)"; mkdir -p "$EVAL_PROJECT_ROOT/taskspaces/${EVAL_TASK_ID}/workspace" "$EVAL_PROJECT_ROOT/verification/state" "$EVAL_PROJECT_ROOT/workspace"; cp /eval/taskspace-metadata.json "$EVAL_PROJECT_ROOT/taskspaces/${EVAL_TASK_ID}/metadata.json"; cp /eval/verification-contract.json "$EVAL_PROJECT_ROOT/verification/contract.json"; node /usr/local/lib/forge-prepare-headless-execution.mjs > /eval/execution-receipt.json; chown -Rh 1000:1000 /workspace /git-meta /dsh-home "$EVAL_PROJECT_ROOT" /run/forge-verify /run/forge-verify-source'
  seed_exit="$(start_archive_seed "${seed_container}" "${case_dir}/seed.stdout.txt" "${case_dir}/seed.stderr.txt" "${case_dir}/seed.archive.stderr.txt" "${case_seed_source_path}")"
  [[ "${seed_exit}" -eq 0 ]] || die "workspace seeding failed for ${case_id}; see retained evidence"
  remove_owned_container "${seed_container}"
  node - "${case_execution_receipt_file}" "${eval_project_slug}" "${eval_task_id}" "${case_id}" "${REQUIRED_SOURCE_COMMIT}" "${phase_workflow_id:-}" "${MODEL_PHASE_IDS[initial_phase_index]}" "${initial_phase_index}" "${FRONTEND_RETRY_SOURCE}" "${phase_control_dir}/state.json" "${phase_control_dir}/frontend-continuation-receipt.json" "${ACCESS_WIRING_CONTINUATION_SOURCE}" "${phase_control_dir}/access-wiring-continuation-receipt.json" "${ACCESS_WIRING_CONTINUATION_BINDINGS_SHA256}" "${ACCESS_WIRING_CONTINUATION_PATCH_SHA256}" "${CROSS_LAYER_CONTINUATION_SOURCE}" "${phase_control_dir}/cross-layer-continuation-receipt.json" "${CROSS_LAYER_CONTINUATION_BINDINGS_SHA256}" "${CROSS_LAYER_CONTINUATION_PATCH_SHA256}" <<'NODE'
 const fs = require('node:fs');
 const [file, projectSlug, taskId, caseFamily, sourceCommit, workflowId, firstPhaseId, initialPhaseIndexText,
   frontendRetrySource, phaseStateFile, frontendContinuationReceiptFile,
   accessWiringSource, accessWiringReceiptFile, accessWiringBindingsSha256,
   accessWiringPatchSha256, crossLayerSource, crossLayerReceiptFile,
   crossLayerBindingsSha256, crossLayerPatchSha256] = process.argv.slice(2);
const initialPhaseIndex = Number(initialPhaseIndexText);
const continuation = initialPhaseIndex === 2 || initialPhaseIndex === 5 || initialPhaseIndex === 6 || initialPhaseIndex === 7;
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
const phased = workflowId.length > 0;
 if (receipt.schemaVersion !== 1
  || receipt.receiptType !== 'forge-protected-execution/test-shadow-prepare'
  || receipt.testOnly !== true || receipt.projectSlug !== projectSlug || receipt.taskId !== taskId
  || receipt.caseFamily !== caseFamily || receipt.sourceCommit !== sourceCommit
  || !/^[0-9a-f]{64}$/u.test(receipt.contractId)
  || (phased && (receipt.workflowId !== workflowId || receipt.phaseId !== firstPhaseId
    || receipt.phaseIndex !== initialPhaseIndex || receipt.sessionMode !== (continuation ? 'resume' : 'create')
    || receipt.actionCeiling !== (continuation && initialPhaseIndex !== 7 ? 'workspace-write' : 'read-only') || !Array.isArray(receipt.ownedPaths)
    || (continuation && initialPhaseIndex !== 7 ? receipt.ownedPaths.length < 1 : receipt.ownedPaths.length !== 0)
    || typeof receipt.phaseAttemptId !== 'string'))
  || (!phased && (receipt.actionCeiling !== 'workspace-write' || !Array.isArray(receipt.ownedPaths)
    || receipt.ownedPaths.length < 1))) {
   throw new Error('protected test-shadow execution receipt mismatch');
 }
 if (frontendRetrySource) {
   const state = JSON.parse(fs.readFileSync(phaseStateFile, 'utf8'));
   const continuationReceipt = JSON.parse(fs.readFileSync(frontendContinuationReceiptFile, 'utf8'));
   if (continuationReceipt.schemaVersion !== 'forge-delivery-frontend-retry-continuation/v1'
     || continuationReceipt.inheritedStageCount !== 5 || continuationReceipt.newAcceptedStageCount !== 0
     || continuationReceipt.remainingAttempts !== 1 || continuationReceipt.newModelStarted !== false
     || receipt.generation !== continuationReceipt.nextExecutionGenerationMinimum
     || receipt.generation !== continuationReceipt.rejectedExecutionGeneration + 1
     || receipt.phaseAttemptId !== state.activeAttempt?.attemptId
     || state.activeAttempt?.executionGeneration !== receipt.generation
     || state.activeAttempt?.phaseId !== 'frontend' || state.activeAttempt?.sessionMode !== 'resume'
     || state.history?.at(-1)?.decision !== 'rejected'
     || state.history.at(-1).attemptId !== continuationReceipt.rejectedAttemptId
     || Object.keys(state.acceptedArtifacts ?? {}).length !== 5) {
     throw new Error('protected FE02 seed does not bind the inherited FE01 rejection and generation');
   }
 }
 if (accessWiringSource) {
   const state = JSON.parse(fs.readFileSync(phaseStateFile, 'utf8'));
   const inherited = JSON.parse(fs.readFileSync(accessWiringReceiptFile, 'utf8'));
   if (inherited.schemaVersion !== 'forge-delivery-access-wiring-continuation/v1'
     || inherited.inheritedStageCount !== 6 || inherited.newAcceptedStageCount !== 0
     || inherited.newModelStarted !== false || inherited.parentStateUnchanged !== true
     || inherited.bindingsSha256 !== accessWiringBindingsSha256
     || inherited.cumulativePatchSha256 !== accessWiringPatchSha256
     || inherited.parentLastExecutionGeneration !== 12 || inherited.nextExecutionGenerationMinimum !== 13
     || receipt.generation !== inherited.nextExecutionGenerationMinimum
     || receipt.phaseAttemptId !== state.activeAttempt?.attemptId
     || state.activeAttempt?.executionGeneration !== receipt.generation
     || state.activeAttempt?.phaseId !== 'access-wiring' || state.activeAttempt?.phaseIndex !== 6
     || state.activeAttempt?.sessionMode !== 'resume'
     || state.history?.at(-1)?.phaseId !== 'frontend' || state.history.at(-1)?.decision !== 'accepted'
     || Object.keys(inherited.inheritedArtifactDigests ?? {}).length !== 6
     || Object.keys(state.acceptedArtifacts ?? {}).length !== 6
     || Object.entries(inherited.inheritedArtifactDigests).some(([kind, digest]) => state.acceptedArtifacts[kind] !== digest)) {
     throw new Error('protected access-wiring seed does not bind the inherited accepted frontend and generation');
   }
 }
 if (crossLayerSource) {
   const state = JSON.parse(fs.readFileSync(phaseStateFile, 'utf8'));
   const inherited = JSON.parse(fs.readFileSync(crossLayerReceiptFile, 'utf8'));
   if (inherited.schemaVersion !== 'forge-delivery-cross-layer-continuation/v1'
     || inherited.inheritedStageCount !== 7 || inherited.newAcceptedStageCount !== 0
     || inherited.newModelStarted !== false || inherited.parentStateUnchanged !== true
     || inherited.bindingsSha256 !== crossLayerBindingsSha256
     || inherited.cumulativePatchSha256 !== crossLayerPatchSha256
     || inherited.parentLastExecutionGeneration !== 14 || inherited.nextExecutionGenerationMinimum !== 15
     || receipt.generation !== inherited.nextExecutionGenerationMinimum
     || receipt.phaseAttemptId !== state.activeAttempt?.attemptId
     || state.activeAttempt?.executionGeneration !== receipt.generation
     || state.activeAttempt?.phaseId !== 'cross-layer-acceptance' || state.activeAttempt?.phaseIndex !== 7
     || state.activeAttempt?.sessionMode !== 'resume'
     || state.history?.at(-1)?.phaseId !== 'access-wiring' || state.history.at(-1)?.decision !== 'accepted'
     || Object.keys(inherited.inheritedArtifactDigests ?? {}).length !== 7
     || Object.keys(state.acceptedArtifacts ?? {}).length !== 7
     || Object.entries(inherited.inheritedArtifactDigests).some(([kind, digest]) => state.acceptedArtifacts[kind] !== digest)) {
     throw new Error('protected cross-layer seed does not bind the inherited accepted access wiring and generation');
   }
 }
NODE

  # shellcheck disable=SC2016
  create_readonly_workspace_container "${admission_container}" "${case_workspace_source}" "${case_git_source}" /bin/sh -c 'set -eu; test "$(git -C /workspace rev-parse HEAD)" = "908e13bdc08ec2cbb071d355a2c33a77c970bdd3"; test -z "$(git -C /workspace status --porcelain=v1 --untracked-files=all)"; git -C /workspace status --porcelain=v2 --branch --untracked-files=all'
  admission_exit="$(start_capture "${admission_container}" "${case_dir}/workspace-admission.status.txt" "${case_dir}/workspace-admission.stderr.txt")"
  remove_owned_container "${admission_container}"
  [[ "${admission_exit}" -eq 0 ]] || die "fixed baseline admission failed for ${case_id}; see retained evidence"

  if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
    start_native_host_runner
  else
  declare -a verification_runner_mounts
  if [[ "${VERIFICATION_MODE}" == 'cache-ready' ]]; then
    verification_runner_user="1000:1000"
    verification_runner_mounts=(
      --group-add "${VERIFICATION_DOCKER_SOCKET_GID}"
      --mount "type=bind,src=$(docker_host_path "${case_runtime_host}"),dst=${case_runtime_daemon}"
      --mount "type=bind,src=$(docker_host_path "${VERIFICATION_RUNTIME_ROOT}/cache-packs"),dst=${VERIFICATION_RUNTIME_DAEMON_ROOT}/cache-packs,readonly"
      --mount "type=bind,src=${case_workspace_source},dst=${case_runtime_daemon}/taskspaces/${eval_task_id}/workspace,readonly"
      --mount "type=bind,src=${case_git_source},dst=${case_runtime_daemon}/taskspaces/${eval_task_id}/workspace/.git,readonly"
      --mount "type=bind,src=$(docker_host_path "${VERIFICATION_RUNTIME_ROOT}/bin/docker"),dst=/usr/local/bin/docker,readonly"
      --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock"
    )
  else
    verification_runner_user="1000:1000"
    verification_runner_mounts=(
      --mount "type=volume,src=${verification_control_volume},dst=/eval-project,volume-nocopy"
      --mount "type=volume,src=${workspace_volume},dst=/eval-project/taskspaces/${eval_task_id}/workspace,readonly,volume-nocopy"
      --mount "type=volume,src=${git_metadata_volume},dst=/eval-project/taskspaces/${eval_task_id}/workspace/.git,readonly,volume-nocopy"
    )
  fi
  create_owned_container "${verification_runner_container}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 256 --user "${verification_runner_user}" \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700 \
    --env "VERIFICATION_PROJECT_SLUG=${eval_project_slug}" \
    --env "VERIFICATION_TASKSPACES_ROOT=${case_runtime_daemon}/taskspaces" \
    --env "VERIFICATION_CONTRACT=${case_runtime_daemon}/verification/contract.json" \
    --env VERIFICATION_RUNNER_SOCKET=/run/forge-verify/runner.sock \
    --env VERIFICATION_SOURCE_SOCKET=/run/forge-verify-source/source.sock \
    --env DOCKER_HOST=unix:///var/run/docker.sock --env DOCKER_CONTEXT= \
    --env DOCKER_TLS_VERIFY= --env DOCKER_CERT_PATH= \
    --env HTTP_PROXY= --env HTTPS_PROXY= --env ALL_PROXY= --env NO_PROXY= \
    "${verification_runner_mounts[@]}" \
    --mount "${verification_ipc_mount}" \
    --mount "${verification_source_ipc_mount}" \
    --entrypoint /usr/local/bin/node "${image_id}" /usr/local/lib/verification-runner.mjs
  docker start "${verification_runner_container}" >/dev/null
  fi
  create_owned_container "${verification_probe_container}" \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --mount "${verification_ipc_readonly_mount}" \
    --mount "${verification_source_ipc_readonly_mount}" \
    --env "VERIFICATION_RUNNER_SOCKET=${verification_runner_socket}" --env "VERIFICATION_SOURCE_SOCKET=${verification_source_socket}" \
    --entrypoint /usr/local/bin/node "${image_id}" -e 'const h=require("node:http");let n=0;const sockets=[process.env.VERIFICATION_RUNNER_SOCKET,process.env.VERIFICATION_SOURCE_SOCKET];const once=(socketPath)=>new Promise((resolve,reject)=>{const q=h.request({socketPath,path:"/healthz"},r=>{r.resume();r.statusCode===200?resolve():reject(new Error(`unready ${socketPath}`))});q.on("error",reject);q.end()});const p=async()=>{n+=1;try{for(const socketPath of sockets)await once(socketPath);process.exit(0)}catch{n>=50?process.exit(1):setTimeout(p,100)}};p()'
  verification_probe_exit="$(start_capture "${verification_probe_container}" "${case_dir}/verification-runner.probe.stdout.txt" "${case_dir}/verification-runner.probe.stderr.txt")"
  remove_owned_container "${verification_probe_container}"
  if [[ "${verification_probe_exit}" -ne 0 ]]; then
    if [[ "${VERIFICATION_MODE}" != 'host-toolchain' ]]; then
    docker logs "${verification_runner_container}" >"${case_dir}/verification-runner.readiness.stdout.txt" \
      2>"${case_dir}/verification-runner.readiness.stderr.txt" || true
    docker container inspect "${verification_runner_container}" \
      >"${case_dir}/verification-runner.readiness.inspect.json" \
      2>"${case_dir}/verification-runner.readiness.inspect.stderr.txt" || true
    fi
    die "controlled Verification Runner readiness failed for ${case_id}"
  fi

  declare -a broker_control_mounts
  if [[ "${VERIFICATION_MODE}" != 'cache-miss' ]]; then
    broker_control_mounts=(
      --mount "type=bind,src=$(docker_host_path "${case_runtime_host}"),dst=${case_runtime_daemon}"
      --mount "type=bind,src=${case_workspace_source},dst=${case_runtime_daemon}/workspace,readonly"
      --mount "type=bind,src=${case_git_source},dst=${case_runtime_daemon}/workspace/.git,readonly"
      --mount "type=bind,src=${case_workspace_source},dst=${case_runtime_daemon}/taskspaces/${eval_task_id}/workspace,readonly"
      --mount "type=bind,src=${case_git_source},dst=${case_runtime_daemon}/taskspaces/${eval_task_id}/workspace/.git,readonly"
    )
  else
    broker_control_mounts=(
      --mount "type=volume,src=${verification_control_volume},dst=/eval-project,volume-nocopy"
      --mount "type=volume,src=${workspace_volume},dst=/eval-project/workspace,readonly,volume-nocopy"
      --mount "type=volume,src=${git_metadata_volume},dst=/eval-project/workspace/.git,readonly,volume-nocopy"
      --mount "type=volume,src=${workspace_volume},dst=/eval-project/taskspaces/${eval_task_id}/workspace,readonly,volume-nocopy"
      --mount "type=volume,src=${git_metadata_volume},dst=/eval-project/taskspaces/${eval_task_id}/workspace/.git,readonly,volume-nocopy"
    )
  fi
  broker_verification_ipc_mount="${verification_ipc_readonly_mount}"
  if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
    broker_verification_ipc_mount="type=bind,src=${HOST_IPC_ROOT}/runner,dst=/run/forge-verify,readonly"
  fi
  create_owned_container "${broker_container}" \
    --network "${case_network}" --network-alias taskspace-broker \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 256 --user 1000:1000 \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700 \
    --env "TASKSPACE_PROJECT_ROOT=${case_runtime_daemon}" \
    --env "TASKSPACE_PROJECT_SLUG=${eval_project_slug}" \
    --env TASKSPACE_BROKER_ADDRESS=0.0.0.0 --env TASKSPACE_BROKER_PORT=3100 \
    --env TASKSPACE_GIT_REMOTE_REQUIRED=false --env TASKSPACE_GIT_REMOTE_READY=false \
    "${broker_control_mounts[@]}" \
    --mount "${broker_verification_ipc_mount}" \
    --entrypoint /usr/local/bin/node "${image_id}" /usr/local/lib/taskspace-broker.mjs
  docker start "${broker_container}" >/dev/null
  create_owned_container "${broker_probe_container}" \
    --network "${case_network}" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --user 1000:1000 \
    --env FORGE_TASKSPACE_BROKER_URL=http://taskspace-broker:3100 \
    --env FORGE_TASKSPACE_TOKEN_FILE=/run/forge-taskspace/broker-token \
    --mount "type=bind,src=${BROKER_TOKEN_SNAPSHOT_DOCKER_PATH},dst=/run/forge-taskspace/broker-token,readonly" \
    --entrypoint /bin/sh "${image_id}" -c 'attempt=0; while [ "$attempt" -lt 50 ]; do attempt=$((attempt+1)); if /usr/local/bin/forge-verify admit --profile governance --profile backend-red-test --profile frontend-red-test --profile backend-module-compile --profile backend-module-test --profile backend-test-class --profile frontend-admin-lint --profile frontend-admin-test --profile frontend-admin-typecheck --profile frontend-admin-build --profile frontend-h5-build --profile changed-safe --profile full-regression; then exit 0; fi; sleep 0.1; done; exit 1'
  broker_probe_exit="$(start_capture "${broker_probe_container}" "${case_dir}/verification-execution-admission.json" "${case_dir}/verification-execution-admission.stderr.txt")"
  remove_owned_container "${broker_probe_container}"
  if [[ "${broker_probe_exit}" -ne 0 ]]; then
    docker logs "${broker_container}" >"${case_dir}/taskspace-broker.readiness.stdout.txt" \
      2>"${case_dir}/taskspace-broker.readiness.stderr.txt" || true
    docker container inspect "${broker_container}" \
      >"${case_dir}/taskspace-broker.readiness.inspect.json" \
      2>"${case_dir}/taskspace-broker.readiness.inspect.stderr.txt" || true
    die "authenticated Broker to Verification Runner execution admission failed for ${case_id}"
  fi
  node - "${case_dir}/verification-execution-admission.json" "${eval_project_slug}" "${image_id}" \
    "${EXPECTED_HARNESS_IMAGE_REVISION}" "${VERIFICATION_MODE}" "${VERIFICATION_CACHE_FINGERPRINT}" "${HOST_RUNNER_BUNDLE}/runner.manifest.json" "${eval_task_id}" "${EXPECTED_PHASE_CATALOG_VERSION}" <<'NODE'
const fs = require('node:fs');
const [file, projectSlug, imageId, runnerRevision, verificationMode, cacheFingerprint, hostManifestFile, taskId, profileCatalogVersion] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
const falseTruth = ['executionProven', 'verificationProven', 'semanticCorrectnessProven', 'databaseIntegrationProven', 'releaseProven'];
const expectedReady = verificationMode === 'cache-ready';
const executorProofs = ['proven', 'dockerApiProven', 'toolchainImageProven', 'samePathBindProven', 'stateWriteProven', 'cleanupProven'];
const expectedProfiles = ['governance', 'backend-red-test', 'frontend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build', 'changed-safe', 'full-regression'];
if (verificationMode === 'host-toolchain') {
  const manifest = JSON.parse(fs.readFileSync(hostManifestFile, 'utf8'));
  if (receipt.schemaVersion !== 2 || receipt.receiptType !== 'forge-verify/host-execution-admission'
    || receipt.projectSlug !== projectSlug || receipt.taskId !== taskId || receipt.outcome !== 'ready' || receipt.reasonCode !== null
    || receipt.runner?.revision !== `forge-host-runner-${manifest.bundleVersion}` || receipt.profileCatalogVersion !== profileCatalogVersion
    || JSON.stringify(receipt.profiles) !== JSON.stringify(expectedProfiles) || typeof receipt.admissionId !== 'string'
    || !receipt.issuedAt || !receipt.expiresAt || !receipt.toolchain || receipt.cache !== undefined || receipt.executor !== undefined
    || falseTruth.some((name) => receipt.truth?.[name] !== false)) throw new Error('native Host execution admission receipt mismatch');
} else if (receipt.schemaVersion !== 1 || receipt.receiptType !== 'forge-verify/execution-admission'
  || receipt.projectSlug !== projectSlug
  || JSON.stringify(receipt.profiles) !== JSON.stringify(expectedProfiles)
  || receipt.runner?.revision !== runnerRevision
  || receipt.cache?.mode !== 'project-scoped-immutable-pack'
  || receipt.cache?.compatible !== expectedReady
  || receipt.outcome !== (expectedReady ? 'ready' : 'cache_miss')
  || receipt.reasonCode !== (expectedReady ? null : 'VERIFY_CACHE_MISS')
  || (expectedReady && receipt.source?.dependencyManifestFingerprint !== cacheFingerprint)
  || (expectedReady && (typeof receipt.admissionId !== 'string' || receipt.issuedAt === null || receipt.expiresAt === null))
  || (!expectedReady && (receipt.admissionId !== null || receipt.issuedAt !== null || receipt.expiresAt !== null))
  || executorProofs.some((name) => receipt.executor?.[name] !== expectedReady)
  || Object.hasOwn(receipt, 'network')
  || falseTruth.some((name) => receipt.truth?.[name] !== false)) {
  throw new Error('controlled verification execution admission receipt mismatch');
}
NODE

  git -C "${SOURCE_PATH}" status --porcelain=v2 --branch --untracked-files=all >"${case_dir}/source-admission.status.txt"
  docker image inspect "${image_id}" | node -e '
const fs = require("node:fs");
const image = JSON.parse(fs.readFileSync(0, "utf8"))[0];
const labels = Object.fromEntries(Object.entries(image.Config?.Labels ?? {}).filter(([key]) => key.startsWith("org.opencontainers.image.") || key.startsWith("com.forge-delivery.")));
process.stdout.write(JSON.stringify({
  schemaVersion: "forge-harness-image-inspect/v1",
  projectionOf: "docker image inspect",
  Id: image.Id,
  RepoTags: image.RepoTags ?? [],
  RepoDigests: image.RepoDigests ?? [],
  Created: image.Created,
  Architecture: image.Architecture,
  Os: image.Os,
  Size: image.Size,
  Config: { User: image.Config?.User, Entrypoint: image.Config?.Entrypoint, Cmd: image.Config?.Cmd, WorkingDir: image.Config?.WorkingDir, Labels: labels },
  RootFS: { Type: image.RootFS?.Type, Layers: image.RootFS?.Layers ?? [] },
}, null, 2) + "\n");
' >"${case_dir}/image.inspect.json"

  create_owned_container "${proxy_container}" \
    --network "${proxy_egress_network}" \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 \
    --user "${local_uid}:${local_gid}" \
    --tmpfs "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=${local_uid},gid=${local_gid},mode=0700" \
    --mount "type=bind,src=${SECRET_SNAPSHOT_DOCKER_PATH},dst=/run/secrets/model-api-key,readonly" \
    --mount "type=bind,src=${ANALYZER_DOCKER_PATH},dst=/eval/analyze-forge-harness-session.mjs,readonly" \
    --entrypoint /usr/local/bin/node "${proxy_image_id}" /eval/analyze-forge-harness-session.mjs credential-proxy \
      --secret-file /run/secrets/model-api-key \
      --max-requests "${MAX_MODEL_REQUESTS}" \
      --expected-provider "${EXPECTED_CONFIGURED_PROVIDER}" \
      --expected-model "${EXPECTED_REQUEST_MODEL}" \
      --max-output-tokens "${MAX_OUTPUT_TOKENS_PER_REQUEST}" \
      --max-request-bytes "${MAX_PROXY_REQUEST_BYTES}" \
      --max-total-request-bytes "${MAX_PROXY_TOTAL_REQUEST_BYTES}"
  docker network connect --alias credential-proxy "${case_network}" "${proxy_container}"
  docker start "${proxy_container}" >/dev/null
  ACTIVE_PROXY_CONTAINER="${proxy_container}"
  ACTIVE_PROXY_CASE_DIR="${case_dir}"

  create_owned_container "${proxy_probe_container}" \
    --network "${case_network}" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --user 1000:1000 \
    --entrypoint /usr/local/bin/node "${proxy_image_id}" -e 'let attempts=0; const probe=async()=>{ attempts+=1; try { const response=await fetch("http://credential-proxy:8080/__forge_health"); if(response.status===204) process.exit(0); } catch {} if(attempts>=50) process.exit(1); setTimeout(probe,100); }; probe();'
  proxy_probe_exit="$(start_capture "${proxy_probe_container}" "${case_dir}/credential-proxy.probe.stdout.txt" "${case_dir}/credential-proxy.probe.stderr.txt")"
  remove_owned_container "${proxy_probe_container}"
  [[ "${proxy_probe_exit}" -eq 0 ]] || die "credential proxy readiness failed for ${case_id}; see retained evidence"

  if [[ -n "${phase_workflow_id}" ]]; then
    : >"${case_dir}/model.stdout.txt"
    : >"${case_dir}/model.stderr.txt"
  fi

  # The model receives only a non-secret placeholder. The real key exists solely in the proxy sidecar.
  # shellcheck disable=SC2016
  model_bootstrap='set -eu; task="$(cat /eval-prompt/prompt.md)"; test -n "${task}"; exec /usr/local/bin/dsh --profile headless --patch /eval/headless-audit.patch.yml "${task}"'
  if [[ "${VERIFICATION_MODE}" != 'cache-miss' ]]; then
    model_workspace_mount="type=bind,src=${case_workspace_source},dst=/workspace"
    model_git_mount="type=bind,src=${case_git_source},dst=/workspace/.git,readonly"
  else
    model_workspace_mount="type=volume,src=${workspace_volume},dst=/workspace,volume-nocopy"
    model_git_mount="type=volume,src=${git_metadata_volume},dst=/workspace/.git,readonly,volume-nocopy"
  fi
  model_candidate_write_args=()
  if [[ "${TEST_SHADOW_CANDIDATE_WRITE}" == 'candidate-only' ]]; then
    model_candidate_write_args=(
      --env "FORGE_TEST_SHADOW_CANDIDATE_WRITE=${TEST_SHADOW_CANDIDATE_WRITE_RUNTIME_MODE}"
      --env "FORGE_TEST_SHADOW_VERIFICATION_RUNNER_REVISION=${EXPECTED_HARNESS_IMAGE_REVISION}"
      --mount "type=bind,src=${PHASE_BUDGET_GUARD_SNAPSHOT_DOCKER_PATH},dst=/usr/local/lib/forge-phase-budget-guard.mjs,readonly"
      --mount "type=bind,src=${PROGRESS_DETECTOR_SNAPSHOT_DOCKER_PATH},dst=/usr/local/lib/forge-progress-detector.mjs,readonly"
    )
  fi
  phase_index="${initial_phase_index}"
  while [[ "${phase_index}" -lt "${#MODEL_PHASE_IDS[@]}" ]]; do
    current_phase_id="${MODEL_PHASE_IDS[phase_index]}"
    phase_attempt_number=0
    if [[ -n "${FRONTEND_RETRY_SOURCE}" && "${phase_index}" -eq 5 ]]; then
      phase_attempt_number=1
    fi
    while :; do
    phase_attempt_number=$((phase_attempt_number + 1))
    current_model_container="${model_container}"
    current_prompt_file="${prompt_file}"
    current_prompt_file_docker="${prompt_file_docker}"
    current_rpc_id="${eval_headless_rpc_id}"
    current_session_mode="create"
    current_model_stdout="${case_dir}/model.stdout.txt"
    current_model_stderr="${case_dir}/model.stderr.txt"
    current_supervision_file="${case_dir}/model-supervision.json"
    current_boundary_dir="${case_dir}"
    prompt_evidence_dir="${case_dir}"
    phase_dir=""
    phase_dir_docker=""
    if [[ -n "${phase_workflow_id}" ]]; then
      phase_number="$(printf '%02d' "$((phase_index + 1))")"
      phase_canonical_dir="${case_dir}/phases/${phase_number}-${current_phase_id}"
      phase_dir="${phase_canonical_dir}"
      if [[ "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]]; then
        phase_dir="${phase_canonical_dir}/attempts/$(printf '%02d' "${phase_attempt_number}")"
      fi
      mkdir -p -- "${phase_dir}"
      node - "${phase_dir}" "${PHASE_EVIDENCE_CONSUMER_GID}" <<'NODE'
const fs = require('node:fs');
const [directory, consumerGidText] = process.argv.slice(2);
if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
  const consumerGid = Number.parseInt(consumerGidText, 10);
  fs.chownSync(directory, 0, consumerGid);
  fs.chmodSync(directory, 0o770);
  const info = fs.lstatSync(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.uid !== 0n || info.gid !== BigInt(consumerGid)
    || (info.mode & 0o7777n) !== 0o770n) {
    throw new Error('phase evidence directory is not writable only by root and the fixed phase consumer gid');
  }
}
NODE
      phase_dir_docker="$(docker_host_path "${phase_dir}")"
      current_model_container="${resource_prefix}-model-${phase_number}-${current_phase_id:0:12}-${phase_attempt_number}"
      current_prompt_file="${phase_control_dir}/current-prompt.md"
      current_prompt_file_docker="$(docker_host_path "${phase_control_dir}/current-prompt.md")"
      current_model_stdout="${phase_dir}/model.stdout.txt"
      current_model_stderr="${phase_dir}/model.stderr.txt"
      current_supervision_file="${phase_dir}/model-supervision.json"
      current_boundary_dir="${phase_dir}"
      prompt_evidence_dir="${phase_dir}"
      if [[ "${phase_index}" -eq "${initial_phase_index}" && ( "${phase_attempt_number}" -eq 1 \
        || ( -n "${FRONTEND_RETRY_SOURCE}" && "${phase_attempt_number}" -eq 2 ) ) ]]; then
        current_boundary_dir="${case_dir}"
        current_execution_receipt="${case_execution_receipt_file}"
      else
        current_rpc_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
        phase_prepare_container="${resource_prefix}-prepare-${phase_number}-${current_phase_id:0:12}-${phase_attempt_number}"
        run_phase_prepare "${phase_prepare_container}" "${current_phase_id}" "${current_rpc_id}" \
          "${phase_dir_docker}" "${phase_dir}/prepare.stdout.txt" "${phase_dir}/prepare.stderr.txt" \
          || die "protected phase preparation failed for ${case_id}/${current_phase_id}"
        current_execution_receipt="${phase_dir}/execution-receipt.json"
      fi
      current_session_mode="$(node - "${current_execution_receipt}" "${phase_workflow_id}" \
        "${current_phase_id}" "${phase_index}" "${current_rpc_id}" "${phase_control_dir}/state.json" <<'NODE'
const fs = require('node:fs');
const [file, workflowId, phaseId, phaseIndex, rpcId] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
const state = JSON.parse(fs.readFileSync(process.argv[7], 'utf8'));
const expectedMode = state.activeAttempt?.sessionMode;
if (!['create', 'resume'].includes(expectedMode)
  || receipt.workflowId !== workflowId || receipt.phaseId !== phaseId
  || receipt.phaseIndex !== Number(phaseIndex) || receipt.sessionMode !== expectedMode
  || !Number.isSafeInteger(receipt.generation)
  || receipt.generation !== state.activeAttempt?.executionGeneration
  || receipt.phaseAttemptId !== state.activeAttempt?.attemptId
  || (rpcId && state.activeAttempt?.rpcId !== rpcId)) {
  throw new Error('protected phase execution receipt mismatch');
}
process.stdout.write(expectedMode);
NODE
      )" || die "protected phase receipt validation failed for ${case_id}/${current_phase_id}"
      if [[ "${phase_attempt_number}" -eq 1 ]]; then
        if [[ -n "${BACKEND_CONTINUATION_SOURCE}" && "${phase_index}" -eq 5 ]]; then
          restore_backend_continuation_patch \
            || die 'reviewed backend cumulative patch could not be restored before frontend baseline snapshot'
        elif [[ -n "${ACCESS_WIRING_CONTINUATION_SOURCE}" && "${phase_index}" -eq 6 ]]; then
          restore_access_wiring_continuation_patch \
            || die 'reviewed six-stage cumulative patch could not be restored before access wiring baseline snapshot'
        elif [[ -n "${CROSS_LAYER_CONTINUATION_SOURCE}" && "${phase_index}" -eq 7 ]]; then
          restore_cross_layer_continuation_patch \
            || die 'reviewed seven-stage cumulative patch could not be restored before cross-layer baseline snapshot'
        fi
        phase_snapshot_container="${resource_prefix}-snapshot-${phase_number}-${current_phase_id:0:18}"
        run_phase_workspace_snapshot "${phase_snapshot_container}" "${phase_dir_docker}" \
          "${phase_dir}/snapshot.stdout.txt" "${phase_dir}/snapshot.stderr.txt" \
          || die "pre-phase workspace snapshot failed for ${case_id}/${current_phase_id}"
        if [[ -n "${DATABASE_CONTINUATION_SOURCE}" && "${phase_index}" -eq 2 ]]; then
          restore_database_continuation_patch \
            || die 'reviewed database candidate could not be restored after the phase baseline snapshot'
        fi
      else
        if [[ -n "${FRONTEND_RETRY_SOURCE}" && "${phase_index}" -eq 5 && "${phase_attempt_number}" -eq 2 ]]; then
          [[ -f "${phase_canonical_dir}/attempts/01/before-snapshot.json" \
            && ! -L "${phase_canonical_dir}/attempts/01/before-snapshot.json" ]] \
            || die 'Controller did not retain the original FE01 phase baseline'
          [[ "$(sha256_file "${phase_canonical_dir}/attempts/01/before-snapshot.json")" \
            == "$(sha256_file "${FRONTEND_RETRY_SOURCE}/phases/06-frontend/attempts/01/before-snapshot.json")" ]] \
            || die 'Controller-retained FE01 phase baseline differs from its bound source'
          chown 1000:1000 -- "${phase_canonical_dir}/attempts/01/before-snapshot.json" \
            || die 'inherited FE01 phase baseline owner could not be restored'
        fi
        cp --preserve=mode,ownership --no-clobber -- "${phase_canonical_dir}/attempts/01/before-snapshot.json" "${phase_dir}/before-snapshot.json" \
          || die "accepted phase baseline could not be retained for ${case_id}/${current_phase_id}"
        if [[ -n "${FRONTEND_RETRY_SOURCE}" && "${phase_index}" -eq 5 && "${phase_attempt_number}" -eq 2 ]]; then
          restore_frontend_retry_patch \
            || die 'reviewed FE01 cumulative patch could not be restored before FE02 model execution'
        fi
      fi
    fi
  current_prompt_sha256="$(sha256_file "${current_prompt_file}")" \
    || die "current prompt digest could not be established for ${case_id}/${current_phase_id}"
  prompt_stage_container="${resource_prefix}-prompt-stage-$((phase_index + 1))-${phase_attempt_number}"
  prompt_probe_container="${resource_prefix}-prompt-probe-$((phase_index + 1))-${phase_attempt_number}"
  prepare_model_prompt_volume \
    "${prompt_stage_container}" "${prompt_probe_container}" \
    "${current_prompt_file_docker}" "${current_prompt_sha256}" \
    "${prompt_evidence_dir}/prompt-stage.receipt.json" "${prompt_evidence_dir}/prompt-stage.stderr.txt" \
    "${prompt_evidence_dir}/prompt-access.receipt.json" "${prompt_evidence_dir}/prompt-access.stderr.txt" \
    || die "model prompt staging/access probe failed for ${case_id}/${current_phase_id}"
  create_owned_container "${current_model_container}" \
    --network "${case_network}" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 512 --user 1000:1000 --workdir /workspace \
    --env DSH_PERMISSION_MODE=workspace-write --env DSH_TELEMETRY_MODE=DISABLED \
    --env "DSH_BUNDLED_SKILL_DIR=${EXTERNAL_SKILLS_CONTAINER_PATH}" \
    --env "FORGE_PHASE_STEP_BUDGET=${PHASE_STEP_BUDGET}" \
    --env GIT_OPTIONAL_LOCKS=0 \
    --env "FORGE_EVAL_PROXY_CREDENTIAL=${MODEL_CREDENTIAL_PLACEHOLDER}" \
    --env FORGE_TASKSPACE_BROKER_URL=http://taskspace-broker:3100 \
    --env FORGE_TASKSPACE_TOKEN_FILE=/run/forge-taskspace/broker-token \
    --env "PROJECT_SLUG=${eval_project_slug}" \
    --env "FORGE_TASKSPACE_ID=${eval_task_id}" \
    --env "FORGE_TASKSPACE_ACTOR_ID=${eval_actor_id}" \
    --env "FORGE_TASKSPACE_ACTOR_USER_ID=${eval_actor_user_id}" \
    --env "FORGE_TASKSPACE_CONVERSATION_ID=${eval_conversation_id}" \
    --env "FORGE_PROTECTED_HEADLESS_SESSION_ID=${eval_headless_session_id}" \
    --env "FORGE_PROTECTED_HEADLESS_RPC_ID=${current_rpc_id}" \
    --env "FORGE_PROTECTED_HEADLESS_SESSION_MODE=${current_session_mode}" \
    --env MAVEN_CONFIG=/tmp/forge-eval-m2 \
    --env 'MAVEN_OPTS=-Dmaven.repo.local=/tmp/forge-eval-m2/repository -Djansi.tmpdir=/tmp/forge-eval-jansi' \
    --env npm_config_cache=/tmp/forge-eval-npm-cache \
    --env npm_config_store_dir=/tmp/forge-eval-pnpm-store \
    --env PNPM_HOME=/tmp/forge-eval-pnpm-home \
    --env XDG_CACHE_HOME=/tmp/forge-eval-xdg-cache \
    --env XDG_DATA_HOME=/tmp/forge-eval-xdg-data \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=2g,uid=1000,gid=1000,mode=0700 \
    --mount "${model_workspace_mount}" \
    --mount "${model_git_mount}" \
    --mount "type=volume,src=${dsh_home_volume},dst=/home/node/.dsh,volume-nocopy" \
    --mount "type=bind,src=${BROKER_TOKEN_SNAPSHOT_DOCKER_PATH},dst=/run/forge-taskspace/broker-token,readonly" \
    --mount "type=volume,src=${prompt_volume},dst=/eval-prompt,readonly,volume-nocopy" \
    --mount "type=bind,src=${patch_file_docker},dst=/eval/headless-audit.patch.yml,readonly" \
    --mount "type=bind,src=${PROTECTED_HEADLESS_RUNNER_SNAPSHOT_DOCKER_PATH},dst=/usr/local/lib/forge-protected-headless-runner.mjs,readonly" \
    --mount "type=bind,src=${EXTERNAL_SKILLS_DOCKER_PATH},dst=${EXTERNAL_SKILLS_CONTAINER_PATH},readonly" \
    "${model_candidate_write_args[@]}" \
    --entrypoint /bin/sh "${image_id}" -c "${model_bootstrap}"
  verify_external_skills_bundle \
    || die "the external Skill bundle changed before boundary inspection: ${case_id}"
  verify_input_snapshot || die "the evaluation input closure changed before boundary inspection: ${case_id}"
  docker container inspect "${current_model_container}" "${proxy_container}" \
    | MSYS2_ARG_CONV_EXCL='*' node "${ANALYZER_DOCKER_PATH}" project-container-boundary \
      --model-name "${current_model_container}" --proxy-name "${proxy_container}" \
      --model-image-id "${image_id}" --proxy-image-id "${proxy_image_id}" \
      --model-network "${case_network}" --proxy-egress-network "${proxy_egress_network}" \
      --secret-file "${SECRET_SNAPSHOT_DOCKER_PATH}" --proxy-secret-source "${SECRET_SNAPSHOT_DOCKER_PATH}" \
      --external-skills-source "${EXTERNAL_SKILLS_DOCKER_PATH}" \
      --external-skills-destination "${EXTERNAL_SKILLS_CONTAINER_PATH}" \
      --output "$(docker_host_path "${current_boundary_dir}/runtime-boundary.inspect.json")"
  verification_boundary_raw="${current_boundary_dir}/.verification-boundary.raw.json"
  boundary_container_names=("${current_model_container}" "${broker_container}")
  if [[ "${VERIFICATION_MODE}" != 'host-toolchain' ]]; then boundary_container_names+=("${verification_runner_container}"); fi
  docker container inspect "${boundary_container_names[@]}" >"${verification_boundary_raw}"
  node - "${verification_boundary_raw}" "${current_boundary_dir}/verification-boundary.inspect.json" "${current_model_container}" "${broker_container}" \
      "${verification_runner_container}" "${image_id}" "${case_network}" "${BROKER_TOKEN_SNAPSHOT_FILE}" \
      "${VERIFICATION_MODE}" "container:${case_runtime_daemon}" "${TEST_SHADOW_CANDIDATE_WRITE}" \
      "${TEST_SHADOW_CANDIDATE_WRITE_RUNTIME_MODE}" "${EXPECTED_HARNESS_IMAGE_REVISION}" \
      "${EXPECTED_PHASE_BUDGET_GUARD_SHA256}" "${PHASE_BUDGET_GUARD_SNAPSHOT_DOCKER_PATH}" \
      "${EXPECTED_PROGRESS_DETECTOR_SHA256}" "${PROGRESS_DETECTOR_SNAPSHOT_DOCKER_PATH}" \
      "${EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256}" "${PROTECTED_HEADLESS_RUNNER_SNAPSHOT_DOCKER_PATH}" \
      "${prompt_volume}" "${case_dir}/verification-runner.stdout.txt" "${HOST_RUNNER_PID}" "${HOST_RUNNER_STARTTIME}" \
      "${verification_runner_socket}" "${verification_source_socket}" "${run_token}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rawFile, output, modelName, brokerName, runnerName, imageId, internalNetwork, tokenFile,
  verificationMode, expectedProjectRootArg, candidateWriteMode, candidateWriteRuntimeMode,
  expectedVerificationRunnerRevision, phaseGuardSha256, expectedPhaseGuardSource,
  progressDetectorSha256, expectedProgressDetectorSource,
  protectedRunnerSha256, expectedProtectedRunnerSource, expectedPromptVolume, hostLogFile, hostPid, hostStartTime, runnerSocket, sourceSocket, runToken] = process.argv.slice(2);
if (!expectedProjectRootArg.startsWith('container:/')) throw new Error('expected project root must be one typed container path');
const expectedProjectRoot = expectedProjectRootArg.slice('container:'.length);
if (!['cache-miss', 'cache-ready', 'host-toolchain'].includes(verificationMode)) throw new Error('verification mode is invalid');
if (!expectedProjectRoot.startsWith('/')) throw new Error('expected verification project root is invalid');
if (!['', 'candidate-only'].includes(candidateWriteMode)) throw new Error('candidate-write mode is invalid');
const candidateWriteEnabled = candidateWriteMode === 'candidate-only';
if (candidateWriteEnabled && verificationMode !== 'cache-miss') throw new Error('candidate-write mode exceeded cache-miss authority');
const containers = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const byName = new Map(containers.map((item) => [String(item.Name ?? '').replace(/^\//u, ''), item]));
const nativeHost = verificationMode === 'host-toolchain';
if (containers.length !== (nativeHost ? 2 : 3) || byName.size !== containers.length
  || !byName.has(modelName) || !byName.has(brokerName) || (!nativeHost && !byName.has(runnerName))) {
  throw new Error('verification boundary container closure mismatch');
}
const model = byName.get(modelName);
const broker = byName.get(brokerName);
const runner = byName.get(runnerName);
const verificationContainers = nativeHost ? [model, broker] : [model, broker, runner];
const serviceContainers = nativeHost ? [broker] : [broker, runner];
let hostProcess;
if (nativeHost) {
  const ready = fs.readFileSync(hostLogFile, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.event === 'ready');
  const observedStart = fs.readFileSync(`/proc/${hostPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  const status = fs.readFileSync(`/proc/${hostPid}/status`, 'utf8');
  if (ready?.runToken !== runToken || ready.pid !== Number(hostPid) || ready.startTime !== hostStartTime || observedStart !== hostStartTime
    || ready.uid !== 1000 || ready.gid !== 1000 || ready.dockerSocketAccessible !== false
    || !/^Uid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status)
    || !/^Gid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status)
    || !Array.isArray(ready.environmentNames) || ready.environmentNames.includes('DOCKER_HOST')
    || !/^CapEff:\s+0+$/mu.test(status) || !/^NoNewPrivs:\s+1$/mu.test(status)) throw new Error('native Host process boundary mismatch');
  hostProcess = { executionMode: 'host-toolchain', pid: Number(hostPid), startTime: hostStartTime,
    uid: 1000, gid: 1000, noNewPrivileges: true, running: true, dockerSocketAccessible: false,
    dockerSocketMounted: false, networkMode: 'host', dependencyNetworkIsolationProven: false,
    runnerSocket, sourceSocket, mounts: [], environmentNames: ready.environmentNames };
}
if (model.State?.Running !== false || broker.State?.Running !== true || (!nativeHost && runner.State?.Running !== true)
  || verificationContainers.some((item) => item.Image !== imageId
    || item.HostConfig?.ReadonlyRootfs !== true || item.HostConfig?.Privileged !== false
    || !item.HostConfig?.CapDrop?.includes('ALL')
    || !item.HostConfig?.SecurityOpt?.includes('no-new-privileges:true')
    || Object.keys(item.HostConfig?.PortBindings ?? {}).length !== 0)) {
  throw new Error('verification boundary privilege or state mismatch');
}
const dockerSocket = (item) => item.Mounts?.filter((mount) => mount.Destination === '/var/run/docker.sock') ?? [];
if (dockerSocket(model).length !== 0 || dockerSocket(broker).length !== 0
  || (verificationMode === 'cache-ready'
    ? dockerSocket(runner).length !== 1 || dockerSocket(runner)[0].RW !== true
    : !nativeHost && dockerSocket(runner).length !== 0)) {
  throw new Error('verification Docker socket boundary mismatch');
}
const networks = (item) => Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
if (JSON.stringify(networks(model)) !== JSON.stringify([internalNetwork])
  || JSON.stringify(networks(broker)) !== JSON.stringify([internalNetwork])
  || (!nativeHost && (runner.HostConfig?.NetworkMode !== 'none' || JSON.stringify(networks(runner)) !== JSON.stringify(['none'])))) {
  throw new Error('verification boundary network mismatch');
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
if (verificationContainers.some((item) => (item.Config?.Env ?? []).some((entry) => entry === token || entry.endsWith(`=${token}`)))) {
  throw new Error('TaskSpace Broker token leaked through container environment');
}
const tokenMounts = model.Mounts.filter((mount) => mount.Destination === '/run/forge-taskspace/broker-token'
  || path.win32.basename(String(mount.Source ?? '')) === path.win32.basename(tokenFile)
  || path.posix.basename(String(mount.Source ?? '')) === path.posix.basename(tokenFile));
if (tokenMounts.length !== 1 || tokenMounts[0].Type !== 'bind' || tokenMounts[0].RW !== false
  || tokenMounts[0].Destination !== '/run/forge-taskspace/broker-token'
  || serviceContainers.some((item) => item.Mounts.some((mount) => mount.Destination === '/run/forge-taskspace/broker-token'))) {
  throw new Error('TaskSpace Broker token mount boundary mismatch');
}
const candidateModeEnvName = 'FORGE_TEST_SHADOW_CANDIDATE_WRITE';
const runnerRevisionEnvName = 'FORGE_TEST_SHADOW_VERIFICATION_RUNNER_REVISION';
const candidateEnv = (item, name) => (item.Config?.Env ?? []).filter((entry) => entry.startsWith(`${name}=`));
const phaseGuardDestination = '/usr/local/lib/forge-phase-budget-guard.mjs';
const phaseGuardMounts = (item) => item.Mounts?.filter((entry) => entry.Destination === phaseGuardDestination) ?? [];
const progressDetectorDestination = '/usr/local/lib/forge-progress-detector.mjs';
const progressDetectorMounts = (item) => item.Mounts?.filter(
  (entry) => entry.Destination === progressDetectorDestination) ?? [];
const protectedRunnerDestination = '/usr/local/lib/forge-protected-headless-runner.mjs';
const protectedRunnerMounts = (item) => item.Mounts?.filter(
  (entry) => entry.Destination === protectedRunnerDestination) ?? [];
const promptMounts = (item) => item.Mounts?.filter(
  (entry) => entry.Destination === '/eval-prompt') ?? [];
const hostPathKey = (value) => String(value ?? '').replaceAll('\\', '/')
  .replace(/^\/run\/desktop\/mnt\/host\/([a-z])\//iu, '$1:/')
  .replace(/^\/host_mnt\/([a-z])\//iu, '$1:/')
  .replace(/\/$/u, '').toLocaleLowerCase('en-US');
if (candidateWriteEnabled
  ? candidateEnv(model, candidateModeEnvName).length !== 1
    || candidateEnv(model, candidateModeEnvName)[0] !== `${candidateModeEnvName}=${candidateWriteRuntimeMode}`
    || candidateEnv(model, runnerRevisionEnvName).length !== 1
    || candidateEnv(model, runnerRevisionEnvName)[0] !== `${runnerRevisionEnvName}=${expectedVerificationRunnerRevision}`
    || serviceContainers.some((item) => candidateEnv(item, candidateModeEnvName).length !== 0
      || candidateEnv(item, runnerRevisionEnvName).length !== 0)
    || phaseGuardMounts(model).length !== 1
    || phaseGuardMounts(model)[0].Type !== 'bind' || phaseGuardMounts(model)[0].RW !== false
    || hostPathKey(phaseGuardMounts(model)[0].Source) !== hostPathKey(expectedPhaseGuardSource)
    || serviceContainers.some((item) => phaseGuardMounts(item).length !== 0)
    || progressDetectorMounts(model).length !== 1
    || progressDetectorMounts(model)[0].Type !== 'bind' || progressDetectorMounts(model)[0].RW !== false
    || hostPathKey(progressDetectorMounts(model)[0].Source) !== hostPathKey(expectedProgressDetectorSource)
    || serviceContainers.some((item) => progressDetectorMounts(item).length !== 0)
  : verificationContainers.some((item) => candidateEnv(item, candidateModeEnvName).length !== 0
    || candidateEnv(item, runnerRevisionEnvName).length !== 0
    || phaseGuardMounts(item).length !== 0 || progressDetectorMounts(item).length !== 0)) {
  throw new Error('candidate-write model-only runtime overlay boundary mismatch');
}
if (protectedRunnerMounts(model).length !== 1
  || protectedRunnerMounts(model)[0].Type !== 'bind' || protectedRunnerMounts(model)[0].RW !== false
  || hostPathKey(protectedRunnerMounts(model)[0].Source) !== hostPathKey(expectedProtectedRunnerSource)
  || serviceContainers.some((item) => protectedRunnerMounts(item).length !== 0)) {
  throw new Error('protected headless runner model-only runtime overlay boundary mismatch');
}
if (promptMounts(model).length !== 1 || promptMounts(model)[0].Type !== 'volume'
  || promptMounts(model)[0].RW !== false || promptMounts(model)[0].Name !== expectedPromptVolume
  || serviceContainers.some((item) => promptMounts(item).length !== 0)) {
  throw new Error('model prompt volume boundary mismatch');
}
const mount = (item, destination) => item.Mounts.find((entry) => entry.Destination === destination);
if (!nativeHost && (mount(runner, '/run/forge-verify')?.RW !== true || mount(broker, '/run/forge-verify')?.RW !== false
  || mount(runner, '/run/forge-verify-source')?.RW !== true
  || mount(model, '/run/forge-verify-source') !== undefined
  || mount(broker, '/run/forge-verify-source') !== undefined
  || !(runner.Config?.Env ?? []).includes('VERIFICATION_SOURCE_SOCKET=/run/forge-verify-source/source.sock')
  || !runner.Mounts.some((entry) => entry.Destination.startsWith(`${expectedProjectRoot}/taskspaces/`)
    && entry.Destination.endsWith('/workspace') && entry.RW === false)
  || !broker.Mounts.some((entry) => entry.Destination.startsWith(`${expectedProjectRoot}/taskspaces/`)
    && entry.Destination.endsWith('/workspace') && entry.RW === false))) {
  throw new Error('verification IPC boundary mismatch');
}
if (nativeHost && (mount(broker, '/run/forge-verify')?.RW !== false
  || mount(broker, '/run/forge-verify')?.Type !== 'bind'
  || mount(broker, '/run/forge-verify')?.Source !== path.dirname(runnerSocket)
  || mount(model, '/run/forge-verify') !== undefined
  || mount(model, path.dirname(runnerSocket)) !== undefined
  || verificationContainers.some((item) => mount(item, path.dirname(sourceSocket)) !== undefined)
  || !broker.Mounts.some((entry) => entry.Destination.startsWith(`${expectedProjectRoot}/taskspaces/`)
    && entry.Destination.endsWith('/workspace') && entry.RW === false))) throw new Error('native Host IPC boundary mismatch');
const project = (item) => ({
  name: String(item.Name).replace(/^\//u, ''), imageId: item.Image,
  running: item.State.Running, networkMode: item.HostConfig.NetworkMode,
  networks: networks(item), readOnlyRootFilesystem: item.HostConfig.ReadonlyRootfs,
  dockerSocketMounted: item.Mounts.some((entry) => entry.Destination === '/var/run/docker.sock'),
  publishedPorts: Object.keys(item.HostConfig.PortBindings ?? {}).length > 0,
  mounts: item.Mounts.map((entry) => ({ type: entry.Type, destination: entry.Destination, readOnly: entry.RW === false })),
  environmentNames: (item.Config?.Env ?? []).map((entry) => String(entry).split('=', 1)[0]).sort(),
});
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 'forge-harness-controlled-verification-boundary/v1',
  mode: 'real-broker-runner-execution-admission-plane',
  verificationMode,
  cachePrepared: verificationMode === 'cache-ready',
  dockerExecutionAvailable: verificationMode === 'cache-ready',
  candidateWrite: {
    enabled: candidateWriteEnabled,
    cliMode: candidateWriteMode || null,
    runtimeMode: candidateWriteEnabled ? candidateWriteRuntimeMode : null,
    authorityClass: candidateWriteEnabled ? 'test-shadow-writer' : null,
    verificationRunnerRevision: candidateWriteEnabled ? expectedVerificationRunnerRevision : null,
    phaseGuardOverlay: candidateWriteEnabled ? {
      destination: phaseGuardDestination, readOnly: true, sha256: phaseGuardSha256,
      sourceMatchesExpectedSnapshot: true,
      integratedInCandidateImage: false,
    } : null,
    progressDetectorOverlay: candidateWriteEnabled ? {
      destination: progressDetectorDestination, readOnly: true, sha256: progressDetectorSha256,
      sourceMatchesExpectedSnapshot: true,
      integratedInCandidateImage: false,
    } : null,
    verificationProven: false,
    semanticCorrectnessProven: false,
    databaseBehaviorProven: false,
    completionProven: false,
    releaseProven: false,
  },
  protectedHeadlessRunnerOverlay: {
    destination: protectedRunnerDestination, readOnly: true, sha256: protectedRunnerSha256,
    sourceMatchesExpectedSnapshot: true, integratedInCandidateImage: false,
  },
  promptDelivery: {
    transport: 'run-owned-docker-volume', destination: '/eval-prompt', readOnly: true,
    modelOnly: true, hostPathExposedToModel: false,
  },
  model: project(model), broker: project(broker), runner: nativeHost ? hostProcess : project(runner),
  dependencyNetworkIsolationProven: false,
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
fs.unlinkSync(rawFile);
NODE
  docker network inspect "${case_network}" "${proxy_egress_network}" \
    | node "${ACTIVE_ANALYZER_FILE}" project-network-boundary \
      --model-name "${current_model_container}" --proxy-name "${proxy_container}" \
      --broker-name "${broker_container}" \
      --model-network "${case_network}" --proxy-egress-network "${proxy_egress_network}" \
      --run-token "${run_token}" \
      --output "${current_boundary_dir}/network-boundary.inspect.json"
  if [[ "${PREFLIGHT_ONLY}" -eq 1 ]]; then
    node - "${current_boundary_dir}/preflight-only.receipt.json" "${RUNNER_VERSION}" "${run_id}" \
      "${case_id}" "${current_phase_id}" "${image_id}" "${INPUT_CLOSURE_DIGEST}" \
      "${RUNTIME_PACKAGE_LOCK_SHA256}" "${current_prompt_sha256}" "${VERIFICATION_MODE}" <<'NODE'
const fs = require('node:fs');
const [target, runnerVersion, runId, caseId, phaseId, imageId, inputClosureDigest,
  runtimeLockSha256, promptSha256, verificationMode] = process.argv.slice(2);
fs.writeFileSync(target, `${JSON.stringify({
  schemaVersion: 'forge-harness-eval-preflight-only/v2',
  runnerVersion,
  runId,
  caseId,
  phaseId,
  imageId,
  inputClosureDigest,
  runtimeLockSha256,
  reachedBoundary: 'model-prompt-access-verified-created-not-started',
  runtimeBoundaryVerified: true,
  verificationBoundaryVerified: true,
  networkBoundaryVerified: true,
  promptDelivery: {
    transport: 'run-owned-docker-volume', destination: '/eval-prompt', readOnly: true,
    modelUser: '1000:1000', readable: true, nonEmpty: true, digestMatches: true,
    promptSha256, hostPathExposedToModel: false,
  },
  modelContainerStarted: false,
  modelRequests: 0,
  hostRunnerStarted: verificationMode === 'host-toolchain',
  hostProfileExecutions: 0,
  dependencyNetworkIsolationProven: false,
  serverTouched: false,
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
    PREFLIGHT_COMPLETED=1
    exit 0
  fi
  start_capture_with_timeout \
    "${current_model_container}" "${current_model_stdout}" "${current_model_stderr}" \
    "${MODEL_TIMEOUT_SECONDS}"
  model_attach_exit="${MODEL_ATTACH_EXIT}"
  model_timeout_status="${MODEL_TIMEOUT_STATUS}"
  model_elapsed_seconds="${MODEL_ELAPSED_SECONDS}"
  model_running_before_stop="$(docker container inspect --format '{{.State.Running}}' "${current_model_container}" 2>/dev/null)" \
    || die "model container state inspection failed for ${case_id}"
  [[ "${model_running_before_stop}" == "true" || "${model_running_before_stop}" == "false" ]] \
    || die "model container returned an invalid running state for ${case_id}"
  model_stop_invoked=0
  model_timeout_stop_exit=0
  if [[ "${model_timeout_status}" == "completed" && "${model_running_before_stop}" == "true" ]]; then
    model_timeout_status="supervisor-failed"
  fi
  if [[ "${model_timeout_status}" != "completed" || "${model_running_before_stop}" == "true" ]]; then
    model_stop_invoked=1
    set +e
    stop_owned_container "${current_model_container}" \
      >"${current_boundary_dir}/model-timeout-stop.stdout.txt" 2>"${current_boundary_dir}/model-timeout-stop.stderr.txt"
    model_timeout_stop_exit=$?
    set -e
  fi
  model_running_after_stop="$(docker container inspect --format '{{.State.Running}}' "${current_model_container}" 2>/dev/null)" \
    || die "model post-timeout state inspection failed for ${case_id}"
  [[ "${model_running_after_stop}" == "false" ]] \
    || die "model container remained active after bounded supervision for ${case_id}"
  model_supervision_elapsed_seconds=$((SECONDS - MODEL_SUPERVISION_STARTED_SECONDS))
  model_exit="$(docker container inspect --format '{{.State.ExitCode}}' "${current_model_container}" 2>/dev/null)"
  [[ "${model_exit}" =~ ^[0-9]+$ ]] || model_exit=255
  node - "${current_supervision_file}" "${MODEL_TIMEOUT_SECONDS}" "${model_elapsed_seconds}" "${model_supervision_elapsed_seconds}" "${model_timeout_status}" \
    "${model_attach_exit}" "${model_exit}" "${model_stop_invoked}" "${model_timeout_stop_exit}" \
    "${model_running_before_stop}" "${model_running_after_stop}" <<'NODE'
const fs = require('node:fs');
const [target, timeoutSeconds, attachElapsedSeconds, supervisionElapsedSeconds, status, attachExitCode, containerExitCode, stopInvoked, stopExitCode, runningBefore, runningAfter] = process.argv.slice(2);
const integer = (value) => Number.parseInt(value, 10);
const stopped = runningAfter === 'false';
const stopSucceeded = stopInvoked !== '1' || integer(stopExitCode) === 0;
const payload = {
  schemaVersion: 'forge-harness-model-supervision/v1',
  configuredAttachDeadlineSeconds: integer(timeoutSeconds),
  attachElapsedSeconds: integer(attachElapsedSeconds),
  supervisionElapsedSeconds: integer(supervisionElapsedSeconds),
  attachDeadlineSupervisorSucceeded: status !== 'supervisor-failed',
  containerQuiescenceProvenBeforeEvidence: stopped && stopSucceeded,
  hostTotalDurationBoundProven: false,
  configuredDockerStopGraceSeconds: 15,
  status,
  timedOut: status === 'timed-out',
  supervisorFailed: status === 'supervisor-failed',
  attachExitCode: integer(attachExitCode),
  containerExitCode: integer(containerExitCode),
  exactOwnedStop: {
    invoked: stopInvoked === '1',
    exitCode: integer(stopExitCode),
    runningBefore: runningBefore === 'true',
    runningAfter: runningAfter === 'true',
  },
};
fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
  [[ "${model_timeout_status}" != "supervisor-failed" && "${model_timeout_stop_exit}" -eq 0 ]] \
    || die "model supervision failed closed for ${case_id}; incomplete evidence was retained"

    if [[ -n "${phase_workflow_id}" ]]; then
      printf '\n===== %s =====\n' "${current_phase_id}" >>"${case_dir}/model.stdout.txt"
      cat -- "${current_model_stdout}" >>"${case_dir}/model.stdout.txt"
      printf '\n===== %s =====\n' "${current_phase_id}" >>"${case_dir}/model.stderr.txt"
      cat -- "${current_model_stderr}" >>"${case_dir}/model.stderr.txt"
      cp -f -- "${current_supervision_file}" "${case_dir}/model-supervision.json"
      [[ "${model_exit}" -eq 0 && "${model_timeout_status}" == 'completed' ]] \
        || die "model phase failed for ${case_id}/${current_phase_id}; later paid phases were not started"

      phase_observer_container="${resource_prefix}-observe-${phase_number}-${current_phase_id:0:18}"
      run_phase_workspace_observation "${phase_observer_container}" "${phase_dir_docker}" \
        "${phase_dir}/observation.stdout.txt" "${phase_dir}/observation.stderr.txt" \
        || die "post-phase workspace observation failed for ${case_id}/${current_phase_id}"

      phase_preflight_container="${resource_prefix}-preflight-${phase_number}-${current_phase_id:0:18}"
      if ! run_phase_controller_preflight "${phase_preflight_container}" "${phase_dir_docker}" \
        "${phase_dir}/controller-preflight.stdout.txt" "${phase_dir}/controller-preflight.stderr.txt"; then
        [[ "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 && "${phase_attempt_number}" -eq 1 ]] \
          || die "phase controller preflight rejected ${case_id}/${current_phase_id}; Host Runner and later paid phases were not started"
        phase_format_retry_container="${resource_prefix}-format-retry-${phase_number}-${phase_attempt_number}"
        run_phase_controller_review_command "${phase_format_retry_container}" format-retry-prompt "${phase_dir_docker}" \
          "${phase_dir}/controller-format-retry.stdout.txt" "${phase_dir}/controller-format-retry.stderr.txt" \
          --artifacts-directory /phase-control/artifacts --original-request-file /original-request.md \
          --response-file /phase-evidence/model.stdout.txt \
          --all-changed-paths-file /phase-evidence/all-changed-paths.json \
          --phase-changed-paths-file /phase-evidence/phase-changed-paths.json \
          --phase-patch-file /phase-evidence/phase.patch \
          --cumulative-patch-file /phase-evidence/cumulative.patch \
          --prompt-file /phase-control/current-prompt.md \
          --rejection-receipt-file /phase-evidence/controller-reject-receipt.json \
          || die "phase controller rejected format correction for ${case_id}/${current_phase_id}; Host Runner and later paid phases were not started"
        rejected_attempt_id="$(node - "${phase_dir}/controller-format-retry.stdout.txt" <<'NODE'
const fs = require('node:fs');
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (receipt.schemaVersion !== 'forge-delivery-phase-format-retry-prompt/v1'
  || receipt.stateAdvanced !== false || !/^[0-9a-f-]{36}$/u.test(receipt.rejectedAttemptId)) process.exit(1);
process.stdout.write(receipt.rejectedAttemptId);
NODE
)" || die "controller format retry receipt invalid for ${case_id}/${current_phase_id}"
        cp -- "${phase_control_dir}/current-prompt.md.${rejected_attempt_id}.retry-receipt.json" \
          "${phase_dir}/controller-retry-prompt-receipt.json"
        remove_owned_container "${current_model_container}"
        continue
      fi

      if [[ "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]]; then
        semantic_review_file="${phase_dir}/independent-semantic-review.json"
        node - "${phase_dir}/controller-preflight-receipt.json" "${current_model_stdout}" "${semantic_review_file}" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [preflightFile, responseFile, reviewFile] = process.argv.slice(2);
const preflight = JSON.parse(fs.readFileSync(preflightFile, 'utf8'));
const responseSha256 = crypto.createHash('sha256').update(fs.readFileSync(responseFile)).digest('hex');
process.stderr.write(`forge-harness-eval: WAITING_INDEPENDENT_REVIEW file=${reviewFile} phase=${preflight.phaseId} attempt=${preflight.phaseAttemptId} responseSha256=${responseSha256} candidateArtifactDigest=${preflight.candidateArtifactDigest}\n`);
NODE
        wait_for_independent_semantic_review "${semantic_review_file}" \
          || die "independent semantic review missing, unsafe, or timed out after ${SEMANTIC_REVIEW_TIMEOUT_SECONDS}s for ${case_id}/${current_phase_id}"
        phase_review_container="${resource_prefix}-review-${phase_number}-${phase_attempt_number}"
        run_phase_controller_review_command "${phase_review_container}" inspect-semantic-review "${phase_dir_docker}" \
          "${phase_dir}/controller-review.stdout.txt" "${phase_dir}/controller-review.stderr.txt" \
          --response-file /phase-evidence/model.stdout.txt \
          --preflight-receipt-file /phase-evidence/controller-preflight-receipt.json \
          --semantic-review-file /phase-evidence/independent-semantic-review.json \
          || die "independent semantic review evidence failed closed for ${case_id}/${current_phase_id}"
        semantic_verdict="$(node - "${phase_dir}/controller-review.stdout.txt" <<'NODE'
const fs = require('node:fs');
const review = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!['PASS', 'reject'].includes(review.verdict)) process.exit(1);
process.stdout.write(review.verdict);
NODE
)" || die "controller semantic verdict could not be read for ${case_id}/${current_phase_id}"
        if [[ "${semantic_verdict}" == 'reject' ]]; then
          phase_reject_container="${resource_prefix}-reject-${phase_number}-${phase_attempt_number}"
          run_phase_controller_review_command "${phase_reject_container}" reject "${phase_dir_docker}" \
            "${phase_dir}/controller-reject.stdout.txt" "${phase_dir}/controller-reject.stderr.txt" \
            --reason-code SEMANTIC_INDEPENDENT_REVIEW_REJECTED \
            --receipt-file /phase-evidence/controller-reject-receipt.json \
            || die "controller semantic rejection failed for ${case_id}/${current_phase_id}"
          rejected_attempt_id="$(node - "${phase_dir}/controller-reject-receipt.json" <<'NODE'
const fs = require('node:fs');
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (receipt.decision !== 'rejected' || !/^[0-9a-f-]{36}$/u.test(receipt.attemptId)) process.exit(1);
process.stdout.write(receipt.attemptId);
NODE
)" || die "controller rejection receipt invalid for ${case_id}/${current_phase_id}"
          phase_retry_container="${resource_prefix}-retry-${phase_number}-${phase_attempt_number}"
          run_phase_controller_review_command "${phase_retry_container}" retry-prompt "${phase_dir_docker}" \
            "${phase_dir}/controller-retry.stdout.txt" "${phase_dir}/controller-retry.stderr.txt" \
            --artifacts-directory /phase-control/artifacts --original-request-file /original-request.md \
            --response-file /phase-evidence/model.stdout.txt \
            --preflight-receipt-file /phase-evidence/controller-preflight-receipt.json \
            --semantic-review-file /phase-evidence/independent-semantic-review.json \
            --prompt-file /phase-control/current-prompt.md \
            --receipt-file "/phase-control/current-prompt.md.${rejected_attempt_id}.retry-receipt.json" \
            || die "controller retry budget/evidence rejected ${case_id}/${current_phase_id}; Host Runner was not started"
          cp -- "${phase_control_dir}/current-prompt.md.${rejected_attempt_id}.retry-receipt.json" \
            "${phase_dir}/controller-retry-prompt-receipt.json"
          remove_owned_container "${current_model_container}"
          continue
        fi
      fi

      phase_host_profiles_text="$(node - "${phase_dir}/controller-preflight-receipt.json" \
        "${phase_workflow_descriptor}" "${phase_workflow_id}" "${current_phase_id}" "${phase_index}" <<'NODE'
const fs = require('node:fs');
const [file, descriptorJson, workflowId, phaseId, phaseIndex] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
const descriptor = JSON.parse(descriptorJson);
const numericPhaseIndex = Number(phaseIndex);
const phase = descriptor.phases?.[numericPhaseIndex];
const profiles = receipt.hostVerificationProfiles;
if (receipt.schemaVersion !== 'forge-delivery-phase-controller-preflight/v1'
  || receipt.workflowId !== workflowId || receipt.phaseId !== phaseId
  || receipt.phaseIndex !== numericPhaseIndex || receipt.safeForOperatorHostVerification !== true
  || receipt.stateAdvanced !== false || !Array.isArray(profiles)
  || new Set(profiles).size !== profiles.length
  || profiles.some((profile) => typeof profile !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(profile))
  || descriptor.workflowId !== workflowId || descriptor.orderedPhases?.[numericPhaseIndex] !== phaseId
  || phase?.id !== phaseId || phase.index !== numericPhaseIndex
  || JSON.stringify(profiles) !== JSON.stringify(phase.hostVerificationProfiles)) {
  throw new Error('phase preflight Host profile projection mismatch');
}
for (const profile of profiles) process.stdout.write(`${profile}\n`);
NODE
      )" || die "phase preflight Host profile projection failed for ${case_id}/${current_phase_id}"
      phase_host_profiles=()
      mapfile -t phase_host_profiles < <(printf '%s' "${phase_host_profiles_text}")
      if [[ "${#phase_host_profiles[@]}" -gt 0 ]]; then
        phase_patch_for_host="${phase_dir}/cumulative.patch"
        host_profile_selection_args=()
        for phase_host_profile in "${phase_host_profiles[@]}"; do
          host_profile_selection_args+=(--profile "${phase_host_profile}")
        done
        verify_host_runner_bundle \
          || die "Host Runner bundle changed before ${case_id}/${current_phase_id} verification"
        verify_host_profile_adapter \
          || die "Host Runner adapter changed before ${case_id}/${current_phase_id} verification"
        host_profile_command=(bash)
        host_profile_source="${SOURCE_PATH}"
        host_profile_evidence="${phase_dir}/host-runner"
        host_profile_state_args=()
        if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
          # The paid model is stopped before the operator adapter uses the same TaskSpace cache.
          node -e 'const h=require("node:http");const q=h.request({socketPath:process.argv[1],path:"/healthz"},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{if(r.statusCode!==200||JSON.parse(b).activeJobs!==0)process.exitCode=1})});q.on("error",()=>process.exitCode=1);q.end()' "${verification_runner_socket}" \
            || die 'native Host Runner still has active verification before operator phase execution'
          native_phase_root="${HOST_RUNTIME_ROOT}/host-phases/${current_phase_id}"
          mkdir -p -- "${native_phase_root}"
          cp -- "${phase_patch_for_host}" "${native_phase_root}/cumulative.patch"
          if [[ "${local_uid}" -eq 0 ]]; then chown -R 1000:1000 -- "${HOST_RUNTIME_ROOT}/host-phases"; fi
          host_profile_source="${HOST_RUNTIME_ROOT}/baseline"
          phase_patch_for_host="${native_phase_root}/cumulative.patch"
          host_profile_evidence="${native_phase_root}/evidence"
          host_profile_command=("${HOST_USER_COMMAND[@]}" env -i PATH="${PATH}" HOME="${HOST_STATE_ROOT}" LANG=C.UTF-8 LC_ALL=C.UTF-8 bash)
          host_profile_state_args=(--state-root "${HOST_STATE_ROOT}" --project-slug "${eval_project_slug}")
        fi
        host_profile_exit=0
        "${host_profile_command[@]}" "${LOCAL_HOST_PROFILE_RUNNER}" \
          --source "${host_profile_source}" --patch "${phase_patch_for_host}" \
          --case "${case_id}" --phase "${current_phase_id}" --image "${image_id}" \
          --runner-bundle "${HOST_RUNNER_BUNDLE}" \
          --runner-manifest-sha256 "${HOST_RUNNER_MANIFEST_SHA256}" \
          --runtime-root "${host_profile_runtime_root}" --runtime-root-owner "${run_token}" \
          "${host_profile_selection_args[@]}" "${host_profile_state_args[@]}" \
          --evidence-dir "${host_profile_evidence}" \
          >"${phase_dir}/host-runner.stdout.txt" 2>"${phase_dir}/host-runner.stderr.txt" \
          || host_profile_exit=$?
        if [[ "${VERIFICATION_MODE}" == 'host-toolchain' && -d "${host_profile_evidence}" ]]; then
          cp -a -- "${host_profile_evidence}" "${phase_dir}/host-runner"
        fi
        [[ "${host_profile_exit}" -eq 0 ]] || die "operator Host Runner failed for ${case_id}/${current_phase_id}"
        cp -- "${phase_dir}/host-runner/phase-host-receipts.json" \
          "${phase_dir}/phase-host-receipts.json"
      else
        printf '[]\n' >"${phase_dir}/phase-host-receipts.json"
      fi

      phase_finalize_container="${resource_prefix}-finalize-${phase_number}-${current_phase_id:0:18}"
      run_phase_controller_finalize "${phase_finalize_container}" "${phase_dir_docker}" \
        "${phase_dir}/controller-finalize.stdout.txt" "${phase_dir}/controller-finalize.stderr.txt" \
        || die "phase controller rejected ${case_id}/${current_phase_id}; later paid phases were not started"
      if [[ "${INDEPENDENT_SEMANTIC_REVIEW}" -eq 1 ]]; then
        cp -a -- "${phase_dir}/." "${phase_canonical_dir}/" \
          || die "accepted phase evidence projection failed for ${case_id}/${current_phase_id}"
      fi
      node - "${phase_dir}/controller/controller-result.json" "${current_phase_id}" \
        "${phase_index}" "${#MODEL_PHASE_IDS[@]}" "${MODEL_PHASE_IDS[$((phase_index + 1))]:-}" <<'NODE'
const fs = require('node:fs');
const [file, phaseId, phaseIndex, phaseCount, expectedNext] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
const finalPhase = Number(phaseIndex) === Number(phaseCount) - 1;
if (result.acceptedPhaseId !== phaseId || result.acceptedPhaseIndex !== Number(phaseIndex)
  || result.workflowStatus !== (finalPhase ? 'completed' : 'active')
  || result.nextPhaseId !== (finalPhase ? null : expectedNext)
  || !/^[0-9a-f]{64}$/u.test(result.phaseArtifactDigest)
  || !/^[0-9a-f]{64}$/u.test(result.cumulativePatchDigest)) {
  throw new Error('phase controller advancement receipt mismatch');
}
NODE
      if [[ "${phase_index}" -lt "$(( ${#MODEL_PHASE_IDS[@]} - 1 ))" ]]; then
        remove_owned_container "${current_model_container}"
      else
        model_container="${current_model_container}"
      fi
    fi
    break
    done
    phase_index=$((phase_index + 1))
  done

  stop_controlled_verification_service_with_evidence "${broker_container}" "${case_dir}/taskspace-broker" taskspace-broker \
    || die "TaskSpace Broker stop/log/inspection supervision failed closed for ${case_id}"
  if [[ "${VERIFICATION_MODE}" == 'host-toolchain' ]]; then
    stop_native_host_runner || die "native Host Runner supervision failed closed for ${case_id}"
  else
    stop_controlled_verification_service_with_evidence "${verification_runner_container}" "${case_dir}/verification-runner" verification-runner \
      || die "Verification Runner stop/log/inspection supervision failed closed for ${case_id}"
  fi

  set +e
  stop_owned_container "${proxy_container}" >"${case_dir}/credential-proxy.stop.stdout.txt" 2>"${case_dir}/credential-proxy.stop.stderr.txt"
  proxy_stop_exit=$?
  proxy_exit="$(docker container inspect --format '{{.State.ExitCode}}' "${proxy_container}" 2>/dev/null)"
  proxy_exit_inspect_exit=$?
  proxy_running_after_stop="$(docker container inspect --format '{{.State.Running}}' "${proxy_container}" 2>/dev/null)"
  proxy_running_inspect_exit=$?
  docker logs "${proxy_container}" >"${case_dir}/credential-proxy.stdout.txt" 2>"${case_dir}/credential-proxy.stderr.txt"
  proxy_logs_exit=$?
  set -e
  [[ "${proxy_exit}" =~ ^[0-9]+$ ]] || proxy_exit=255
  [[ "${proxy_stop_exit}" -eq 0 && "${proxy_exit_inspect_exit}" -eq 0 \
    && "${proxy_running_inspect_exit}" -eq 0 && "${proxy_running_after_stop}" == "false" \
    && "${proxy_logs_exit}" -eq 0 && "${proxy_exit}" -eq 0 ]] \
    || die "credential proxy stop/process/log supervision failed closed for ${case_id}"
  node - "${case_dir}/credential-proxy-supervision.json" "${proxy_stop_exit}" \
    "${proxy_exit_inspect_exit}" "${proxy_running_inspect_exit}" "${proxy_running_after_stop}" \
    "${proxy_logs_exit}" "${proxy_exit}" <<'NODE'
const fs = require('node:fs');
const [target, stopExitCode, exitInspectExitCode, runningInspectExitCode,
  runningAfterStop, logsExitCode, processExitCode] = process.argv.slice(2);
const numeric = (value) => Number.parseInt(value, 10);
const payload = {
  schemaVersion: 'forge-harness-credential-proxy-supervision/v1',
  configuredDockerStopGraceSeconds: 15,
  exactOwnedStopExitCode: numeric(stopExitCode),
  exitCodeInspectionExitCode: numeric(exitInspectExitCode),
  runningStateInspectionExitCode: numeric(runningInspectExitCode),
  runningAfterStop: runningAfterStop === 'true',
  logsCollectionExitCode: numeric(logsExitCode),
  processExitCode: numeric(processExitCode),
  processQuiescenceProvenBeforeEvidence: runningAfterStop === 'false',
};
fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
  remove_owned_container "${proxy_container}"
  ACTIVE_PROXY_CONTAINER=""
  ACTIVE_PROXY_CASE_DIR=""

  set +e
  docker cp "${model_container}:/home/node/.dsh/sessions/." "${case_session_docker_path}" 2>"${case_dir}/session-export.stderr.txt"
  session_export_exit=$?
  set -e

  create_readonly_workspace_container "${status_container}" "${case_workspace_source}" "${case_git_source}" /usr/bin/git -C /workspace status --porcelain=v2 --branch --untracked-files=all
  status_exit="$(start_capture "${status_container}" "${case_dir}/git.status.txt" "${case_dir}/git.status.stderr.txt")"
  remove_owned_container "${status_container}"

  create_readonly_workspace_container "${diff_container}" "${case_workspace_source}" "${case_git_source}" /usr/bin/git -C /workspace diff --binary "${REQUIRED_SOURCE_COMMIT}" --
  diff_exit="$(start_capture "${diff_container}" "${case_dir}/git.diff.patch" "${case_dir}/git.diff.stderr.txt")"
  remove_owned_container "${diff_container}"

  # Preserve a reviewable complete source patch. Plain `git diff` excludes all
  # untracked files, which made the first real CRUD run reconstructable only
  # from the raw model trace. The NUL-delimited loop is filename-safe and emits
  # a binary patch for every changed tracked or untracked file without granting
  # the evidence collector write access to the workspace.
  create_readonly_workspace_container "${workspace_patch_container}" "${case_workspace_source}" "${case_git_source}" \
    /bin/bash -c 'set -euo pipefail
      export LC_ALL=C
      git -C /workspace diff --binary 908e13bdc08ec2cbb071d355a2c33a77c970bdd3 --
      while IFS= read -r -d "" file; do
        set +e
        git -C /workspace diff --binary --no-index -- /dev/null "$file"
        code=$?
        set -e
        [ "$code" -eq 1 ] || exit "$code"
      done < <(git -C /workspace ls-files --others --exclude-standard -z)'
  workspace_patch_exit="$(start_capture "${workspace_patch_container}" "${case_dir}/workspace.patch" "${case_dir}/workspace.patch.stderr.txt")"
  remove_owned_container "${workspace_patch_container}"

  create_readonly_workspace_container "${audit_container}" "${case_workspace_source}" "${case_git_source}" /usr/local/bin/forge-governance audit --root /workspace --base "${REQUIRED_SOURCE_COMMIT}" --format json
  static_gate_exit="$(start_capture "${audit_container}" "${case_dir}/forge-governance.json" "${case_dir}/forge-governance.stderr.txt")"
  remove_owned_container "${audit_container}"

  set +e
  verify_input_snapshot || die "the evaluation input closure changed before evidence projection: ${case_id}"
  node "${ACTIVE_ANALYZER_FILE}" project --input-root "${case_dir}/session" --output "${case_dir}/session-projection.jsonl" \
    >"${case_dir}/session-projection.stdout.txt" 2>"${case_dir}/session-projection.stderr.txt"
  analyzer_exit=$?
  set -e

  # Raw artifacts and their projection exist only in the private staging directory.
  # Exact-key replacement and a full rescan must succeed before hashing or publication.
  set +e
  scrub_all_bearer_secrets "${case_dir}" "${case_dir}/secret-scan" "${case_dir}/secret-scan.json" \
    >"${case_dir}/secret-scrub.stdout.txt" 2>"${case_dir}/secret-scrub.stderr.txt"
  scrub_exit=$?
  set -e
  [[ "${scrub_exit}" -eq 0 ]] || die "secret scrub failed for ${case_id}; evidence manifest was not created"
  set +e
  node "${ACTIVE_ANALYZER_FILE}" evaluate-behavior \
    --suite "${ACTIVE_SUITE_FILE}" \
    --case-id "${case_id}" \
    --projection "${case_dir}/session-projection.jsonl" \
    --model-stdout "${case_dir}/model.stdout.txt" \
    --model-supervision "${case_dir}/model-supervision.json" \
    --static-gate "${case_dir}/forge-governance.json" \
    --workspace-patch "${case_dir}/workspace.patch" \
    --model-timeout-seconds "${MODEL_TIMEOUT_SECONDS}" \
    --output "${case_dir}/behavior-evaluation.json" \
    >"${case_dir}/behavior-evaluation.stdout.txt" 2>"${case_dir}/behavior-evaluation.stderr.txt"
  behavior_evaluation_exit=$?
  set -e
  [[ "${session_export_exit}" -eq 0 \
    && "${status_exit}" -eq 0 \
    && "${diff_exit}" -eq 0 \
    && "${workspace_patch_exit}" -eq 0 \
    && "${analyzer_exit}" -eq 0 \
    && "${behavior_evaluation_exit}" -eq 0 \
    && "${proxy_logs_exit}" -eq 0 \
    && "${proxy_stop_exit}" -eq 0 \
    && ( "${static_gate_exit}" -eq 0 || "${static_gate_exit}" -eq 2 ) ]] \
    || die "evidence collection failed closed for ${case_id}; incomplete evidence was retained"
  verify_input_snapshot || die "the evaluation input closure changed before case manifest creation: ${case_id}"

  case_finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  manifest_path="${case_dir}/manifest.json"
  phase_execution_json='null'
  if [[ -n "${phase_workflow_id}" ]]; then
    phase_execution_json="$(node - "${ACTIVE_PHASE_RUNTIME}" "${phase_catalog_file}" \
      "${phase_control_dir}/state.json" "${phase_workflow_id}" "${case_id}" <<'NODE'
const { pathToFileURL } = require('node:url');
const [runtimeFile, catalogFile, stateFile, workflowId, caseFamily] = process.argv.slice(2);
(async () => {
  const runtime = await import(pathToFileURL(runtimeFile).href);
  const loaded = await runtime.loadForgeDeliveryPhaseCatalog(catalogFile);
  const state = await runtime.readForgeDeliveryPhaseState(stateFile, loaded.catalog);
  const projection = runtime.projectCompletedForgeDeliveryPhaseExecution({
    catalog: loaded.catalog,
    workflowId,
    caseFamily,
    state,
  });
  process.stdout.write(JSON.stringify(projection));
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
NODE
    )" || die "completed phase execution projection failed for ${case_id}"
  fi
  node - "${case_dir}" "${manifest_path}" "${RUNNER_VERSION}" "${run_id}" "${case_id}" "${suite_version}" "${prompt_version}" "${prompt_relative}" "${prompt_sha}" "${source_head}" "${admission_exit}" "${image_id}" "${proxy_image_id}" "${proxy_image_reference}" "${EXPECTED_CONFIGURED_PROVIDER}" "${EXPECTED_REQUEST_MODEL}" "${EXPECTED_UPSTREAM_ORIGIN}" "${MAX_OUTPUT_TOKENS_PER_REQUEST}" "${MAX_PROXY_REQUEST_BYTES}" "${MAX_PROXY_TOTAL_REQUEST_BYTES}" "${EXPECTED_SUITE_SHA256}" "${EXPECTED_ANALYZER_SHA256}" "${INPUT_CLOSURE_DIGEST}" "${INPUT_LOCK_SHA256}" "${case_started_at}" "${case_finished_at}" "${model_exit}" "${static_gate_exit}" "${session_export_exit}" "${status_exit}" "${diff_exit}" "${workspace_patch_exit}" "${scrub_exit}" "${analyzer_exit}" "${proxy_probe_exit}" "${proxy_logs_exit}" "${proxy_stop_exit}" "${proxy_exit}" "${MAX_MODEL_REQUESTS}" "${MODEL_TIMEOUT_SECONDS}" "${RETAIN_VOLUMES}" "${MAX_CASE_EVIDENCE_FILES}" "${MAX_CASE_EVIDENCE_BYTES}" "${VERIFICATION_MODE}" "${VERIFICATION_CACHE_FINGERPRINT}" "${TEST_SHADOW_CANDIDATE_WRITE}" "${TEST_SHADOW_CANDIDATE_WRITE_RUNTIME_MODE}" "${EXPECTED_HARNESS_IMAGE_REVISION}" "${EXPECTED_PHASE_BUDGET_GUARD_SHA256}" "${EXPECTED_PROGRESS_DETECTOR_SHA256}" "${EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256}" "${phase_execution_json}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const [caseDir, manifestPath, runnerVersion, runId, caseId, suiteVersion, promptVersion, promptRelative, promptSha256, sourceHead, admissionExit, imageId, proxyImageId, proxyImageReference, configuredProvider, requestModel, upstreamOrigin, maxOutputTokens, maxRequestBytes, maxTotalRequestBytes, suiteSha256, analyzerSha256, inputClosureDigest, inputLockSha256, startedAt, finishedAt, modelExit, staticGateExit, sessionExportExit, statusExit, diffExit, workspacePatchExit, scrubExit, analyzerExit, proxyProbeExit, proxyLogsExit, proxyStopExit, proxyExit, maxModelRequests, modelTimeoutSeconds, retainVolumes, maxCaseFiles, maxCaseBytes, verificationMode, verificationCacheFingerprint, candidateWriteMode, candidateWriteRuntimeMode, expectedVerificationRunnerRevision, phaseGuardSha256, progressDetectorSha256, protectedRunnerSha256, phaseExecutionJson] = args;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) throw new Error('evidence must not contain symlinks');
    if (info.isDirectory()) walk(target);
    else if (info.isFile() && path.resolve(target) !== path.resolve(manifestPath)) files.push(target);
  }
};
walk(caseDir);
files.sort((left, right) => left.localeCompare(right));
const artifacts = Object.fromEntries(files.map((file) => {
  const name = path.relative(caseDir, file).split(path.sep).join('/');
  return [name, { sha256: hash(file), bytes: fs.statSync(file).size }];
}));
const artifactBytes = Object.values(artifacts).reduce((total, receipt) => total + receipt.bytes, 0);
const secretScan = JSON.parse(fs.readFileSync(path.join(caseDir, 'secret-scan.json'), 'utf8'));
if (secretScan.schemaVersion !== 'forge-harness-multi-secret-scrub/v1'
  || JSON.stringify(secretScan.secretClasses) !== JSON.stringify(['model-api-key', 'taskspace-broker-token'])
  || secretScan.secretRetained !== false || secretScan.passes?.some((pass) => pass.secretRetained !== false)) {
  throw new Error('multi-bearer secret scrub receipt mismatch');
}
const numeric = (value) => Number.parseInt(value, 10);
const supervision = JSON.parse(fs.readFileSync(path.join(caseDir, 'model-supervision.json'), 'utf8'));
if (supervision.schemaVersion !== 'forge-harness-model-supervision/v1'
  || supervision.configuredAttachDeadlineSeconds !== numeric(modelTimeoutSeconds)
  || supervision.containerExitCode !== numeric(modelExit)
  || supervision.attachDeadlineSupervisorSucceeded !== true
  || supervision.containerQuiescenceProvenBeforeEvidence !== true
  || supervision.hostTotalDurationBoundProven !== false
  || supervision.configuredDockerStopGraceSeconds !== 15
  || !Number.isSafeInteger(supervision.attachElapsedSeconds)
  || !Number.isSafeInteger(supervision.supervisionElapsedSeconds)
  || supervision.supervisionElapsedSeconds < supervision.attachElapsedSeconds
  || supervision.supervisorFailed !== false
  || supervision.exactOwnedStop?.runningAfter !== false) {
  throw new Error('model supervision receipt mismatch');
}
const verificationExecutionAdmission = JSON.parse(fs.readFileSync(path.join(caseDir, 'verification-execution-admission.json'), 'utf8'));
const verificationBoundary = JSON.parse(fs.readFileSync(path.join(caseDir, 'verification-boundary.inspect.json'), 'utf8'));
const brokerSupervision = JSON.parse(fs.readFileSync(path.join(caseDir, 'taskspace-broker.supervision.json'), 'utf8'));
const verificationRunnerSupervision = JSON.parse(fs.readFileSync(path.join(caseDir, 'verification-runner.supervision.json'), 'utf8'));
const verificationReady = verificationMode === 'cache-ready';
const nativeHost = verificationMode === 'host-toolchain';
if (!verificationReady && !nativeHost && verificationMode !== 'cache-miss') throw new Error('controlled verification mode is invalid');
const candidateWriteEnabled = candidateWriteMode === 'candidate-only';
if (!['', 'candidate-only'].includes(candidateWriteMode)
  || (candidateWriteEnabled && verificationMode !== 'cache-miss')) {
  throw new Error('controlled candidate-write mode is invalid');
}
const executorProofs = ['proven', 'dockerApiProven', 'toolchainImageProven', 'samePathBindProven', 'stateWriteProven', 'cleanupProven'];
const truthProofs = ['executionProven', 'verificationProven', 'semanticCorrectnessProven', 'databaseIntegrationProven', 'releaseProven'];
if (verificationExecutionAdmission.schemaVersion !== (nativeHost ? 2 : 1)
  || verificationExecutionAdmission.receiptType !== (nativeHost ? 'forge-verify/host-execution-admission' : 'forge-verify/execution-admission')
  || verificationExecutionAdmission.outcome !== (verificationReady || nativeHost ? 'ready' : 'cache_miss')
  || verificationExecutionAdmission.reasonCode !== (verificationReady || nativeHost ? null : 'VERIFY_CACHE_MISS')
  || (nativeHost ? verificationExecutionAdmission.cache !== undefined || verificationExecutionAdmission.executor !== undefined
    : verificationExecutionAdmission.cache?.compatible !== verificationReady)
  || (verificationReady && verificationExecutionAdmission.source?.dependencyManifestFingerprint !== verificationCacheFingerprint)
  || (!nativeHost && executorProofs.some((name) => verificationExecutionAdmission.executor?.[name] !== verificationReady))
  || truthProofs.some((name) => verificationExecutionAdmission.truth?.[name] !== false)
  || verificationBoundary.schemaVersion !== 'forge-harness-controlled-verification-boundary/v1'
  || verificationBoundary.mode !== 'real-broker-runner-execution-admission-plane'
  || verificationBoundary.verificationMode !== verificationMode
  || verificationBoundary.cachePrepared !== verificationReady
  || verificationBoundary.dockerExecutionAvailable !== verificationReady
  || verificationBoundary.candidateWrite?.enabled !== candidateWriteEnabled
  || verificationBoundary.candidateWrite?.cliMode !== (candidateWriteEnabled ? 'candidate-only' : null)
  || verificationBoundary.candidateWrite?.runtimeMode !== (candidateWriteEnabled ? candidateWriteRuntimeMode : null)
  || verificationBoundary.candidateWrite?.authorityClass !== (candidateWriteEnabled ? 'test-shadow-writer' : null)
  || verificationBoundary.candidateWrite?.verificationRunnerRevision !== (candidateWriteEnabled ? expectedVerificationRunnerRevision : null)
  || verificationBoundary.protectedHeadlessRunnerOverlay?.destination !== '/usr/local/lib/forge-protected-headless-runner.mjs'
  || verificationBoundary.protectedHeadlessRunnerOverlay?.readOnly !== true
  || verificationBoundary.protectedHeadlessRunnerOverlay?.sha256 !== protectedRunnerSha256
  || verificationBoundary.protectedHeadlessRunnerOverlay?.sourceMatchesExpectedSnapshot !== true
  || verificationBoundary.protectedHeadlessRunnerOverlay?.integratedInCandidateImage !== false
  || (candidateWriteEnabled
    ? verificationBoundary.candidateWrite?.phaseGuardOverlay?.destination !== '/usr/local/lib/forge-phase-budget-guard.mjs'
      || verificationBoundary.candidateWrite?.phaseGuardOverlay?.readOnly !== true
      || verificationBoundary.candidateWrite?.phaseGuardOverlay?.sha256 !== phaseGuardSha256
      || verificationBoundary.candidateWrite?.phaseGuardOverlay?.sourceMatchesExpectedSnapshot !== true
      || verificationBoundary.candidateWrite?.phaseGuardOverlay?.integratedInCandidateImage !== false
      || verificationBoundary.candidateWrite?.progressDetectorOverlay?.destination !== '/usr/local/lib/forge-progress-detector.mjs'
      || verificationBoundary.candidateWrite?.progressDetectorOverlay?.readOnly !== true
      || verificationBoundary.candidateWrite?.progressDetectorOverlay?.sha256 !== progressDetectorSha256
      || verificationBoundary.candidateWrite?.progressDetectorOverlay?.sourceMatchesExpectedSnapshot !== true
      || verificationBoundary.candidateWrite?.progressDetectorOverlay?.integratedInCandidateImage !== false
    : verificationBoundary.candidateWrite?.phaseGuardOverlay !== null
      || verificationBoundary.candidateWrite?.progressDetectorOverlay !== null)
  || ['verificationProven', 'semanticCorrectnessProven', 'databaseBehaviorProven', 'completionProven', 'releaseProven']
    .some((name) => verificationBoundary.candidateWrite?.[name] !== false)
  || verificationBoundary.model?.dockerSocketMounted !== false
  || verificationBoundary.broker?.dockerSocketMounted !== false
  || verificationBoundary.runner?.dockerSocketMounted !== verificationReady
  || verificationBoundary.runner?.networkMode !== (nativeHost ? 'host' : 'none')
  || (nativeHost && (verificationBoundary.runner?.executionMode !== 'host-toolchain'
    || verificationBoundary.runner?.uid !== 1000 || verificationBoundary.runner?.gid !== 1000
    || verificationBoundary.runner?.noNewPrivileges !== true || verificationBoundary.runner?.dockerSocketAccessible !== false
    || verificationBoundary.runner?.dependencyNetworkIsolationProven !== false))
  || brokerSupervision.role !== 'taskspace-broker'
  || verificationRunnerSupervision.role !== 'verification-runner'
  || brokerSupervision.containerQuiescenceProvenBeforeEvidence !== true
  || (nativeHost ? verificationRunnerSupervision.schemaVersion !== 'forge-harness-host-runner-supervision/v1'
      || verificationRunnerSupervision.executionMode !== 'host-toolchain' || verificationRunnerSupervision.uid !== 1000
      || verificationRunnerSupervision.gid !== 1000 || verificationRunnerSupervision.processQuiescenceProvenBeforeEvidence !== true
      || verificationRunnerSupervision.pid !== verificationBoundary.runner?.pid
      || verificationRunnerSupervision.startTime !== verificationBoundary.runner?.startTime
      || verificationRunnerSupervision.dockerSocketAccessible !== false || verificationRunnerSupervision.dependencyNetworkIsolationProven !== false
    : verificationRunnerSupervision.containerQuiescenceProvenBeforeEvidence !== true)) {
  throw new Error('controlled verification execution-admission-plane evidence mismatch');
}
const proxyRecords = fs.readFileSync(path.join(caseDir, 'credential-proxy.stdout.txt'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));
if (proxyRecords.length !== 2 || proxyRecords[0]?.event !== 'ready' || proxyRecords[1]?.event !== 'stopped') {
  throw new Error('credential proxy logs must contain exactly ready then stopped receipts');
}
const proxyReady = proxyRecords[0];
const proxyStats = proxyRecords[1];
const safeNonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const expectedRejectionKeys = [
  'clientStream', 'contentType', 'invalidMaxOutputTokens', 'malformedJson',
  'modelContract', 'requestBytes', 'route', 'totalRequestBytes',
];
const actualRejectionKeys = Object.keys(proxyStats?.rejectedRequests ?? {}).sort();
if (!proxyStats || proxyStats.stopped !== true || proxyStats.service !== 'forge-credential-proxy'
  || proxyReady.ready !== true || proxyReady.port !== 8080
  || proxyReady.service !== 'forge-credential-proxy'
  || JSON.stringify(proxyReady.contract) !== JSON.stringify(proxyStats.contract)
  || proxyReady.maxRequests !== proxyStats.maxRequests
  || proxyReady.acceptedRequests !== 0 || proxyReady.rejectedByLimit !== 0
  || proxyReady.forwardedRequests !== 0 || proxyReady.forwardedRequestBytes !== 0
  || proxyStats.maxRequests !== numeric(maxModelRequests)
  || !safeNonnegativeInteger(proxyStats.acceptedRequests)
  || proxyStats.acceptedRequests > proxyStats.maxRequests
  || !safeNonnegativeInteger(proxyStats.rejectedByLimit)
  || proxyStats.contract?.expectedModel !== requestModel
  || proxyStats.contract?.maxOutputTokens !== numeric(maxOutputTokens)
  || proxyStats.contract?.maxRequestBytes !== numeric(maxRequestBytes)
  || proxyStats.contract?.maxTotalRequestBytes !== numeric(maxTotalRequestBytes)
  || !safeNonnegativeInteger(proxyStats.forwardedRequests)
  || proxyStats.forwardedRequests !== proxyStats.acceptedRequests
  || !safeNonnegativeInteger(proxyStats.forwardedRequestBytes)
  || proxyStats.forwardedRequestBytes > proxyStats.contract.maxTotalRequestBytes
  || !safeNonnegativeInteger(proxyStats.injectedMaxOutputTokens)
  || !safeNonnegativeInteger(proxyStats.clampedMaxOutputTokens)
  || proxyStats.injectedMaxOutputTokens + proxyStats.clampedMaxOutputTokens > proxyStats.forwardedRequests
  || !safeNonnegativeInteger(proxyStats.upstreamCreationFailures)
  || actualRejectionKeys.length !== expectedRejectionKeys.length
  || actualRejectionKeys.some((name, index) => name !== expectedRejectionKeys[index])
  || actualRejectionKeys.some((name) => !safeNonnegativeInteger(proxyStats.rejectedRequests[name]))
  || proxyStats.contractRejectedRequests !== proxyStats.rejectedRequests.malformedJson
    + proxyStats.rejectedRequests.modelContract + proxyStats.rejectedRequests.invalidMaxOutputTokens
  || proxyStats.byteLimitRejectedRequests !== proxyStats.rejectedRequests.requestBytes
    + proxyStats.rejectedRequests.totalRequestBytes) {
  throw new Error('credential proxy budget or request-contract receipt mismatch');
}
const proxySupervision = JSON.parse(fs.readFileSync(path.join(caseDir, 'credential-proxy-supervision.json'), 'utf8'));
if (proxySupervision.schemaVersion !== 'forge-harness-credential-proxy-supervision/v1'
  || proxySupervision.configuredDockerStopGraceSeconds !== 15
  || proxySupervision.exactOwnedStopExitCode !== numeric(proxyStopExit)
  || proxySupervision.logsCollectionExitCode !== numeric(proxyLogsExit)
  || proxySupervision.processExitCode !== numeric(proxyExit)
  || proxySupervision.exitCodeInspectionExitCode !== 0
  || proxySupervision.runningStateInspectionExitCode !== 0
  || proxySupervision.runningAfterStop !== false
  || proxySupervision.processQuiescenceProvenBeforeEvidence !== true
  || proxySupervision.exactOwnedStopExitCode !== 0
  || proxySupervision.logsCollectionExitCode !== 0
  || proxySupervision.processExitCode !== 0) {
  throw new Error('credential proxy supervision receipt mismatch');
}
const theoreticalMaximumRequestedOutputTokens = numeric(maxModelRequests) * numeric(maxOutputTokens);
const behavior = JSON.parse(fs.readFileSync(path.join(caseDir, 'behavior-evaluation.json'), 'utf8'));
if (behavior.schemaVersion !== 'forge-harness-behavior-contract-evaluation/v1'
  || !['implemented-candidate', 'bounded-blocked', 'incomplete'].includes(behavior.outcome)
  || !['trace-contract-satisfied', 'trace-contract-failed'].includes(behavior.machineEvaluation?.status)
  || behavior.machineEvaluation?.semanticCorrectnessProven !== false) {
  throw new Error('behavior evaluation receipt mismatch');
}
const phaseExecution = JSON.parse(phaseExecutionJson);
const continuationFile = path.join(caseDir, 'phase-control/continuation-receipt.json');
const continuation = fs.existsSync(continuationFile)
  ? JSON.parse(fs.readFileSync(continuationFile, 'utf8')) : null;
const payload = {
  schemaVersion: 'forge-harness-behavior-evidence/v1', runnerVersion, runId, caseId, suiteVersion,
  source: {
    expectedCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3', observedCommit: sourceHead,
    cleanAtAdmission: true, workspaceSeed: 'git-archive-of-fixed-commit', baselineGitMetadata: 'independent-read-only-volume',
    workspaceAdmissionExitCode: Number.parseInt(admissionExit, 10),
  },
  candidateImage: { immutableIdExecuted: imageId, inspectArtifact: 'image.inspect.json' },
  inputClosure: {
    pathBase: 'run-evidence-root', runRelativeSnapshot: 'inputs',
    runRelativeLockArtifact: 'inputs/input-lock.json', lockSha256: inputLockSha256,
    closureDigest: inputClosureDigest, suiteSha256, analyzerSha256,
    verifiedBeforeCaseExecution: true, verifiedBeforeManifestCreation: true,
  },
  prompt: { version: promptVersion, path: promptRelative, sha256: promptSha256 },
  phaseExecution,
  ...(continuation ? { databaseContinuation: {
    receiptArtifact: 'phase-control/continuation-receipt.json',
    parentStateSha256: continuation.sourceStateSha256,
    inheritedStages: ['requirements', 'domain-contract'],
    inheritedStageCount: 2,
    newlyAcceptedStageCount: Object.keys(phaseExecution.acceptedArtifactDigests).length - 2,
    freshEightStageRun: false,
    sessionCopyArtifact: 'database-session-copy.json',
  } } : {}),
  dsh: {
    profile: 'headless', patch: 'headless-audit.patch.yml',
    sessionPersistence: { compression: 'none', packChunks: false }, webToolsDisabled: true,
    protectedHeadlessRunnerOverlay: {
      pathBase: 'run-evidence-root', runRelativeArtifact: 'runtime-tools/protected-headless-runner.mjs',
      containerDestination: '/usr/local/lib/forge-protected-headless-runner.mjs',
      sha256: protectedRunnerSha256, readOnly: true,
      sourceMatchesExpectedSnapshot: true, integratedInCandidateImage: false,
    },
    modelContract: {
      configuredProvider, requestModel, upstreamOrigin,
      maxOutputTokensPerRequest: numeric(maxOutputTokens),
      maxRequestBytes: numeric(maxRequestBytes),
      maxTotalRequestBytes: numeric(maxTotalRequestBytes),
    },
  },
  isolation: {
    independentWorkspaceVolume: true, independentBaselineGitVolume: true, independentDshHomeVolume: true,
    independentCaseNetwork: true, independentProxyEgressNetwork: true,
    modelNetworkInternal: true, modelDirectEgress: false, proxyIsOnlyModelNetworkPeerWithEgress: true,
    dependencyDownloadsAvailableToModel: false, baselineGitMetadataReadOnlyToModel: true,
    trustedBaselineInitializerCapabilities: ['CHOWN', 'DAC_READ_SEARCH'],
    dockerSocketMounted: false, publishedPorts: false, capDrop: ['ALL'], noNewPrivileges: true,
    readOnlyRootFilesystem: true, modelToolPermissionMode: 'workspace-write', platformTemporaryAreaWritable: true,
    networkPeerSnapshotPhase: 'proxy-and-broker-ready-before-model-start',
    runtimeBoundaryInspectArtifact: 'runtime-boundary.inspect.json',
    networkBoundaryInspectArtifact: 'network-boundary.inspect.json',
  },
  execution: {
    startedAt, finishedAt,
    limits: {
      modelAttachDeadlineSeconds: numeric(modelTimeoutSeconds), maxModelRequests: numeric(maxModelRequests),
      dockerStopGraceSeconds: 15, totalWallClockHardBoundProven: false, limitsDisableable: false,
    },
    model: {
      exitCode: numeric(modelExit),
      status: supervision.timedOut ? 'timed-out'
        : supervision.supervisorFailed ? 'supervisor-failed'
          : numeric(modelExit) === 0 ? 'zero-exit' : 'nonzero-exit',
      supervision,
    },
    staticGate: { tool: 'forge-governance', exitCode: numeric(staticGateExit), status: numeric(staticGateExit) === 0 ? 'passed' : 'blocking-findings' },
    evidenceCollection: {
      sessionExportExitCode: numeric(sessionExportExit), gitStatusExitCode: numeric(statusExit), gitDiffExitCode: numeric(diffExit),
      completeWorkspacePatchExitCode: numeric(workspacePatchExit), completeWorkspacePatchArtifact: 'workspace.patch',
      secretScrubExitCode: numeric(scrubExit), analyzerExitCode: numeric(analyzerExit),
    },
    credentialProxy: {
      image: { pinnedReference: proxyImageReference, immutableIdExecuted: proxyImageId },
      readinessExitCode: numeric(proxyProbeExit), logsExitCode: numeric(proxyLogsExit),
      stopExitCode: numeric(proxyStopExit), processExitCode: numeric(proxyExit),
      requestContract: {
        expectedModel: proxyStats.contract.expectedModel,
        maxOutputTokens: proxyStats.contract.maxOutputTokens,
        maxRequestBytes: proxyStats.contract.maxRequestBytes,
        maxTotalRequestBytes: proxyStats.contract.maxTotalRequestBytes,
        fixedUpstreamOrigin: upstreamOrigin,
        enforcedBeforeUpstreamForwarding: true,
      },
      requestBudget: {
        maxRequests: proxyStats.maxRequests,
        actualAcceptedRequests: proxyStats.acceptedRequests,
        rejectedByLimit: proxyStats.rejectedByLimit,
        hardLimitEnforced: true,
      },
      metering: {
        forwardedRequests: proxyStats.forwardedRequests,
        forwardedRequestBytes: proxyStats.forwardedRequestBytes,
        injectedMaxOutputTokens: proxyStats.injectedMaxOutputTokens,
        clampedMaxOutputTokens: proxyStats.clampedMaxOutputTokens,
        upstreamCreationFailures: proxyStats.upstreamCreationFailures,
        rejectedRequests: proxyStats.rejectedRequests,
        contractRejectedRequests: proxyStats.contractRejectedRequests,
        byteLimitRejectedRequests: proxyStats.byteLimitRejectedRequests,
      },
      supervision: proxySupervision,
      exposureBounds: {
        theoreticalMaximumForwardedRequestCount: numeric(maxModelRequests),
        theoreticalMaximumForwardedRequestBodyBytes: numeric(maxTotalRequestBytes),
        theoreticalMaximumRequestedOutputTokens,
        actualTokenUsageProvenByProxy: false,
        actualMonetaryCostProvenByProxy: false,
      },
    },
    controlledVerification: {
      mode: 'real-broker-runner-execution-admission-plane',
      verificationMode,
      executionAdmissionArtifact: 'verification-execution-admission.json',
      boundaryArtifact: 'verification-boundary.inspect.json',
      cachePrepared: verificationReady,
      dockerExecutionAvailable: verificationReady,
      cacheFingerprint: verificationReady ? verificationCacheFingerprint : null,
      expectedOutcome: verificationReady || nativeHost ? 'ready' : 'cache_miss',
      executionMode: nativeHost ? 'host-toolchain' : 'container-toolchain',
      dependencyNetworkIsolationProven: false,
      hostStateRoot: nativeHost ? JSON.parse(fs.readFileSync(path.join(caseDir, 'verification-contract.json'), 'utf8')).stateRoot : null,
      executionProven: false,
      verificationProven: false,
      executionAdmission: verificationExecutionAdmission,
      boundary: verificationBoundary,
      brokerSupervision,
      verificationRunnerSupervision,
    },
    candidateWrite: {
      enabled: candidateWriteEnabled,
      cliMode: candidateWriteEnabled ? 'candidate-only' : null,
      runtimeMode: candidateWriteEnabled ? candidateWriteRuntimeMode : null,
      authorityClass: candidateWriteEnabled ? 'test-shadow-writer' : null,
      verificationRunnerRevision: candidateWriteEnabled ? expectedVerificationRunnerRevision : null,
      scope: candidateWriteEnabled ? 'single-local-test-shadow-case' : null,
      phaseGuardOverlay: candidateWriteEnabled ? {
        pathBase: 'run-evidence-root',
        runRelativeArtifact: 'runtime-tools/phase-budget-guard.mjs',
        containerDestination: '/usr/local/lib/forge-phase-budget-guard.mjs',
        sha256: phaseGuardSha256,
        readOnly: true,
        sourceMatchesExpectedSnapshot: true,
        integratedInCandidateImage: false,
      } : null,
      progressDetectorOverlay: candidateWriteEnabled ? {
        pathBase: 'run-evidence-root',
        runRelativeArtifact: 'runtime-tools/progress-detector.mjs',
        containerDestination: '/usr/local/lib/forge-progress-detector.mjs',
        sha256: progressDetectorSha256,
        readOnly: true,
        sourceMatchesExpectedSnapshot: true,
        integratedInCandidateImage: false,
      } : null,
      verificationBlocked: candidateWriteEnabled,
      verificationProven: false,
      semanticCorrectnessProven: false,
      databaseBehaviorProven: false,
      completionProven: false,
      releaseProven: false,
      productionWriterAuthorityProven: false,
    },
  },
  proofBoundary: {
    runtimeBehavior: 'not-proven-by-runner', semanticCorrectness: 'not-proven-by-runner',
    note: 'A zero model exit and a passing static gate are separate observations. Human/eval review of trace, diff, tests, and domain semantics is still required.',
  },
  behaviorOutcome: behavior.outcome,
  behaviorObservations: behavior.observations,
  machineEvaluation: behavior.machineEvaluation,
  secretHandling: {
    credentialDelivery: 'independent-proxy-model-key-plus-read-only-taskspace-broker-token',
    sourceSnapshotReadStableAndDestinationExclusive: true,
    snapshotAccessControl: {
      hostPlatform: process.platform,
      verifiedBySnapshotHelperBeforeContainerCreation: true,
      verifiedPlatformBranch: process.platform === 'win32' ? 'windows-protected-dacl' : 'posix-mode-0600',
      posixContract: {
        requiredMode: '0600',
        satisfiedOnThisHost: process.platform !== 'win32',
      },
      windowsDaclContract: {
        inheritanceProtectedRequired: true,
        onlyCurrentSidExplicitAllowFullControlRequired: true,
        satisfiedOnThisHost: process.platform === 'win32',
      },
    },
    modelContainerKeyFileMounted: false,
    containerEnvironmentValueExactlyEqualsKeyValue: false,
    runnerInjectedKeyValueInDockerEnvOrArgv: false,
    credentialNotPassedViaLocalArgvOrEnvironment: true,
    authorizationHeaderNotPersistedByRunnerOrProxyEvidence: true,
    exactKeyRetainedInEvidence: false, postScrubExactKeyRescanPassed: secretScan.secretRetained === false,
    brokerTokenMountedReadOnlyToModelOnly: true,
    brokerTokenEnvironmentExposure: false,
    scrub: secretScan,
  },
  cleanup: {
    evidencePreservedByDefault: true, generatedVolumesRetained: retainVolumes === '1',
    resourceDeletionScope: 'exact-run-owned-names-only',
  },
  evidenceLimits: {
    maxOrdinaryFilesIncludingManifest: numeric(maxCaseFiles),
    maxBytesIncludingManifest: numeric(maxCaseBytes),
    observedArtifactFilesExcludingManifest: files.length,
    observedArtifactBytesExcludingManifest: artifactBytes,
    selfManifestIncludedInLimit: true,
  },
  artifacts,
};
const serialized = JSON.stringify(payload, null, 2) + '\n';
if (files.length + 1 > numeric(maxCaseFiles)
  || artifactBytes + Buffer.byteLength(serialized) > numeric(maxCaseBytes)) {
  throw new Error('case evidence exceeds the bounded ordinary-file count or byte closure');
}
fs.writeFileSync(manifestPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
  verify_input_snapshot || die "the evaluation input closure changed after case manifest creation: ${case_id}"

  remove_owned_container "${model_container}"
  verify_external_skills_bundle \
    || die "the external Skill bundle changed during model execution: ${case_id}"
  remove_owned_container "${broker_container}"
  if [[ "${VERIFICATION_MODE}" != 'host-toolchain' ]]; then remove_owned_container "${verification_runner_container}"; fi
  remove_owned_network "${proxy_egress_network}"
  remove_owned_network "${case_network}"
  if [[ "${RETAIN_VOLUMES}" -eq 0 ]]; then
    remove_owned_volume "${dsh_home_volume}"
    remove_owned_volume "${verification_ipc_volume}"
    remove_owned_volume "${verification_source_ipc_volume}"
    remove_owned_volume "${verification_control_volume}"
    remove_owned_volume "${git_metadata_volume}"
    remove_owned_volume "${workspace_volume}"
  fi
  COMPLETED_CASES+=("${case_id}")
done

[[ ${#COMPLETED_CASES[@]} -gt 0 ]] || die 'no evaluation case was selected'
remove_native_host_runtime || die 'the exact run-owned Host runtime could not be removed before evidence closure'
if [[ "${VERIFICATION_MODE}" == 'cache-ready' ]]; then
  remove_owned_verification_runtime \
    || die 'the exact run-owned verification runtime could not be removed before evidence closure'
fi
verify_input_snapshot || die 'the evaluation input closure changed before final secret scanning'
set +e
scrub_all_bearer_secrets "${run_stage}" "${run_stage}/run-secret-scan" "${run_stage}/run-secret-scan.json" \
  >"${run_stage}/run-secret-scrub.stdout.txt" 2>"${run_stage}/run-secret-scrub.stderr.txt"
run_scrub_exit=$?
set -e
[[ "${run_scrub_exit}" -eq 0 ]] || die 'final run-level secret scrub and rescan failed; evidence was not published'
verify_input_snapshot || die 'the evaluation input closure changed during final secret scanning'
verify_runner_unchanged || die 'the evaluation runner changed before run evidence closure creation'
verify_runtime_package_lock >/dev/null \
  || die 'the external runtime package content lock changed before run evidence closure creation'

node - "${run_stage}" "${run_id}" "${run_token}" "${RUNNER_VERSION}" \
  "${RUNNER_OBSERVED_SHA256}" "${EXPECTED_INPUT_SNAPSHOT_HELPER_SHA256}" \
  "${EXPECTED_SECRET_SNAPSHOT_HELPER_SHA256}" "${EXPECTED_RUNTIME_LOCK_VERIFIER_SHA256}" \
  "${RUNTIME_PACKAGE_LOCK_SHA256}" "${RUNTIME_PACKAGE_LOCK_BYTES}" \
  "${RUNTIME_PACKAGE_ENTRY_COUNT}" \
  "${EXPECTED_RUNTIME_PACKAGE_ID}" "${EXPECTED_RUNTIME_PACKAGE_VERSION}" \
  "${RUNTIME_TOOLS_LOCK_SHA256}" \
  "${EXPECTED_SUITE_SHA256}" "${EXPECTED_ANALYZER_SHA256}" \
  "${INPUT_CLOSURE_DIGEST}" "${INPUT_LOCK_SHA256}" "${image_id}" \
  "${EXPECTED_CONFIGURED_PROVIDER}" "${EXPECTED_REQUEST_MODEL}" "${MAX_MODEL_REQUESTS}" \
  "${MAX_OUTPUT_TOKENS_PER_REQUEST}" "${MAX_PROXY_TOTAL_REQUEST_BYTES}" \
  "${MAX_CASE_EVIDENCE_FILES}" "${MAX_CASE_EVIDENCE_BYTES}" \
  "${MAX_RUN_EVIDENCE_FILES}" "${MAX_RUN_EVIDENCE_BYTES}" \
  "${VERIFICATION_MODE}" "${VERIFICATION_CACHE_FINGERPRINT}" \
  "${VERIFICATION_CACHE_MANIFEST_SHA256}" "${VERIFICATION_DOCKER_CLI_IMAGE_ID}" \
  "${VERIFICATION_DOCKER_CLI_SHA256}" "${EXPECTED_PHASE_BUDGET_GUARD_SHA256}" \
  "${EXPECTED_PROGRESS_DETECTOR_SHA256}" \
  "${EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256}" \
  "${TEST_SHADOW_CANDIDATE_WRITE}" "${TEST_SHADOW_CANDIDATE_WRITE_RUNTIME_MODE}" \
  "${EXPECTED_HARNESS_IMAGE_REVISION}" \
  -- "${COMPLETED_CASES[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [runDir, runId, runToken, runnerVersion, runnerObservedSha256, inputHelperSha256,
  secretHelperSha256, runtimeLockVerifierSha256, runtimePackageLockSha256,
  runtimePackageLockBytes, runtimePackageEntryCount, runtimePackageId, runtimePackageVersion,
  runtimeToolsLockSha256, suiteSha256, analyzerSha256,
  closureDigest, inputLockSha256, imageId, configuredProvider, requestModel, maxModelRequests,
  maxOutputTokens, maxTotalRequestBytes, maxCaseFiles, maxCaseBytes, maxRunFiles, maxRunBytes,
  verificationMode, verificationCacheFingerprint, verificationCacheManifestSha256,
  verificationDockerCliImageId, verificationDockerCliSha256, phaseGuardSha256, progressDetectorSha256,
  protectedRunnerSha256,
  candidateWriteMode, candidateWriteRuntimeMode, expectedVerificationRunnerRevision,
  separator, ...caseIds] = process.argv.slice(2);
if (separator !== '--') throw new Error('run manifest argument closure mismatch');
const numeric = (value) => Number.parseInt(value, 10);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = (portable) => {
  const target = path.join(runDir, ...portable.split('/'));
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`invalid run artifact: ${portable}`);
  return { sha256: hash(target), bytes: info.size };
};
const cases = caseIds.map((caseId) => {
  const manifest = path.join(runDir, caseId, 'manifest.json');
  const info = fs.lstatSync(manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`invalid case manifest: ${caseId}`);
  return { caseId, manifest: caseId + '/manifest.json', manifestSha256: hash(manifest), manifestBytes: info.size };
});
const secretScanPath = path.join(runDir, 'run-secret-scan.json');
const secretScan = JSON.parse(fs.readFileSync(secretScanPath, 'utf8'));
if (secretScan.secretRetained !== false || secretScan.replacementCount !== 0) {
  throw new Error('run-level secret scan must prove no post-case secret introduction');
}
const baseRunArtifacts = [
  '.forge-hbe-owner.json',
  'run-secret-scan.json',
  'run-secret-scan.model-api.json',
  'run-secret-scan.broker-token.json',
  'run-secret-scrub.stdout.txt',
  'run-secret-scrub.stderr.txt',
  'agent-preset-admission.stdout.txt',
  'agent-preset-admission.stderr.txt',
  'agent-preset-admission.exit-code.txt',
  'agent-preset-admission.container.inspect.json',
  'agent-preset-admission.receipt.json',
  'dsh-config-admission.stdout.txt',
  'dsh-config-admission.stderr.txt',
  'dsh-config-admission.exit-code.txt',
  'dsh-config-admission.container.inspect.json',
  'dsh-config-admission.receipt.json',
  'candidate-image-admission.receipt.json',
];
const verificationReady = verificationMode === 'cache-ready';
const nativeHost = verificationMode === 'host-toolchain';
if (!verificationReady && !nativeHost && verificationMode !== 'cache-miss') throw new Error('run verification mode is invalid');
const candidateWriteEnabled = candidateWriteMode === 'candidate-only';
if (!['', 'candidate-only'].includes(candidateWriteMode)
  || (candidateWriteEnabled && (verificationMode !== 'cache-miss' || caseIds.length !== 1))) {
  throw new Error('run candidate-write mode is invalid');
}
if (verificationReady) baseRunArtifacts.push(
  'verification-cache-admission-contract.json',
  'verification-cache-admission.json',
  'verification-runner-socket-gid.txt',
  'verification-runner-socket-gid.stderr.txt',
);
const runArtifacts = Object.fromEntries(baseRunArtifacts.map((portable) => [portable, receipt(portable)]));
const candidateImageAdmission = JSON.parse(fs.readFileSync(
  path.join(runDir, 'candidate-image-admission.receipt.json'), 'utf8'));
if (candidateImageAdmission.schemaVersion !== 'forge-harness-candidate-image-admission/v1'
  || candidateImageAdmission.imageId !== imageId
  || candidateImageAdmission.verification?.localImageIdStableAtAdmission !== true
  || candidateImageAdmission.verification?.baseImageAvailableAndImmutable !== true
  || candidateImageAdmission.verification?.inheritedBaseLayerPrefixMatches !== true
  || candidateImageAdmission.verification?.embeddedBuildInputReceiptPresent !== true
  || candidateImageAdmission.verification?.embeddedRuntimeDependencyReceiptPresent !== true
  || candidateImageAdmission.verification?.externalSignatureAttestation !== false) {
  throw new Error('run-level candidate image admission receipt mismatch');
}
if (verificationReady) {
  const cacheAdmission = JSON.parse(fs.readFileSync(path.join(runDir, 'verification-cache-admission.json'), 'utf8'));
  if (cacheAdmission.schemaVersion !== 'forge-harness-verification-cache-admission/v1'
    || cacheAdmission.mode !== 'cache-ready'
    || cacheAdmission.dependencyManifestFingerprint !== verificationCacheFingerprint
    || cacheAdmission.manifestSha256 !== verificationCacheManifestSha256
    || cacheAdmission.toolchainImage !== imageId
    || cacheAdmission.callerPackNetworklessVerified !== true
    || cacheAdmission.runOwnedPackNetworklessVerified !== true
    || cacheAdmission.importedPackMountedReadOnlyAtExecution !== true) {
    throw new Error('run-level verification cache admission receipt mismatch');
  }
}
const configAdmission = JSON.parse(fs.readFileSync(path.join(runDir, 'dsh-config-admission.receipt.json'), 'utf8'));
const agentPresetAdmission = JSON.parse(fs.readFileSync(path.join(runDir, 'agent-preset-admission.receipt.json'), 'utf8'));
if (agentPresetAdmission.schemaVersion !== 'forge-harness-agent-preset-admission/v1'
  || agentPresetAdmission.candidateImageId !== imageId
  || JSON.stringify(agentPresetAdmission.effectiveContract?.allowedPresets) !== JSON.stringify(['standard'])
  || agentPresetAdmission.effectiveContract?.defaultPreset !== 'standard'
  || agentPresetAdmission.effectiveContract?.userPresetRootEnabled !== false
  || agentPresetAdmission.effectiveContract?.promptAssemblyGovernanceGuarded !== true) {
  throw new Error('run-level agent-preset admission receipt mismatch');
}
if (configAdmission.schemaVersion !== 'forge-harness-dsh-config-admission/v1'
  || configAdmission.candidateImageId !== imageId
  || configAdmission.effectiveContract?.agentProvider !== configuredProvider
  || configAdmission.effectiveContract?.agentModel !== requestModel
  || configAdmission.effectiveContract?.approvalPolicy !== 'never'
  || configAdmission.effectiveContract?.permissionDefaultPreset !== 'forge-eval-workspace-write-never'
  || configAdmission.effectiveContract?.permissionPresetSandbox !== 'workspace-write'
  || configAdmission.effectiveContract?.permissionPresetApproval !== 'never') {
  throw new Error('run-level DSH config admission receipt mismatch');
}
const runPayload = {
  schemaVersion: 'forge-harness-behavior-run/v1', runnerVersion, runId, cases,
  owner: { artifact: '.forge-hbe-owner.json', runToken },
  runtimeClosure: {
    pathBase: 'run-evidence-root', runRelativeSnapshot: 'runtime-tools',
    runRelativeLockArtifact: 'runtime-tools/runtime-tools-lock.json',
    lockSha256: runtimeToolsLockSha256,
    lockBytes: fs.statSync(path.join(runDir, 'runtime-tools', 'runtime-tools-lock.json')).size,
    runnerObservedSha256, inputSnapshotHelperSha256: inputHelperSha256,
    secretSnapshotHelperSha256: secretHelperSha256,
    runtimeLockVerifierSha256,
    phaseBudgetGuardSha256: phaseGuardSha256,
    progressDetectorSha256,
    protectedHeadlessRunnerSha256: protectedRunnerSha256,
    runnerStableDoubleReadAtStartupAndBeforePublication: true,
    helpersPinnedAndCopiedBeforeFirstExecution: true,
    packageContentLock: {
      packageId: runtimePackageId,
      packageVersion: runtimePackageVersion,
      runRelativeArtifact: 'runtime-tools/package-runtime-trust-lock.json',
      sha256: runtimePackageLockSha256,
      bytes: numeric(runtimePackageLockBytes),
      entryCount: numeric(runtimePackageEntryCount),
      contentAddressed: true,
      expectedDigestSuppliedOutOfBand: true,
      externalIdentitySource: 'required-cli-argument',
      runnerEmbedsExpectedDigest: false,
      gitCommitIdentityProven: false,
      signedAttestation: false,
      sameHostMaliciousTamperingExcluded: false,
    },
  },
  dshConfigAdmission: {
    receiptArtifact: 'dsh-config-admission.receipt.json',
    stdoutArtifact: 'dsh-config-admission.stdout.txt',
    stderrArtifact: 'dsh-config-admission.stderr.txt',
    exitCodeArtifact: 'dsh-config-admission.exit-code.txt',
    containerInspectArtifact: 'dsh-config-admission.container.inspect.json',
    paidExecutionAdmittedOnlyAfterReceipt: true,
  },
  agentPresetAdmission: {
    receiptArtifact: 'agent-preset-admission.receipt.json',
    stdoutArtifact: 'agent-preset-admission.stdout.txt',
    stderrArtifact: 'agent-preset-admission.stderr.txt',
    exitCodeArtifact: 'agent-preset-admission.exit-code.txt',
    containerInspectArtifact: 'agent-preset-admission.container.inspect.json',
    paidExecutionAdmittedOnlyAfterReceipt: true,
  },
  candidateImageAdmission: {
    receiptArtifact: 'candidate-image-admission.receipt.json',
    paidExecutionAdmittedOnlyAfterReceipt: true,
    externalSignatureAttestation: false,
  },
  controlledVerification: nativeHost ? {
    mode: 'host-toolchain', schemaVersion: 2, cacheAdmissionArtifact: null,
    cacheMode: 'persistent-taskspace-host-cache',
    hostStateRoot: JSON.parse(fs.readFileSync(path.join(runDir, caseIds[0], 'verification-contract.json'), 'utf8')).stateRoot,
    hostUser: { uid: 1000, gid: 1000 }, dockerSocketAccessible: false,
    dependencyNetworkIsolationProven: false,
  } : verificationReady ? {
    mode: 'cache-ready', cacheAdmissionArtifact: 'verification-cache-admission.json',
    dependencyManifestFingerprint: verificationCacheFingerprint,
    manifestSha256: verificationCacheManifestSha256,
    dockerCliSupplierImageId: verificationDockerCliImageId,
    dockerCliSha256: verificationDockerCliSha256,
    callerPackNetworklessVerified: true, runOwnedPackNetworklessVerified: true,
    runnerOnlyDockerSocketBoundary: true,
  } : {
    mode: 'cache-miss', cacheAdmissionArtifact: null,
    runnerOnlyDockerSocketBoundary: true,
  },
  candidateWrite: {
    enabled: candidateWriteEnabled,
    cliMode: candidateWriteEnabled ? 'candidate-only' : null,
    runtimeMode: candidateWriteEnabled ? candidateWriteRuntimeMode : null,
    authorityClass: candidateWriteEnabled ? 'test-shadow-writer' : null,
    verificationRunnerRevision: candidateWriteEnabled ? expectedVerificationRunnerRevision : null,
    scope: candidateWriteEnabled ? 'single-local-test-shadow-case' : null,
    phaseGuardOverlay: candidateWriteEnabled ? {
      pathBase: 'run-evidence-root',
      runRelativeArtifact: 'runtime-tools/phase-budget-guard.mjs',
      containerDestination: '/usr/local/lib/forge-phase-budget-guard.mjs',
      sha256: phaseGuardSha256,
      readOnly: true,
      sourceMatchesExpectedSnapshot: true,
      integratedInCandidateImage: false,
    } : null,
    progressDetectorOverlay: candidateWriteEnabled ? {
      pathBase: 'run-evidence-root',
      runRelativeArtifact: 'runtime-tools/progress-detector.mjs',
      containerDestination: '/usr/local/lib/forge-progress-detector.mjs',
      sha256: progressDetectorSha256,
      readOnly: true,
      sourceMatchesExpectedSnapshot: true,
      integratedInCandidateImage: false,
    } : null,
    verificationBlocked: candidateWriteEnabled,
    verificationProven: false,
    semanticCorrectnessProven: false,
    databaseBehaviorProven: false,
    completionProven: false,
    releaseProven: false,
    productionWriterAuthorityProven: false,
  },
  modelCostBoundary: {
    actualCaseCount: caseIds.length,
    theoreticalMaximumForwardedRequestCount: caseIds.length * numeric(maxModelRequests),
    theoreticalMaximumForwardedRequestBodyBytes: caseIds.length * numeric(maxTotalRequestBytes),
    theoreticalMaximumRequestedOutputTokens: caseIds.length * numeric(maxModelRequests) * numeric(maxOutputTokens),
    actualTokenUsageProvenByProxy: false,
    actualMonetaryCostProvenByProxy: false,
  },
  evidenceLimits: {
    case: {
      maxOrdinaryFilesIncludingManifest: numeric(maxCaseFiles),
      maxBytesIncludingManifest: numeric(maxCaseBytes),
    },
    run: {
      maxOrdinaryFilesIncludingManifest: numeric(maxRunFiles),
      maxBytesIncludingManifest: numeric(maxRunBytes),
      selfManifestIncludedInLimit: true,
    },
  },
  inputClosure: {
    pathBase: 'run-evidence-root', runRelativeSnapshot: 'inputs',
    runRelativeLockArtifact: 'inputs/input-lock.json', lockSha256: inputLockSha256,
    lockBytes: fs.statSync(path.join(runDir, 'inputs', 'input-lock.json')).size,
    closureDigest, suiteSha256, analyzerSha256,
    verifiedBeforePublication: true,
  },
  topLevelClosure: {
    ordinaryArtifacts: Object.keys(runArtifacts).sort(),
    directories: ['inputs', 'runtime-tools', ...caseIds].sort(),
    selfExcludedManifest: 'run-manifest.json',
  },
  runArtifacts,
  finalSecretScan: { artifact: 'run-secret-scan.json', sha256: hash(secretScanPath), exactKeyRetained: false },
  evidencePreserved: true, collectionStatus: 'completed', evaluationVerdict: 'not-computed',
  publication: { privateStagingRequired: true, atomicRenameRequired: true },
};
const serialized = JSON.stringify(runPayload, null, 2) + '\n';
let runFileCount = 1;
let runBytes = Buffer.byteLength(serialized);
const countTree = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (path.resolve(target) === path.resolve(path.join(runDir, 'run-manifest.json'))) continue;
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) throw new Error('run evidence must not contain symlinks');
    if (info.isDirectory()) countTree(target);
    else if (info.isFile()) { runFileCount += 1; runBytes += info.size; }
    else throw new Error('run evidence contains a non-file filesystem entry');
  }
};
countTree(runDir);
if (runFileCount > numeric(maxRunFiles) || runBytes > numeric(maxRunBytes)) {
  throw new Error('run evidence exceeds the bounded ordinary-file count or byte closure');
}
fs.writeFileSync(path.join(runDir, 'run-manifest.json'), serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE

validate_phase_execution_closure() {
  node - "${ACTIVE_PHASE_RUNTIME}" "${phase_catalog_file}" "${ACTIVE_SUITE_FILE}" \
    "$1" -- "${COMPLETED_CASES[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const [runtimeFile, catalogFile, suiteFile, runDir, separator, ...caseIds] = process.argv.slice(2);
if (separator !== '--' || new Set(caseIds).size !== caseIds.length) {
  throw new Error('phase execution validator argument closure mismatch');
}
(async () => {
  const runtime = await import(pathToFileURL(runtimeFile).href);
  const loaded = await runtime.loadForgeDeliveryPhaseCatalog(catalogFile);
  const suite = JSON.parse(fs.readFileSync(suiteFile, 'utf8'));
  const suiteCases = new Map(suite.cases.map((entry) => [entry.id, entry]));
  if (suiteCases.size !== suite.cases.length) throw new Error('suite case identity is ambiguous');
  for (const caseId of caseIds) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(caseId)) throw new Error('unsafe case identity');
    const definition = suiteCases.get(caseId);
    if (definition === undefined) throw new Error(`suite case is unavailable: ${caseId}`);
    const manifestFile = path.join(runDir, caseId, 'manifest.json');
    const manifestInfo = fs.lstatSync(manifestFile);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1) {
      throw new Error(`case manifest is invalid: ${caseId}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const workflowId = definition.phaseWorkflowId ?? null;
    const stateFile = path.join(runDir, caseId, 'phase-control', 'state.json');
    if (workflowId === null) {
      if (fs.existsSync(stateFile)) throw new Error(`non-phased case retained phase state: ${caseId}`);
      runtime.validateForgeDeliveryPhaseExecutionProjection({
        catalog: loaded.catalog,
        workflowId: null,
        caseFamily: caseId,
        state: null,
        phaseExecution: manifest.phaseExecution,
      });
      continue;
    }
    const state = await runtime.readForgeDeliveryPhaseState(stateFile, loaded.catalog);
    runtime.validateForgeDeliveryPhaseExecutionProjection({
      catalog: loaded.catalog,
      workflowId,
      caseFamily: caseId,
      state,
      phaseExecution: manifest.phaseExecution,
    });
  }
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
NODE
}

validate_run_manifest() {
  validate_phase_execution_closure "$1" || return 1
  node - "$1" "${run_id}" "${run_token}" "${RUNNER_VERSION}" "${RUNNER_OBSERVED_SHA256}" \
    "${EXPECTED_INPUT_SNAPSHOT_HELPER_SHA256}" "${EXPECTED_SECRET_SNAPSHOT_HELPER_SHA256}" \
    "${EXPECTED_RUNTIME_LOCK_VERIFIER_SHA256}" "${RUNTIME_PACKAGE_LOCK_SHA256}" \
    "${RUNTIME_PACKAGE_LOCK_BYTES}" "${RUNTIME_PACKAGE_ENTRY_COUNT}" \
    "${EXPECTED_RUNTIME_PACKAGE_ID}" \
    "${EXPECTED_RUNTIME_PACKAGE_VERSION}" \
    "${RUNTIME_TOOLS_LOCK_SHA256}" "${EXPECTED_SUITE_SHA256}" "${EXPECTED_ANALYZER_SHA256}" \
    "${INPUT_CLOSURE_DIGEST}" "${INPUT_LOCK_SHA256}" "${image_id}" "${proxy_image_id}" \
    "${EXPECTED_CONFIGURED_PROVIDER}" "${EXPECTED_REQUEST_MODEL}" "${EXPECTED_UPSTREAM_ORIGIN}" \
    "${MAX_MODEL_REQUESTS}" "${MAX_OUTPUT_TOKENS_PER_REQUEST}" "${MAX_PROXY_REQUEST_BYTES}" \
    "${MAX_PROXY_TOTAL_REQUEST_BYTES}" "${MODEL_TIMEOUT_SECONDS}" \
    "${MAX_CASE_EVIDENCE_FILES}" "${MAX_CASE_EVIDENCE_BYTES}" \
    "${MAX_RUN_EVIDENCE_FILES}" "${MAX_RUN_EVIDENCE_BYTES}" \
    "${EXPECTED_PHASE_BUDGET_GUARD_SHA256}" "${EXPECTED_PROGRESS_DETECTOR_SHA256}" \
    "${EXPECTED_PROTECTED_HEADLESS_RUNNER_SHA256}" \
    "${TEST_SHADOW_CANDIDATE_WRITE}" \
    "${TEST_SHADOW_CANDIDATE_WRITE_RUNTIME_MODE}" "${EXPECTED_HARNESS_IMAGE_REVISION}" \
    -- "${COMPLETED_CASES[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [runDir, expectedRunId, expectedRunToken, expectedRunnerVersion, expectedRunnerSha256,
  expectedInputHelperSha256, expectedSecretHelperSha256, expectedRuntimeLockVerifierSha256,
  expectedRuntimePackageLockSha256, expectedRuntimePackageLockBytes, expectedRuntimePackageEntryCount,
  expectedRuntimePackageId,
  expectedRuntimePackageVersion, expectedRuntimeToolsLockSha256,
  expectedSuiteSha256, expectedAnalyzerSha256, expectedClosureDigest,
  expectedInputLockSha256, expectedImageId, expectedProxyImageId, expectedProvider, expectedModel,
  expectedUpstreamOrigin, expectedMaxRequests, expectedMaxOutputTokens, expectedMaxRequestBytes,
  expectedMaxTotalRequestBytes, expectedModelTimeoutSeconds, expectedMaxCaseFiles,
  expectedMaxCaseBytes, expectedMaxRunFiles, expectedMaxRunBytes, expectedPhaseGuardSha256,
  expectedProgressDetectorSha256, expectedProtectedRunnerSha256,
  expectedCandidateWriteMode, expectedCandidateWriteRuntimeMode,
  expectedVerificationRunnerRevision, separator,
  ...expectedCases] = process.argv.slice(2);
if (separator !== '--') throw new Error('run validator argument closure mismatch');
const expectedCandidateWriteEnabled = expectedCandidateWriteMode === 'candidate-only';
if (!['', 'candidate-only'].includes(expectedCandidateWriteMode)
  || (expectedCandidateWriteEnabled && expectedCases.length !== 1)) {
  throw new Error('run validator candidate-write argument mismatch');
}
const numeric = (value) => Number.parseInt(value, 10);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaPattern = /^[0-9a-f]{64}$/;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkedRelative = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error('artifact path is not a safe portable relative path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('artifact path contains an unsafe segment');
  }
  return value;
};
const resolveInside = (root, portablePath) => {
  const checked = checkedRelative(portablePath);
  const target = path.resolve(root, ...checked.split('/'));
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('artifact escapes its evidence root');
  return target;
};
const assertRegularFile = (file, label) => {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${label} must be one ordinary file`);
  return info;
};
const enumerateTree = (root, excludedPortablePath) => {
  const files = [];
  const directories = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) throw new Error('evidence closure must not contain symbolic links');
      if (info.isDirectory()) {
        directories.push(path.relative(root, target).split(path.sep).join('/'));
        visit(target);
      }
      else if (info.isFile()) {
        const portable = path.relative(root, target).split(path.sep).join('/');
        if (portable !== excludedPortablePath) files.push(portable);
      } else throw new Error('evidence closure contains a non-file filesystem entry');
    }
  };
  visit(root);
  return { files: files.sort(), directories: directories.sort() };
};
const derivedDirectories = (files) => {
  const directories = new Set();
  for (const portable of files) {
    const segments = checkedRelative(portable).split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return [...directories].sort();
};
const sameStrings = (left, right) => left.length === right.length
  && left.every((value, index) => value === right[index]);
const receiptMatches = (receipt, target, label) => {
  if (!isPlainObject(receipt) || !shaPattern.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) {
    throw new Error(`invalid ${label} receipt`);
  }
  const info = assertRegularFile(target, label);
  if (info.size !== receipt.bytes || hash(target) !== receipt.sha256) {
    throw new Error(`${label} content mismatch`);
  }
};
const runInfo = fs.lstatSync(runDir);
if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) throw new Error('run evidence root must be one ordinary directory');
const runManifestPath = path.join(runDir, 'run-manifest.json');
assertRegularFile(runManifestPath, 'run manifest');
const manifest = JSON.parse(fs.readFileSync(runManifestPath, 'utf8'));
if (manifest.schemaVersion !== 'forge-harness-behavior-run/v1'
  || manifest.runId !== expectedRunId || manifest.runnerVersion !== expectedRunnerVersion
  || manifest.collectionStatus !== 'completed' || manifest.evaluationVerdict !== 'not-computed'
  || manifest.evidencePreserved !== true
  || manifest.publication?.privateStagingRequired !== true
  || manifest.publication?.atomicRenameRequired !== true) throw new Error('run manifest identity or completion-state mismatch');
if (!Array.isArray(manifest.cases)
  || JSON.stringify(manifest.cases.map((item) => item.caseId)) !== JSON.stringify(expectedCases)
  || new Set(expectedCases).size !== expectedCases.length) throw new Error('run manifest case closure mismatch');
if (manifest.candidateWrite?.enabled !== expectedCandidateWriteEnabled
  || manifest.candidateWrite?.cliMode !== (expectedCandidateWriteEnabled ? 'candidate-only' : null)
  || manifest.candidateWrite?.runtimeMode !== (expectedCandidateWriteEnabled ? expectedCandidateWriteRuntimeMode : null)
  || manifest.candidateWrite?.authorityClass !== (expectedCandidateWriteEnabled ? 'test-shadow-writer' : null)
  || manifest.candidateWrite?.verificationRunnerRevision !== (expectedCandidateWriteEnabled ? expectedVerificationRunnerRevision : null)
  || manifest.candidateWrite?.scope !== (expectedCandidateWriteEnabled ? 'single-local-test-shadow-case' : null)
  || manifest.candidateWrite?.verificationBlocked !== expectedCandidateWriteEnabled
  || ['verificationProven', 'semanticCorrectnessProven', 'databaseBehaviorProven', 'completionProven',
    'releaseProven', 'productionWriterAuthorityProven']
    .some((name) => manifest.candidateWrite?.[name] !== false)
  || (expectedCandidateWriteEnabled
    ? manifest.controlledVerification?.mode !== 'cache-miss'
      || manifest.candidateWrite?.phaseGuardOverlay?.pathBase !== 'run-evidence-root'
      || manifest.candidateWrite?.phaseGuardOverlay?.runRelativeArtifact !== 'runtime-tools/phase-budget-guard.mjs'
      || manifest.candidateWrite?.phaseGuardOverlay?.containerDestination !== '/usr/local/lib/forge-phase-budget-guard.mjs'
      || manifest.candidateWrite?.phaseGuardOverlay?.sha256 !== expectedPhaseGuardSha256
      || manifest.candidateWrite?.phaseGuardOverlay?.readOnly !== true
      || manifest.candidateWrite?.phaseGuardOverlay?.sourceMatchesExpectedSnapshot !== true
      || manifest.candidateWrite?.phaseGuardOverlay?.integratedInCandidateImage !== false
      || manifest.candidateWrite?.progressDetectorOverlay?.pathBase !== 'run-evidence-root'
      || manifest.candidateWrite?.progressDetectorOverlay?.runRelativeArtifact !== 'runtime-tools/progress-detector.mjs'
      || manifest.candidateWrite?.progressDetectorOverlay?.containerDestination !== '/usr/local/lib/forge-progress-detector.mjs'
      || manifest.candidateWrite?.progressDetectorOverlay?.sha256 !== expectedProgressDetectorSha256
      || manifest.candidateWrite?.progressDetectorOverlay?.readOnly !== true
      || manifest.candidateWrite?.progressDetectorOverlay?.sourceMatchesExpectedSnapshot !== true
      || manifest.candidateWrite?.progressDetectorOverlay?.integratedInCandidateImage !== false
    : manifest.candidateWrite?.phaseGuardOverlay !== null
      || manifest.candidateWrite?.progressDetectorOverlay !== null)) {
  throw new Error('run manifest candidate-write proof boundary mismatch');
}
for (const caseId of expectedCases) {
  if (checkedRelative(caseId) !== caseId || caseId.includes('/')) throw new Error('unsafe case directory identity');
}
if (!isPlainObject(manifest.runArtifacts)) throw new Error('run artifact closure missing');
const declaredRunArtifacts = Object.keys(manifest.runArtifacts).sort();
const expectedRunArtifacts = [
  '.forge-hbe-owner.json',
  'run-secret-scan.json',
  'run-secret-scan.model-api.json',
  'run-secret-scan.broker-token.json',
  'run-secret-scrub.stderr.txt',
  'run-secret-scrub.stdout.txt',
  'agent-preset-admission.stdout.txt',
  'agent-preset-admission.stderr.txt',
  'agent-preset-admission.exit-code.txt',
  'agent-preset-admission.container.inspect.json',
  'agent-preset-admission.receipt.json',
  'dsh-config-admission.stdout.txt',
  'dsh-config-admission.stderr.txt',
  'dsh-config-admission.exit-code.txt',
  'dsh-config-admission.container.inspect.json',
  'dsh-config-admission.receipt.json',
  'candidate-image-admission.receipt.json',
].sort();
if (!sameStrings(declaredRunArtifacts, expectedRunArtifacts)
  || declaredRunArtifacts.some((portable) => checkedRelative(portable) !== portable || portable.includes('/'))) {
  throw new Error('run artifact exact closure mismatch');
}
const expectedTopLevelDirectories = ['inputs', 'runtime-tools', ...expectedCases].sort();
const expectedTopLevelFiles = ['run-manifest.json', ...expectedRunArtifacts].sort();
const observedTopLevelFiles = [];
const observedTopLevelDirectories = [];
for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
  const target = path.join(runDir, entry.name);
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink()) throw new Error('run evidence root must not contain symbolic links');
  if (info.isFile()) observedTopLevelFiles.push(entry.name);
  else if (info.isDirectory()) observedTopLevelDirectories.push(entry.name);
  else throw new Error('run evidence root contains a non-file filesystem entry');
}
observedTopLevelFiles.sort();
observedTopLevelDirectories.sort();
if (!sameStrings(observedTopLevelFiles, expectedTopLevelFiles)
  || !sameStrings(observedTopLevelDirectories, expectedTopLevelDirectories)) {
  throw new Error('run evidence top-level exact closure mismatch');
}
if (manifest.topLevelClosure?.selfExcludedManifest !== 'run-manifest.json'
  || !sameStrings(manifest.topLevelClosure?.ordinaryArtifacts ?? [], expectedRunArtifacts)
  || !sameStrings(manifest.topLevelClosure?.directories ?? [], expectedTopLevelDirectories)) {
  throw new Error('run manifest top-level closure receipt mismatch');
}
for (const portable of expectedRunArtifacts) {
  receiptMatches(manifest.runArtifacts[portable], resolveInside(runDir, portable), `run artifact: ${portable}`);
}
const candidateImageAdmission = JSON.parse(fs.readFileSync(
  resolveInside(runDir, 'candidate-image-admission.receipt.json'), 'utf8'));
if (candidateImageAdmission.schemaVersion !== 'forge-harness-candidate-image-admission/v1'
  || candidateImageAdmission.imageId !== expectedImageId
  || candidateImageAdmission.verification?.localImageIdStableAtAdmission !== true
  || candidateImageAdmission.verification?.baseImageAvailableAndImmutable !== true
  || candidateImageAdmission.verification?.inheritedBaseLayerPrefixMatches !== true
  || candidateImageAdmission.verification?.embeddedBuildInputReceiptPresent !== true
  || candidateImageAdmission.verification?.embeddedRuntimeDependencyReceiptPresent !== true
  || candidateImageAdmission.verification?.externalSignatureAttestation !== false
  || manifest.candidateImageAdmission?.receiptArtifact !== 'candidate-image-admission.receipt.json'
  || manifest.candidateImageAdmission?.paidExecutionAdmittedOnlyAfterReceipt !== true) {
  throw new Error('candidate image admission receipt mismatch');
}
const admission = JSON.parse(fs.readFileSync(resolveInside(runDir, 'dsh-config-admission.receipt.json'), 'utf8'));
const presetAdmission = JSON.parse(fs.readFileSync(resolveInside(runDir, 'agent-preset-admission.receipt.json'), 'utf8'));
const presetAdmissionStdout = resolveInside(runDir, 'agent-preset-admission.stdout.txt');
const presetAdmissionStderr = resolveInside(runDir, 'agent-preset-admission.stderr.txt');
const presetAdmissionInspect = resolveInside(runDir, 'agent-preset-admission.container.inspect.json');
if (fs.readFileSync(resolveInside(runDir, 'agent-preset-admission.exit-code.txt'), 'utf8') !== '0\n'
  || presetAdmission.schemaVersion !== 'forge-harness-agent-preset-admission/v1'
  || presetAdmission.candidateImageId !== expectedImageId
  || presetAdmission.command?.exitCode !== 0
  || presetAdmission.isolation?.networkMode !== 'none'
  || presetAdmission.isolation?.readOnlyRootFilesystem !== true
  || JSON.stringify(presetAdmission.isolation?.capDrop) !== JSON.stringify(['ALL'])
  || presetAdmission.isolation?.noNewPrivileges !== true
  || presetAdmission.isolation?.publishedPorts !== false
  || presetAdmission.isolation?.mounts !== false
  || presetAdmission.isolation?.dockerSocketMounted !== false
  || JSON.stringify(presetAdmission.effectiveContract?.allowedPresets) !== JSON.stringify(['standard'])
  || presetAdmission.effectiveContract?.defaultPreset !== 'standard'
  || presetAdmission.effectiveContract?.userPresetRootEnabled !== false
  || presetAdmission.effectiveContract?.promptAssemblyGovernanceGuarded !== true
  || presetAdmission.effectiveContract?.standardSkillAccessMode !== 'native-skill-tool'
  || JSON.stringify(presetAdmission.effectiveContract?.standardRequiredTools) !== JSON.stringify(['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'write'])
  || presetAdmission.sourceEvidence?.stdoutSha256 !== hash(presetAdmissionStdout)
  || presetAdmission.sourceEvidence?.stdoutBytes !== fs.statSync(presetAdmissionStdout).size
  || presetAdmission.sourceEvidence?.stderrSha256 !== hash(presetAdmissionStderr)
  || presetAdmission.sourceEvidence?.stderrBytes !== 0
  || presetAdmission.sourceEvidence?.containerInspectSha256 !== hash(presetAdmissionInspect)
  || presetAdmission.sourceEvidence?.containerInspectBytes !== fs.statSync(presetAdmissionInspect).size
  || manifest.agentPresetAdmission?.receiptArtifact !== 'agent-preset-admission.receipt.json'
  || manifest.agentPresetAdmission?.paidExecutionAdmittedOnlyAfterReceipt !== true) {
  throw new Error('agent-preset admission receipt or source-evidence mismatch');
}
const admissionStdout = resolveInside(runDir, 'dsh-config-admission.stdout.txt');
const admissionStderr = resolveInside(runDir, 'dsh-config-admission.stderr.txt');
const admissionInspect = resolveInside(runDir, 'dsh-config-admission.container.inspect.json');
if (fs.readFileSync(resolveInside(runDir, 'dsh-config-admission.exit-code.txt'), 'utf8') !== '0\n'
  || admission.schemaVersion !== 'forge-harness-dsh-config-admission/v1'
  || admission.candidateImageId !== expectedImageId
  || admission.command?.exitCode !== 0
  || admission.isolation?.networkMode !== 'none'
  || admission.isolation?.readOnlyRootFilesystem !== true
  || JSON.stringify(admission.isolation?.capDrop) !== JSON.stringify(['ALL'])
  || admission.isolation?.noNewPrivileges !== true
  || admission.isolation?.publishedPorts !== false
  || admission.isolation?.patchSnapshotMountedReadOnly !== true
  || admission.isolation?.dockerSocketMounted !== false
  || admission.effectiveContract?.agentProvider !== expectedProvider
  || admission.effectiveContract?.agentModel !== expectedModel
  || admission.effectiveContract?.approvalPolicy !== 'never'
  || admission.effectiveContract?.permissionDefaultPreset !== 'forge-eval-workspace-write-never'
  || admission.effectiveContract?.permissionPresetSandbox !== 'workspace-write'
  || admission.effectiveContract?.permissionPresetApproval !== 'never'
  || admission.effectiveContract?.sandboxModeEnvironment !== 'workspace-write'
  || admission.effectiveContract?.webSearchDisabled !== true
  || admission.effectiveContract?.webToolDisabled !== true
  || admission.effectiveContract?.llmBaseUrl !== 'http://credential-proxy:8080'
  || admission.effectiveContract?.llmApiKeyEnv !== 'FORGE_EVAL_PROXY_CREDENTIAL'
  || admission.effectiveContract?.forgeGovernanceSystemInstruction !== 'FORGE_HARNESS_GOVERNANCE_V1'
  || admission.effectiveContract?.forgeEvidenceTruthRequiredBeforeCompletionClaim !== true
  || admission.effectiveContract?.realCredentialAvailable !== false
  || admission.sourceEvidence?.stdoutSha256 !== hash(admissionStdout)
  || admission.sourceEvidence?.stdoutBytes !== fs.statSync(admissionStdout).size
  || admission.sourceEvidence?.stderrSha256 !== hash(admissionStderr)
  || admission.sourceEvidence?.stderrBytes !== 0
  || admission.sourceEvidence?.containerInspectSha256 !== hash(admissionInspect)
  || admission.sourceEvidence?.containerInspectBytes !== fs.statSync(admissionInspect).size
  || manifest.dshConfigAdmission?.receiptArtifact !== 'dsh-config-admission.receipt.json'
  || manifest.dshConfigAdmission?.paidExecutionAdmittedOnlyAfterReceipt !== true) {
  throw new Error('DSH config admission receipt or source-evidence mismatch');
}
if (manifest.modelCostBoundary?.actualCaseCount !== expectedCases.length
  || manifest.modelCostBoundary?.theoreticalMaximumForwardedRequestCount
    !== expectedCases.length * numeric(expectedMaxRequests)
  || manifest.modelCostBoundary?.theoreticalMaximumForwardedRequestBodyBytes
    !== expectedCases.length * numeric(expectedMaxTotalRequestBytes)
  || manifest.modelCostBoundary?.theoreticalMaximumRequestedOutputTokens
    !== expectedCases.length * numeric(expectedMaxRequests) * numeric(expectedMaxOutputTokens)
  || manifest.modelCostBoundary?.actualTokenUsageProvenByProxy !== false
  || manifest.modelCostBoundary?.actualMonetaryCostProvenByProxy !== false) {
  throw new Error('run theoretical model-cost boundary mismatch');
}
if (manifest.evidenceLimits?.case?.maxOrdinaryFilesIncludingManifest !== numeric(expectedMaxCaseFiles)
  || manifest.evidenceLimits?.case?.maxBytesIncludingManifest !== numeric(expectedMaxCaseBytes)
  || manifest.evidenceLimits?.run?.maxOrdinaryFilesIncludingManifest !== numeric(expectedMaxRunFiles)
  || manifest.evidenceLimits?.run?.maxBytesIncludingManifest !== numeric(expectedMaxRunBytes)
  || manifest.evidenceLimits?.run?.selfManifestIncludedInLimit !== true) {
  throw new Error('run evidence limit contract mismatch');
}
const fullRunTree = enumerateTree(runDir, null);
const fullRunBytes = fullRunTree.files.reduce(
  (total, portable) => total + assertRegularFile(resolveInside(runDir, portable), `run closure: ${portable}`).size,
  0,
);
if (fullRunTree.files.length > numeric(expectedMaxRunFiles)
  || fullRunBytes > numeric(expectedMaxRunBytes)) {
  throw new Error('run evidence exceeds its bounded ordinary-file count or byte closure');
}
if (manifest.owner?.artifact !== '.forge-hbe-owner.json' || manifest.owner?.runToken !== expectedRunToken) {
  throw new Error('run owner receipt mismatch');
}
const owner = JSON.parse(fs.readFileSync(resolveInside(runDir, manifest.owner.artifact), 'utf8'));
if (owner.schemaVersion !== 'forge-harness-staging-owner/v1'
  || owner.runId !== expectedRunId || owner.runToken !== expectedRunToken) {
  throw new Error('run owner marker identity mismatch');
}
if (manifest.runtimeClosure?.pathBase !== 'run-evidence-root'
  || manifest.runtimeClosure?.runRelativeSnapshot !== 'runtime-tools'
  || manifest.runtimeClosure?.runRelativeLockArtifact !== 'runtime-tools/runtime-tools-lock.json'
  || manifest.runtimeClosure?.lockSha256 !== expectedRuntimeToolsLockSha256
  || !Number.isSafeInteger(manifest.runtimeClosure?.lockBytes) || manifest.runtimeClosure.lockBytes < 1
  || manifest.runtimeClosure?.runnerObservedSha256 !== expectedRunnerSha256
  || manifest.runtimeClosure?.inputSnapshotHelperSha256 !== expectedInputHelperSha256
  || manifest.runtimeClosure?.secretSnapshotHelperSha256 !== expectedSecretHelperSha256
  || manifest.runtimeClosure?.runtimeLockVerifierSha256 !== expectedRuntimeLockVerifierSha256
  || manifest.runtimeClosure?.phaseBudgetGuardSha256 !== expectedPhaseGuardSha256
  || manifest.runtimeClosure?.progressDetectorSha256 !== expectedProgressDetectorSha256
  || manifest.runtimeClosure?.protectedHeadlessRunnerSha256 !== expectedProtectedRunnerSha256
  || manifest.runtimeClosure?.runnerStableDoubleReadAtStartupAndBeforePublication !== true
  || manifest.runtimeClosure?.helpersPinnedAndCopiedBeforeFirstExecution !== true
  || manifest.runtimeClosure?.packageContentLock?.packageId !== expectedRuntimePackageId
  || manifest.runtimeClosure?.packageContentLock?.packageVersion !== expectedRuntimePackageVersion
  || manifest.runtimeClosure?.packageContentLock?.runRelativeArtifact !== 'runtime-tools/package-runtime-trust-lock.json'
  || manifest.runtimeClosure?.packageContentLock?.sha256 !== expectedRuntimePackageLockSha256
  || manifest.runtimeClosure?.packageContentLock?.bytes !== numeric(expectedRuntimePackageLockBytes)
  || manifest.runtimeClosure?.packageContentLock?.entryCount !== numeric(expectedRuntimePackageEntryCount)
  || manifest.runtimeClosure?.packageContentLock?.contentAddressed !== true
  || manifest.runtimeClosure?.packageContentLock?.expectedDigestSuppliedOutOfBand !== true
  || manifest.runtimeClosure?.packageContentLock?.externalIdentitySource !== 'required-cli-argument'
  || manifest.runtimeClosure?.packageContentLock?.runnerEmbedsExpectedDigest !== false
  || manifest.runtimeClosure?.packageContentLock?.gitCommitIdentityProven !== false
  || manifest.runtimeClosure?.packageContentLock?.signedAttestation !== false
  || manifest.runtimeClosure?.packageContentLock?.sameHostMaliciousTamperingExcluded !== false) {
  throw new Error('run manifest runtime-tools closure mismatch');
}
const runtimeToolsRoot = resolveInside(runDir, manifest.runtimeClosure.runRelativeSnapshot);
const runtimeToolsLockPath = resolveInside(runDir, manifest.runtimeClosure.runRelativeLockArtifact);
const runtimeToolsLockInfo = assertRegularFile(runtimeToolsLockPath, 'runtime-tools lock');
if (runtimeToolsLockInfo.size !== manifest.runtimeClosure.lockBytes
  || hash(runtimeToolsLockPath) !== expectedRuntimeToolsLockSha256) throw new Error('runtime-tools lock content mismatch');
const runtimeToolsLock = JSON.parse(fs.readFileSync(runtimeToolsLockPath, 'utf8'));
if (runtimeToolsLock.schemaVersion !== 'forge-harness-runtime-tools-lock/v1'
  || runtimeToolsLock.runnerObservedSha256 !== expectedRunnerSha256
  || !Array.isArray(runtimeToolsLock.entries)) throw new Error('runtime-tools lock identity mismatch');
const expectedRuntimeEntries = new Map([
  ['input-snapshot-helper.mjs', expectedInputHelperSha256],
  ['secret-snapshot-helper.mjs', expectedSecretHelperSha256],
  ['runtime-lock-verifier.mjs', expectedRuntimeLockVerifierSha256],
  ['phase-budget-guard.mjs', expectedPhaseGuardSha256],
  ['progress-detector.mjs', expectedProgressDetectorSha256],
  ['protected-headless-runner.mjs', expectedProtectedRunnerSha256],
  ['package-runtime-trust-lock.json', expectedRuntimePackageLockSha256],
]);
const runtimeEntries = new Map(runtimeToolsLock.entries.map((entry) => [entry?.path, entry]));
if (runtimeEntries.size !== runtimeToolsLock.entries.length || runtimeEntries.size !== expectedRuntimeEntries.size) {
  throw new Error('runtime-tools lock entry closure mismatch');
}
const expectedRuntimeFiles = ['runtime-tools-lock.json', ...expectedRuntimeEntries.keys()].sort();
const observedRuntimeTree = enumerateTree(runtimeToolsRoot, null);
if (!sameStrings(observedRuntimeTree.files, expectedRuntimeFiles) || observedRuntimeTree.directories.length !== 0) {
  throw new Error('runtime-tools filesystem closure mismatch');
}
for (const [portable, expectedSha256] of expectedRuntimeEntries) {
  const receipt = runtimeEntries.get(portable);
  const target = resolveInside(runtimeToolsRoot, portable);
  if (receipt?.sha256 !== expectedSha256) throw new Error(`runtime tool anchor mismatch: ${portable}`);
  receiptMatches(receipt, target, `runtime tool: ${portable}`);
}
const runtimePackageLockPath = resolveInside(
  runDir,
  manifest.runtimeClosure.packageContentLock.runRelativeArtifact,
);
const runtimePackageLockInfo = assertRegularFile(runtimePackageLockPath, 'external runtime package content lock');
if (runtimePackageLockInfo.size !== numeric(expectedRuntimePackageLockBytes)
  || hash(runtimePackageLockPath) !== expectedRuntimePackageLockSha256) {
  throw new Error('external runtime package content lock artifact mismatch');
}
const runtimePackageLock = JSON.parse(fs.readFileSync(runtimePackageLockPath, 'utf8'));
if (runtimePackageLock.schemaVersion !== 'forge-harness-eval-runtime-trust-lock/v1'
  || runtimePackageLock.packageId !== expectedRuntimePackageId
  || runtimePackageLock.packageVersion !== expectedRuntimePackageVersion
  || runtimePackageLock.assuranceBoundaries?.contentAddressed !== true
  || runtimePackageLock.assuranceBoundaries?.gitCommitIdentityProven !== false
  || runtimePackageLock.assuranceBoundaries?.signedAttestation !== false
  || runtimePackageLock.assuranceBoundaries?.sameHostMaliciousTamperingExcluded !== false
  || !Array.isArray(runtimePackageLock.entries)) {
  throw new Error('external runtime package content lock identity mismatch');
}
const runtimePackageEntries = new Map(runtimePackageLock.entries.map((entry) => [entry?.path, entry]));
if (runtimePackageEntries.size !== runtimePackageLock.entries.length
  || runtimePackageEntries.size !== numeric(expectedRuntimePackageEntryCount)
  || runtimePackageEntries.get('scripts/run-local-forge-harness-evals.sh')?.sha256 !== expectedRunnerSha256
  || runtimePackageEntries.get('scripts/analyze-forge-harness-session.mjs')?.sha256 !== expectedAnalyzerSha256
  || runtimePackageEntries.get('scripts/snapshot-forge-harness-eval-inputs.mjs')?.sha256 !== expectedInputHelperSha256
  || runtimePackageEntries.get('scripts/snapshot-local-secret.mjs')?.sha256 !== expectedSecretHelperSha256
  || runtimePackageEntries.get('docker/harness/forge-phase-budget-guard.mjs')?.sha256 !== expectedPhaseGuardSha256
  || runtimePackageEntries.get('docker/harness/forge-progress-detector.mjs')?.sha256 !== expectedProgressDetectorSha256) {
  throw new Error('external runtime package content lock entry anchor mismatch');
}
if (manifest.inputClosure?.pathBase !== 'run-evidence-root'
  || manifest.inputClosure?.runRelativeSnapshot !== 'inputs'
  || manifest.inputClosure?.runRelativeLockArtifact !== 'inputs/input-lock.json'
  || manifest.inputClosure?.lockSha256 !== expectedInputLockSha256
  || !Number.isSafeInteger(manifest.inputClosure?.lockBytes) || manifest.inputClosure.lockBytes < 1
  || manifest.inputClosure?.closureDigest !== expectedClosureDigest
  || manifest.inputClosure?.suiteSha256 !== expectedSuiteSha256
  || manifest.inputClosure?.analyzerSha256 !== expectedAnalyzerSha256
  || manifest.inputClosure?.verifiedBeforePublication !== true) {
  throw new Error('run manifest input closure mismatch');
}
const lockPath = resolveInside(runDir, manifest.inputClosure.runRelativeLockArtifact);
const inputLockInfo = assertRegularFile(lockPath, 'evaluation input lock');
if (inputLockInfo.size !== manifest.inputClosure.lockBytes
  || hash(lockPath) !== expectedInputLockSha256) throw new Error('evaluation input lock content mismatch');
const inputLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (inputLock.schemaVersion !== 'forge-harness-eval-input-lock/v1'
  || inputLock.closureDigest !== expectedClosureDigest
  || !Array.isArray(inputLock.entries)) throw new Error('evaluation input lock receipt mismatch');
const lockedEntries = new Map(inputLock.entries.map((entry) => [entry?.path, entry]));
if (lockedEntries.size !== inputLock.entries.length
  || lockedEntries.get('suite/suite.json')?.sha256 !== expectedSuiteSha256
  || lockedEntries.get('analyzer.mjs')?.sha256 !== expectedAnalyzerSha256) {
  throw new Error('evaluation input lock anchor mismatch');
}
const packageToSnapshotPath = new Map([
  ['tests/fixtures/forge-harness-behavior-evals/suite.json', 'suite/suite.json'],
  ['tests/fixtures/forge-harness-behavior-evals/headless-audit.patch.yml', 'suite/headless-audit.patch.yml'],
  ['tests/fixtures/forge-harness-behavior-evals/prompts/adversarial-shortcuts.v1.md', 'suite/prompts/adversarial-shortcuts.v1.md'],
  ['tests/fixtures/forge-harness-behavior-evals/prompts/crud-complete.v1.md', 'suite/prompts/crud-complete.v1.md'],
  ['tests/fixtures/forge-harness-behavior-evals/prompts/edge-pagination-shared-owner.v1.md', 'suite/prompts/edge-pagination-shared-owner.v1.md'],
  ['tests/fixtures/forge-harness-behavior-evals/prompts/frontend-aicrudpage-api-contract.v1.md', 'suite/prompts/frontend-aicrudpage-api-contract.v1.md'],
]);
for (const [packagePath, snapshotPath] of packageToSnapshotPath) {
  const packageEntry = runtimePackageEntries.get(packagePath);
  const snapshotEntry = lockedEntries.get(snapshotPath);
  if (!isPlainObject(packageEntry) || !isPlainObject(snapshotEntry)
    || packageEntry.sha256 !== snapshotEntry.sha256 || packageEntry.bytes !== snapshotEntry.bytes) {
    throw new Error(`external runtime package lock disagrees with the input snapshot: ${snapshotPath}`);
  }
}
const snapshotRoot = resolveInside(runDir, manifest.inputClosure.runRelativeSnapshot);
const snapshotInfo = fs.lstatSync(snapshotRoot);
if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw new Error('evaluation input snapshot root is invalid');
const expectedSnapshotFiles = ['input-lock.json'];
for (const entry of inputLock.entries) {
  if (!isPlainObject(entry) || !shaPattern.test(entry.sha256)
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
    throw new Error('evaluation input lock contains an invalid file receipt');
  }
  const portable = checkedRelative(entry.path);
  expectedSnapshotFiles.push(portable);
  const inputPath = resolveInside(snapshotRoot, portable);
  const inputInfo = assertRegularFile(inputPath, `evaluation input: ${portable}`);
  if (inputInfo.size !== entry.bytes || hash(inputPath) !== entry.sha256) {
    throw new Error(`evaluation input content mismatch: ${portable}`);
  }
}
expectedSnapshotFiles.sort();
const observedSnapshotTree = enumerateTree(snapshotRoot, null);
if (!sameStrings(expectedSnapshotFiles, observedSnapshotTree.files)
  || !sameStrings(derivedDirectories(expectedSnapshotFiles), observedSnapshotTree.directories)) {
  throw new Error('evaluation input snapshot filesystem closure mismatch');
}
for (const item of manifest.cases) {
  if (!isPlainObject(item) || item.manifest !== `${item.caseId}/manifest.json`) throw new Error('unsafe case manifest reference');
  const caseDir = resolveInside(runDir, item.caseId);
  const target = resolveInside(runDir, item.manifest);
  const caseInfo = fs.lstatSync(caseDir);
  if (!caseInfo.isDirectory() || caseInfo.isSymbolicLink()) throw new Error(`invalid case evidence directory: ${item.caseId}`);
  const caseManifestInfo = assertRegularFile(target, `case manifest: ${item.caseId}`);
  if (!shaPattern.test(item.manifestSha256)
    || !Number.isSafeInteger(item.manifestBytes) || item.manifestBytes < 1) throw new Error(`invalid case manifest receipt: ${item.caseId}`);
  if (caseManifestInfo.size !== item.manifestBytes
    || hash(target) !== item.manifestSha256) throw new Error(`case manifest content mismatch: ${item.caseId}`);
  const caseManifest = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (caseManifest.schemaVersion !== 'forge-harness-behavior-evidence/v1'
    || caseManifest.runId !== expectedRunId || caseManifest.caseId !== item.caseId) {
    throw new Error(`case manifest identity mismatch: ${item.caseId}`);
  }
  if (caseManifest.inputClosure?.pathBase !== 'run-evidence-root'
    || caseManifest.inputClosure?.runRelativeSnapshot !== 'inputs'
    || caseManifest.inputClosure?.runRelativeLockArtifact !== 'inputs/input-lock.json'
    || caseManifest.inputClosure?.lockSha256 !== expectedInputLockSha256
    || caseManifest.inputClosure?.closureDigest !== expectedClosureDigest
    || caseManifest.inputClosure?.suiteSha256 !== expectedSuiteSha256
    || caseManifest.inputClosure?.analyzerSha256 !== expectedAnalyzerSha256
    || caseManifest.inputClosure?.verifiedBeforeCaseExecution !== true
    || caseManifest.inputClosure?.verifiedBeforeManifestCreation !== true) {
    throw new Error(`case input closure mismatch: ${item.caseId}`);
  }
  if (!isPlainObject(caseManifest.artifacts)) throw new Error(`case artifact closure missing: ${item.caseId}`);
  const declared = Object.keys(caseManifest.artifacts).map(checkedRelative).sort();
  const observed = enumerateTree(caseDir, 'manifest.json');
  if (!sameStrings(declared, observed.files)
    || !sameStrings(derivedDirectories(declared), observed.directories)) {
    throw new Error(`case artifact filesystem closure mismatch: ${item.caseId}`);
  }
  for (const name of declared) {
    const receipt = caseManifest.artifacts[name];
    if (!isPlainObject(receipt) || !shaPattern.test(receipt.sha256)
      || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) {
      throw new Error(`invalid case artifact receipt: ${item.caseId}/${name}`);
    }
    const artifactPath = resolveInside(caseDir, name);
    const artifactInfo = assertRegularFile(artifactPath, `case artifact: ${item.caseId}/${name}`);
    if (artifactInfo.size !== receipt.bytes || hash(artifactPath) !== receipt.sha256) {
      throw new Error(`case artifact content mismatch: ${item.caseId}/${name}`);
    }
  }
  if (caseManifest.execution?.evidenceCollection?.completeWorkspacePatchExitCode !== 0
    || caseManifest.execution?.evidenceCollection?.completeWorkspacePatchArtifact !== 'workspace.patch'
    || !declared.includes('workspace.patch') || !declared.includes('workspace.patch.stderr.txt')) {
    throw new Error(`complete workspace patch evidence is missing: ${item.caseId}`);
  }
  const artifactBytes = declared.reduce((total, name) => total + caseManifest.artifacts[name].bytes, 0);
  if (caseManifest.evidenceLimits?.maxOrdinaryFilesIncludingManifest !== numeric(expectedMaxCaseFiles)
    || caseManifest.evidenceLimits?.maxBytesIncludingManifest !== numeric(expectedMaxCaseBytes)
    || caseManifest.evidenceLimits?.observedArtifactFilesExcludingManifest !== declared.length
    || caseManifest.evidenceLimits?.observedArtifactBytesExcludingManifest !== artifactBytes
    || caseManifest.evidenceLimits?.selfManifestIncludedInLimit !== true
    || declared.length + 1 > numeric(expectedMaxCaseFiles)
    || artifactBytes + caseManifestInfo.size > numeric(expectedMaxCaseBytes)) {
    throw new Error(`case evidence limit contract mismatch: ${item.caseId}`);
  }

  // Re-derive the safety-critical claims from immutable case receipts instead
  // of trusting the prose/boolean claims copied into the case manifest.
  const runtime = JSON.parse(fs.readFileSync(resolveInside(caseDir, 'runtime-boundary.inspect.json'), 'utf8'));
  const verificationBoundary = JSON.parse(fs.readFileSync(
    resolveInside(caseDir, 'verification-boundary.inspect.json'), 'utf8'));
  const networks = JSON.parse(fs.readFileSync(resolveInside(caseDir, 'network-boundary.inspect.json'), 'utf8'));
  const modelSupervision = JSON.parse(fs.readFileSync(resolveInside(caseDir, 'model-supervision.json'), 'utf8'));
  const proxySupervision = JSON.parse(fs.readFileSync(resolveInside(caseDir, 'credential-proxy-supervision.json'), 'utf8'));
  const proxyRecords = fs.readFileSync(resolveInside(caseDir, 'credential-proxy.stdout.txt'), 'utf8')
    .split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line));
  const caseCandidateWrite = caseManifest.execution?.candidateWrite;
  const candidateEnvironmentNames = [
    'FORGE_TEST_SHADOW_CANDIDATE_WRITE',
    'FORGE_TEST_SHADOW_VERIFICATION_RUNNER_REVISION',
  ];
  const candidateMountDestination = '/usr/local/lib/forge-phase-budget-guard.mjs';
  const progressDetectorMountDestination = '/usr/local/lib/forge-progress-detector.mjs';
  const modelCandidateMounts = runtime.model?.mounts?.filter(
    (mount) => mount.destination === candidateMountDestination) ?? [];
  const proxyCandidateMounts = runtime.proxy?.mounts?.filter(
    (mount) => mount.destination === candidateMountDestination) ?? [];
  const modelProgressDetectorMounts = runtime.model?.mounts?.filter(
    (mount) => mount.destination === progressDetectorMountDestination) ?? [];
  const proxyProgressDetectorMounts = runtime.proxy?.mounts?.filter(
    (mount) => mount.destination === progressDetectorMountDestination) ?? [];
  if (caseCandidateWrite?.enabled !== expectedCandidateWriteEnabled
    || caseCandidateWrite?.cliMode !== (expectedCandidateWriteEnabled ? 'candidate-only' : null)
    || caseCandidateWrite?.runtimeMode !== (expectedCandidateWriteEnabled ? expectedCandidateWriteRuntimeMode : null)
    || caseCandidateWrite?.authorityClass !== (expectedCandidateWriteEnabled ? 'test-shadow-writer' : null)
    || caseCandidateWrite?.verificationRunnerRevision !== (expectedCandidateWriteEnabled ? expectedVerificationRunnerRevision : null)
    || caseCandidateWrite?.scope !== (expectedCandidateWriteEnabled ? 'single-local-test-shadow-case' : null)
    || caseCandidateWrite?.verificationBlocked !== expectedCandidateWriteEnabled
    || ['verificationProven', 'semanticCorrectnessProven', 'databaseBehaviorProven', 'completionProven',
      'releaseProven', 'productionWriterAuthorityProven']
      .some((name) => caseCandidateWrite?.[name] !== false)
    || verificationBoundary.candidateWrite?.enabled !== expectedCandidateWriteEnabled
    || verificationBoundary.candidateWrite?.cliMode !== (expectedCandidateWriteEnabled ? 'candidate-only' : null)
    || verificationBoundary.candidateWrite?.runtimeMode !== (expectedCandidateWriteEnabled ? expectedCandidateWriteRuntimeMode : null)
    || verificationBoundary.candidateWrite?.authorityClass !== (expectedCandidateWriteEnabled ? 'test-shadow-writer' : null)
    || verificationBoundary.candidateWrite?.verificationRunnerRevision !== (expectedCandidateWriteEnabled ? expectedVerificationRunnerRevision : null)
    || ['verificationProven', 'semanticCorrectnessProven', 'databaseBehaviorProven', 'completionProven', 'releaseProven']
      .some((name) => verificationBoundary.candidateWrite?.[name] !== false)
    || (expectedCandidateWriteEnabled
      ? caseManifest.execution?.controlledVerification?.verificationMode !== 'cache-miss'
        || verificationBoundary.verificationMode !== 'cache-miss'
        || caseCandidateWrite?.phaseGuardOverlay?.pathBase !== 'run-evidence-root'
        || caseCandidateWrite?.phaseGuardOverlay?.runRelativeArtifact !== 'runtime-tools/phase-budget-guard.mjs'
        || caseCandidateWrite?.phaseGuardOverlay?.containerDestination !== candidateMountDestination
        || caseCandidateWrite?.phaseGuardOverlay?.sha256 !== expectedPhaseGuardSha256
        || caseCandidateWrite?.phaseGuardOverlay?.readOnly !== true
        || caseCandidateWrite?.phaseGuardOverlay?.sourceMatchesExpectedSnapshot !== true
        || caseCandidateWrite?.phaseGuardOverlay?.integratedInCandidateImage !== false
        || verificationBoundary.candidateWrite?.phaseGuardOverlay?.destination !== candidateMountDestination
        || verificationBoundary.candidateWrite?.phaseGuardOverlay?.sha256 !== expectedPhaseGuardSha256
        || verificationBoundary.candidateWrite?.phaseGuardOverlay?.readOnly !== true
        || verificationBoundary.candidateWrite?.phaseGuardOverlay?.sourceMatchesExpectedSnapshot !== true
        || verificationBoundary.candidateWrite?.phaseGuardOverlay?.integratedInCandidateImage !== false
        || hash(resolveInside(runDir, caseCandidateWrite.phaseGuardOverlay.runRelativeArtifact)) !== expectedPhaseGuardSha256
        || caseCandidateWrite?.progressDetectorOverlay?.pathBase !== 'run-evidence-root'
        || caseCandidateWrite?.progressDetectorOverlay?.runRelativeArtifact !== 'runtime-tools/progress-detector.mjs'
        || caseCandidateWrite?.progressDetectorOverlay?.containerDestination !== progressDetectorMountDestination
        || caseCandidateWrite?.progressDetectorOverlay?.sha256 !== expectedProgressDetectorSha256
        || caseCandidateWrite?.progressDetectorOverlay?.readOnly !== true
        || caseCandidateWrite?.progressDetectorOverlay?.sourceMatchesExpectedSnapshot !== true
        || caseCandidateWrite?.progressDetectorOverlay?.integratedInCandidateImage !== false
        || verificationBoundary.candidateWrite?.progressDetectorOverlay?.destination !== progressDetectorMountDestination
        || verificationBoundary.candidateWrite?.progressDetectorOverlay?.sha256 !== expectedProgressDetectorSha256
        || verificationBoundary.candidateWrite?.progressDetectorOverlay?.readOnly !== true
        || verificationBoundary.candidateWrite?.progressDetectorOverlay?.sourceMatchesExpectedSnapshot !== true
        || verificationBoundary.candidateWrite?.progressDetectorOverlay?.integratedInCandidateImage !== false
        || hash(resolveInside(runDir, caseCandidateWrite.progressDetectorOverlay.runRelativeArtifact)) !== expectedProgressDetectorSha256
        || candidateEnvironmentNames.some((name) => !runtime.model?.environmentNames?.includes(name))
        || candidateEnvironmentNames.some((name) => runtime.proxy?.environmentNames?.includes(name))
        || candidateEnvironmentNames.some((name) => !verificationBoundary.model?.environmentNames?.includes(name)
          || verificationBoundary.broker?.environmentNames?.includes(name)
          || verificationBoundary.runner?.environmentNames?.includes(name))
        || modelCandidateMounts.length !== 1 || modelCandidateMounts[0].type !== 'bind'
        || modelCandidateMounts[0].readOnly !== true || proxyCandidateMounts.length !== 0
        || modelProgressDetectorMounts.length !== 1 || modelProgressDetectorMounts[0].type !== 'bind'
        || modelProgressDetectorMounts[0].readOnly !== true || proxyProgressDetectorMounts.length !== 0
        || verificationBoundary.model?.mounts?.filter((mount) => mount.destination === candidateMountDestination
          && mount.type === 'bind' && mount.readOnly === true).length !== 1
        || verificationBoundary.model?.mounts?.filter((mount) => mount.destination === progressDetectorMountDestination
          && mount.type === 'bind' && mount.readOnly === true).length !== 1
        || [verificationBoundary.broker, verificationBoundary.runner]
          .some((service) => service?.mounts?.some((mount) => [candidateMountDestination, progressDetectorMountDestination]
            .includes(mount.destination)))
      : caseCandidateWrite?.phaseGuardOverlay !== null
        || verificationBoundary.candidateWrite?.phaseGuardOverlay !== null
        || caseCandidateWrite?.progressDetectorOverlay !== null
        || verificationBoundary.candidateWrite?.progressDetectorOverlay !== null
        || candidateEnvironmentNames.some((name) => runtime.model?.environmentNames?.includes(name)
          || runtime.proxy?.environmentNames?.includes(name))
        || candidateEnvironmentNames.some((name) => [verificationBoundary.model, verificationBoundary.broker,
          verificationBoundary.runner].some((service) => service?.environmentNames?.includes(name)))
        || modelCandidateMounts.length !== 0 || proxyCandidateMounts.length !== 0
        || modelProgressDetectorMounts.length !== 0 || proxyProgressDetectorMounts.length !== 0)) {
    throw new Error(`candidate-write evidence does not re-prove the model-only test-shadow boundary: ${item.caseId}`);
  }
  if (runtime.schemaVersion !== 'forge-harness-runtime-boundary/v1'
    || runtime.model?.imageId !== expectedImageId || runtime.proxy?.imageId !== expectedProxyImageId
    || runtime.model?.running !== false || runtime.proxy?.running !== true
    || runtime.model?.readOnlyRootFilesystem !== true || runtime.proxy?.readOnlyRootFilesystem !== true
    || !runtime.model?.capDrop?.includes('ALL') || !runtime.proxy?.capDrop?.includes('ALL')
    || !runtime.model?.securityOpt?.includes('no-new-privileges:true')
    || !runtime.proxy?.securityOpt?.includes('no-new-privileges:true')
    || Object.keys(runtime.model?.publishedPorts ?? {}).length !== 0
    || Object.keys(runtime.proxy?.publishedPorts ?? {}).length !== 0
    || !Array.isArray(runtime.model?.networks) || runtime.model.networks.length !== 1
    || !Array.isArray(runtime.proxy?.networks) || runtime.proxy.networks.length !== 2
    || !runtime.proxy.networks.includes(runtime.model.networks[0])
    || runtime.model.mounts?.some((mount) => mount.sourceMatchesExpectedSecretSnapshot
      || mount.destination === '/run/secrets/model-api-key')
    || runtime.proxy.mounts?.filter((mount) => mount.type === 'bind'
      && mount.destination === '/run/secrets/model-api-key' && mount.readOnly
      && mount.sourceMatchesExpectedSecretSnapshot).length !== 1
    || !runtime.model.environmentNames?.includes('FORGE_EVAL_PROXY_CREDENTIAL')
    || runtime.model.environmentNames?.includes('DEEPSEEK_API_KEY')
    || runtime.proxy.environmentNames?.includes('DEEPSEEK_API_KEY')) {
    throw new Error(`runtime boundary receipt does not re-prove isolation: ${item.caseId}`);
  }
  const internal = networks.networks?.find((network) => network.name === runtime.model.networks[0]);
  const egress = networks.networks?.find((network) => network.name !== runtime.model.networks[0]);
  const expectedInternalPeers = [runtime.proxy.name, networks.configuredCapabilityBroker].sort();
  if (networks.schemaVersion !== 'forge-harness-network-boundary/v1'
    || networks.observationPhase !== 'proxy-and-broker-ready-before-model-start'
    || networks.configuredStoppedModel !== runtime.model.name
    || typeof networks.configuredCapabilityBroker !== 'string'
    || networks.configuredCapabilityBroker.length === 0
    || networks.networks?.length !== 2 || internal?.internal !== true || egress?.internal !== false
    || internal?.driver !== 'bridge' || egress?.driver !== 'bridge'
    || JSON.stringify(internal?.peers) !== JSON.stringify(expectedInternalPeers)
    || JSON.stringify(egress?.peers) !== JSON.stringify([runtime.proxy.name])
    || internal?.labels?.['com.forge.hbe.run'] !== expectedRunToken
    || egress?.labels?.['com.forge.hbe.run'] !== expectedRunToken) {
    throw new Error(`network boundary receipt does not re-prove isolation: ${item.caseId}`);
  }
  if (modelSupervision.schemaVersion !== 'forge-harness-model-supervision/v1'
    || modelSupervision.configuredAttachDeadlineSeconds !== numeric(expectedModelTimeoutSeconds)
    || modelSupervision.attachDeadlineSupervisorSucceeded !== true
    || modelSupervision.containerQuiescenceProvenBeforeEvidence !== true
    || modelSupervision.hostTotalDurationBoundProven !== false
    || modelSupervision.supervisorFailed !== false
    || modelSupervision.exactOwnedStop?.runningAfter !== false
    || caseManifest.execution?.model?.supervision?.containerQuiescenceProvenBeforeEvidence !== true) {
    throw new Error(`model supervision receipt does not re-prove quiescence: ${item.caseId}`);
  }
  if (proxySupervision.schemaVersion !== 'forge-harness-credential-proxy-supervision/v1'
    || proxySupervision.exactOwnedStopExitCode !== 0
    || proxySupervision.exitCodeInspectionExitCode !== 0
    || proxySupervision.runningStateInspectionExitCode !== 0
    || proxySupervision.runningAfterStop !== false
    || proxySupervision.logsCollectionExitCode !== 0
    || proxySupervision.processExitCode !== 0
    || proxySupervision.processQuiescenceProvenBeforeEvidence !== true
    || proxyRecords.length !== 2 || proxyRecords[0]?.event !== 'ready'
    || proxyRecords[1]?.event !== 'stopped' || proxyRecords[0]?.ready !== true
    || proxyRecords[1]?.stopped !== true
    || JSON.stringify(proxyRecords[0]?.contract) !== JSON.stringify(proxyRecords[1]?.contract)
    || proxyRecords[0]?.maxRequests !== numeric(expectedMaxRequests)
    || proxyRecords[1]?.maxRequests !== numeric(expectedMaxRequests)
    || proxyRecords[0]?.acceptedRequests !== 0 || proxyRecords[0]?.forwardedRequests !== 0
    || proxyRecords[1]?.contract?.expectedModel !== expectedModel
    || proxyRecords[1]?.contract?.maxOutputTokens !== numeric(expectedMaxOutputTokens)
    || proxyRecords[1]?.contract?.maxRequestBytes !== numeric(expectedMaxRequestBytes)
    || proxyRecords[1]?.contract?.maxTotalRequestBytes !== numeric(expectedMaxTotalRequestBytes)
    || !Number.isSafeInteger(proxyRecords[1]?.acceptedRequests)
    || proxyRecords[1].acceptedRequests < 0
    || proxyRecords[1].acceptedRequests > numeric(expectedMaxRequests)
    || !Number.isSafeInteger(proxyRecords[1]?.forwardedRequestBytes)
    || proxyRecords[1].forwardedRequestBytes < 0
    || proxyRecords[1].forwardedRequestBytes > numeric(expectedMaxTotalRequestBytes)) {
    throw new Error(`credential proxy receipts do not re-prove bounded clean shutdown: ${item.caseId}`);
  }
  if (caseManifest.dsh?.modelContract?.configuredProvider !== expectedProvider
    || caseManifest.dsh?.modelContract?.requestModel !== expectedModel
    || caseManifest.dsh?.modelContract?.upstreamOrigin !== expectedUpstreamOrigin
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.pathBase !== 'run-evidence-root'
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.runRelativeArtifact !== 'runtime-tools/protected-headless-runner.mjs'
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.containerDestination !== '/usr/local/lib/forge-protected-headless-runner.mjs'
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.sha256 !== expectedProtectedRunnerSha256
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.readOnly !== true
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.sourceMatchesExpectedSnapshot !== true
    || caseManifest.dsh?.protectedHeadlessRunnerOverlay?.integratedInCandidateImage !== false
    || hash(resolveInside(runDir, caseManifest.dsh.protectedHeadlessRunnerOverlay.runRelativeArtifact))
      !== expectedProtectedRunnerSha256
    || caseManifest.execution?.credentialProxy?.readinessExitCode !== 0
    || caseManifest.execution?.credentialProxy?.logsExitCode !== 0
    || caseManifest.execution?.credentialProxy?.stopExitCode !== 0
    || caseManifest.execution?.credentialProxy?.processExitCode !== 0
    || caseManifest.execution?.credentialProxy?.exposureBounds?.theoreticalMaximumForwardedRequestCount
      !== numeric(expectedMaxRequests)
    || caseManifest.execution?.credentialProxy?.exposureBounds?.theoreticalMaximumForwardedRequestBodyBytes
      !== numeric(expectedMaxTotalRequestBytes)
    || caseManifest.execution?.credentialProxy?.exposureBounds?.theoreticalMaximumRequestedOutputTokens
      !== numeric(expectedMaxRequests) * numeric(expectedMaxOutputTokens)
    || caseManifest.execution?.credentialProxy?.exposureBounds?.actualTokenUsageProvenByProxy !== false
    || caseManifest.execution?.credentialProxy?.exposureBounds?.actualMonetaryCostProvenByProxy !== false) {
    throw new Error(`case manifest does not match re-derived model boundary: ${item.caseId}`);
  }
}
if (manifest.finalSecretScan?.artifact !== 'run-secret-scan.json'
  || !shaPattern.test(manifest.finalSecretScan?.sha256)
  || manifest.finalSecretScan?.exactKeyRetained !== false) throw new Error('invalid final secret scan reference');
const scanPath = resolveInside(runDir, manifest.finalSecretScan.artifact);
assertRegularFile(scanPath, 'final secret scan');
const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
if (hash(scanPath) !== manifest.finalSecretScan.sha256
  || manifest.runArtifacts['run-secret-scan.json']?.sha256 !== manifest.finalSecretScan.sha256
  || manifest.runArtifacts['run-secret-scan.json']?.bytes !== fs.statSync(scanPath).size
  || scan.secretRetained !== false || scan.replacementCount !== 0) {
  throw new Error('final secret scan receipt mismatch');
}
NODE
}

verify_runner_unchanged || die 'the evaluation runner changed before staging publication validation'
verify_external_skills_bundle \
  || die 'the external Skill bundle changed before staging publication validation'
verify_runtime_package_lock >/dev/null \
  || die 'the external runtime package content lock changed before publication validation'
verify_input_snapshot || die 'the evaluation input closure changed before publication validation'
validate_run_manifest "${run_stage}"
[[ ! -e "${run_dir}" && ! -L "${run_dir}" ]] || die 'generated completed evidence path collided before atomic publication'
mv -T --no-clobber -- "${run_stage}" "${run_dir}" \
  || die 'atomic evidence publication rename failed closed'
[[ ! -e "${run_stage}" && ! -L "${run_stage}" && -d "${run_dir}" && ! -L "${run_dir}" ]] \
  || die 'atomic evidence publication did not produce the exact completed run directory'
verify_owned_evidence_path "${run_dir}" || die 'published evidence lost its exact ownership marker'
INPUT_SNAPSHOT_DIR="${run_dir}/inputs"
RUNTIME_TOOLS_DIR="${run_dir}/runtime-tools"
ACTIVE_INPUT_SNAPSHOT_HELPER="${RUNTIME_TOOLS_DIR}/input-snapshot-helper.mjs"
ACTIVE_SECRET_SNAPSHOT_HELPER="${RUNTIME_TOOLS_DIR}/secret-snapshot-helper.mjs"
ACTIVE_RUNTIME_LOCK_VERIFIER="${RUNTIME_TOOLS_DIR}/runtime-lock-verifier.mjs"
ACTIVE_RUNTIME_PACKAGE_LOCK="${RUNTIME_TOOLS_DIR}/package-runtime-trust-lock.json"
ACTIVE_PHASE_BUDGET_GUARD="${RUNTIME_TOOLS_DIR}/phase-budget-guard.mjs"
ACTIVE_PROGRESS_DETECTOR="${RUNTIME_TOOLS_DIR}/progress-detector.mjs"
ACTIVE_PRODUCTION_TASK_GRANT="${RUNTIME_TOOLS_DIR}/forge-production-task-grant.mjs"
ACTIVE_PROTECTED_HEADLESS_RUNNER="${RUNTIME_TOOLS_DIR}/protected-headless-runner.mjs"
ACTIVE_PHASE_CONTROLLER="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-controller.mjs"
ACTIVE_PHASE_WORK_PACKAGE="${RUNTIME_TOOLS_DIR}/forge-phase-work-package.mjs"
ACTIVE_PHASE_RUNTIME="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-runtime.mjs"
ACTIVE_PHASE_RESPONSE="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-response.mjs"
ACTIVE_PHASE_OBSERVER="${RUNTIME_TOOLS_DIR}/forge-delivery-phase-workspace-observer.mjs"
RUNTIME_TOOLS_DOCKER_PATH="$(docker_host_path "${RUNTIME_TOOLS_DIR}")"
ACTIVE_SUITE_FILE="${INPUT_SNAPSHOT_DIR}/suite/suite.json"
ACTIVE_ANALYZER_FILE="${INPUT_SNAPSHOT_DIR}/analyzer.mjs"
ACTIVE_FIXTURE_ROOT="${INPUT_SNAPSHOT_DIR}/suite"
verify_runner_unchanged || die 'the evaluation runner changed during atomic publication'
verify_external_skills_bundle \
  || die 'the external Skill bundle changed during atomic publication'
verify_host_runner_bundle \
  || die 'the Host Runner bundle changed during atomic publication'
verify_runtime_package_lock >/dev/null \
  || die 'the external runtime package content lock changed during atomic publication'
verify_runtime_tools_snapshot || die 'the published runtime-tools closure changed during atomic publication'
verify_input_snapshot || die 'the published evaluation input closure changed during atomic publication'
validate_run_manifest "${run_dir}"
RUN_PUBLISHED=1

printf 'Forge Harness local behavior evidence: %s\n' "${run_dir}"
