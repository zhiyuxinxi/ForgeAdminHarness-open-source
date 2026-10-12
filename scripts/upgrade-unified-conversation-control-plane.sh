#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/taskspace-compose-network.sh
source "${SCRIPT_DIR}/lib/taskspace-compose-network.sh"
load_platform_config

usage() {
  printf 'Usage: %s --confirm-maintenance-window unified-conversation-control-plane\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == unified-conversation-control-plane ]] \
  || die "This upgrade requires --confirm-maintenance-window unified-conversation-control-plane."

for command_name in curl docker flock jq sha256sum; do require_command "${command_name}"; done
require_docker_access
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
[[ -f "${registry_file}" ]] || die "Project registry is missing."
mapfile -t project_slugs < <(awk -F '\t' 'NR > 1 {print $1}' "${registry_file}")
((${#project_slugs[@]} > 0)) || die "No registered projects exist."

upgrade_lock="${DELIVERY_ROOT}/registry/unified-conversation-upgrade.lock"
prepare_delivery_lock "${upgrade_lock}"
exec 9>>"${upgrade_lock}"
flock --exclusive --nonblock 9 || die "Another unified conversation upgrade is running."
taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"
prepare_delivery_lock "${taskspaces_lock}"
exec 8>>"${taskspaces_lock}"
flock --exclusive --nonblock 8 \
  || die "A TaskSpace lifecycle action is active; retry after it finishes."
# taskspacectl validates this descriptor before reusing it.  Keeping the same
# open file description across the child start calls preserves the lifecycle
# exclusion without a release-and-reacquire window.
FORGE_TASKSPACES_LOCK_FD=8
export FORGE_TASKSPACES_LOCK_FD

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="${DELIVERY_ROOT}/platform-backups/pre-unified-conversation-${timestamp}"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}/projects"
control_state_root="${DELIVERY_ROOT}/conversation-control-plane/state"
control_state_before="${backup_root}/control-plane-state.before"
control_state_was_present=false
if [[ -f "${control_state_root}/state.json" || -f "${control_state_root}/audit.jsonl" ]]; then
  control_state_was_present=true
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${control_state_before}"
  for state_file in state.json audit.jsonl; do
    [[ -f "${control_state_root}/${state_file}" ]] || continue
    install -m 0600 "${control_state_root}/${state_file}" "${control_state_before}/${state_file}"
  done
fi
rollback_taskspace_override="${backup_root}/legacy-taskspace-auth.override.yaml"
cat >"${rollback_taskspace_override}" <<'YAML'
services:
  harness:
    environment:
      HARNESS_ACCESS_AUTHZ_SOCKET: !reset null
      HARNESS_ACCESS_AUTHZ_URL: ${CONVERSATION_GATEWAY_AUTHZ_URL:?CONVERSATION_GATEWAY_AUTHZ_URL is required for legacy rollback}
YAML
chmod 0600 "${rollback_taskspace_override}"

upsert_env() {
  local file="$1" key="$2" value="$3" temporary
  temporary="${file}.tmp.$$"
  awk -F= -v key="${key}" -v value="${value}" '
    BEGIN {found=0}
    $1 == key {print key "=" value; found=1; next}
    {print}
    END {if (!found) print key "=" value}
  ' "${file}" >"${temporary}"
  chmod --reference="${file}" "${temporary}"
  chown --reference="${file}" "${temporary}"
  mv -- "${temporary}" "${file}"
}

project_compose() {
  local slug="$1"
  shift
  docker compose \
    --env-file "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" \
    --file "${DELIVERY_ROOT}/projects/${slug}/ops/compose.yaml" "$@"
}

# This historical upgrade touches TaskSpace Compose only during rollback. It
# therefore validates and loads canonical/legacy network metadata without
# migrating files or changing no-override predecessors.
rollback_task_compose() {
  local slug="$1" task_env="$2" task_root task_id
  local -a network_args=()
  shift 2
  task_root="$(dirname -- "${task_env}")"
  task_id="$(basename -- "${task_root}")"
  taskspace_network_compose_args "${task_root}" "${slug}/${task_id}" network_args \
    || return 1
  docker compose --env-file "${task_env}" \
    --file "${REPO_ROOT}/templates/taskspace/compose.yaml" \
    "${network_args[@]}" \
    --file "${rollback_taskspace_override}" "$@"
}

wait_project_service_health() {
  local slug="$1" service="$2" timeout_seconds="${3:-90}"
  local deadline container_id health
  deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    container_id="$(project_compose "${slug}" ps --quiet "${service}")"
    if [[ -n "${container_id}" ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || true)"
      [[ "${health}" == healthy ]] && return 0
      [[ "${health}" == exited || "${health}" == dead ]] && break
    fi
    sleep 2
  done
  project_compose "${slug}" logs --no-color --tail 200 "${service}" \
    >"${backup_root}/projects/${slug}/${service}.failed.log" 2>&1 || true
  warn "${service} did not become healthy for ${slug}; logs were preserved in the rollback evidence."
  return 1
}

verify_release_contract_readable() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" host_uid host_gid
  host_uid="$(id -u "${DELIVERY_OWNER}")"
  host_gid="$(getent group "${DELIVERY_GROUP}" | cut -d: -f3)"
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "${host_uid}:${host_gid}" \
    --volume "${project_root}/ops:${project_root}/ops:ro" \
    --entrypoint node \
    "${RELEASE_RUNNER_IMAGE}" \
    -e 'const fs=require("node:fs");JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' \
    "${project_root}/ops/runtime-contract.json"
}

backup_project() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" target="${backup_root}/projects/${slug}"
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${target}/task-env"
  install -m 0600 "${project_root}/ops/project.env" "${target}/project.env"
  install -m 0600 "${project_root}/ops/compose.yaml" "${target}/compose.yaml"
  install -m 0600 "${project_root}/ops/runtime-contract.json" "${target}/runtime-contract.json"
  shopt -s nullglob
  for task_env in "${project_root}"/taskspaces/*/task.env; do
    install -m 0600 "${task_env}" "${target}/task-env/$(basename -- "$(dirname -- "${task_env}")").env"
  done
  shopt -u nullglob
  project_compose "${slug}" ps --all --format json >"${target}/compose-ps.json"
  for service in forge-admin forge-flow forge-ui; do
    project_compose "${slug}" ps --quiet "${service}" | xargs -r docker inspect --format '{{.Id}}' >>"${target}/application-container-ids.before"
  done
}

restore_project_files() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" source="${backup_root}/projects/${slug}"
  install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${source}/project.env" "${project_root}/ops/project.env"
  install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${source}/compose.yaml" "${project_root}/ops/compose.yaml"
  install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${source}/runtime-contract.json" "${project_root}/ops/runtime-contract.json"
  shopt -s nullglob
  for backup_env in "${source}"/task-env/*.env; do
    local task_id
    task_id="$(basename -- "${backup_env}" .env)"
    install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_env}" "${project_root}/taskspaces/${task_id}/task.env"
  done
  shopt -u nullglob
}

switched=false
rollback() {
  local exit_code=$?
  trap - ERR
  if [[ "${switched}" == true ]]; then
    warn "Unified entry upgrade failed; restoring the project-local Gateway control planes."
    bash "${SCRIPT_DIR}/conversation-control-planectl.sh" down >/dev/null 2>&1 || true
    failed_state="${backup_root}/control-plane-state.failed"
    install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${failed_state}" || true
    for state_file in state.json audit.jsonl; do
      if [[ -f "${control_state_root}/${state_file}" ]]; then
        mv -- "${control_state_root}/${state_file}" "${failed_state}/${state_file}" || true
      fi
      if [[ "${control_state_was_present}" == true && -f "${control_state_before}/${state_file}" ]]; then
        install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
          "${control_state_before}/${state_file}" "${control_state_root}/${state_file}" || true
      fi
    done
    install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${DELIVERY_ROOT}/conversation-control-plane/auth-ipc" || true
    for slug in "${project_slugs[@]}"; do
      restore_project_files "${slug}" || true
      project_compose "${slug}" up --detach conversation-manager conversation-gateway || true
      shopt -s nullglob
      for metadata in "${DELIVERY_ROOT}/projects/${slug}"/taskspaces/*/metadata.json; do
        [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
        task_id="$(jq -r '.taskId' "${metadata}")"
        task_env="${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}/task.env"
        # The current TaskSpace template understands both transports. During
        # rollback we run the current image against the restored project-local
        # Gateway URL, while the project application and old Gateway remain on
        # their preserved versions.
        upsert_env "${task_env}" PLATFORM_CONVERSATION_AUTH_ROOT \
          "${DELIVERY_ROOT}/conversation-control-plane/auth-ipc"
        upsert_env "${task_env}" HARNESS_IMAGE "${HARNESS_IMAGE}"
        chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${task_env}" || true
        chmod 0600 "${task_env}" || true
        rollback_task_compose "${slug}" "${task_env}" up --detach \
          || warn "TaskSpace rollback restart failed closed: ${slug}/$(basename -- "$(dirname -- "${task_env}")")"
      done
      shopt -u nullglob
    done
  fi
  warn "Rollback evidence is retained at ${backup_root}."
  exit "${exit_code}"
}
trap rollback ERR

for slug in "${project_slugs[@]}"; do backup_project "${slug}"; done

# Freeze all legacy writers before taking the migration snapshot. Otherwise a
# conversation or password change committed between migration and cutover could
# disappear from the unified state. The rollback trap restarts every legacy
# Gateway if any later step fails.
switched=true
for slug in "${project_slugs[@]}"; do
  old_env="${backup_root}/projects/${slug}/project.env"
  old_compose="${backup_root}/projects/${slug}/compose.yaml"
  docker compose --env-file "${old_env}" --file "${old_compose}" stop conversation-gateway
done

# A previous failed, never-started migration may have left an inactive unified
# state. Preserve it as evidence and always rebuild from the just-frozen legacy
# writers. Rollback restores the exact pre-attempt state if this attempt fails.
if [[ "${control_state_was_present}" == true ]]; then
  stale_state="${backup_root}/control-plane-state.stale"
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${stale_state}"
  for state_file in state.json audit.jsonl; do
    [[ -f "${control_state_root}/${state_file}" ]] || continue
    mv -- "${control_state_root}/${state_file}" "${stale_state}/${state_file}"
  done
fi

bash "${SCRIPT_DIR}/conversation-control-planectl.sh" prepare

for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  env_file="${project_root}/ops/project.env"
  old_env="${backup_root}/projects/${slug}/project.env"
  old_compose="${backup_root}/projects/${slug}/compose.yaml"
  control_project_root="${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}"
  upsert_env "${env_file}" HARNESS_PORT "${CONVERSATION_GATEWAY_PORT}"
  upsert_env "${env_file}" PLATFORM_CONVERSATION_PROJECT_ROOT "${control_project_root}"
  upsert_env "${env_file}" PLATFORM_CONVERSATION_AUTH_ROOT "${DELIVERY_ROOT}/conversation-control-plane/auth-ipc"
  upsert_env "${env_file}" CONVERSATION_MANAGER_TOKEN_FILE "${control_project_root}/manager-token"
  upsert_env "${env_file}" CONVERSATION_MANAGER_SOCKET "${control_project_root}/ipc/manager.sock"
  upsert_env "${env_file}" CONVERSATION_GATEWAY_AUTHZ_URL ''
  upsert_env "${env_file}" CONVERSATION_GATEWAY_LOGIN_URL "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/forge-gateway/login"
  upsert_env "${env_file}" HARNESS_IMAGE "${HARNESS_IMAGE}"
  upsert_env "${env_file}" RELEASE_RUNNER_IMAGE "${RELEASE_RUNNER_IMAGE}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${env_file}"
  chmod 0600 "${env_file}"
  install -m 0640 "${REPO_ROOT}/templates/project/compose.yaml" "${project_root}/ops/compose.yaml"
  if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${project_root}/ops/compose.yaml"; fi
  bash "${SCRIPT_DIR}/generate-release-contract.sh" "${slug}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${project_root}/ops/runtime-contract.json"
  chmod 0640 "${project_root}/ops/runtime-contract.json"
  verify_release_contract_readable "${slug}"

  docker compose --env-file "${old_env}" --file "${old_compose}" rm --force --stop conversation-gateway
  project_compose "${slug}" config --quiet
  # Start the bounded control chain in dependency order. Besides avoiding a
  # Compose-wide dependency race, this preserves the exact failing service log
  # before rollback recreates the predecessor containers.
  project_compose "${slug}" up --detach --force-recreate --no-deps release-runner
  wait_project_service_health "${slug}" release-runner 90
  project_compose "${slug}" up --detach --force-recreate --no-deps taskspace-broker
  wait_project_service_health "${slug}" taskspace-broker 90
  project_compose "${slug}" up --detach --force-recreate --no-deps conversation-manager
  wait_project_service_health "${slug}" conversation-manager 90

  shopt -s nullglob
  for task_env in "${project_root}"/taskspaces/*/task.env; do
    upsert_env "${task_env}" PLATFORM_CONVERSATION_AUTH_ROOT "${DELIVERY_ROOT}/conversation-control-plane/auth-ipc"
    upsert_env "${task_env}" CONVERSATION_GATEWAY_AUTHZ_URL ''
    upsert_env "${task_env}" CONVERSATION_GATEWAY_LOGIN_URL "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/forge-gateway/login"
    upsert_env "${task_env}" HARNESS_IMAGE "${HARNESS_IMAGE}"
    chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${task_env}"
    chmod 0600 "${task_env}"
  done
  shopt -u nullglob
done

bash "${SCRIPT_DIR}/conversation-control-planectl.sh" up

for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error --max-time 3 \
      --unix-socket "${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}/ipc/manager.sock" \
      http://localhost/healthz >/dev/null; then break; fi
    sleep 2
  done
  curl --fail --silent --show-error --max-time 3 \
    --unix-socket "${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}/ipc/manager.sock" \
    http://localhost/healthz >/dev/null \
    || die "Conversation Manager did not become ready for ${slug}."

  shopt -s nullglob
  for metadata in "${project_root}"/taskspaces/*/metadata.json; do
    [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
    task_id="$(jq -r '.taskId' "${metadata}")"
    bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" start "${task_id}"
  done
  shopt -u nullglob

  : >"${backup_root}/projects/${slug}/application-container-ids.after"
  for service in forge-admin forge-flow forge-ui; do
    project_compose "${slug}" ps --quiet "${service}" | xargs -r docker inspect --format '{{.Id}}' >>"${backup_root}/projects/${slug}/application-container-ids.after"
  done
  cmp "${backup_root}/projects/${slug}/application-container-ids.before" \
      "${backup_root}/projects/${slug}/application-container-ids.after" \
    || die "Application containers changed unexpectedly for ${slug}."
done

curl --fail --silent --show-error --max-time 5 \
  "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" >/dev/null
curl --fail --silent --show-error --max-time 5 \
  "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/forge-gateway/login" >/dev/null

trap - ERR
log "Unified multi-project Conversation Gateway upgrade completed. Backup and rollback evidence: ${backup_root}"
log "All prior browser sessions were intentionally revoked; users must sign in again at the single platform entry."
