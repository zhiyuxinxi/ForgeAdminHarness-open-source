#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

# The exact restore subcommand must remain available when the live platform
# source is incomplete or its optional platform.env is absent.  Its caller
# supplies the non-secret host identity explicitly, so this generic script
# never substitutes a host-specific default.
if [[ "${1:-}" == --restore-baseline-lock ]]; then
  : "${DELIVERY_ROOT:?DELIVERY_ROOT is required for baseline-lock restore}"
  : "${DELIVERY_OWNER:?DELIVERY_OWNER is required for baseline-lock restore}"
  : "${DELIVERY_GROUP:?DELIVERY_GROUP is required for baseline-lock restore}"
else
  load_platform_config
fi

baseline_dir_fd=''
baseline_temp_fd=''
baseline_temp_name=''
baseline_temp_path=''
baseline_lock_contents=''
adoption_receipt_contents=''

cleanup_baseline_receipt() {
  local cleanup_name="${baseline_temp_name}"
  if [[ -z "${cleanup_name}" && -n "${baseline_temp_path}" ]]; then
    cleanup_name="${baseline_temp_path##*/}"
  fi
  if [[ -n "${baseline_temp_fd}" ]]; then
    exec {baseline_temp_fd}>&- || true
    baseline_temp_fd=''
  fi
  if [[ -n "${cleanup_name}" \
      && "${cleanup_name}" =~ ^\.baseline\.lock\.[A-Za-z0-9]+$ \
      && "${baseline_dir_fd}" =~ ^[0-9]+$ \
      && -e "/proc/$$/fd/${baseline_dir_fd}" ]]; then
    rm -f -- "/proc/$$/fd/${baseline_dir_fd}/${cleanup_name}" || true
    baseline_temp_name=''
    baseline_temp_path=''
  fi
  if [[ -n "${baseline_dir_fd}" ]]; then
    exec {baseline_dir_fd}>&- || true
    baseline_dir_fd=''
  fi
}
trap cleanup_baseline_receipt EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${EUID}" -eq 0 ]] || die "sync-baseline.sh must run as root so it can build and inspect Docker images."
for command_name in awk cat chmod chown getent git id mktemp mv readlink rm runuser sha256sum stat sync; do
  require_command "${command_name}"
done
require_docker_access
acquire_harness_image_upgrade_lock

[[ -d "${DELIVERY_ROOT}/baselines" ]] \
  || die "Host is not bootstrapped. Run bootstrap-host.sh first."

run_as_owner() {
  runuser --user "${DELIVERY_OWNER}" -- "$@"
}

require_sha256() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die 'expected SHA-256 is invalid.'
}

baseline_lock_value() {
  local contents="$1" key="$2"
  awk -F= -v key="$key" '$1 == key { count += 1; sub(/^[^=]*=/, ""); value=$0 } END { if (count == 1 && length(value) > 0) print value; else exit 1 }' <<<"$contents"
}

read_bound_baseline_lock() {
  local expected_sha="$1" baselines_root lock_file owner_uid group_gid lock_fd lock_fd_path metadata digest
  require_sha256 "$expected_sha"
  baselines_root="${DELIVERY_ROOT}/baselines"
  [[ -d "$baselines_root" && ! -L "$baselines_root" && "$(readlink -f -- "$baselines_root")" == "$baselines_root" ]] || die 'baseline directory is unsafe.'
  owner_uid="$(id -u "${DELIVERY_OWNER}")" || die 'configured delivery owner does not exist.'
  group_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 { print $3 }')"
  [[ "$group_gid" =~ ^[0-9]+$ ]] || die 'configured delivery group does not exist.'
  lock_file="${baselines_root}/baseline.lock"
  [[ -f "$lock_file" && ! -L "$lock_file" ]] || die 'canonical baseline lock is missing or unsafe.'
  exec {lock_fd}<"$lock_file" || die 'canonical baseline lock cannot be opened safely.'
  lock_fd_path="/proc/${BASHPID}/fd/${lock_fd}"
  metadata="$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "$lock_fd_path")"
  digest="$(sha256sum -- "$lock_fd_path" | awk '{ print $1 }')"
  [[ "$(readlink -f -- "$lock_fd_path")" == "$lock_file" && "$metadata" == "${owner_uid}:${group_gid}:640:1:regular file" && "$digest" == "$expected_sha" ]] || die 'canonical baseline lock differs from its explicit binding.'
  baseline_lock_contents="$(cat <&${lock_fd})"
  exec {lock_fd}<&-
}

publish_bound_baseline_lock() {
  local expected_current_sha="$1" expected_next_sha="$2" writer="$3"
  shift 3
  local baselines_root lock_file owner_uid group_gid baseline_dir_fd_path baseline_dir_identity current_fd current_fd_path current_metadata current_digest baseline_temp_fd_path baseline_temp_identity baseline_temp_digest
  require_sha256 "$expected_current_sha"; require_sha256 "$expected_next_sha"
  baselines_root="${DELIVERY_ROOT}/baselines"
  [[ -d "$baselines_root" && ! -L "$baselines_root" && "$(readlink -f -- "$baselines_root")" == "$baselines_root" ]] || die 'baseline directory is unsafe.'
  owner_uid="$(id -u "${DELIVERY_OWNER}")" || die 'configured delivery owner does not exist.'
  group_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 { print $3 }')"
  [[ "$group_gid" =~ ^[0-9]+$ ]] || die 'configured delivery group does not exist.'
  exec {baseline_dir_fd}<"$baselines_root" || die 'baseline directory cannot be opened safely.'
  baseline_dir_fd_path="/proc/${BASHPID}/fd/${baseline_dir_fd}"
  baseline_dir_identity="$(stat -L -c '%d:%i' -- "$baseline_dir_fd_path")"
  [[ "$(readlink -f -- "$baseline_dir_fd_path")" == "$baselines_root" && "$(LC_ALL=C stat -L -c '%u:%g:%a:%F' -- "$baseline_dir_fd_path")" == "${owner_uid}:${group_gid}:750:directory" ]] || die 'baseline directory changed while it was opened.'
  lock_file="${baseline_dir_fd_path}/baseline.lock"
  [[ -f "$lock_file" && ! -L "$lock_file" ]] || die 'canonical baseline lock is missing or unsafe.'
  exec {current_fd}<"$lock_file" || die 'canonical baseline lock cannot be opened safely.'
  current_fd_path="/proc/${BASHPID}/fd/${current_fd}"
  current_metadata="$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "$current_fd_path")"
  current_digest="$(sha256sum -- "$current_fd_path" | awk '{ print $1 }')"
  [[ "$(readlink -f -- "$current_fd_path")" == "${baselines_root}/baseline.lock" && "$current_metadata" == "${owner_uid}:${group_gid}:640:1:regular file" && "$current_digest" == "$expected_current_sha" ]] || die 'canonical baseline lock differs from its explicit binding before publication.'
  exec {current_fd}<&-
  baseline_temp_path="$(mktemp "${baseline_dir_fd_path}/.baseline.lock.XXXXXX")" || die 'cannot create a private baseline receipt candidate.'
  baseline_temp_name="${baseline_temp_path##*/}"
  [[ "$baseline_temp_name" =~ ^\.baseline\.lock\.[A-Za-z0-9]+$ && -f "${baseline_dir_fd_path}/${baseline_temp_name}" && ! -L "${baseline_dir_fd_path}/${baseline_temp_name}" ]] || die 'baseline receipt candidate is unsafe.'
  exec {baseline_temp_fd}<>"${baseline_dir_fd_path}/${baseline_temp_name}" || die 'baseline receipt candidate cannot be opened safely.'
  baseline_temp_fd_path="/proc/${BASHPID}/fd/${baseline_temp_fd}"
  baseline_temp_identity="$(stat -L -c '%d:%i' -- "$baseline_temp_fd_path")"
  "$writer" "$@" >&${baseline_temp_fd}
  sync -- "$baseline_temp_fd_path"
  baseline_temp_digest="$(sha256sum -- "$baseline_temp_fd_path" | awk '{ print $1 }')"
  [[ "$baseline_temp_digest" == "$expected_next_sha" ]] || die 'baseline receipt candidate differs from its explicit binding.'
  chown --dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "$baseline_temp_fd_path"; chmod 0640 "$baseline_temp_fd_path"; sync -- "$baseline_temp_fd_path"
  [[ -f "${baseline_dir_fd_path}/${baseline_temp_name}" && ! -L "${baseline_dir_fd_path}/${baseline_temp_name}" && "$(stat -c '%d:%i' -- "${baseline_dir_fd_path}/${baseline_temp_name}")" == "$baseline_temp_identity" && "$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "$baseline_temp_fd_path")" == "${owner_uid}:${group_gid}:640:1:regular file" && "$(sha256sum -- "$baseline_temp_fd_path" | awk '{ print $1 }')" == "$baseline_temp_digest" && "$(stat -c '%d:%i' -- "$baselines_root")" == "$baseline_dir_identity" ]] || die 'baseline receipt candidate or directory changed before publication.'
  mv --no-target-directory -- "${baseline_dir_fd_path}/${baseline_temp_name}" "$lock_file"
  [[ -f "$lock_file" && ! -L "$lock_file" && "$(stat -c '%d:%i' -- "$lock_file")" == "$baseline_temp_identity" && "$(LC_ALL=C stat -c '%u:%g:%a:%h:%F' -- "$lock_file")" == "${owner_uid}:${group_gid}:640:1:regular file" && "$(sha256sum -- "$lock_file" | awk '{ print $1 }')" == "$expected_next_sha" ]] || die 'published baseline receipt differs from the verified candidate.'
  baseline_temp_name=''; baseline_temp_path=''; exec {baseline_temp_fd}>&-; baseline_temp_fd=''; sync -- "$baseline_dir_fd_path"; exec {baseline_dir_fd}>&-; baseline_dir_fd=''
}

canonical_adoption_receipt() {
  local generated_at="$1" foundation_ref="$2" foundation_id="$3" target_ref="$4" target_id="$5" foundation_commit
  foundation_commit="$(baseline_lock_value "$baseline_lock_contents" FOUNDATION_MAIN_COMMIT)" || die 'bound baseline lock has no unique foundation commit.'
  [[ "$foundation_commit" =~ ^[0-9a-f]{40}$ ]] || die 'bound baseline lock foundation commit is invalid.'
  printf '%s\n' "GENERATED_AT=${generated_at}" "FORGE_ADMIN_REF=${FORGE_ADMIN_REF}" "FORGE_ADMIN_COMMIT=${FORGE_ADMIN_COMMIT}" "FOUNDATION_REPOSITORY=${DELIVERY_ROOT}/baselines/forge-admin-foundation.git" "FOUNDATION_MAIN_COMMIT=${foundation_commit}" "DSH_GIT_REF=${DSH_GIT_REF}" "DSH_COMMIT=${DSH_COMMIT}" "DSH_VERSION=${DSH_VERSION}" "HARNESS_FOUNDATION_IMAGE=${foundation_ref}" "HARNESS_FOUNDATION_IMAGE_ID=${foundation_id}" "HARNESS_IMAGE=${target_ref}" "HARNESS_IMAGE_ID=${target_id}" "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" "SFTPGO_REF=${SFTPGO_REF}" "SFTPGO_COMMIT=${SFTPGO_COMMIT}" "SFTPGO_IMAGE=${SFTPGO_IMAGE}" "SFTPGO_IMAGE_ID=${SFTPGO_IMAGE_ID}" "SFTPGO_ROOTFS_FINGERPRINT=${SFTPGO_ROOTFS_FINGERPRINT}" "SHARED_SERVICES_ENV_FILE=${SHARED_SERVICES_ENV_FILE}"
}

write_baseline_backup() { cat -- "$1"; }
write_adoption_receipt() { printf '%s\n' "$adoption_receipt_contents"; }

require_adoption_transition_path() {
  local transition_file="$1" transition_root
  [[ "$transition_file" == "${DELIVERY_ROOT}/platform-backups/"vpn78-internal-test-*/baseline-lock-transition ]] || die 'adoption transition path is outside the bounded vpn78 backup root.'
  transition_root="${transition_file%/baseline-lock-transition}"
  [[ -d "$transition_root" && ! -L "$transition_root" && "$(readlink -f -- "$transition_root")" == "$transition_root" && "$(LC_ALL=C stat -L -c '%u:%g:%a:%F' -- "$transition_root")" == '0:0:700:directory' ]] || die 'adoption transition root is unsafe.'
}

read_adoption_transition_sha() {
  local transition_file="$1" transition_fd transition_fd_path metadata bytes value
  require_adoption_transition_path "$transition_file"
  [[ -f "$transition_file" && ! -L "$transition_file" ]] || die 'adoption transition is missing or unsafe.'
  exec {transition_fd}<"$transition_file" || die 'adoption transition cannot be opened safely.'
  transition_fd_path="/proc/${BASHPID}/fd/${transition_fd}"
  metadata="$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "$transition_fd_path")"; bytes="$(stat -L -c '%s' -- "$transition_fd_path")"
  [[ "$(readlink -f -- "$transition_fd_path")" == "$transition_file" && "$metadata" == '0:0:600:1:regular file' && "$bytes" == 65 ]] || die 'adoption transition changed while it was opened.'
  value="$(cat <&${transition_fd})"; exec {transition_fd}<&-
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die 'adoption transition SHA-256 is invalid.'
  printf '%s\n' "$value"
}

write_or_validate_adoption_transition() {
  local transition_file="$1" next_sha="$2" transition_root candidate candidate_name candidate_fd candidate_fd_path candidate_metadata candidate_sha
  require_sha256 "$next_sha"; require_adoption_transition_path "$transition_file"
  if [[ -e "$transition_file" || -L "$transition_file" ]]; then
    [[ "$(read_adoption_transition_sha "$transition_file")" == "$next_sha" ]] || die 'existing adoption transition differs from the exact next baseline SHA-256.'
    return 0
  fi
  transition_root="${transition_file%/baseline-lock-transition}"
  candidate="$(mktemp "${transition_root}/.baseline-lock-transition.XXXXXX")" || die 'cannot create a private adoption transition candidate.'
  candidate_name="${candidate##*/}"
  [[ "$candidate_name" =~ ^\.baseline-lock-transition\.[A-Za-z0-9]+$ && -f "$candidate" && ! -L "$candidate" ]] || die 'adoption transition candidate is unsafe.'
  exec {candidate_fd}<>"$candidate" || die 'adoption transition candidate cannot be opened safely.'
  candidate_fd_path="/proc/${BASHPID}/fd/${candidate_fd}"
  printf '%s\n' "$next_sha" >&${candidate_fd}; sync -- "$candidate_fd_path"; chown --dereference 0:0 "$candidate_fd_path"; chmod 0600 "$candidate_fd_path"; sync -- "$candidate_fd_path"
  candidate_metadata="$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "$candidate_fd_path")"; candidate_sha="$(sha256sum -- "$candidate_fd_path" | awk '{ print $1 }')"
  [[ "$candidate_metadata" == '0:0:600:1:regular file' && "$(stat -L -c '%s' -- "$candidate_fd_path")" == 65 && "$(cat -- "$candidate_fd_path")" == "$next_sha" && "$candidate_sha" =~ ^[0-9a-f]{64}$ ]] || die 'adoption transition candidate differs from its exact binding.'
  exec {candidate_fd}>&-
  mv --no-target-directory -- "$candidate" "$transition_file"; sync -- "$transition_root"
  [[ "$(read_adoption_transition_sha "$transition_file")" == "$next_sha" ]] || die 'published adoption transition differs from its exact binding.'
}

adopt_verified_images() {
  local expected_current="$1" foundation_ref="$2" foundation_id="$3" target_ref="$4" target_id="$5" transition_file="$6" generated_at next_sha persisted_foundation persisted_target
  require_sha256 "$expected_current"; [[ "$foundation_id" =~ ^sha256:[0-9a-f]{64}$ && "$target_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'adoption image ID is invalid.'
  [[ "$foundation_ref" == "$HARNESS_FOUNDATION_IMAGE" && "$target_ref" == "$HARNESS_IMAGE" ]] || die 'adoption image references differ from configured Harness references.'
  read_bound_baseline_lock "$expected_current"
  verify_harness_foundation_image "$foundation_ref" "$foundation_id" >/dev/null
  [[ "$FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID" == "$foundation_id" ]] || die 'adoption foundation image verification differs from its binding.'
  verify_target_harness_image "$target_ref" "$foundation_id" >/dev/null
  [[ "$FORGE_VERIFIED_HARNESS_IMAGE_ID" == "$target_id" ]] || die 'adoption target image verification differs from its binding.'
  generated_at="$(date --iso-8601=seconds)"; adoption_receipt_contents="$(canonical_adoption_receipt "$generated_at" "$foundation_ref" "$foundation_id" "$target_ref" "$target_id")"
  next_sha="$(printf '%s\n' "$adoption_receipt_contents" | sha256sum | awk '{ print $1 }')"; require_sha256 "$next_sha"
  write_or_validate_adoption_transition "$transition_file" "$next_sha"
  publish_bound_baseline_lock "$expected_current" "$next_sha" write_adoption_receipt
  persisted_foundation="$(resolve_configured_harness_foundation_image_id)"; persisted_target="$(resolve_configured_harness_image_id)"
  [[ "$persisted_foundation" == "$foundation_id" && "$persisted_target" == "$target_id" ]] || die 'adoption resolver readback differs from verified image bindings.'
  printf '%s\n' "$next_sha"
}

restore_baseline_receipt() {
  local expected_current="$1" backup_file="$2" backup_sha="$3"
  require_sha256 "$expected_current"; require_sha256 "$backup_sha"
  [[ "$backup_file" == "${DELIVERY_ROOT}/platform-backups/"vpn78-internal-test-*/baseline.lock || "$backup_file" == "${DELIVERY_ROOT}/platform-backups/"vpn78-rollback-safety-*/baseline.lock ]] || die 'baseline restore backup path is outside the bounded vpn78 backup roots.'
  [[ -f "$backup_file" && ! -L "$backup_file" && "$(stat -c '%u:%g:%a:%h' -- "$backup_file")" == '0:0:600:1' ]] || die 'baseline restore backup is unsafe.'
  [[ "$(sha256sum -- "$backup_file" | awk '{ print $1 }')" == "$backup_sha" ]] || die 'baseline restore backup differs from its explicit binding.'
  publish_bound_baseline_lock "$expected_current" "$backup_sha" write_baseline_backup "$backup_file"
  [[ "$(sha256sum "${DELIVERY_ROOT}/baselines/baseline.lock" | awk '{ print $1 }')" == "$backup_sha" ]] || die 'baseline restore readback differs from its backup SHA-256.'
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    --adopt-verified-images)
      [[ $# == 13 && "$2" == --expected-current-lock-sha256 && "$4" == --foundation-image && "$6" == --foundation-image-id && "$8" == --target-image && "${10}" == --target-image-id && "${12}" == --transition-file ]] || die 'usage: sync-baseline.sh --adopt-verified-images --expected-current-lock-sha256 SHA256 --foundation-image REF --foundation-image-id SHA256_ID --target-image REF --target-image-id SHA256_ID --transition-file PATH'
      adopt_verified_images "$3" "$5" "$7" "$9" "${11}" "${13}"; exit 0 ;;
    --restore-baseline-lock)
      [[ $# == 7 && "$2" == --expected-current-lock-sha256 && "$4" == --backup-file && "$6" == --backup-sha256 ]] || die 'usage: sync-baseline.sh --restore-baseline-lock --expected-current-lock-sha256 SHA256 --backup-file PATH --backup-sha256 SHA256'
      restore_baseline_receipt "$3" "$5" "$7"; exit 0 ;;
    *) die 'usage: sync-baseline.sh [--adopt-verified-images ...|--restore-baseline-lock ...]' ;;
  esac
fi

remote_ref_commit() {
  local repository="$1"
  local ref="$2"
  local commit

  commit="$(git ls-remote "${repository}" "refs/tags/${ref}^{}" | awk 'NR == 1 {print $1}')"
  if [[ -z "${commit}" ]]; then
    commit="$(git ls-remote "${repository}" "refs/tags/${ref}" | awk 'NR == 1 {print $1}')"
  fi
  if [[ -z "${commit}" ]]; then
    commit="$(git ls-remote "${repository}" "refs/heads/${ref}" | awk 'NR == 1 {print $1}')"
  fi
  [[ -n "${commit}" ]] || die "Upstream ref does not exist: ${repository} ${ref}"
  printf '%s' "${commit}"
}

forge_remote_commit="$(remote_ref_commit "${FORGE_ADMIN_REPOSITORY}" "${FORGE_ADMIN_REF}")"
[[ "${forge_remote_commit}" == "${FORGE_ADMIN_COMMIT}" ]] \
  || die "Forge Admin ref moved: expected ${FORGE_ADMIN_COMMIT}, got ${forge_remote_commit}. Review before updating the lock."

dsh_remote_commit="$(remote_ref_commit "${DSH_REPOSITORY}" "${DSH_GIT_REF}")"
[[ "${dsh_remote_commit}" == "${DSH_COMMIT}" ]] \
  || die "DeepSeek Harness ref moved: expected ${DSH_COMMIT}, got ${dsh_remote_commit}. Review before updating the lock."

sftpgo_remote_commit="$(remote_ref_commit "${SFTPGO_REPOSITORY}" "${SFTPGO_REF}")"
[[ "${sftpgo_remote_commit}" == "${SFTPGO_COMMIT}" ]] \
  || die "SFTPGo ref moved: expected ${SFTPGO_COMMIT}, got ${sftpgo_remote_commit}. Review before updating the lock."
[[ "${SFTPGO_IMAGE}" == *@sha256:* ]] \
  || die "SFTPGO_IMAGE must be pinned by an immutable manifest digest."
[[ "${SFTPGO_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "SFTPGO_IMAGE_ID must be a sha256 image content ID."
[[ "${SFTPGO_ROOTFS_FINGERPRINT}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "SFTPGO_ROOTFS_FINGERPRINT must be a sha256 root filesystem fingerprint."

mirror_path="${DELIVERY_ROOT}/baselines/forge-admin.git"
if [[ -d "${mirror_path}" ]]; then
  configured_url="$(git --git-dir="${mirror_path}" remote get-url origin)"
  [[ "${configured_url}" == "${FORGE_ADMIN_REPOSITORY}" ]] \
    || die "Existing mirror points to an unexpected repository: ${configured_url}"
  run_as_owner git --git-dir="${mirror_path}" fetch --prune origin \
    '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
else
  run_as_owner git clone --mirror "${FORGE_ADMIN_REPOSITORY}" "${mirror_path}"
fi

local_forge_commit="$(git --git-dir="${mirror_path}" rev-parse "${FORGE_ADMIN_REF}^{commit}")"
[[ "${local_forge_commit}" == "${FORGE_ADMIN_COMMIT}" ]] \
  || die "Local Forge Admin mirror failed verification: ${local_forge_commit}"

# The public mirror remains an exact, read-only representation of upstream.
# The internal foundation repository is initialized only once and thereafter
# advances exclusively through promote-foundation.sh.
foundation_path="${DELIVERY_ROOT}/baselines/forge-admin-foundation.git"
if [[ -d "${foundation_path}" ]]; then
  git --git-dir="${foundation_path}" rev-parse --is-bare-repository | grep -Fxq true \
    || die "Foundation path is not a bare Git repository: ${foundation_path}"
  foundation_commit="$(git --git-dir="${foundation_path}" rev-parse 'refs/heads/main^{commit}')"
else
  run_as_owner git init --bare --initial-branch=main "${foundation_path}"
  run_as_owner git --git-dir="${foundation_path}" fetch --no-tags "${mirror_path}" \
    "${FORGE_ADMIN_COMMIT}:refs/heads/main"
  run_as_owner git --git-dir="${foundation_path}" symbolic-ref HEAD refs/heads/main
  run_as_owner git --git-dir="${foundation_path}" remote add upstream "${FORGE_ADMIN_REPOSITORY}"
  run_as_owner git --git-dir="${foundation_path}" config receive.denyNonFastforwards true
  bootstrap_tag="foundation-upstream-${FORGE_ADMIN_REF//\//-}"
  run_as_owner git --git-dir="${foundation_path}" update-ref \
    "refs/tags/${bootstrap_tag}" "${FORGE_ADMIN_COMMIT}"
  foundation_commit="${FORGE_ADMIN_COMMIT}"
  log "Initialized internal Forge Admin foundation at ${foundation_commit}."
fi

log "Building loopback-safe Harness foundation ${HARNESS_FOUNDATION_IMAGE}."
docker build \
  --build-arg "HARNESS_NODE_BASE_IMAGE=${HARNESS_NODE_BASE_IMAGE}" \
  --build-arg "HARNESS_MAVEN_BASE_IMAGE=${HARNESS_MAVEN_BASE_IMAGE}" \
  --build-arg "DSH_VERSION=${DSH_VERSION}" \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
  --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" \
  --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
  --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" \
  --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_FOUNDATION_IMAGE_REVISION}" \
  --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
  --build-arg 'HARNESS_RUNTIME_PROFILE=loopback-safe' \
  --tag "${HARNESS_FOUNDATION_IMAGE}" \
  --file "${REPO_ROOT}/docker/harness/Dockerfile" \
  "${REPO_ROOT}"

foundation_image_id="$(docker image inspect --format '{{.Id}}' "${HARNESS_FOUNDATION_IMAGE}")"
[[ "${foundation_image_id}" == sha256:* ]] \
  || die "Harness foundation has no immutable image ID."
verify_harness_foundation_image "${HARNESS_FOUNDATION_IMAGE}" "${foundation_image_id}" >/dev/null
foundation_image_id="${FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID}"
foundation_image_build_ref="$(resolve_local_docker_build_ref "${HARNESS_FOUNDATION_IMAGE}" "${foundation_image_id}")"
# Runtime defaults may be immutable IDs; Docker build requires a named output.
if [[ "${HARNESS_IMAGE}" == sha256:* || "${HARNESS_IMAGE}" == *@sha256:* ]]; then
  HARNESS_IMAGE="forge-delivery/harness:build-${HARNESS_IMAGE_REVISION}"
fi
log "Building trusted-host Harness target ${HARNESS_IMAGE} from ${foundation_image_id}."
docker build \
  --build-arg "HARNESS_BASE_IMAGE=${foundation_image_build_ref}" \
  --build-arg "HARNESS_BASE_IMAGE_ID=${foundation_image_id}" \
  --build-arg "DSH_VERSION=${DSH_VERSION}" \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  --build-arg 'INSTALL_DOCUMENT_DEPENDENCIES=false' \
  --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
  --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" \
  --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
  --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" \
  --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" \
  --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
  --build-arg "HARNESS_RUNTIME_PROFILE=${HARNESS_RUNTIME_PROFILE}" \
  --tag "${HARNESS_IMAGE}" \
  --file "${REPO_ROOT}/docker/harness/Dockerfile.overlay" \
  "${REPO_ROOT}"
# Publish a shallow image on every full build; preserve the assembled runtime
# Config and filesystem instead of accumulating the previous release's layers.
require_command python3
assembled_image_id="$(docker image inspect --format '{{.Id}}' "${HARNESS_IMAGE}")"
compaction_resource="${DELIVERY_ROOT}/build/harness-compaction-${assembled_image_id#sha256:}"
if [[ -f "${compaction_resource}/result.json" ]]; then
  python3 "${REPO_ROOT}/scripts/compact-harness-image.py" --register-only --tag "${HARNESS_IMAGE}" \
    --resource "${compaction_resource}" --foundation-image "${foundation_image_id}" \
    --receipt-root "${DELIVERY_ROOT}/baselines/harness-compactions"
else
  python3 "${REPO_ROOT}/scripts/compact-harness-image.py" \
    --source-image "${assembled_image_id}" --tag "${HARNESS_IMAGE}" \
    --resource "${compaction_resource}" --foundation-image "${foundation_image_id}" \
    --receipt-root "${DELIVERY_ROOT}/baselines/harness-compactions"
fi
verify_target_harness_image "${HARNESS_IMAGE}" "${foundation_image_id}"
harness_image_id="${FORGE_VERIFIED_HARNESS_IMAGE_ID}"
[[ "$(docker image inspect --format '{{.Id}}' "${HARNESS_IMAGE}")" == "${harness_image_id}" ]] \
  || die "Harness target tag changed before baseline persistence."
generated_at="$(date --iso-8601=seconds)"

baselines_root="${DELIVERY_ROOT}/baselines"
[[ -d "${baselines_root}" && ! -L "${baselines_root}" \
    && "$(readlink -f -- "${baselines_root}")" == "${baselines_root}" ]] \
  || die "Harness baseline directory is missing, linked, or non-canonical: ${baselines_root}"
delivery_owner_uid="$(id -u "${DELIVERY_OWNER}")" \
  || die "Configured delivery owner does not exist: ${DELIVERY_OWNER}"
delivery_group_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
[[ "${delivery_group_gid}" =~ ^[0-9]+$ ]] \
  || die "Configured delivery group does not exist: ${DELIVERY_GROUP}"
baselines_metadata="$(LC_ALL=C stat -c '%u:%g:%a:%F' -- "${baselines_root}")"
[[ "${baselines_metadata}" == "${delivery_owner_uid}:${delivery_group_gid}:750:directory" ]] \
  || die "Harness baseline directory ownership, mode, or type is invalid."

exec {baseline_dir_fd}<"${baselines_root}" \
  || die "Harness baseline directory cannot be opened safely."
baseline_dir_fd_path="/proc/$$/fd/${baseline_dir_fd}"
baseline_dir_identity="$(stat -L -c '%d:%i' -- "${baseline_dir_fd_path}")"
[[ "$(readlink -f -- "${baseline_dir_fd_path}")" == "${baselines_root}" \
    && "$(stat -c '%d:%i' -- "${baselines_root}")" == "${baseline_dir_identity}" \
    && "$(LC_ALL=C stat -L -c '%u:%g:%a:%F' -- "${baseline_dir_fd_path}")" == "${baselines_metadata}" ]] \
  || die "Harness baseline directory changed while it was opened."

lock_file="${baseline_dir_fd_path}/baseline.lock"
if [[ -e "${lock_file}" || -L "${lock_file}" ]]; then
  [[ -f "${lock_file}" && ! -L "${lock_file}" \
      && "$(LC_ALL=C stat -c '%u:%g:%a:%h:%F' -- "${lock_file}")" \
        == "${delivery_owner_uid}:${delivery_group_gid}:640:1:regular file" ]] \
    || die "Existing Harness baseline receipt is linked, non-regular, multiply linked, or has unsafe metadata."
fi

baseline_temp_path="$(mktemp "${baseline_dir_fd_path}/.baseline.lock.XXXXXX")" \
  || die "Cannot create a private Harness baseline receipt candidate."
baseline_temp_name="${baseline_temp_path##*/}"
[[ "${baseline_temp_name}" =~ ^\.baseline\.lock\.[A-Za-z0-9]+$ \
    && -f "${baseline_dir_fd_path}/${baseline_temp_name}" \
    && ! -L "${baseline_dir_fd_path}/${baseline_temp_name}" ]] \
  || die "Harness baseline receipt candidate is not a fresh regular no-follow file."
exec {baseline_temp_fd}<>"${baseline_dir_fd_path}/${baseline_temp_name}" \
  || die "Harness baseline receipt candidate cannot be opened safely."
baseline_temp_fd_path="/proc/$$/fd/${baseline_temp_fd}"
baseline_temp_identity="$(stat -L -c '%d:%i' -- "${baseline_temp_fd_path}")"
[[ "$(readlink -f -- "${baseline_temp_fd_path}")" == "${baselines_root}/${baseline_temp_name}" \
    && "$(stat -c '%d:%i' -- "${baseline_dir_fd_path}/${baseline_temp_name}")" == "${baseline_temp_identity}" \
    && "$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "${baseline_temp_fd_path}")" \
      == "0:0:600:1:regular file" ]] \
  || die "Harness baseline receipt candidate changed while it was opened."

printf '%s\n' \
  "GENERATED_AT=${generated_at}" \
  "FORGE_ADMIN_REF=${FORGE_ADMIN_REF}" \
  "FORGE_ADMIN_COMMIT=${FORGE_ADMIN_COMMIT}" \
  "FOUNDATION_REPOSITORY=${foundation_path}" \
  "FOUNDATION_MAIN_COMMIT=${foundation_commit}" \
  "DSH_GIT_REF=${DSH_GIT_REF}" \
  "DSH_COMMIT=${DSH_COMMIT}" \
  "DSH_VERSION=${DSH_VERSION}" \
  "HARNESS_FOUNDATION_IMAGE=${HARNESS_FOUNDATION_IMAGE}" \
  "HARNESS_FOUNDATION_IMAGE_ID=${foundation_image_id}" \
  "HARNESS_IMAGE=${HARNESS_IMAGE}" \
  "HARNESS_IMAGE_ID=${harness_image_id}" \
  "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" \
  "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
  "SFTPGO_REF=${SFTPGO_REF}" \
  "SFTPGO_COMMIT=${SFTPGO_COMMIT}" \
  "SFTPGO_IMAGE=${SFTPGO_IMAGE}" \
  "SFTPGO_IMAGE_ID=${SFTPGO_IMAGE_ID}" \
  "SFTPGO_ROOTFS_FINGERPRINT=${SFTPGO_ROOTFS_FINGERPRINT}" \
  "SHARED_SERVICES_ENV_FILE=${SHARED_SERVICES_ENV_FILE}" >&${baseline_temp_fd}
sync -- "${baseline_temp_fd_path}"
baseline_temp_digest="$(sha256sum -- "${baseline_temp_fd_path}" | awk '{print $1}')"
[[ "${baseline_temp_digest}" =~ ^[0-9a-f]{64}$ ]] \
  || die "Harness baseline receipt candidate has no valid SHA-256 digest."
chown --dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${baseline_temp_fd_path}"
chmod 0640 "${baseline_temp_fd_path}"
sync -- "${baseline_temp_fd_path}"
[[ -f "${baseline_dir_fd_path}/${baseline_temp_name}" \
    && ! -L "${baseline_dir_fd_path}/${baseline_temp_name}" \
    && "$(stat -c '%d:%i' -- "${baseline_dir_fd_path}/${baseline_temp_name}")" == "${baseline_temp_identity}" \
    && "$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "${baseline_temp_fd_path}")" \
      == "${delivery_owner_uid}:${delivery_group_gid}:640:1:regular file" \
    && "$(sha256sum -- "${baseline_temp_fd_path}" | awk '{print $1}')" == "${baseline_temp_digest}" \
    && "$(readlink -f -- "${baseline_dir_fd_path}")" == "${baselines_root}" \
    && "$(stat -c '%d:%i' -- "${baselines_root}")" == "${baseline_dir_identity}" ]] \
  || die "Harness baseline receipt candidate or directory changed before publication."
mv --no-target-directory -- \
  "${baseline_dir_fd_path}/${baseline_temp_name}" \
  "${lock_file}"
[[ -f "${lock_file}" && ! -L "${lock_file}" \
    && "$(stat -c '%d:%i' -- "${lock_file}")" == "${baseline_temp_identity}" \
    && "$(LC_ALL=C stat -c '%u:%g:%a:%h:%F' -- "${lock_file}")" \
      == "${delivery_owner_uid}:${delivery_group_gid}:640:1:regular file" \
    && "$(sha256sum -- "${lock_file}" | awk '{print $1}')" == "${baseline_temp_digest}" ]] \
  || die "Published Harness baseline receipt differs from the verified candidate."
baseline_temp_name=''
baseline_temp_path=''
sync -- "${baseline_dir_fd_path}"
persisted_harness_image_id="$(resolve_configured_harness_image_id)"
[[ "${persisted_harness_image_id}" == "${harness_image_id}" ]] \
  || die "Persisted Harness target identity differs from the fully verified candidate."
exec {baseline_temp_fd}>&-
baseline_temp_fd=''
exec {baseline_dir_fd}>&-
baseline_dir_fd=''

log "Verified Forge Admin ${FORGE_ADMIN_REF} at ${FORGE_ADMIN_COMMIT}."
log "Internal foundation main is ${foundation_commit}; baseline sync never resets it."
log "Verified DeepSeek Harness ${DSH_GIT_REF} at ${DSH_COMMIT}."
log "Verified SFTPGo ${SFTPGO_REF} at ${SFTPGO_COMMIT}; its runtime image is digest-pinned."
warn "DeepSeek Harness is a developer preview. Promote upgrades only after regression tests."
