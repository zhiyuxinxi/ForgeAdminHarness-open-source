#!/usr/bin/env bash

# Shared, fail-closed TaskSpace Compose network contract. This file is sourced by
# lifecycle scripts; it intentionally has no top-level platform configuration or
# Docker side effects.

# shellcheck source=taskspace-tool-worker.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/taskspace-tool-worker.sh"

_taskspace_network_constant() {
  local name="$1" expected="$2"
  if [[ -v "${name}" ]]; then
    [[ "${!name}" == "${expected}" ]] || {
      printf 'TaskSpace network constant is inconsistent: %s.\n' "${name}" >&2
      return 1
    }
  else
    printf -v "${name}" '%s' "${expected}"
  fi
  readonly "${name}"
}

_taskspace_network_constant TASKSPACE_NETWORK_POOL_PORT_MIN 20000 || return 1
_taskspace_network_constant TASKSPACE_NETWORK_POOL_PREFIX 15 || return 1
_taskspace_network_constant TASKSPACE_NETWORK_PREFIX 29 || return 1
_taskspace_network_constant TASKSPACE_NETWORK_POOL_SLOT_COUNT 16384 || return 1
_taskspace_network_constant TASKSPACE_NETWORK_POOL_PORT_MAX 36383 || return 1
_taskspace_network_constant TASKSPACE_NETWORK_OVERRIDE_NAME compose.network.override.yaml || return 1
_taskspace_network_constant TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME network.compose.yaml || return 1
unset -f _taskspace_network_constant

taskspace_network_subnet_for_port() {
  local port="${1:-}" decimal slot offset second_octet remainder third_octet fourth_octet
  [[ "${port}" =~ ^[1-9][0-9]{4}$ ]] \
    || { printf 'TaskSpace network port must be a canonical five-digit integer.\n' >&2; return 1; }
  decimal=$((10#${port}))
  ((decimal >= TASKSPACE_NETWORK_POOL_PORT_MIN \
    && decimal <= TASKSPACE_NETWORK_POOL_PORT_MAX)) \
    || { printf 'TaskSpace network port must be between %s and %s.\n' \
      "${TASKSPACE_NETWORK_POOL_PORT_MIN}" "${TASKSPACE_NETWORK_POOL_PORT_MAX}" >&2; return 1; }

  slot=$((decimal - TASKSPACE_NETWORK_POOL_PORT_MIN))
  offset=$((slot * 8))
  second_octet=$((240 + offset / 65536))
  remainder=$((offset % 65536))
  third_octet=$((remainder / 256))
  fourth_octet=$((remainder % 256))
  printf '10.%s.%s.%s/29\n' "${second_octet}" "${third_octet}" "${fourth_octet}"
}

taskspace_network_override_document() {
  local subnet
  subnet="$(taskspace_network_subnet_for_port "$1")" || return 1
  printf '%s\n' \
    '# forge-taskspace-network-v1' \
    'networks:' \
    '  uploads:' \
    '    ipam:' \
    '      config:' \
    "        - subnet: ${subnet}"
}

taskspace_legacy_network_override_document() {
  local subnet
  subnet="$(taskspace_network_subnet_for_port "$1")" || return 1
  printf '%s\n' \
    'networks:' \
    '  uploads:' \
    '    ipam:' \
    '      config:' \
    "        - subnet: ${subnet}"
}

_taskspace_network_root_is_safe() {
  local task_root="$1" label="${2:-TaskSpace}" task_real parent parent_real base
  if declare -F taskspace_root_is_contained >/dev/null 2>&1; then
    taskspace_root_is_contained "${task_root}" "${label}"
    return
  fi

  [[ -d "${task_root}" && ! -L "${task_root}" ]] \
    || { printf 'TaskSpace directory is unsafe (%s).\n' "${label}" >&2; return 1; }
  task_real="$(readlink -f -- "${task_root}")" || return 1
  parent="$(dirname -- "${task_root}")"
  parent_real="$(readlink -f -- "${parent}")" || return 1
  base="$(basename -- "${task_root}")"
  [[ "${task_real}" == "${parent_real}/${base}" ]] \
    || { printf 'TaskSpace directory escaped its expected parent (%s).\n' "${label}" >&2; return 1; }
}

_taskspace_network_task_env_path() {
  local task_root="$1" label="${2:-TaskSpace}" path task_real path_real links size
  _taskspace_network_root_is_safe "${task_root}" "${label}" || return 1
  path="${task_root}/task.env"
  [[ -f "${path}" && ! -L "${path}" ]] \
    || { printf 'TaskSpace environment is missing or unsafe (%s).\n' "${label}" >&2; return 1; }
  task_real="$(readlink -f -- "${task_root}")" || return 1
  path_real="$(readlink -f -- "${path}")" || return 1
  links="$(stat -c '%h' -- "${path}")" || return 1
  size="$(stat -c '%s' -- "${path}")" || return 1
  [[ "${path_real}" == "${task_real}/task.env" \
    && "${links}" == 1 \
    && "${size}" =~ ^[0-9]+$ && "${size}" -gt 0 && "${size}" -le 65536 ]] \
    || { printf 'TaskSpace environment is not a bounded single-link file (%s).\n' \
      "${label}" >&2; return 1; }
  printf '%s\n' "${path}"
}

_taskspace_network_env_exact_value() {
  local task_env="$1" key="$2"
  awk -F= -v name="${key}" '
    $1 == name { sub(/^[^=]*=/, ""); value=$0; count++ }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "${task_env}"
}

_taskspace_network_port_value() {
  local task_root="$1" label="$2" task_env port decimal
  task_env="$(_taskspace_network_task_env_path "${task_root}" "${label}")" || return 1
  port="$(_taskspace_network_env_exact_value "${task_env}" TASKSPACE_HARNESS_PORT)" \
    || { printf 'TaskSpace environment must contain exactly one Harness port (%s).\n' \
      "${label}" >&2; return 1; }
  [[ "${port}" =~ ^[1-9][0-9]{3,4}$ ]] \
    || { printf 'TaskSpace environment Harness port is invalid (%s).\n' "${label}" >&2; return 1; }
  decimal=$((10#${port}))
  ((decimal >= 1024 && decimal <= 65535)) \
    || { printf 'TaskSpace environment Harness port is invalid (%s).\n' "${label}" >&2; return 1; }
  printf '%s\n' "${port}"
}

_taskspace_network_port_from_env() {
  local task_root="$1" label="$2" port
  port="$(_taskspace_network_port_value "${task_root}" "${label}")" || return 1
  taskspace_network_subnet_for_port "${port}" >/dev/null || return 1
  printf '%s\n' "${port}"
}

taskspace_network_override_path() {
  local task_root="$1" label="${2:-TaskSpace}" name="${3:-${TASKSPACE_NETWORK_OVERRIDE_NAME}}"
  local override task_real override_real
  [[ "${name}" == "${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
    || "${name}" == "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" ]] \
    || { printf 'TaskSpace network override name is unsupported (%s).\n' "${label}" >&2; return 1; }
  _taskspace_network_root_is_safe "${task_root}" "${label}" || return 1
  override="${task_root}/${name}"
  [[ ! -L "${override}" && ( ! -e "${override}" || -f "${override}" ) ]] \
    || { printf 'TaskSpace network override is unsafe (%s).\n' "${label}" >&2; return 1; }
  task_real="$(readlink -f -- "${task_root}")" || return 1
  if [[ -e "${override}" ]]; then
    override_real="$(readlink -f -- "${override}")" || return 1
  else
    override_real="${task_real}/${name}"
  fi
  [[ "${override_real}" == "${task_real}/${name}" ]] \
    || { printf 'TaskSpace network override escaped its TaskSpace (%s).\n' "${label}" >&2; return 1; }
  printf '%s\n' "${override}"
}

validate_taskspace_network_override() {
  local task_root="$1" label="$2" port="$3" name="${4:-${TASKSPACE_NETWORK_OVERRIDE_NAME}}"
  local override expected_hash actual_hash links size
  taskspace_network_subnet_for_port "${port}" >/dev/null || return 1
  override="$(taskspace_network_override_path "${task_root}" "${label}" "${name}")" || return 1
  [[ -f "${override}" && ! -L "${override}" ]] \
    || { printf 'TaskSpace network override is missing (%s).\n' "${label}" >&2; return 1; }
  links="$(stat -c '%h' -- "${override}")" || return 1
  size="$(stat -c '%s' -- "${override}")" || return 1
  [[ "${links}" == 1 && "${size}" =~ ^[0-9]+$ && "${size}" -gt 0 && "${size}" -le 512 ]] \
    || { printf 'TaskSpace network override is not a bounded single-link file (%s).\n' \
      "${label}" >&2; return 1; }
  if [[ "${name}" == "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" ]]; then
    expected_hash="$(taskspace_legacy_network_override_document "${port}" \
      | sha256sum | awk '{print $1}')" || return 1
  else
    expected_hash="$(taskspace_network_override_document "${port}" \
      | sha256sum | awk '{print $1}')" || return 1
  fi
  actual_hash="$(dd if="${override}" iflag=nofollow,count_bytes count=513 status=none \
    | sha256sum | awk '{print $1}')" || return 1
  [[ "${actual_hash}" == "${expected_hash}" ]] \
    || { printf 'TaskSpace network override does not match its reserved port (%s).\n' \
      "${label}" >&2; return 1; }
  printf '%s\n' "${override}"
}

# Populate a caller-owned array with the validated optional Compose file. The
# base TaskSpace Compose file remains the caller's responsibility.
taskspace_network_compose_args() {
  local task_root="$1" label="$2" output_name="$3" port override legacy_override
  [[ "${output_name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || { printf 'TaskSpace network Compose output name is invalid.\n' >&2; return 1; }
  local -n output_ref="${output_name}"
  output_ref=()
  port="$(_taskspace_network_port_value "${task_root}" "${label}")" || return 1
  override="$(taskspace_network_override_path "${task_root}" "${label}")" || return 1
  legacy_override="$(taskspace_network_override_path "${task_root}" "${label}" \
    "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}")" || return 1

  if [[ ! -e "${override}" && ! -L "${override}" \
      && ! -e "${legacy_override}" && ! -L "${legacy_override}" ]]; then
    taskspace_tool_worker_compose_args "${task_root}" "${label}" "${output_name}"
    return
  fi
  taskspace_network_subnet_for_port "${port}" >/dev/null || return 1

  if [[ -e "${legacy_override}" || -L "${legacy_override}" ]]; then
    legacy_override="$(validate_taskspace_network_override "${task_root}" "${label}" "${port}" \
      "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}")" || return 1
  fi
  if [[ -e "${override}" || -L "${override}" ]]; then
    override="$(validate_taskspace_network_override \
      "${task_root}" "${label}" "${port}")" || return 1
    output_ref=(--file "${override}")
  elif [[ -e "${legacy_override}" ]]; then
    output_ref=(--file "${legacy_override}")
  fi
  taskspace_tool_worker_compose_args "${task_root}" "${label}" "${output_name}"
}

# Establish the canonical file for new TaskSpaces or a reviewed migration. A
# supplied port is checked against task.env; it never overrides that authority.
ensure_taskspace_network_override() {
  local task_root="$1" label="$2" requested_port="${3-}"
  local task_env port override legacy_override temporary
  task_env="$(_taskspace_network_task_env_path "${task_root}" "${label}")" || return 1
  port="$(_taskspace_network_port_from_env "${task_root}" "${label}")" || return 1
  if (($# >= 3)); then
    [[ "${requested_port}" == "${port}" ]] \
      || { printf 'TaskSpace network port differs from task.env (%s).\n' "${label}" >&2; return 1; }
  fi
  override="$(taskspace_network_override_path "${task_root}" "${label}")" || return 1
  legacy_override="$(taskspace_network_override_path "${task_root}" "${label}" \
    "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}")" || return 1
  if [[ -e "${legacy_override}" || -L "${legacy_override}" ]]; then
    validate_taskspace_network_override "${task_root}" "${label}" "${port}" \
      "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" >/dev/null || return 1
  fi
  if [[ -e "${override}" || -L "${override}" ]]; then
    validate_taskspace_network_override "${task_root}" "${label}" "${port}" >/dev/null
    return
  fi

  temporary="$(mktemp "${task_root}/.compose-network.XXXXXX")" || return 1
  if ! taskspace_network_override_document "${port}" >"${temporary}" \
      || ! chmod 0644 "${temporary}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  if [[ "${EUID}" -eq 0 ]] && ! chown --reference="${task_env}" "${temporary}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  # Publish a complete same-directory file without ever replacing an existing
  # destination. A racing destination is accepted only after full validation.
  if ! ln -- "${temporary}" "${override}" 2>/dev/null; then
    rm -f -- "${temporary}" 2>/dev/null || true
    validate_taskspace_network_override "${task_root}" "${label}" "${port}" >/dev/null
    return
  fi
  rm -f -- "${temporary}" || return 1
  validate_taskspace_network_override "${task_root}" "${label}" "${port}" >/dev/null
}

# Upgrade-only migration gate. Old TaskSpaces with no override retain their
# original Docker allocation model; legacy fixed-subnet tasks gain canonical
# metadata while keeping the validated legacy file in place.
migrate_taskspace_network_override() {
  local task_root="$1" label="$2" override legacy_override
  _taskspace_network_port_value "${task_root}" "${label}" >/dev/null || return 1
  override="$(taskspace_network_override_path "${task_root}" "${label}")" || return 1
  legacy_override="$(taskspace_network_override_path "${task_root}" "${label}" \
    "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}")" || return 1
  if [[ ! -e "${override}" && ! -L "${override}" \
      && ! -e "${legacy_override}" && ! -L "${legacy_override}" ]]; then
    return 0
  fi
  ensure_taskspace_network_override "${task_root}" "${label}"
}
