#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "${repo}/scripts/lib/taskspace-compose-network.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "${fixture}"' EXIT
task_root="${fixture}/c-worker"
mkdir -m 0700 -- "${task_root}"
printf 'TASKSPACE_HARNESS_PORT=20020\n' >"${task_root}/task.env"
chmod 0600 "${task_root}/task.env"
declare -a args=()
taskspace_network_compose_args "${task_root}" legacy args
[[ "${#args[@]}" == 0 && ! -e "${task_root}/tool-worker" ]]
printf 'FORGE_TOOL_WORKER_ENABLED=true\n' >>"${task_root}/task.env"
if taskspace_network_compose_args "${task_root}" missing-directory args 2>/dev/null; then
  printf 'Missing worker directory was accepted.\n' >&2; exit 1
fi
[[ ! -e "${task_root}/tool-worker" ]]
ensure_taskspace_tool_worker_directory "${task_root}" current
ensure_taskspace_tool_worker_directory "${task_root}" idempotent
taskspace_network_compose_args "${task_root}" enabled args
[[ "${#args[@]}" == 2 && "${args[0]}" == --file && "${args[1]}" == "${repo}/templates/taskspace/compose.tool-worker.yaml" ]]
printf 'FORGE_DEVELOPMENT_MODE=direct\nHARNESS_IMAGE=legacy-image\n' >>"${task_root}/task.env"
docker() {
  [[ "$1 $2" == 'image inspect' ]] || return 99
  case "${*: -1}" in legacy-image) printf '<no value>\n' ;; private-proc-image) printf 'v1\n' ;; missing-image) return 1 ;; *) return 99 ;; esac
}
declare -a direct_args=()
taskspace_network_compose_args "${task_root}" direct-create direct_args
[[ "${#direct_args[@]}" == 4 && "${direct_args[3]}" == "${repo}/templates/taskspace/compose.tool-worker.direct.yaml" ]]
declare -a upgraded_args=()
taskspace_network_compose_args "${task_root}" direct-upgrade upgraded_args
[[ "${direct_args[*]}" == "${upgraded_args[*]}" ]]
! grep -q 'systempaths=unconfined' "${direct_args[3]}"
sed -i 's/HARNESS_IMAGE=legacy-image/HARNESS_IMAGE=missing-image/' "${task_root}/task.env"
declare -a missing_args=()
taskspace_network_compose_args "${task_root}" not-yet-pulled missing_args
[[ "${#missing_args[@]}" == 4 ]]
sed -i 's/HARNESS_IMAGE=missing-image/HARNESS_IMAGE=private-proc-image/' "${task_root}/task.env"
declare -a capable_args=() capable_upgrade_args=()
taskspace_network_compose_args "${task_root}" capable-create capable_args
taskspace_network_compose_args "${task_root}" capable-upgrade capable_upgrade_args
[[ "${#capable_args[@]}" == 6 && "${capable_args[*]}" == "${capable_upgrade_args[*]}" ]]
[[ "${capable_args[5]}" == "${repo}/templates/taskspace/compose.tool-worker.private-proc.yaml" ]]
grep -q 'systempaths=unconfined' "${capable_args[5]}"
unset -f docker
printf 'FORGE_TOOL_WORKER_ENABLED=false\n' >>"${task_root}/task.env"
if taskspace_network_compose_args "${task_root}" duplicate args 2>/dev/null; then
  printf 'Duplicate worker setting was accepted.\n' >&2; exit 1
fi
printf 'TASKSPACE_HARNESS_PORT=20020\nFORGE_TOOL_WORKER_ENABLED=true\n' >"${task_root}/task.env"
rmdir -- "${task_root}/tool-worker"
mkdir -- "${fixture}/outside"
ln -s -- "${fixture}/outside" "${task_root}/tool-worker"
if ensure_taskspace_tool_worker_directory "${task_root}" escaped 2>/dev/null; then
  printf 'Worker directory symlink was accepted.\n' >&2; exit 1
fi
printf 'PASS: optional lifecycle composition, idempotence, read-only inspection, duplicate and symlink rejection\n'
