#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly REFRESH_WORKFLOW_VERSION='2'
readonly EXPECTED_NPM_VERSION='11.19.0'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly VERSIONS_FILE="${REPO_ROOT}/config/versions.env"
readonly RUNTIME_DEPENDENCY_ROOT="${REPO_ROOT}/docker/harness/runtime-dependencies"
readonly REVIEWED_PACKAGE_JSON="${RUNTIME_DEPENDENCY_ROOT}/package.json"
readonly REVIEWED_PACKAGE_LOCK="${RUNTIME_DEPENDENCY_ROOT}/package-lock.json"
readonly REVIEWED_LOCK_GUARD="${RUNTIME_DEPENDENCY_ROOT}/package-lock.json.lock.local"
readonly VALIDATOR="${REPO_ROOT}/docker/harness/validate-runtime-dependencies.mjs"
readonly CANDIDATE_OUTPUT_ROOT_INPUT="${REPO_ROOT}/output/runtime-lock-refresh"

APPLY_REVIEWED_LOCK=0
CONFIRM_CURRENT_SHA256=''
CONFIRM_CANDIDATE_SHA256=''
scratch_root=''
input_snapshot_root=''
candidate_publish_temp=''
reviewed_lock_temp=''
reviewed_lock_fd=''
temp_root=''

usage() {
  printf '%s\n' \
    'Usage:' \
    "  $0" \
    "  $0 --apply-reviewed-lock \\" \
    '    --confirm-current-sha256 sha256:<64-lowercase-hex> \' \
    '    --confirm-candidate-sha256 sha256:<64-lowercase-hex>' \
    '' \
    'The default run creates an ignored, reviewable candidate and receipts only.' \
    'Replacing the reviewed lock requires both exact hashes from a prior candidate summary.'
}

die() {
  printf 'runtime-lock-refresh: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "${reviewed_lock_fd}" ]]; then
    flock --unlock "${reviewed_lock_fd}" >/dev/null 2>&1 || true
    exec {reviewed_lock_fd}>&- || true
    reviewed_lock_fd=''
  fi
  if [[ -n "${reviewed_lock_temp}" && -f "${reviewed_lock_temp}" ]]; then
    rm -f -- "${reviewed_lock_temp}"
  fi
  if [[ -n "${candidate_publish_temp}" && -d "${candidate_publish_temp}" ]]; then
    case "${candidate_publish_temp}" in
      "${CANDIDATE_OUTPUT_ROOT_INPUT}"/.candidate.*) rm -rf -- "${candidate_publish_temp}" ;;
    esac
  fi
  if [[ -n "${scratch_root}" && -d "${scratch_root}" ]]; then
    case "${scratch_root}" in
      "${temp_root}"/forge-harness-runtime-lock-refresh.*) rm -rf -- "${scratch_root}" ;;
    esac
  fi
  if [[ -n "${input_snapshot_root}" && -d "${input_snapshot_root}" ]]; then
    case "${input_snapshot_root}" in
      "${temp_root}"/forge-harness-runtime-lock-inputs.*)
        chmod -R u+w "${input_snapshot_root}" >/dev/null 2>&1 || true
        rm -rf -- "${input_snapshot_root}"
        ;;
    esac
  fi
}
trap cleanup EXIT

while (($# > 0)); do
  case "$1" in
    --apply-reviewed-lock)
      APPLY_REVIEWED_LOCK=1
      shift
      ;;
    --confirm-current-sha256)
      (($# >= 2)) || die '--confirm-current-sha256 requires a value.'
      CONFIRM_CURRENT_SHA256="$2"
      shift 2
      ;;
    --confirm-candidate-sha256)
      (($# >= 2)) || die '--confirm-candidate-sha256 requires a value.'
      CONFIRM_CANDIDATE_SHA256="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown argument: $1"
      ;;
  esac
done

if [[ "${APPLY_REVIEWED_LOCK}" -eq 1 ]]; then
  [[ "${CONFIRM_CURRENT_SHA256}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die 'Applying requires an exact --confirm-current-sha256 value.'
  [[ "${CONFIRM_CANDIDATE_SHA256}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die 'Applying requires an exact --confirm-candidate-sha256 value.'
elif [[ -n "${CONFIRM_CURRENT_SHA256}" || -n "${CONFIRM_CANDIDATE_SHA256}" ]]; then
  die 'Confirmation hashes are only accepted with --apply-reviewed-lock.'
fi

for command_name in awk chmod chown cp date docker flock grep id mkdir mktemp mv pwd rm sha256sum stat; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || die "Required command is unavailable: ${command_name}"
done

for reviewed_file in \
  "${VERSIONS_FILE}" \
  "${REVIEWED_PACKAGE_JSON}" \
  "${REVIEWED_PACKAGE_LOCK}" \
  "${VALIDATOR}"; do
  [[ -f "${reviewed_file}" && ! -L "${reviewed_file}" ]] \
    || die "Reviewed input is missing, linked, or non-regular: ${reviewed_file#"${REPO_ROOT}/"}"
done
[[ "$(cd -- "${RUNTIME_DEPENDENCY_ROOT}" && pwd -P)" == "${RUNTIME_DEPENDENCY_ROOT}" ]] \
  || die 'Runtime dependency root is not a real repository directory.'

sha256_file() {
  local value
  value="$(sha256sum -- "$1" | awk '{print $1}')"
  [[ "${value}" =~ ^[0-9a-f]{64}$ ]] || die 'sha256sum returned an invalid digest.'
  printf 'sha256:%s\n' "${value}"
}

versions_env_sha256_before="$(sha256_file "${VERSIONS_FILE}")"
package_json_sha256_before="$(sha256_file "${REVIEWED_PACKAGE_JSON}")"
validator_sha256_before="$(sha256_file "${VALIDATOR}")"
reviewed_lock_sha256_before="$(sha256_file "${REVIEWED_PACKAGE_LOCK}")"

assert_source_inputs_unchanged() {
  local phase="$1"
  [[ "$(sha256_file "${VERSIONS_FILE}")" == "${versions_env_sha256_before}" ]] \
    || die "Source input drifted before ${phase}: config/versions.env"
  [[ "$(sha256_file "${REVIEWED_PACKAGE_JSON}")" == "${package_json_sha256_before}" ]] \
    || die "Source input drifted before ${phase}: runtime-dependencies/package.json"
  [[ "$(sha256_file "${VALIDATOR}")" == "${validator_sha256_before}" ]] \
    || die "Source input drifted before ${phase}: validate-runtime-dependencies.mjs"
  [[ "$(sha256_file "${input_snapshot_root}/versions.env")" == "${versions_env_sha256_before}" \
      && "$(sha256_file "${input_snapshot_root}/package.json")" == "${package_json_sha256_before}" \
      && "$(sha256_file "${input_snapshot_root}/validator.mjs")" == "${validator_sha256_before}" \
      && "$(sha256_file "${scratch_root}/package.json")" == "${package_json_sha256_before}" ]] \
    || die "Frozen source snapshot drifted before ${phase}."
}

runtime_uid="$(id -u)"
runtime_gid="$(id -g)"
if [[ "${runtime_uid}" -eq 0 ]]; then
  runtime_uid='65532'
  runtime_gid='65532'
fi
[[ "${runtime_uid}" =~ ^[0-9]+$ && "${runtime_uid}" -ne 0 \
    && "${runtime_gid}" =~ ^[0-9]+$ ]] \
  || die 'A numeric non-root container identity is required.'
readonly runtime_identity="${runtime_uid}:${runtime_gid}"

temp_root="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)" \
  || die 'Cannot resolve the local temporary directory.'
input_snapshot_root="$(mktemp -d "${temp_root}/forge-harness-runtime-lock-inputs.XXXXXX")"
scratch_root="$(mktemp -d "${temp_root}/forge-harness-runtime-lock-refresh.XXXXXX")"
[[ -d "${input_snapshot_root}" && ! -L "${input_snapshot_root}" \
    && -d "${scratch_root}" && ! -L "${scratch_root}" ]] \
  || die 'Failed to create fresh no-follow runtime lock workspaces.'
chmod 0700 "${input_snapshot_root}"
chmod 0700 "${scratch_root}"
cp -- "${VERSIONS_FILE}" "${input_snapshot_root}/versions.env"
cp -- "${REVIEWED_PACKAGE_JSON}" "${input_snapshot_root}/package.json"
cp -- "${VALIDATOR}" "${input_snapshot_root}/validator.mjs"
[[ "$(sha256_file "${input_snapshot_root}/versions.env")" == "${versions_env_sha256_before}" \
    && "$(sha256_file "${input_snapshot_root}/package.json")" == "${package_json_sha256_before}" \
    && "$(sha256_file "${input_snapshot_root}/validator.mjs")" == "${validator_sha256_before}" ]] \
  || die 'A source input changed while its immutable snapshot was created.'
chmod 0555 "${input_snapshot_root}"
chmod 0444 "${input_snapshot_root}"/*
cp -- "${input_snapshot_root}/package.json" "${scratch_root}/package.json"
printf '' >"${scratch_root}/.npmrc"
printf '' >"${scratch_root}/.npm-globalrc"
mkdir -- "${scratch_root}/.home" "${scratch_root}/.npm-cache"
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R "${runtime_identity}" "${scratch_root}"
fi
[[ ! -e "${scratch_root}/node_modules" && ! -e "${scratch_root}/package-lock.json" ]] \
  || die 'The fresh runtime lock workspace was unexpectedly pre-populated.'

assert_source_inputs_unchanged 'dependency resolution'

mapfile -t node_base_rows < <(grep -E '^HARNESS_NODE_BASE_IMAGE=' "${input_snapshot_root}/versions.env")
[[ "${#node_base_rows[@]}" -eq 1 ]] \
  || die 'config/versions.env must contain exactly one HARNESS_NODE_BASE_IMAGE entry.'
HARNESS_NODE_BASE_IMAGE="${node_base_rows[0]#*=}"
readonly HARNESS_NODE_BASE_IMAGE
[[ "${HARNESS_NODE_BASE_IMAGE}" =~ ^node:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] \
  || die 'HARNESS_NODE_BASE_IMAGE must be an exact node tag plus sha256 manifest digest.'

base_image_id="$(docker image inspect --format '{{.Id}}' "${HARNESS_NODE_BASE_IMAGE}")" \
  || die 'The pinned HARNESS_NODE_BASE_IMAGE is not available locally; import or pull that exact digest first.'
base_image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "${HARNESS_NODE_BASE_IMAGE}")" \
  || die 'Cannot inspect the pinned HARNESS_NODE_BASE_IMAGE platform.'
[[ "${base_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die 'The pinned Node base resolved to an invalid local image ID.'
[[ "${base_image_platform}" == 'linux/amd64' ]] \
  || die "The runtime lock must be refreshed on linux/amd64, not ${base_image_platform}."

npm_version="$(docker run --rm --pull never --platform linux/amd64 --network none \
  --user "${runtime_identity}" "${HARNESS_NODE_BASE_IMAGE}" npm --version)" \
  || die 'Cannot execute npm from the pinned Node base image.'
[[ "${npm_version}" == "${EXPECTED_NPM_VERSION}" ]] \
  || die "Pinned Node base npm version is ${npm_version}; expected ${EXPECTED_NPM_VERSION}."

run_in_fresh_workspace() {
  local network_mode="$1"
  shift
  docker run --rm --pull never --platform linux/amd64 \
    --network "${network_mode}" \
    --user "${runtime_identity}" \
    --mount "type=bind,src=${scratch_root},dst=/work" \
    --mount "type=bind,src=${input_snapshot_root}/validator.mjs,dst=/validator.mjs,readonly" \
    --workdir /work \
    --env HOME=/work/.home \
    --env NODE_PATH= \
    --env NPM_CONFIG_USERCONFIG=/work/.npmrc \
    --env NPM_CONFIG_GLOBALCONFIG=/work/.npm-globalrc \
    --env NPM_CONFIG_CACHE=/work/.npm-cache \
    --env NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    --env NPM_CONFIG_AUDIT=false \
    --env NPM_CONFIG_FUND=false \
    --env NPM_CONFIG_UPDATE_NOTIFIER=false \
    "${HARNESS_NODE_BASE_IMAGE}" "$@"
}

# Phase 1a may reach only the public package registry, but lifecycle scripts are
# disabled and the workspace contains no prior lock, node_modules, npmrc, or cache.
run_in_fresh_workspace bridge \
  npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund
[[ "$(sha256_file "${scratch_root}/package.json")" == "${package_json_sha256_before}" ]] \
  || die 'npm changed the reviewed package declarations while resolving the candidate lock.'
[[ -f "${scratch_root}/package-lock.json" && ! -L "${scratch_root}/package-lock.json" ]] \
  || die 'npm did not create a regular candidate package-lock.json.'

# Source policy is checked before any package content is installed.
run_in_fresh_workspace none \
  node /validator.mjs --mode source --root /work --json \
  >"${scratch_root}/source-receipt.json"
grep -Eq '"schemaVersion":3' "${scratch_root}/source-receipt.json" \
  || die 'Source validator did not emit a schema 3 receipt.'
grep -Eq '"mode":"source"' "${scratch_root}/source-receipt.json" \
  || die 'Source validator receipt mode is invalid.'

# The advisory database is time-varying and cannot be part of the reproducible
# image input. Query it explicitly while producing a review candidate, retain
# the complete response, and fail closed on HIGH or CRITICAL production issues.
run_in_fresh_workspace bridge \
  env NPM_CONFIG_AUDIT=true npm audit --omit=dev --package-lock-only \
    --audit-level=high --json \
  >"${scratch_root}/advisory-audit-receipt.json"
run_in_fresh_workspace none node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const report = JSON.parse(readFileSync("/work/advisory-audit-receipt.json", "utf8"));
  const counts = report?.metadata?.vulnerabilities;
  const severities = ["info", "low", "moderate", "high", "critical"];
  if (!counts || !Number.isInteger(report.auditReportVersion)) process.exit(1);
  for (const severity of [...severities, "total"]) {
    if (!Number.isInteger(counts[severity]) || counts[severity] < 0) process.exit(1);
  }
  if (counts.total !== severities.reduce((total, severity) => total + counts[severity], 0)) process.exit(1);
  if (counts.high !== 0 || counts.critical !== 0) process.exit(1);
'

# Phase 1b downloads the reviewed closure with every lifecycle script disabled.
run_in_fresh_workspace bridge \
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Phase 2 is intentionally non-root and network-less. Only the exact
# package.json allowScripts set can run, and no unreviewed script may remain.
run_in_fresh_workspace none sh -euc '
  npm rebuild --no-audit --no-fund --strict-allow-scripts
  npm install-scripts ls --json >/work/install-scripts-pending.json
  node -e '\''
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync("/work/install-scripts-pending.json", "utf8"));
    if (JSON.stringify(Object.keys(value)) !== JSON.stringify(["allowScripts"])
        || !Array.isArray(value.allowScripts)
        || value.allowScripts.length !== 0) process.exit(1);
  '\''
'

# Installed validation binds the full hidden lock, actual file tree, native
# platform requirements, and live runtime capabilities into a schema 3 receipt.
run_in_fresh_workspace none \
  node /validator.mjs --mode installed --root /work --smoke --json \
  >"${scratch_root}/installed-smoke-receipt.json"
grep -Eq '"schemaVersion":3' "${scratch_root}/installed-smoke-receipt.json" \
  || die 'Installed validator did not emit a schema 3 receipt.'
grep -Eq '"mode":"installed"' "${scratch_root}/installed-smoke-receipt.json" \
  || die 'Installed validator receipt mode is invalid.'
grep -Eq '"capabilities":\{' "${scratch_root}/installed-smoke-receipt.json" \
  || die 'Installed schema 3 receipt does not contain successful smoke capabilities.'

candidate_lock_sha256="$(sha256_file "${scratch_root}/package-lock.json")"
base_image_id_after="$(docker image inspect --format '{{.Id}}' "${HARNESS_NODE_BASE_IMAGE}")" \
  || die 'Pinned Node base disappeared during refresh.'
[[ "${base_image_id_after}" == "${base_image_id}" ]] \
  || die 'Pinned Node base identity changed during refresh.'

run_timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_in_fresh_workspace none node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync, writeFileSync } from "node:fs";
  const [workflowVersion, createdAt, baseRef, baseId, npmVersion, versionsEnvSha,
    packageJsonSha, validatorSha, previousLockSha, candidateLockSha, applyRequested] = process.argv.slice(1);
  const source = JSON.parse(readFileSync("/work/source-receipt.json", "utf8"));
  const installed = JSON.parse(readFileSync("/work/installed-smoke-receipt.json", "utf8"));
  const advisoryBytes = readFileSync("/work/advisory-audit-receipt.json");
  const advisory = JSON.parse(advisoryBytes.toString("utf8"));
  const advisoryCounts = advisory.metadata.vulnerabilities;
  const summary = {
    schemaVersion: 1,
    workflowVersion,
    createdAt,
    baseImage: { ref: baseRef, id: baseId, platform: "linux/amd64", npmVersion },
    inputs: {
      versionsEnvSha256: versionsEnvSha,
      packageJsonSha256: packageJsonSha,
      validatorSha256: validatorSha,
      previousLockSha256: previousLockSha,
    },
    candidate: {
      packageLockSha256: candidateLockSha,
      sourceReceiptDigest: source.digest,
      installedReceiptDigest: installed.digest,
      sourcePackageCount: source.sourcePackageCount,
      installedPackageCount: installed.packageCount,
      approvedInstallScripts: source.approvedInstallScripts,
      runtimePolicy: source.runtimePolicy,
      advisoryAudit: {
        receiptSha256: `sha256:${createHash("sha256").update(advisoryBytes).digest("hex")}`,
        auditReportVersion: advisory.auditReportVersion,
        databaseObservedAt: createdAt,
        registry: "https://registry.npmjs.org/",
        auditLevel: "high",
        blockingSeverities: ["high", "critical"],
        vulnerabilityCounts: advisoryCounts,
        passed: advisoryCounts.high === 0 && advisoryCounts.critical === 0,
      },
    },
    validationBoundary: {
      candidateSmokeEnvironment: "digest-pinned Debian Node linux/amd64 base",
      candidateSmokeIsFinalHarnessImageEvidence: false,
      requiredFinalEvidence: "schema 3 --smoke inside the final Maven/Ubuntu Harness image",
      advisoryDatabaseIsPinned: false,
      advisoryResultIsPointInTime: true,
      advisoryResultDoesNotGuaranteeFutureAbsence: true,
    },
    applyRequested: applyRequested === "true",
    candidateGenerationChangedReviewedLock: false,
  };
  writeFileSync("/work/summary.json", `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
' "${REFRESH_WORKFLOW_VERSION}" "${run_timestamp}" "${HARNESS_NODE_BASE_IMAGE}" \
  "${base_image_id}" "${npm_version}" "${versions_env_sha256_before}" \
  "${package_json_sha256_before}" "${validator_sha256_before}" \
  "${reviewed_lock_sha256_before}" "${candidate_lock_sha256}" \
  "$([[ "${APPLY_REVIEWED_LOCK}" -eq 1 ]] && printf true || printf false)"

assert_source_inputs_unchanged 'candidate publication'
[[ ! -L "${REPO_ROOT}/output" && ! -L "${CANDIDATE_OUTPUT_ROOT_INPUT}" ]] \
  || die 'Candidate output path must not contain a symbolic-link boundary.'
mkdir -p -- "${CANDIDATE_OUTPUT_ROOT_INPUT}"
candidate_output_root="$(cd -- "${CANDIDATE_OUTPUT_ROOT_INPUT}" && pwd -P)"
[[ "${candidate_output_root}" == "${CANDIDATE_OUTPUT_ROOT_INPUT}" ]] \
  || die 'Candidate output root resolves through a symbolic link or outside the repository output directory.'
candidate_name="${run_timestamp//[:]/}-${candidate_lock_sha256#sha256:}"
candidate_name="${candidate_name:0:44}-$$"
candidate_dir="${candidate_output_root}/${candidate_name}"
[[ ! -e "${candidate_dir}" && ! -L "${candidate_dir}" ]] \
  || die 'Candidate output directory already exists.'
candidate_publish_temp="$(mktemp -d "${candidate_output_root}/.candidate.XXXXXX")"
cp -- "${scratch_root}/package.json" "${candidate_publish_temp}/package.json"
cp -- "${scratch_root}/package-lock.json" "${candidate_publish_temp}/package-lock.json"
cp -- "${scratch_root}/source-receipt.json" "${candidate_publish_temp}/source-receipt.json"
cp -- "${scratch_root}/advisory-audit-receipt.json" \
  "${candidate_publish_temp}/advisory-audit-receipt.json"
cp -- "${scratch_root}/installed-smoke-receipt.json" \
  "${candidate_publish_temp}/installed-smoke-receipt.json"
cp -- "${scratch_root}/summary.json" "${candidate_publish_temp}/summary.json"
chmod 0644 "${candidate_publish_temp}"/*
[[ "$(sha256_file "${candidate_publish_temp}/package.json")" == "${package_json_sha256_before}" \
    && "$(sha256_file "${candidate_publish_temp}/package-lock.json")" == "${candidate_lock_sha256}" ]] \
  || die 'Published candidate inputs differ from the validated source snapshot.'
assert_source_inputs_unchanged 'candidate directory rename'
mv -- "${candidate_publish_temp}" "${candidate_dir}"
candidate_publish_temp=''

printf '%s\n' \
  "candidate_dir=${candidate_dir}" \
  "candidate_lock_sha256=${candidate_lock_sha256}" \
  "reviewed_lock_sha256_before=${reviewed_lock_sha256_before}" \
  "base_image_id=${base_image_id}" \
  "npm_version=${npm_version}"

if [[ "${APPLY_REVIEWED_LOCK}" -eq 0 ]]; then
  printf '%s\n' \
    'reviewed_lock_updated=false' \
    "review_then_apply=$0 --apply-reviewed-lock --confirm-current-sha256 ${reviewed_lock_sha256_before} --confirm-candidate-sha256 ${candidate_lock_sha256}"
  exit 0
fi

[[ "${CONFIRM_CURRENT_SHA256}" == "${reviewed_lock_sha256_before}" ]] \
  || die 'The exact current-lock confirmation does not match this run.'
[[ "${CONFIRM_CANDIDATE_SHA256}" == "${candidate_lock_sha256}" ]] \
  || die 'The exact candidate-lock confirmation does not match this run.'

[[ ! -e "${REVIEWED_LOCK_GUARD}" \
    || ( -f "${REVIEWED_LOCK_GUARD}" && ! -L "${REVIEWED_LOCK_GUARD}" ) ]] \
  || die 'The sibling runtime lock guard is linked or non-regular.'
exec {reviewed_lock_fd}>>"${REVIEWED_LOCK_GUARD}" \
  || die 'Cannot open the sibling runtime lock guard.'
chmod 0600 "${REVIEWED_LOCK_GUARD}"
if ! flock --exclusive --nonblock "${reviewed_lock_fd}"; then
  die 'Another runtime lock writer holds the sibling advisory lock; no replacement was made.'
fi
[[ -f "${REVIEWED_LOCK_GUARD}" && ! -L "${REVIEWED_LOCK_GUARD}" ]] \
  || die 'The sibling runtime lock guard changed while it was acquired.'
guard_path_identity="$(stat -Lc '%d:%i' "${REVIEWED_LOCK_GUARD}")"
guard_fd_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/${reviewed_lock_fd}")"
[[ "${guard_path_identity}" == "${guard_fd_identity}" ]] \
  || die 'The sibling runtime lock guard identity changed while it was acquired.'

# Every mutation precondition is checked while the sibling advisory writer lock
# is held. Cooperating writers fail immediately instead of waiting or racing.
[[ "$(sha256_file "${REVIEWED_PACKAGE_LOCK}")" == "${reviewed_lock_sha256_before}" ]] \
  || die 'The reviewed lock changed after candidate generation; no replacement was made.'
assert_source_inputs_unchanged 'reviewed lock replacement'
[[ "$(docker image inspect --format '{{.Id}}' "${HARNESS_NODE_BASE_IMAGE}")" == "${base_image_id}" ]] \
  || die 'Pinned Node base identity changed before replacement.'

# The temporary file is created in the reviewed lock directory so the final
# rename is an atomic same-filesystem replacement. The lock and hashes are CAS gates.
reviewed_lock_temp="$(mktemp "${RUNTIME_DEPENDENCY_ROOT}/.package-lock.refresh.XXXXXX")"
cp -- "${candidate_dir}/package-lock.json" "${reviewed_lock_temp}"
chmod 0644 "${reviewed_lock_temp}"
[[ "$(sha256_file "${reviewed_lock_temp}")" == "${candidate_lock_sha256}" ]] \
  || die 'Staged reviewed lock differs from the validated candidate.'
assert_source_inputs_unchanged 'atomic reviewed lock rename'
[[ "$(sha256_file "${REVIEWED_PACKAGE_LOCK}")" == "${reviewed_lock_sha256_before}" ]] \
  || die 'The reviewed lock changed before the atomic rename; no replacement was made.'
mv -- "${reviewed_lock_temp}" "${REVIEWED_PACKAGE_LOCK}"
reviewed_lock_temp=''
[[ "$(sha256_file "${REVIEWED_PACKAGE_LOCK}")" == "${candidate_lock_sha256}" ]] \
  || die 'Reviewed lock replacement did not preserve the confirmed candidate digest.'
flock --unlock "${reviewed_lock_fd}"
exec {reviewed_lock_fd}>&-
reviewed_lock_fd=''

run_in_fresh_workspace none node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const [appliedAt, before, after] = process.argv.slice(1);
  writeFileSync("/work/apply-receipt.json", `${JSON.stringify({
    schemaVersion: 1,
    appliedAt,
    previousLockSha256: before,
    appliedLockSha256: after,
    siblingAdvisoryWriterLock: "package-lock.json.lock.local",
    atomicSameDirectoryRename: true,
  }, null, 2)}\n`, { mode: 0o600 });
' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${reviewed_lock_sha256_before}" "${candidate_lock_sha256}"
cp -- "${scratch_root}/apply-receipt.json" "${candidate_dir}/apply-receipt.json"
chmod 0644 "${candidate_dir}/apply-receipt.json"
printf '%s\n' 'reviewed_lock_updated=true' "reviewed_lock_sha256_after=${candidate_lock_sha256}"
