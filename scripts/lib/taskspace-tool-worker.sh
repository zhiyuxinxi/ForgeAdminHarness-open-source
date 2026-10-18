#!/usr/bin/env bash

# Optional per-TaskSpace composition, reused by every lifecycle/upgrade caller
# of taskspace_network_compose_args. Existing active TaskSpaces are not migrated
# merely by installing a new platform template.
taskspace_tool_worker_enabled() {
  local task_env value count
  task_env="$(_taskspace_network_task_env_path "$1" "$2")" || return 2
  count="$(awk -F= '$1 == "FORGE_TOOL_WORKER_ENABLED" {n++} END {print n+0}' "${task_env}")"
  [[ "${count}" == 0 ]] && return 1
  [[ "${count}" == 1 ]] || { printf 'Duplicate TaskSpace tool-worker setting.\n' >&2; return 2; }
  value="$(_taskspace_network_env_exact_value "${task_env}" FORGE_TOOL_WORKER_ENABLED)" || return 2
  case "${value}" in true) return 0 ;; false) return 1 ;; *) printf 'Invalid TaskSpace tool-worker setting.\n' >&2; return 2 ;; esac
}

ensure_taskspace_tool_worker_directory() {
  local task_root="$1" label="$2" directory task_env owner mode
  task_env="$(_taskspace_network_task_env_path "${task_root}" "${label}")" || return 1
  directory="${task_root}/tool-worker"
  [[ ! -L "${directory}" && ( ! -e "${directory}" || -d "${directory}" ) ]] || return 1
  if [[ ! -e "${directory}" ]]; then
    mkdir -m 0700 -- "${directory}" || return 1
    if [[ "${EUID}" == 0 ]]; then chown --reference="${task_env}" "${directory}" || return 1; fi
  fi
  [[ "$(readlink -f -- "${directory}")" == "$(readlink -f -- "${task_root}")/tool-worker" ]] || return 1
  owner="$(stat -c '%u:%g' -- "${task_env}")" || return 1
  [[ "$(stat -c '%u:%g' -- "${directory}")" == "${owner}" && "$(stat -c '%a' -- "${directory}")" == 700 ]] || return 1
}

taskspace_tool_worker_compose_args() {
  local task_root="$1" label="$2" output_name="$3" enabled=0 template
  local -n tool_worker_args_ref="${output_name}"
  taskspace_tool_worker_enabled "${task_root}" "${label}" || enabled=$?
  [[ "${enabled}" == 1 ]] && return 0
  [[ "${enabled}" == 0 ]] || return 1
  # Read-only validation: status/inspection never creates a directory.
  [[ -d "${task_root}/tool-worker" && ! -L "${task_root}/tool-worker" \
    && "$(readlink -f -- "${task_root}/tool-worker")" == "$(readlink -f -- "${task_root}")/tool-worker" \
    && "$(stat -c '%a' -- "${task_root}/tool-worker")" == 700 \
    && "$(stat -c '%u:%g' -- "${task_root}/tool-worker")" == "$(stat -c '%u:%g' -- "${task_root}/task.env")" ]] || return 1
  template="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../templates/taskspace" && pwd -P)/compose.tool-worker.yaml" || return 1
  [[ -f "${template}" && ! -L "${template}" ]] || return 1
  tool_worker_args_ref+=(--file "${template}")
  # Direct development needs unprivileged Bubblewrap namespaces only in the
  # separate credential-free worker. Legacy/default TaskSpaces keep the original
  # Docker policies; status inspection never installs or loads a host profile.
  local development_mode='' development_mode_count
  development_mode_count="$(awk -F= '$1 == "FORGE_DEVELOPMENT_MODE" {n++} END {print n+0}' "${task_root}/task.env")"
  if [[ "${development_mode_count}" != 0 ]]; then
    [[ "${development_mode_count}" == 1 ]] || return 1
    development_mode="$(_taskspace_network_env_exact_value "${task_root}/task.env" FORGE_DEVELOPMENT_MODE)" || return 1
  fi
  if [[ "${development_mode}" == direct ]]; then
    template="$(dirname -- "${template}")/compose.tool-worker.direct.yaml"
    [[ -f "${template}" && ! -L "${template}" ]] || return 1
    tool_worker_args_ref+=(--file "${template}")
    # Follow the existing tool-worker image capability contract. A tag name or
    # a template installation alone never relaxes an older worker's proc mounts.
    # Missing/local-unavailable images retain the original outer masks; normal
    # preparation can select the capability after it has obtained the real image.
    local image private_proc_capability=''
    image="$(_taskspace_network_env_exact_value "${task_root}/task.env" HARNESS_IMAGE)" || return 1
    if private_proc_capability="$(docker image inspect --format '{{index .Config.Labels "io.forge.tool-worker.private-proc"}}' "${image}" 2>/dev/null)" \
      && [[ "${private_proc_capability}" == v1 ]]; then
      template="$(dirname -- "${template}")/compose.tool-worker.private-proc.yaml"
      [[ -f "${template}" && ! -L "${template}" ]] || return 1
      tool_worker_args_ref+=(--file "${template}")
    fi
  fi
}
