#!/usr/bin/env bash

set -Eeuo pipefail

COMMON_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${COMMON_DIR}/../.." && pwd -P)"

log() {
  printf '[forge-delivery] %s\n' "$*"
}

warn() {
  printf '[forge-delivery] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[forge-delivery] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

# Docker bind-mounted secrets retain host ownership. Match the non-root
# Harness primary group instead of silently leaving DeepSeek unreadable.
repair_harness_deepseek_secret_access() {
  [[ -n "${DEEPSEEK_KEY_FILE:-}" ]] || return 0
  [[ -e "${DEEPSEEK_KEY_FILE}" || -L "${DEEPSEEK_KEY_FILE}" ]] || return 0
  [[ "${EUID}" -eq 0 ]] || die "DeepSeek secret ownership repair requires the root installation path."
  require_command python3
  local harness_gid
  harness_gid="$(getent group "${DELIVERY_GROUP}" | cut -d: -f3)"
  [[ "${harness_gid}" =~ ^[0-9]+$ ]] || die "Harness delivery group is unavailable."
  python3 - "${DELIVERY_ROOT}" "${DEEPSEEK_KEY_FILE}" "${harness_gid}" <<'PY'
import os,stat,sys
from pathlib import Path
root=Path(sys.argv[1])/'secrets';key=Path(sys.argv[2]);gid=int(sys.argv[3])
if not key.is_absolute() or root.is_symlink() or key.parent.resolve()!=root.resolve():
    raise SystemExit('DeepSeek secret must be a direct protected file under DELIVERY_ROOT/secrets.')
fd=os.open(key,os.O_RDONLY|os.O_NOFOLLOW)
try:
    metadata=os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=0:
        raise SystemExit('DeepSeek secret identity is invalid; no ownership changed.')
    os.fchown(fd,0,gid)
    os.fchmod(fd,0o640)
finally:
    os.close(fd)
PY
}

run_as_delivery_owner() {
  local owner_uid configured_owner_uid expected_owner_uid current_uid
  : "${DELIVERY_OWNER:?DELIVERY_OWNER is required}"
  current_uid="$(id -u)"
  owner_uid="$(id -u "${DELIVERY_OWNER}" 2>/dev/null || true)"
  configured_owner_uid="${DELIVERY_OWNER_UID:-}"
  if [[ -n "${configured_owner_uid}" ]]; then
    [[ "${configured_owner_uid}" =~ ^[0-9]+$ ]] \
      || die "Configured delivery owner UID is invalid: ${configured_owner_uid}"
    if [[ -n "${owner_uid}" && "${owner_uid}" != "${configured_owner_uid}" ]]; then
      die "Delivery owner name and numeric UID do not match: ${DELIVERY_OWNER}"
    fi
  fi
  expected_owner_uid="${configured_owner_uid:-${owner_uid}}"
  # Host and container account names may differ even when the Manager runs with
  # the exact host UID/GID. A legacy non-root Manager may omit the explicit UID;
  # only its own current identity is accepted as the compatibility fallback.
  if [[ -z "${expected_owner_uid}" && "${EUID}" -ne 0 ]]; then
    expected_owner_uid="${current_uid}"
  fi
  [[ "${expected_owner_uid}" =~ ^[0-9]+$ ]] \
    || die "Delivery owner numeric identity is unavailable: ${DELIVERY_OWNER}"
  if [[ "${current_uid}" == "${expected_owner_uid}" ]]; then
    "$@"
    return
  fi
  if [[ "${EUID}" -eq 0 ]]; then
    [[ -n "${owner_uid}" ]] || die "Delivery owner does not exist: ${DELIVERY_OWNER}"
    require_command runuser
    runuser -u "${DELIVERY_OWNER}" -- "$@"
    return
  fi
  die "This operation must run as root or the delivery owner ${DELIVERY_OWNER}."
}

run_project_git_command() {
  local readonly_mode="$1"
  shift
  require_command env
  local -a git_environment=(
    env
    -u GIT_DIR
    -u GIT_WORK_TREE
    -u GIT_INDEX_FILE
    -u GIT_OBJECT_DIRECTORY
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES
    -u GIT_COMMON_DIR
    -u GIT_QUARANTINE_PATH
    -u GIT_OPTIONAL_LOCKS
    -u GIT_SSH_COMMAND
  )
  if [[ "${readonly_mode}" == true ]]; then
    git_environment+=(GIT_OPTIONAL_LOCKS=0)
  fi
  if [[ -n "${GIT_SSH_COMMAND:-}" ]]; then
    git_environment+=("GIT_SSH_COMMAND=${GIT_SSH_COMMAND}")
  fi
  run_as_delivery_owner "${git_environment[@]}" git "$@"
}

project_git() {
  local workspace="$1"
  shift
  [[ -d "${workspace}" && ! -L "${workspace}" \
    && -d "${workspace}/.git" && ! -L "${workspace}/.git" ]] \
    || die "Managed Git workspace is missing or unsafe: ${workspace}"

  run_project_git_command false -C "${workspace}" "$@"
}

project_git_readonly() {
  local workspace="$1"
  shift
  [[ -d "${workspace}" && ! -L "${workspace}" \
    && -d "${workspace}/.git" && ! -L "${workspace}/.git" ]] \
    || die "Managed Git workspace is missing or unsafe: ${workspace}"

  run_project_git_command true -C "${workspace}" "$@"
}

prepare_delivery_lock() {
  local lock_path="$1" lock_parent expected_owner_uid expected_group_gid
  require_command dirname
  require_command stat
  lock_parent="$(dirname -- "${lock_path}")"
  [[ -d "${lock_parent}" && ! -L "${lock_parent}" && ! -L "${lock_path}" ]] \
    || die "Delivery lock path is missing or unsafe: ${lock_path}"
  if [[ -e "${lock_path}" ]]; then
    [[ -f "${lock_path}" && "$(stat -c '%h' -- "${lock_path}")" == 1 ]] \
      || die "Delivery lock must be a single-link regular file: ${lock_path}"
  fi
  (umask 0007; : >>"${lock_path}")
  [[ -f "${lock_path}" && ! -L "${lock_path}" \
    && "$(stat -c '%h' -- "${lock_path}")" == 1 ]] \
    || die "Delivery lock changed while it was prepared: ${lock_path}"
  expected_owner_uid="${DELIVERY_OWNER_UID:-}"
  if [[ -z "${expected_owner_uid}" ]]; then
    expected_owner_uid="$(id -u "${DELIVERY_OWNER}" 2>/dev/null || true)"
  fi
  if [[ -z "${expected_owner_uid}" && "${EUID}" -ne 0 ]]; then
    expected_owner_uid="$(id -u)"
  fi
  [[ "${expected_owner_uid}" =~ ^[0-9]+$ ]] \
    || die "Delivery owner numeric identity is unavailable: ${DELIVERY_OWNER}"

  expected_group_gid="${DELIVERY_GROUP_GID:-}"
  if [[ -z "${expected_group_gid}" ]]; then
    expected_group_gid="$(getent group "${DELIVERY_GROUP}" 2>/dev/null \
      | awk -F: 'NR == 1 {print $3}' || true)"
  fi
  if [[ -z "${expected_group_gid}" && "${EUID}" -ne 0 ]]; then
    expected_group_gid="$(id -g)"
  fi
  [[ "${expected_group_gid}" =~ ^[0-9]+$ ]] \
    || die "Delivery group numeric identity is unavailable: ${DELIVERY_GROUP}"

  if [[ "${EUID}" -eq 0 ]]; then
    chown --no-dereference "${expected_owner_uid}:${expected_group_gid}" "${lock_path}"
  fi
  chmod 0660 -- "${lock_path}"
  # User/group names differ across host and container namespaces even when their numeric
  # identities are the same. The no-link checks above establish the kind; keep every
  # remaining postcondition numeric and namespace-stable.
  [[ "$(stat -c '%u:%g:%a:%h' -- "${lock_path}")" \
      == "${expected_owner_uid}:${expected_group_gid}:660:1" ]] \
    || die "Delivery lock ownership or mode is invalid after preparation: ${lock_path}"
}

assert_taskspace_mutation_fence_committed() {
  local task_root="$1" label="${2:-TaskSpace}"
  local maintenance_root fence task_real maintenance_real fence_real
  local before after before_device before_inode before_links before_size
  local before_mtime before_ctime parsed state epoch

  require_command dd
  require_command jq
  require_command readlink
  require_command stat

  maintenance_root="${task_root}/maintenance"
  fence="${maintenance_root}/proxy-fence.json"
  [[ -d "${task_root}" && ! -L "${task_root}" \
    && -d "${maintenance_root}" && ! -L "${maintenance_root}" \
    && -f "${fence}" && ! -L "${fence}" ]] \
    || die "TaskSpace mutation fence is missing or unsafe (${label})."

  task_real="$(readlink -f -- "${task_root}")" \
    || die "TaskSpace mutation root cannot be resolved (${label})."
  maintenance_real="$(readlink -f -- "${maintenance_root}")" \
    || die "TaskSpace maintenance root cannot be resolved (${label})."
  fence_real="$(readlink -f -- "${fence}")" \
    || die "TaskSpace mutation fence cannot be resolved (${label})."
  [[ "${maintenance_real}" == "${task_real}/maintenance" \
    && "${fence_real}" == "${maintenance_real}/proxy-fence.json" ]] \
    || die "TaskSpace mutation fence escaped its TaskSpace (${label})."

  before="$(stat -c '%d:%i:%h:%s:%Y:%Z' -- "${fence}")" \
    || die "TaskSpace mutation fence cannot be inspected (${label})."
  IFS=: read -r before_device before_inode before_links before_size \
    before_mtime before_ctime <<<"${before}"
  [[ "${before_device}" =~ ^[0-9]+$ && "${before_inode}" =~ ^[0-9]+$ \
    && "${before_links}" == 1 && "${before_size}" =~ ^[0-9]+$ \
    && "${before_size}" -gt 0 && "${before_size}" -le 4096 \
    && "${before_mtime}" =~ ^-?[0-9]+$ && "${before_ctime}" =~ ^-?[0-9]+$ ]] \
    || die "TaskSpace mutation fence is not a bounded single-link regular file (${label})."

  parsed="$(
    dd if="${fence}" iflag=nofollow,count_bytes count=4097 status=none \
      | jq -er 'if (type == "object"
          and (keys | sort) == ["epoch", "schemaVersion", "state"]
          and .schemaVersion == 1
          and (.epoch | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))
          and (.state == "committed" or .state == "maintenance"))
        then [.state, .epoch] | @tsv
        else error("invalid TaskSpace mutation fence") end'
  )" || die "TaskSpace mutation fence has invalid or uncommitted content (${label})."
  after="$(stat -c '%d:%i:%h:%s:%Y:%Z' -- "${fence}")" \
    || die "TaskSpace mutation fence disappeared during admission (${label})."
  [[ "${after}" == "${before}" \
    && -d "${task_root}" && ! -L "${task_root}" \
    && -d "${maintenance_root}" && ! -L "${maintenance_root}" \
    && -f "${fence}" && ! -L "${fence}" \
    && "$(stat -c '%h' -- "${fence}")" == 1 \
    && "$(readlink -f -- "${task_root}")" == "${task_real}" \
    && "$(readlink -f -- "${maintenance_root}")" == "${maintenance_real}" \
    && "$(readlink -f -- "${fence}")" == "${fence_real}" ]] \
    || die "TaskSpace mutation fence changed during admission (${label})."

  IFS=$'\t' read -r state epoch <<<"${parsed}"
  [[ -n "${epoch}" ]] \
    || die "TaskSpace mutation fence epoch is unavailable (${label})."
  [[ "${state}" == committed ]] \
    || die "TaskSpace is owned by an active maintenance recovery; use only its dedicated reconciliation entrypoint (${label})."
}

assert_project_taskspace_mutation_fences_committed() {
  local project_root="$1" label="${2:-project}" taskspaces_root task_root task_id
  local -a task_roots

  taskspaces_root="${project_root}/taskspaces"
  [[ -d "${project_root}" && ! -L "${project_root}" \
    && -d "${taskspaces_root}" && ! -L "${taskspaces_root}" ]] \
    || die "Project TaskSpace root is missing or unsafe (${label})."

  task_roots=("${taskspaces_root}"/*)
  if ((${#task_roots[@]} == 1)) \
      && [[ ! -e "${task_roots[0]}" && ! -L "${task_roots[0]}" ]]; then
    return 0
  fi
  for task_root in "${task_roots[@]}"; do
    [[ -d "${task_root}" && ! -L "${task_root}" ]] \
      || die "Project TaskSpace entry is unsafe (${label}): ${task_root}"
    task_id="$(basename -- "${task_root}")"
    [[ "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ \
      && -f "${task_root}/metadata.json" && ! -L "${task_root}/metadata.json" \
      && -f "${task_root}/task.env" && ! -L "${task_root}/task.env" ]] \
      || die "Project TaskSpace entry is incomplete or has an invalid identity (${label}/${task_id})."
    assert_taskspace_mutation_fence_committed "${task_root}" "${label}/${task_id}"
  done
}

repair_delivery_owned_regular_tree() {
  local managed_root="$1" unsafe_path drift
  require_command chown
  require_command find
  require_command stat
  [[ -d "${managed_root}" && ! -L "${managed_root}" ]] \
    || die "Delivery-owned tree is missing or unsafe: ${managed_root}"
  unsafe_path="$(find "${managed_root}" -xdev -type l -print -quit)"
  [[ -z "${unsafe_path}" ]] \
    || die "Delivery-owned tree contains a symbolic link: ${unsafe_path}"
  unsafe_path="$(find "${managed_root}" -xdev ! -type d ! -type f -print -quit)"
  [[ -z "${unsafe_path}" ]] \
    || die "Delivery-owned tree contains a non-regular node: ${unsafe_path}"
  unsafe_path="$(find "${managed_root}" -xdev -type f ! -links 1 -print -quit)"
  [[ -z "${unsafe_path}" ]] \
    || die "Delivery-owned tree contains a multiply linked file: ${unsafe_path}"
  find "${managed_root}" -xdev \
    \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) \
    -exec chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" {} +
  drift="$(find "${managed_root}" -xdev \
    \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) \
    -print -quit)"
  [[ -z "${drift}" ]] \
    || die "Delivery-owned tree repair did not converge: ${drift}"
}

load_platform_config() {
  local config_file="${PLATFORM_CONFIG:-${REPO_ROOT}/config/platform.env}"
  if [[ ! -f "${config_file}" ]]; then
    config_file="${REPO_ROOT}/config/platform.env.example"
    warn "config/platform.env is absent; using non-secret defaults from platform.env.example"
  fi

  # These repository/owner-managed files are trusted shell-compatible KEY=value files.
  # shellcheck disable=SC1090
  source "${config_file}"
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/config/versions.env"

  : "${DELIVERY_ROOT:?DELIVERY_ROOT is required}"
  : "${DELIVERY_OWNER:?DELIVERY_OWNER is required}"
  : "${DELIVERY_GROUP:?DELIVERY_GROUP is required}"
  : "${DEEPSEEK_KEY_FILE:?DEEPSEEK_KEY_FILE is required}"
  : "${KIMI_KEY_FILE:?KIMI_KEY_FILE is required}"
  : "${SHARED_SERVICES_ENV_FILE:?SHARED_SERVICES_ENV_FILE is required}"
  : "${CONVERSATION_GATEWAY_BIND_ADDRESS:=${DEFAULT_BIND_ADDRESS}}"
  : "${CONVERSATION_GATEWAY_PORT:=13080}"
  : "${CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME:=forge-conversation-control-plane}"
}

# Resolve the persisted Compose identity, preserving pre-identity legacy files.
# A different configured name requires a separately prepared installation, not
# an implicit rename of an existing account/control-plane state directory.
control_plane_compose_project_name() {
  local env_file="$1" configured="${CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME:-forge-conversation-control-plane}" observed
  [[ "${configured}" =~ ^[a-z0-9][a-z0-9_-]{0,127}$ ]] \
    || die "Control-plane Compose project name is invalid."
  if [[ -e "${env_file}" || -L "${env_file}" ]]; then
    [[ -f "${env_file}" && ! -L "${env_file}" ]] || die "Control-plane environment is unsafe."
    observed="$(awk -F= '$1 == "CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME" {count++; sub(/^[^=]*=/, ""); value=$0} END {if (count > 1 || (count == 1 && value == "")) exit 1; if (count == 0) print "forge-conversation-control-plane"; else print value}' "${env_file}")" \
      || die "Control-plane environment has no unambiguous Compose identity."
    [[ "${observed}" == "${configured}" ]] \
      || die "Control-plane Compose identity differs from its persisted configuration; implicit rename is refused."
  fi
  printf '%s\n' "${configured}"
}

validate_slug() {
  local slug="$1"
  [[ "${slug}" =~ ^[a-z][a-z0-9-]{2,31}$ ]] \
    || die "Invalid slug '${slug}'. Use 3-32 lowercase letters, digits, or hyphens; start with a letter."
}

validate_port() {
  local port="$1"
  [[ "${port}" =~ ^[0-9]+$ ]] || die "Port must be numeric: ${port}"
  ((port >= 1024 && port <= 65535)) || die "Port must be between 1024 and 65535: ${port}"
}

port_is_listening() {
  local port="$1"
  ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|[:.])${port}$"
}

require_docker_access() {
  require_command docker
  docker info >/dev/null 2>&1 \
    || die "Docker daemon is not accessible. Run the command through approved sudo access; do not expose the Docker socket."
  docker compose version >/dev/null 2>&1 \
    || die "Docker Compose v2+ is required."
}

resolve_local_docker_build_ref() {
  local requested_ref="$1" expected_image_id="$2" candidate_ref resolved_id
  [[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Docker build parent has no immutable image ID."
  resolved_id="$(docker image inspect --format '{{.Id}}' "${requested_ref}" 2>/dev/null || true)"
  [[ "${resolved_id}" == "${expected_image_id}" ]] \
    || die "Docker build parent reference does not resolve to the reviewed image ID: ${requested_ref}"

  if [[ ! "${requested_ref}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' "${requested_ref}"
    return 0
  fi

  while IFS= read -r candidate_ref; do
    [[ -n "${candidate_ref}" && "${candidate_ref}" != '<none>:<none>' ]] || continue
    resolved_id="$(docker image inspect --format '{{.Id}}' "${candidate_ref}" 2>/dev/null || true)"
    if [[ "${resolved_id}" == "${expected_image_id}" ]]; then
      printf '%s\n' "${candidate_ref}"
      return 0
    fi
  done < <(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "${expected_image_id}" | LC_ALL=C sort)

  die "The reviewed Docker build parent has no local named reference: ${expected_image_id}"
}

acquire_harness_image_upgrade_lock() {
  require_command flock
  require_command readlink
  local lock_path="${DELIVERY_ROOT}/registry/harness-image-upgrade.lock"
  local inherited_fd="${FORGE_HARNESS_IMAGE_LOCK_FD:-}"
  [[ -d "${DELIVERY_ROOT}/registry" && ! -L "${lock_path}" ]] \
    || die "Harness image upgrade lock path is unsafe: ${lock_path}"
  if [[ "${inherited_fd}" =~ ^[0-9]+$ \
    && -e "/proc/$$/fd/${inherited_fd}" \
    && "$(readlink -f "/proc/$$/fd/${inherited_fd}")" == "$(readlink -f "${lock_path}")" ]]; then
    flock --exclusive --nonblock "${inherited_fd}" \
      || die "Inherited Harness image upgrade lock is not held."
    return 0
  fi
  local lock_fd
  prepare_delivery_lock "${lock_path}"
  exec {lock_fd}>>"${lock_path}"
  flock --exclusive --nonblock "${lock_fd}" \
    || die "Another Harness image build or platform cutover is active."
  FORGE_HARNESS_IMAGE_LOCK_FD="${lock_fd}"
  export FORGE_HARNESS_IMAGE_LOCK_FD
}

generate_secret() {
  require_command openssl
  openssl rand -hex 32
}

assert_managed_path() {
  local path="$1"
  local resolved_parent
  resolved_parent="$(cd -- "$(dirname -- "${path}")" && pwd -P)"
  [[ "${resolved_parent}/$(basename -- "${path}")" == "${DELIVERY_ROOT}/projects/"* ]] \
    || die "Refusing to operate outside ${DELIVERY_ROOT}/projects: ${path}"
}
