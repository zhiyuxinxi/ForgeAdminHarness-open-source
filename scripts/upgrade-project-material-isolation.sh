#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/taskspace-compose-network.sh
source "${SCRIPT_DIR}/lib/taskspace-compose-network.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() {
  printf 'Usage: %s --confirm-maintenance-window project-material-isolation\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == project-material-isolation ]] \
  || die "This upgrade requires --confirm-maintenance-window project-material-isolation."

for command_name in chmod chown cmp cp curl dd docker find flock grep jq mkdir mktemp mv readlink rm sha256sum sort stat tail tar; do require_command "${command_name}"; done
require_docker_access
acquire_harness_image_upgrade_lock
expected_base_image_id="$(resolve_configured_harness_foundation_image_id)"
harness_image_source="${HARNESS_IMAGE}"
release_runner_image_source="${RELEASE_RUNNER_IMAGE}"
verify_target_harness_image "${harness_image_source}" "${expected_base_image_id}"
target_image_id="${FORGE_VERIFIED_HARNESS_IMAGE_ID}"
format_maintenance_supported=false
if harness_image_supports_format_maintenance "${target_image_id}"; then format_maintenance_supported=true; fi
contract_continuation_supported=false
review_suspension_supported=false
changed_verification_supported=false
focused_backend_verification_supported=false
ordinary_final_verification_supported=false
if harness_image_supports_contract_continuation "${target_image_id}"; then contract_continuation_supported=true; fi
if harness_image_supports_review_suspension "${target_image_id}"; then review_suspension_supported=true; fi
if harness_image_supports_changed_verification "${target_image_id}"; then changed_verification_supported=true; fi
if harness_image_supports_focused_backend_verification "${target_image_id}"; then focused_backend_verification_supported=true; fi
if harness_image_supports_ordinary_final_verification "${target_image_id}"; then ordinary_final_verification_supported=true; fi
release_runner_image_id="$(docker image inspect --format '{{.Id}}' "${release_runner_image_source}")" \
  || die "Release Runner source image is unavailable: ${release_runner_image_source}"
[[ "${release_runner_image_id}" == "${target_image_id}" ]] \
  || die "Harness and Release Runner source references must resolve to the same verified immutable image."
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
control_env="${DELIVERY_ROOT}/conversation-control-plane/control-plane.env"
[[ -f "${registry_file}" && -f "${control_env}" ]] || die "Unified conversation control plane is not prepared."
control_plane_project_name="$(control_plane_compose_project_name "${control_env}")"

# All Harness services receive API keys as Docker secrets.  A supplier can be
# configured only after its root-owned secret exists; an unset or broadly
# readable file must never be papered over with an empty Compose value.
: "${GLM_KEY_FILE:?GLM_KEY_FILE is required before a GLM-aware Harness upgrade}"
glm_secret_metadata="$(stat -Lc '%u:%g:%a:%F' -- "${GLM_KEY_FILE}" 2>/dev/null || true)"
[[ -f "${GLM_KEY_FILE}" && ! -L "${GLM_KEY_FILE}" \
  && -s "${GLM_KEY_FILE}" && "${glm_secret_metadata}" == '0:0:600:regular file' ]] \
  || die "GLM API key must be a non-empty root:root mode-0600 regular secret: ${GLM_KEY_FILE}"

upgrade_lock="${DELIVERY_ROOT}/registry/project-material-isolation.lock"
prepare_delivery_lock "${upgrade_lock}"
exec 9>>"${upgrade_lock}"
flock --exclusive --nonblock 9 || die "Another project material isolation upgrade is running."
projects_lock="${DELIVERY_ROOT}/registry/projects.lock"
prepare_delivery_lock "${projects_lock}"
inherited_projects_lock_fd="${FORGE_PROJECTS_LOCK_FD:-}"
if [[ "${inherited_projects_lock_fd}" =~ ^[0-9]+$ \
  && -e "/proc/$$/fd/${inherited_projects_lock_fd}" \
  && "$(readlink -f "/proc/$$/fd/${inherited_projects_lock_fd}")" == "$(readlink -f "${projects_lock}")" ]]; then
  flock --exclusive --nonblock "${inherited_projects_lock_fd}" \
    || die "Inherited project registry lock is not held."
else
  exec 7>>"${projects_lock}"
  flock --exclusive --nonblock 7 \
    || die "A project create, clone, or registry action is active; retry after it finishes."
fi
mapfile -t project_slugs < <(awk -F '\t' 'NR > 1 {print $1}' "${registry_file}" | sort)
((${#project_slugs[@]} > 0)) || die "No registered projects exist."

# Backup/restore and platform upgrade share the same per-project recovery
# locks. Acquire them in sorted slug order so multi-project maintenance cannot
# deadlock with another reviewed lifecycle operation.
declare -a recovery_lock_fds=()
for slug in "${project_slugs[@]}"; do
  recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
  prepare_delivery_lock "${recovery_lock}"
  exec {recovery_lock_fd}>>"${recovery_lock}"
  flock --exclusive --nonblock "${recovery_lock_fd}" \
    || die "A backup or restore operation owns the recovery lock for ${slug}."
  recovery_lock_fds+=("${recovery_lock_fd}")
done
taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"
prepare_delivery_lock "${taskspaces_lock}"
exec 8>>"${taskspaces_lock}"
flock --exclusive --nonblock 8 \
  || die "A TaskSpace lifecycle action is active; retry after it finishes."

# The portable archive intentionally carries no runtime credentials and can be
# extracted by root with a restrictive umask. Keep the control source root-owned,
# but make the exact directory chain traversable by the unprivileged Manager.
# Files retain their archive modes (scripts 0755, configuration/templates 0644).
for runtime_directory in \
  "${REPO_ROOT}" \
  "${SCRIPT_DIR}" \
  "${SCRIPT_DIR}/lib" \
  "${REPO_ROOT}/config" \
  "${REPO_ROOT}/templates" \
  "${REPO_ROOT}/templates/project" \
  "${REPO_ROOT}/templates/taskspace"; do
  [[ -d "${runtime_directory}" ]] || die "Required runtime directory is missing: ${runtime_directory}"
  chmod 0755 "${runtime_directory}"
done
[[ -r "${SCRIPT_DIR}/taskspacectl.sh" && -x "${SCRIPT_DIR}/taskspacectl.sh" ]] \
  || die "TaskSpace control script is not executable after package extraction."

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="${DELIVERY_ROOT}/platform-backups/pre-project-material-isolation-${timestamp}-$$"
maintenance_epoch="toolkit-${timestamp}-$$"
maintenance_root="${DELIVERY_ROOT}/conversation-control-plane/maintenance"
maintenance_fence="${maintenance_root}/gateway-fence.json"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}/projects"
install -m 0600 "${control_env}" "${backup_root}/control-plane.env"

write_gateway_fence() {
  local state="$1" temporary
  [[ "${state}" == maintenance || "${state}" == committed ]] \
    || return 1
  [[ ! -L "${maintenance_root}" && ! -L "${maintenance_fence}" ]] \
    || return 1
  install -d -m 0755 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${maintenance_root}" \
    || return 1
  temporary="$(mktemp "${maintenance_root}/.gateway-fence.XXXXXX")" || return 1
  if ! jq --null-input \
      --arg state "${state}" \
      --arg epoch "${maintenance_epoch}" \
      '{schemaVersion: 1, state: $state, epoch: $epoch}' >"${temporary}" \
    || ! chmod 0644 "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if [[ "${EUID}" -eq 0 ]] \
      && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! mv -- "${temporary}" "${maintenance_fence}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}

gateway_fence_transaction_state() {
  local state
  [[ -f "${maintenance_fence}" && ! -L "${maintenance_fence}" ]] \
    || { printf '%s\n' unknown; return 0; }
  if ! state="$(jq -er --arg epoch "${maintenance_epoch}" '
      if (type == "object"
        and (keys | sort) == ["epoch", "schemaVersion", "state"]
        and .schemaVersion == 1
        and .epoch == $epoch
        and (.state == "maintenance" or .state == "committed"))
      then .state else error("foreign or invalid fence") end
    ' "${maintenance_fence}" 2>/dev/null)"; then
    printf '%s\n' unknown
    return 0
  fi
  printf '%s\n' "${state}"
}

taskspace_maintenance_root_path() {
  local slug="$1" task_id="$2" project_root taskspaces_root task_root maintenance
  local project_real taskspaces_real task_real maintenance_real
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  taskspaces_root="${project_root}/taskspaces"
  task_root="${taskspaces_root}/${task_id}"
  maintenance="${task_root}/maintenance"
  [[ "${slug}" =~ ^[a-z][a-z0-9-]{2,31}$ \
    && "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ \
    && -d "${project_root}" && ! -L "${project_root}" \
    && -d "${taskspaces_root}" && ! -L "${taskspaces_root}" \
    && -d "${task_root}" && ! -L "${task_root}" \
    && -d "${maintenance}" && ! -L "${maintenance}" ]] || return 1
  project_real="$(readlink -f -- "${project_root}")" || return 1
  taskspaces_real="$(readlink -f -- "${taskspaces_root}")" || return 1
  task_real="$(readlink -f -- "${task_root}")" || return 1
  maintenance_real="$(readlink -f -- "${maintenance}")" || return 1
  [[ "${taskspaces_real}" == "${project_real}/taskspaces" \
    && "${task_real}" == "${taskspaces_real}/${task_id}" \
    && "${maintenance_real}" == "${task_real}/maintenance" ]] || return 1
  printf '%s\n' "${maintenance}"
}

write_taskspace_fence() {
  local slug="$1" task_id="$2" state="$3" task_root maintenance fence temporary
  [[ "${state}" == maintenance || "${state}" == committed ]] || return 1
  task_root="${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}"
  [[ -d "${task_root}" && ! -L "${task_root}" ]] || return 1
  [[ ! -L "${task_root}/maintenance" \
    && ( ! -e "${task_root}/maintenance" || -d "${task_root}/maintenance" ) ]] \
    || return 1
  if [[ ! -e "${task_root}/maintenance" ]]; then
    mkdir -m 0750 -- "${task_root}/maintenance" || return 1
  fi
  maintenance="$(taskspace_maintenance_root_path "${slug}" "${task_id}")" || return 1
  chmod 0750 "${maintenance}" || return 1
  if [[ "${EUID}" -eq 0 ]]; then
    chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${maintenance}" || return 1
  fi
  fence="${maintenance}/proxy-fence.json"
  [[ ! -L "${fence}" && ( ! -e "${fence}" || -f "${fence}" ) ]] || return 1
  temporary="$(mktemp "${maintenance}/.proxy-fence.XXXXXX")" || return 1
  if ! jq --null-input \
      --arg state "${state}" \
      --arg epoch "${maintenance_epoch}" \
      '{schemaVersion: 1, state: $state, epoch: $epoch}' >"${temporary}" \
    || ! chmod 0644 "${temporary}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  if [[ "${EUID}" -eq 0 ]] \
      && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  if ! mv -- "${temporary}" "${fence}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  maintenance="$(taskspace_maintenance_root_path "${slug}" "${task_id}")" || return 1
  fence="${maintenance}/proxy-fence.json"
  [[ -f "${fence}" && ! -L "${fence}" \
    && "$(readlink -f -- "${fence}")" == "${maintenance}/proxy-fence.json" ]] || return 1
  jq -e --arg state "${state}" --arg epoch "${maintenance_epoch}" \
    'type == "object"
      and (keys | sort) == ["epoch", "schemaVersion", "state"]
      and .schemaVersion == 1 and .state == $state and .epoch == $epoch' \
    "${fence}" >/dev/null
}

taskspace_fence_transaction_state() {
  local slug="$1" task_id="$2" maintenance fence
  maintenance="$(taskspace_maintenance_root_path "${slug}" "${task_id}" 2>/dev/null)" \
    || { printf '%s\n' unknown; return 0; }
  fence="${maintenance}/proxy-fence.json"
  [[ -f "${fence}" && ! -L "${fence}" ]] \
    || { printf '%s\n' unknown; return 0; }
  if ! jq -er --arg epoch "${maintenance_epoch}" '
      if (type == "object"
        and (keys | sort) == ["epoch", "schemaVersion", "state"]
        and .schemaVersion == 1 and .epoch == $epoch
        and (.state == "maintenance" or .state == "committed"))
      then .state else error("foreign or invalid fence") end
    ' "${fence}" 2>/dev/null; then
    printf '%s\n' unknown
  fi
}

probe_taskspace_maintenance() {
  local slug="$1" task_id="$2" harness_container
  harness_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness)"
  [[ -n "${harness_container}" ]] || return 1
  docker exec "${harness_container}" node -e '
    fetch(`http://127.0.0.1:${process.env.HARNESS_PORT}/forge-maintenance/healthz`)
      .then(async (response) => {
        const text = await response.text();
        let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 256) }; }
        process.stdout.write(JSON.stringify({ httpStatus: response.status, body }));
      })
      .catch(() => process.exit(2));'
}

wait_taskspace_maintenance() {
  local slug="$1" task_id="$2" deadline response
  deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    response="$(probe_taskspace_maintenance "${slug}" "${task_id}" 2>/dev/null || true)"
    if jq -e --arg epoch "${maintenance_epoch}" '
        .httpStatus == 503
          and .body.code == "TASKSPACE_MAINTENANCE"
          and .body.state == "maintenance" and .body.epoch == $epoch
          and .body.drain.mode == "connection-tracked"
          and .body.drain.drained == true
          and .body.drain.activeTcpConnections == 0
          and .body.drain.activeHttpRequests == 0
          and .body.drain.activeUpgradeConnections == 0' \
        <<<"${response}" >/dev/null 2>&1; then
      return 0
    fi
    if jq -e '.body.code == "TASKSPACE_MAINTENANCE"' \
        <<<"${response}" >/dev/null 2>&1; then
      sleep 2
      continue
    fi
    # A legacy proxy has no accept-time latch. Even conversation authorization
    # cannot exclude a raw TCP connection racing the final zero observation, so
    # scanning /proc or session mtimes would recreate the original TOCTOU. Leave
    # the runtime untouched and require a reviewed graceful stop first.
    die "Active legacy TaskSpace ${slug}/${task_id} has no deterministic maintenance fence; stop it gracefully before upgrading."
  done
  return 1
}

wait_taskspace_open() {
  local slug="$1" task_id="$2" deadline=$((SECONDS + 120)) response
  while ((SECONDS < deadline)); do
    response="$(probe_taskspace_maintenance "${slug}" "${task_id}" 2>/dev/null || true)"
    if jq -e --arg epoch "${maintenance_epoch}" \
        '.httpStatus == 200 and .body.ok == true
          and .body.status == "open" and .body.epoch == $epoch' \
        <<<"${response}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

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

install_managed_harness_settings() {
  local destination="$1" staging
  [[ -d "$(dirname -- "${destination}")" && ! -L "$(dirname -- "${destination}")" \
    && ! -L "${destination}" && ( ! -e "${destination}" || -f "${destination}" ) ]] \
    || die "Harness settings destination is unsafe: ${destination}"
  staging="$(mktemp "$(dirname -- "${destination}")/.settings.yaml.XXXXXX")"
  install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${REPO_ROOT}/templates/project/harness-settings.yaml" "${staging}"
  mv -- "${staging}" "${destination}"
}

project_compose() {
  local slug="$1"
  shift
  docker compose \
    --env-file "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" \
    --file "${DELIVERY_ROOT}/projects/${slug}/ops/compose.yaml" "$@"
}

wait_project_manager() {
  local slug="$1" socket="${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}/ipc/manager.sock"
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error --max-time 3 --unix-socket "${socket}" http://localhost/healthz >/dev/null; then
      return 0
    fi
    sleep 2
  done
  project_compose "${slug}" logs --no-color --tail 200 conversation-manager \
    >"${backup_root}/projects/${slug}/conversation-manager.failed.log" 2>&1 || true
  return 1
}

wait_conversation_gateway() {
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error --max-time 3 \
      "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" \
      | jq -e --arg epoch "${maintenance_epoch}" \
        '.ok == true and .status == "open" and .epoch == $epoch' >/dev/null; then
      return 0
    fi
    sleep 2
  done
  docker compose \
    --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    logs --no-color --tail 200 conversation-gateway \
    >"${backup_root}/conversation-gateway.failed.log" 2>&1 || true
  return 1
}

wait_conversation_gateway_maintenance() {
  local deadline=$((SECONDS + 120)) response_file status
  response_file="${backup_root}/conversation-gateway.maintenance-health.json"
  while ((SECONDS < deadline)); do
    status="$(curl --silent --show-error --max-time 3 \
      --output "${response_file}" --write-out '%{http_code}' \
      "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" 2>/dev/null || true)"
    if [[ "${status}" == 503 ]] \
      && jq -e --arg epoch "${maintenance_epoch}" \
        '.ok == false and .status == "maintenance"
          and .code == "GATEWAY_MAINTENANCE"
          and .state == "maintenance" and .epoch == $epoch
          and .drain.mode == "connection-tracked"
          and .drain.drained == true
          and .drain.activeTcpConnections == 0
          and .drain.activeHttpRequests == 0
          and .drain.activeUpgradeConnections == 0' \
        "${response_file}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_conversation_gateway_stopped() {
  local gateway_container
  gateway_container="$(docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    ps --all --quiet conversation-gateway)"
  [[ -n "${gateway_container}" \
    && "$(docker inspect --format '{{.State.Running}}' "${gateway_container}" 2>/dev/null)" == false ]] \
    || die "Conversation Gateway TCP ingress did not hard-drain to a stopped container."
}

wait_project_service_health() {
  local slug="$1" service="$2" container_id deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    container_id="$(project_compose "${slug}" ps --quiet "${service}")"
    if [[ -n "${container_id}" \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)" == healthy ]]; then
      return 0
    fi
    sleep 2
  done
  project_compose "${slug}" logs --no-color --tail 200 "${service}" \
    >"${backup_root}/projects/${slug}/${service}.failed.log" 2>&1 || true
  return 1
}

wait_taskspace_runtime() {
  local slug="$1" task_id="$2" harness_container upload_container deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    harness_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness)"
    upload_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness-upload)"
    if [[ -n "${harness_container}" && -n "${upload_container}" \
      && "$(docker inspect --format '{{.State.Running}}' "${harness_container}" 2>/dev/null)" == true \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${upload_container}" 2>/dev/null)" == healthy ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

container_is_running_and_healthy() {
  local container_id="$1"
  [[ -n "${container_id}" \
    && "$(docker inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null)" == true \
    && "$(docker inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)" == healthy ]]
}

container_uses_target_image() {
  local container_id="$1" expected_image_ref="$2"
  container_is_running_and_healthy "${container_id}" \
    && [[ "$(docker inspect --format '{{.Config.Image}}' "${container_id}")" == "${expected_image_ref}" \
      && "$(docker inspect --format '{{.Image}}' "${container_id}")" == "${target_image_id}" ]]
}

assert_control_runtime_ready() {
  local gateway_container slug service container_id
  gateway_container="$(docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    ps --quiet conversation-gateway)"
  container_is_running_and_healthy "${gateway_container}" \
    || die "Conversation Gateway must be running and healthy before maintenance."
  for slug in "${project_slugs[@]}"; do
    for service in conversation-manager release-runner taskspace-broker; do
      container_id="$(project_compose "${slug}" ps --quiet "${service}")"
      container_is_running_and_healthy "${container_id}" \
        || die "${service} must be running and healthy for ${slug} before maintenance."
    done
  done
}

verify_target_control_runtime() {
  local gateway_container slug service container_id
  [[ "$(docker image inspect --format '{{.Id}}' "${harness_image_source}")" == "${target_image_id}" \
    && "$(docker image inspect --format '{{.Id}}' "${release_runner_image_source}")" == "${target_image_id}" ]] \
    || die "Harness image tag changed during cutover; rollback is required."
  gateway_container="$(docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    ps --quiet conversation-gateway)"
  container_uses_target_image "${gateway_container}" "${target_image_id}" \
    || die "Conversation Gateway did not converge to immutable image ${target_image_id}."
  for slug in "${project_slugs[@]}"; do
    for service in conversation-manager release-runner taskspace-broker; do
      container_id="$(project_compose "${slug}" ps --quiet "${service}")"
      container_uses_target_image "${container_id}" "${target_image_id}" \
        || die "${service} for ${slug} did not converge to immutable image ${target_image_id}."
    done
  done
}

assert_project_release_idle() {
  local slug="$1"
  project_release_is_idle "${slug}" \
    || die "Release Runner/Broker is active, unhealthy, or locked for ${slug}; retry after recovery or release completion."
}

project_release_is_idle() {
  local slug="$1" broker_container
  runner_release_is_idle "${slug}" || return 1
  broker_container="$(project_compose "${slug}" ps --quiet taskspace-broker)"
  [[ -n "${broker_container}" ]] || return 1
  docker exec "${broker_container}" node -e \
    "fetch('http://127.0.0.1:3100/healthz').then(async r=>{const v=await r.json();if(!r.ok||v.active!==false)process.exit(1)}).catch(()=>process.exit(1))" \
    >/dev/null
}

runner_release_is_idle() {
  local slug="$1" runner_socket project_root
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  [[ ! -e "${project_root}/taskspaces/.broker/release.lock" ]] || return 1
  runner_socket="${project_root}/ops/release-ipc/runner.sock"
  [[ -S "${runner_socket}" ]] || return 1
  curl --fail --silent --show-error --max-time 5 --unix-socket "${runner_socket}" \
      http://localhost/healthz \
    | jq -e '.ok == true and .active == false' >/dev/null
}

wait_project_runner_idle() {
  local slug="$1" deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    if runner_release_is_idle "${slug}"; then return 0; fi
    sleep 2
  done
  project_compose "${slug}" logs --no-color --tail 200 release-runner \
    >"${backup_root}/projects/${slug}/release-runner.drain-timeout.log" 2>&1 || true
  return 1
}

assert_project_sessions_idle() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" recent_session
  if ! recent_session="$(find "${project_root}" -path '*/dsh-home/sessions/*' -type f \
      -name 'session.jsonl.zstd' -mmin -2 -print -quit 2>/dev/null)"; then
    die "Harness session state could not be inspected for ${slug}; maintenance failed closed."
  fi
  if [[ -n "${recent_session}" ]]; then
    die "Harness session state changed in the last two minutes for ${slug}; no project or TaskSpace runtime was changed."
  fi
}

assert_task_sessions_idle() {
  local slug="$1" task_id="$2" task_root recent_session
  task_root="${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}"
  if ! recent_session="$(find "${task_root}" -path '*/dsh-home/sessions/*' -type f \
      -name 'session.jsonl.zstd' -mmin -2 -print -quit 2>/dev/null)"; then
    die "Harness session state could not be inspected for ${slug}/${task_id}; maintenance failed closed."
  fi
  if [[ -n "${recent_session}" ]]; then
    die "Harness session state changed in the last two minutes for ${slug}/${task_id}; the drained runtime will be restored."
  fi
}

capture_project_session_manifest() {
  local slug="$1" output="$2" project_root session_file relative
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  [[ -d "${project_root}" && ! -L "${project_root}" ]] \
    || die "Project root is unsafe for session snapshot: ${slug}"
  if [[ -n "$(find "${project_root}" -path '*/dsh-home/sessions/*' -type l -print -quit 2>/dev/null)" ]]; then
    die "Harness session state contains a symbolic link and cannot be snapshotted safely: ${slug}"
  fi
  : >"${output}"
  while IFS= read -r -d '' session_file; do
    [[ -f "${session_file}" && ! -L "${session_file}" ]] \
      || die "Harness session file changed type during snapshot: ${slug}"
    relative="${session_file#"${project_root}/"}"
    [[ "${relative}" != "${session_file}" && "${relative}" != ../* ]] \
      || die "Harness session file escaped the project root: ${slug}"
    printf '%s\t%s\n' "$(sha256sum "${session_file}" | awk '{print $1}')" "${relative}" \
      >>"${output}"
  done < <(find "${project_root}" -path '*/dsh-home/sessions/*' -type f \
    -print0 | sort -z)
}

backup_project_sessions() {
  local slug="$1" project_root target directory relative
  local -a session_directories=()
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  target="${backup_root}/projects/${slug}/session-state.tar.gz"
  if [[ -d "${project_root}/dsh-home/sessions" && ! -L "${project_root}/dsh-home/sessions" ]]; then
    session_directories+=(dsh-home/sessions)
  fi
  shopt -s nullglob
  for directory in "${project_root}"/taskspaces/*/dsh-home/sessions; do
    [[ -d "${directory}" && ! -L "${directory}" ]] \
      || { shopt -u nullglob; die "TaskSpace session root is unsafe for backup: ${directory}"; }
    relative="${directory#"${project_root}/"}"
    [[ "${relative}" != "${directory}" && "${relative}" != ../* ]] \
      || { shopt -u nullglob; die "TaskSpace session root escaped the project: ${directory}"; }
    [[ -z "$(find "${directory}" -type l -print -quit 2>/dev/null)" ]] \
      || { shopt -u nullglob; die "TaskSpace session root contains a symbolic link: ${directory}"; }
    session_directories+=("${relative}")
  done
  shopt -u nullglob
  if ((${#session_directories[@]} == 0)); then
    tar --create --gzip --file "${target}" --files-from /dev/null
  else
    tar --create --gzip --file "${target}" --directory "${project_root}" -- \
      "${session_directories[@]}"
  fi
  [[ -f "${target}" && ! -L "${target}" ]] \
    || die "Harness session backup was not created safely: ${slug}"
}

prepare_project_governance_context() {
  local slug="$1" project_root workspace governance_root context hash_file legacy
  local project_real workspace_real governance_real context_real hash_real temporary
  local expected_hash actual_hash task_workspace task_context
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  workspace="${project_root}/workspace"
  governance_root="${project_root}/governance"
  context="${governance_root}/PROJECT_CONTEXT.md"
  hash_file="${governance_root}/PROJECT_CONTEXT.sha256"
  legacy="${workspace}/PROJECT_CONTEXT.md"
  [[ -d "${project_root}" && ! -L "${project_root}" \
    && -d "${workspace}" && ! -L "${workspace}" \
    && ! -L "${governance_root}" ]] \
    || die "Project governance roots are unsafe: ${slug}"
  project_real="$(readlink -f -- "${project_root}")"
  workspace_real="$(readlink -f -- "${workspace}")"
  [[ "${workspace_real}" == "${project_real}/workspace" ]] \
    || die "Project workspace escaped its root during governance admission: ${slug}"

  if [[ ! -e "${context}" && ! -L "${context}" ]]; then
    [[ ! -e "${hash_file}" && ! -L "${hash_file}" ]] \
      || die "Incomplete project governance state cannot be migrated automatically: ${slug}"
    project_git_readonly "${workspace}" ls-files --error-unmatch -- PROJECT_CONTEXT.md >/dev/null 2>&1 \
      && die "Tracked PROJECT_CONTEXT.md conflicts with the platform-controlled TaskSpace path: ${slug}"
    [[ -f "${legacy}" && ! -L "${legacy}" ]] \
      || die "Legacy project governance context is unavailable for migration: ${slug}"
    dd if="${legacy}" iflag=nofollow status=none \
      | grep -Fx -- '<!-- forge-delivery-project-context-v1 -->' >/dev/null \
      || die "Legacy project governance context lacks its managed identity: ${slug}"
    install -d -m 0750 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${governance_root}"
    governance_real="$(readlink -f -- "${governance_root}")"
    [[ "${governance_real}" == "${project_real}/governance" ]] \
      || die "Project governance root escaped during migration: ${slug}"
    temporary="$(mktemp "${governance_root}/.PROJECT_CONTEXT.XXXXXX")"
    [[ -f "${temporary}" && ! -L "${temporary}" ]] \
      || die "Project governance staging file is unsafe: ${slug}"
    if ! dd if="${legacy}" iflag=nofollow of="${temporary}" oflag=nofollow \
        conv=fsync status=none \
      || ! chmod 0444 "${temporary}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      die "Project governance context migration failed: ${slug}"
    fi
    if [[ "${EUID}" -eq 0 ]] \
        && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      die "Project governance context ownership migration failed: ${slug}"
    fi
    if ! mv -- "${temporary}" "${context}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      die "Project governance context publication failed: ${slug}"
    fi
    temporary="$(mktemp "${governance_root}/.PROJECT_CONTEXT.sha256.XXXXXX")"
    [[ -f "${temporary}" && ! -L "${temporary}" ]] \
      || { rm -f -- "${temporary}" "${context}" 2>/dev/null || true; die "Project governance hash staging file is unsafe: ${slug}"; }
    if ! printf '%s\n' "$(dd if="${context}" iflag=nofollow status=none | sha256sum | awk '{print $1}')" \
        | dd of="${temporary}" oflag=nofollow conv=fsync status=none \
      || ! chmod 0444 "${temporary}"; then
      rm -f -- "${temporary}" "${context}" 2>/dev/null || true
      die "Project governance hash migration failed: ${slug}"
    fi
    if [[ "${EUID}" -eq 0 ]] \
        && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
      rm -f -- "${temporary}" "${context}" 2>/dev/null || true
      die "Project governance hash ownership migration failed: ${slug}"
    fi
    if ! mv -- "${temporary}" "${hash_file}"; then
      rm -f -- "${temporary}" "${context}" 2>/dev/null || true
      die "Project governance hash publication failed: ${slug}"
    fi
  fi

  [[ -d "${governance_root}" && ! -L "${governance_root}" \
    && -f "${context}" && ! -L "${context}" \
    && -f "${hash_file}" && ! -L "${hash_file}" ]] \
    || die "Project governance context is incomplete or unsafe: ${slug}"
  governance_real="$(readlink -f -- "${governance_root}")"
  context_real="$(readlink -f -- "${context}")"
  hash_real="$(readlink -f -- "${hash_file}")"
  [[ "${governance_real}" == "${project_real}/governance" \
    && "${context_real}" == "${governance_real}/PROJECT_CONTEXT.md" \
    && "${hash_real}" == "${governance_real}/PROJECT_CONTEXT.sha256" ]] \
    || die "Project governance context escaped its root: ${slug}"
  expected_hash="$(dd if="${hash_file}" iflag=nofollow status=none)"
  [[ "${expected_hash}" =~ ^[0-9a-f]{64}$ ]] \
    || die "Project governance hash is invalid: ${slug}"
  actual_hash="$(dd if="${context}" iflag=nofollow status=none | sha256sum | awk '{print $1}')"
  [[ "${actual_hash}" == "${expected_hash}" ]] \
    || die "Project governance context failed hash admission: ${slug}"
  dd if="${context}" iflag=nofollow status=none \
    | grep -Fx -- '<!-- forge-delivery-project-context-v1 -->' >/dev/null \
    || die "Project governance context lacks its managed identity: ${slug}"
  if [[ -e "${legacy}" || -L "${legacy}" ]]; then
    project_git_readonly "${workspace}" ls-files --error-unmatch -- PROJECT_CONTEXT.md >/dev/null 2>&1 \
      && die "Tracked PROJECT_CONTEXT.md conflicts with the platform-controlled TaskSpace path: ${slug}"
    [[ -f "${legacy}" && ! -L "${legacy}" \
      && "$(dd if="${legacy}" iflag=nofollow status=none | sha256sum | awk '{print $1}')" == "${expected_hash}" ]] \
      || die "Legacy PROJECT_CONTEXT.md drifted from the platform authority: ${slug}"
  fi
  if project_git_readonly "${workspace}" ls-files --error-unmatch -- AGENTS.md >/dev/null 2>&1; then
    [[ -f "${workspace}/AGENTS.md" && ! -L "${workspace}/AGENTS.md" ]] \
      || die "Tracked AGENTS.md must remain a regular non-symbolic-link file: ${slug}"
  elif [[ -e "${workspace}/AGENTS.md" || -L "${workspace}/AGENTS.md" ]]; then
    die "Untracked AGENTS.md is ambiguous; the upgrade will not rewrite or adopt it: ${slug}"
  fi
  shopt -s nullglob
  for task_workspace in "${project_root}"/taskspaces/*/workspace; do
    [[ -d "${task_workspace}" && ! -L "${task_workspace}" \
      && -d "${task_workspace}/.git" && ! -L "${task_workspace}/.git" ]] \
      || { shopt -u nullglob; die "TaskSpace workspace is unsafe during governance admission: ${task_workspace}"; }
    task_context="${task_workspace}/PROJECT_CONTEXT.md"
    project_git_readonly "${task_workspace}" ls-files --error-unmatch -- PROJECT_CONTEXT.md >/dev/null 2>&1 \
      && { shopt -u nullglob; die "Tracked TaskSpace PROJECT_CONTEXT.md conflicts with the platform mount: ${task_workspace}"; }
    if [[ -e "${task_context}" || -L "${task_context}" ]]; then
      [[ -f "${task_context}" && ! -L "${task_context}" \
        && ( ! -s "${task_context}" \
          || "$(dd if="${task_context}" iflag=nofollow status=none | sha256sum | awk '{print $1}')" == "${expected_hash}" ) ]] \
        || { shopt -u nullglob; die "TaskSpace PROJECT_CONTEXT.md is drifted or unsafe: ${task_workspace}"; }
    fi
    if project_git_readonly "${task_workspace}" ls-files --error-unmatch -- AGENTS.md >/dev/null 2>&1; then
      [[ -f "${task_workspace}/AGENTS.md" && ! -L "${task_workspace}/AGENTS.md" ]] \
        || { shopt -u nullglob; die "Tracked TaskSpace AGENTS.md is unsafe: ${task_workspace}"; }
    elif [[ -e "${task_workspace}/AGENTS.md" || -L "${task_workspace}/AGENTS.md" ]]; then
      shopt -u nullglob
      die "Untracked TaskSpace AGENTS.md is ambiguous and will not be overwritten: ${task_workspace}"
    fi
  done
  shopt -u nullglob
}

task_compose() {
  local slug="$1" task_id="$2" task_root
  local -a network_args=()
  shift 2
  task_root="${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}"
  taskspace_network_compose_args "${task_root}" "${slug}/${task_id}" network_args \
    || { printf 'TaskSpace network contract validation failed: %s/%s\n' "${slug}" "${task_id}" >&2; return 1; }
  docker compose --env-file "${task_root}/task.env" \
    --file "${REPO_ROOT}/templates/taskspace/compose.yaml" \
    "${network_args[@]}" "$@"
}

file_env_value() {
  local file="$1" key="$2"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${file}"
}

assert_runtime_inventory_exact() {
  local slug project_root project_env project_name metadata task_id status task_root task_project
  local inventory container_id compose_project service key
  declare -A expected=()
  declare -A observed=()
  expected["${control_plane_project_name}|conversation-gateway"]=1
  for slug in "${project_slugs[@]}"; do
    project_root="${DELIVERY_ROOT}/projects/${slug}"
    project_env="${project_root}/ops/project.env"
    project_name="$(file_env_value "${project_env}" COMPOSE_PROJECT_NAME)"
    [[ "${project_name}" == "forge-${slug}" ]] \
      || die "Project Compose identity is not canonical for ${slug}."
    expected["${project_name}|conversation-manager"]=1
    expected["${project_name}|release-runner"]=1
    expected["${project_name}|taskspace-broker"]=1
    shopt -s nullglob
    for metadata in "${project_root}"/taskspaces/*/metadata.json; do
      task_id="$(basename -- "$(dirname -- "${metadata}")")"
      [[ "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ \
        && "$(jq -er '.taskId' "${metadata}")" == "${task_id}" ]] \
        || { shopt -u nullglob; die "TaskSpace metadata identity is invalid for ${slug}: ${metadata}"; }
      status="$(jq -er '.status | strings' "${metadata}")"
      [[ "${status}" == active ]] || continue
      task_root="${project_root}/taskspaces/${task_id}"
      [[ -f "${task_root}/task.env" ]] \
        || { shopt -u nullglob; die "Active TaskSpace env is missing: ${slug}/${task_id}"; }
      task_project="$(file_env_value "${task_root}/task.env" TASKSPACE_COMPOSE_PROJECT_NAME)"
      [[ "${task_project}" == "forge-${slug}-task-${task_id}" ]] \
        || { shopt -u nullglob; die "TaskSpace Compose identity is not canonical: ${slug}/${task_id}"; }
      expected["${task_project}|harness"]=1
      expected["${task_project}|harness-upload"]=1
    done
    shopt -u nullglob
  done

  inventory="$(docker ps -a --format '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}')" \
    || die "Docker runtime inventory could not be enumerated."
  while IFS=$'\t' read -r container_id compose_project service; do
    [[ -n "${container_id}" ]] || continue
    case "${service}" in
      conversation-gateway|conversation-manager|release-runner|taskspace-broker|harness|harness-upload) ;;
      *) continue ;;
    esac
    [[ "${compose_project}" =~ ^[a-z0-9][a-z0-9_-]{0,127}$ ]] \
      || die "Governed runtime has an invalid Compose project label: ${container_id}"
    key="${compose_project}|${service}"
    [[ -n "${compose_project}" && -n "${expected[${key}]+present}" ]] \
      || die "Unregistered, inactive, legacy, or orphan governed runtime container exists: ${container_id} ${key}"
    observed["${key}"]=$(( ${observed[${key}]:-0} + 1 ))
  done <<<"${inventory}"
  for key in "${!expected[@]}"; do
    [[ "${observed[${key}]:-0}" -eq "${expected[${key}]}" ]] \
      || die "Governed runtime inventory is not exact for ${key}: expected ${expected[${key}]}, observed ${observed[${key}]:-0}."
  done
}

assert_taskspace_runtime_removed() {
  local slug="$1" task_id="$2" remaining
  remaining="$(task_compose "${slug}" "${task_id}" ps --all --quiet harness harness-upload)" \
    || die "TaskSpace runtime inventory could not be read after hard drain: ${slug}/${task_id}"
  [[ -z "${remaining}" ]] \
    || die "TaskSpace TCP/WebSocket runtime did not hard-drain completely: ${slug}/${task_id}"
}

verify_target_active_taskspaces() {
  local slug task_id harness_container upload_container
  for slug in "${project_slugs[@]}"; do
    while IFS= read -r task_id; do
      [[ -n "${task_id}" ]] || continue
      wait_taskspace_runtime "${slug}" "${task_id}" \
        || die "Active TaskSpace ${slug}/${task_id} did not become healthy."
      harness_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness)"
      upload_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness-upload)"
      [[ "$(docker inspect --format '{{.Config.Image}}' "${harness_container}")" == "${target_image_id}" \
        && "$(docker inspect --format '{{.Config.Image}}' "${upload_container}")" == "${target_image_id}" \
        && "$(docker inspect --format '{{.Image}}' "${harness_container}")" == "${target_image_id}" \
        && "$(docker inspect --format '{{.Image}}' "${upload_container}")" == "${target_image_id}" ]] \
        || die "Active TaskSpace ${slug}/${task_id} did not converge to immutable image ${target_image_id}."
      docker exec "${harness_container}" node /usr/local/lib/validate-skill-bundle.mjs \
        --skills-root /usr/local/share/dsh-skills \
        --catalog /usr/local/share/dsh-skills.catalog.json \
        --strict >/dev/null \
        || die "Active TaskSpace ${slug}/${task_id} failed strict Skill bundle validation."
      docker exec "${harness_container}" forge-delivery --help >/dev/null \
        || die "Active TaskSpace ${slug}/${task_id} does not expose forge-delivery."
    done <"${backup_root}/projects/${slug}/active-taskspaces.before"
  done
}

taskspace_git_exclude_path() {
  local task_root="$1" label="${2:-TaskSpace}"
  local workspace="${task_root}/workspace" git_dir info_dir exclude_file
  local task_root_real workspace_real git_real info_real exclude_real
  git_dir="${workspace}/.git"
  info_dir="${git_dir}/info"
  exclude_file="${info_dir}/exclude"

  [[ -d "${task_root}" && ! -L "${task_root}" ]] \
    || { printf 'Unsafe TaskSpace root for Git exclude (%s): %s\n' "${label}" "${task_root}" >&2; return 1; }
  [[ -d "${workspace}" && ! -L "${workspace}" ]] \
    || { printf 'TaskSpace workspace must be a real directory, not a symbolic link (%s).\n' "${label}" >&2; return 1; }
  [[ -d "${git_dir}" && ! -L "${git_dir}" ]] \
    || { printf 'TaskSpace .git must be a real directory; gitfile worktrees are unsupported (%s).\n' "${label}" >&2; return 1; }
  [[ -d "${info_dir}" && ! -L "${info_dir}" ]] \
    || { printf 'TaskSpace .git/info must be a real directory, not a symbolic link (%s).\n' "${label}" >&2; return 1; }
  [[ ! -L "${exclude_file}" && ( ! -e "${exclude_file}" || -f "${exclude_file}" ) ]] \
    || { printf 'TaskSpace Git exclude must be absent or a regular non-symbolic-link file (%s).\n' "${label}" >&2; return 1; }

  task_root_real="$(readlink -f -- "${task_root}")" || return 1
  workspace_real="$(readlink -f -- "${workspace}")" || return 1
  git_real="$(readlink -f -- "${git_dir}")" || return 1
  info_real="$(readlink -f -- "${info_dir}")" || return 1
  if [[ -e "${exclude_file}" ]]; then
    exclude_real="$(readlink -f -- "${exclude_file}")" || return 1
  else
    exclude_real="${info_real}/exclude"
  fi
  [[ "${workspace_real}" == "${task_root_real}/workspace" \
    && "${git_real}" == "${workspace_real}/.git" \
    && "${info_real}" == "${workspace_real}/.git/info" \
    && "${exclude_real}" == "${workspace_real}/.git/info/exclude" ]] \
    || { printf 'TaskSpace Git exclude resolved outside its workspace boundary (%s).\n' "${label}" >&2; return 1; }

  printf '%s\n' "${exclude_file}"
}

ensure_taskspace_git_exclude_contract() {
  local task_root="$1" label="${2:-TaskSpace}" exclude_file line
  exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
  if [[ ! -e "${exclude_file}" ]]; then
    exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
    if ! (umask 0077; dd if=/dev/null of="${exclude_file}" \
        conv=excl oflag=nofollow status=none) 2>/dev/null; then
      exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
      [[ -f "${exclude_file}" ]] || return 1
    fi
  fi
  exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
  [[ -f "${exclude_file}" ]] || return 1
  # PROJECT_CONTEXT.md is only an inert nested-bind mountpoint in the clone;
  # the admitted content lives under the platform-owned governance root.
  for line in '/.forge-cache/' '/.forge-delivery/' '/PROJECT_CONTEXT.md'; do
    exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
    if ! dd if="${exclude_file}" iflag=nofollow status=none \
        | grep -Fx -- "${line}" >/dev/null; then
      exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
      printf '%s\n' "${line}" \
        | dd of="${exclude_file}" oflag=append,nofollow conv=notrunc,nocreat status=none \
        || return 1
      exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
      dd if="${exclude_file}" iflag=nofollow status=none \
        | grep -Fx -- "${line}" >/dev/null \
        || return 1
    fi
  done
  printf '%s\n' "${exclude_file}"
}

backup_project() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" target="${backup_root}/projects/${slug}"
  local task_id task_root exclude_source metadata harness_container upload_container
  local harness_image_id upload_image_id metadata_hash task_env_hash container_id image_tag image_id settings_source
  local governance_name governance_source
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${target}/task-env" "${target}/task-compose" "${target}/task-exclude" \
    "${target}/project-governance" "${target}/harness-settings/taskspaces"
  install -m 0600 "${project_root}/ops/project.env" "${target}/project.env"
  install -m 0640 "${project_root}/ops/compose.yaml" "${target}/compose.yaml"
  settings_source="${project_root}/dsh-home/settings.yaml"
  [[ -f "${settings_source}" && ! -L "${settings_source}" ]] \
    || die "Project Harness settings are missing or unsafe: ${slug}"
  install -m 0600 "${settings_source}" "${target}/harness-settings/project.settings.yaml"
  if [[ -L "${project_root}/governance" ]]; then
    die "Project governance root is a symbolic link and cannot be backed up: ${slug}"
  elif [[ ! -e "${project_root}/governance" ]]; then
    : >"${target}/project-governance/root.missing"
  elif [[ -d "${project_root}/governance" ]]; then
    : >"${target}/project-governance/root.existed"
    for governance_name in PROJECT_CONTEXT.md PROJECT_CONTEXT.sha256; do
      governance_source="${project_root}/governance/${governance_name}"
      if [[ -L "${governance_source}" ]]; then
        die "Project governance file is a symbolic link and cannot be backed up: ${slug}/${governance_name}"
      elif [[ -f "${governance_source}" ]]; then
        cp --no-dereference --preserve=mode,ownership,timestamps -- \
          "${governance_source}" "${target}/project-governance/${governance_name}"
      elif [[ ! -e "${governance_source}" ]]; then
        : >"${target}/project-governance/${governance_name}.missing"
      else
        die "Project governance path is not a regular file: ${slug}/${governance_name}"
      fi
    done
  else
    die "Project governance root is not a directory: ${slug}"
  fi
  shopt -s nullglob
  for task_env in "${project_root}"/taskspaces/*/task.env; do
    task_id="$(basename -- "$(dirname -- "${task_env}")")"
    task_root="$(dirname -- "${task_env}")"
    install -m 0600 "${task_env}" "${target}/task-env/${task_id}.env"
    settings_source="${task_root}/dsh-home/settings.yaml"
    [[ -f "${settings_source}" && ! -L "${settings_source}" ]] \
      || { shopt -u nullglob; die "TaskSpace Harness settings are missing or unsafe: ${slug}/${task_id}"; }
    install -m 0600 "${settings_source}" \
      "${target}/harness-settings/taskspaces/${task_id}.settings.yaml"
    if [[ -f "${task_root}/compose.yaml" ]]; then
      install -m 0640 "${task_root}/compose.yaml" "${target}/task-compose/${task_id}.yaml"
    fi
    exclude_source="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
      || die "TaskSpace Git exclude path is unsafe and cannot be backed up: ${slug}/${task_id}"
    if [[ -e "${exclude_source}" ]]; then
      exclude_source="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
        || die "TaskSpace Git exclude path changed before backup: ${slug}/${task_id}"
      cp --no-dereference --preserve=mode,ownership,timestamps -- \
        "${exclude_source}" "${target}/task-exclude/${task_id}.exclude"
      taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}" >/dev/null \
        || die "TaskSpace Git exclude path changed during backup: ${slug}/${task_id}"
      [[ -f "${target}/task-exclude/${task_id}.exclude" \
        && ! -L "${target}/task-exclude/${task_id}.exclude" ]] \
        || die "TaskSpace Git exclude backup is not a regular file: ${slug}/${task_id}"
    else
      exclude_source="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
        || die "TaskSpace Git exclude path changed before missing-state backup: ${slug}/${task_id}"
      [[ ! -e "${exclude_source}" ]] \
        || die "TaskSpace Git exclude appeared during backup: ${slug}/${task_id}"
      : >"${target}/task-exclude/${task_id}.missing"
      exclude_source="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
        || die "TaskSpace Git exclude path changed during missing-state backup: ${slug}/${task_id}"
      [[ ! -e "${exclude_source}" ]] \
        || die "TaskSpace Git exclude appeared during backup: ${slug}/${task_id}"
    fi
  done
  : >"${target}/active-taskspaces.before"
  printf 'taskId\tmetadataSha256\ttaskEnvSha256\tharnessContainer\tharnessImage\tuploadContainer\tuploadImage\n' \
    >"${target}/active-taskspaces.manifest.tsv"
  for metadata in "${project_root}"/taskspaces/*/metadata.json; do
    [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
    task_id="$(jq -er '.taskId' "${metadata}")"
    [[ "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ \
      && "${task_id}" == "$(basename -- "$(dirname -- "${metadata}")")" ]] \
      || die "Active TaskSpace identity is invalid for ${slug}: ${metadata}"
    task_root="${project_root}/taskspaces/${task_id}"
    [[ -f "${task_root}/task.env" ]] || die "Active TaskSpace env is missing: ${slug}/${task_id}"
    harness_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness)"
    upload_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness-upload)"
    [[ -n "${harness_container}" && -n "${upload_container}" \
      && "$(docker inspect --format '{{.State.Running}}' "${harness_container}" 2>/dev/null)" == true \
      && "$(docker inspect --format '{{.State.Running}}' "${upload_container}" 2>/dev/null)" == true ]] \
      || die "Active TaskSpace containers must be running before maintenance: ${slug}/${task_id}"
    harness_image_id="$(docker inspect --format '{{.Image}}' "${harness_container}")"
    upload_image_id="$(docker inspect --format '{{.Image}}' "${upload_container}")"
    docker image inspect "${harness_image_id}" "${upload_image_id}" >/dev/null 2>&1 \
      || die "Rollback image content is unavailable for ${slug}/${task_id}."
    metadata_hash="$(sha256sum "${metadata}" | awk '{print $1}')"
    task_env_hash="$(sha256sum "${task_root}/task.env" | awk '{print $1}')"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${task_id}" "${metadata_hash}" "${task_env_hash}" \
      "${harness_container}" "${harness_image_id}" "${upload_container}" "${upload_image_id}" \
      >>"${target}/active-taskspaces.manifest.tsv"
    printf '%s\n' "${task_id}" >>"${target}/active-taskspaces.before"
  done
  shopt -u nullglob
  : >"${target}/application-container-ids.before"
  for service in forge-admin forge-app forge-flow forge-ui; do
    project_compose "${slug}" ps --quiet "${service}" | xargs -r docker inspect --format '{{.Id}}' \
      >>"${target}/application-container-ids.before"
  done
  printf 'service\tconfigImage\timageId\n' >"${target}/control-runtime.before.tsv"
  for service in conversation-manager release-runner taskspace-broker; do
    container_id="$(project_compose "${slug}" ps --quiet "${service}")"
    image_tag="$(docker inspect --format '{{.Config.Image}}' "${container_id}")"
    image_id="$(docker inspect --format '{{.Image}}' "${container_id}")"
    docker image inspect "${image_id}" >/dev/null 2>&1 \
      || die "Rollback image content is unavailable for ${slug}/${service}."
    printf '%s\t%s\t%s\n' "${service}" "${image_tag}" "${image_id}" \
      >>"${target}/control-runtime.before.tsv"
  done
}

backup_gateway_runtime() {
  local gateway_container image_tag image_id
  gateway_container="$(docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    ps --quiet conversation-gateway)"
  image_tag="$(docker inspect --format '{{.Config.Image}}' "${gateway_container}")"
  image_id="$(docker inspect --format '{{.Image}}' "${gateway_container}")"
  docker image inspect "${image_id}" >/dev/null 2>&1 \
    || die "Rollback image content is unavailable for the Conversation Gateway."
  printf 'service\tconfigImage\timageId\nconversation-gateway\t%s\t%s\n' \
    "${image_tag}" "${image_id}" >"${backup_root}/gateway-runtime.before.tsv"
}

verify_active_manifest_unchanged() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" manifest
  local task_id metadata_hash task_env_hash _harness_container _harness_image _upload_container _upload_image
  manifest="${backup_root}/projects/${slug}/active-taskspaces.manifest.tsv"
  while IFS=$'\t' read -r task_id metadata_hash task_env_hash \
      _harness_container _harness_image _upload_container _upload_image; do
    [[ "${task_id}" != taskId ]] || continue
    [[ "$(sha256sum "${project_root}/taskspaces/${task_id}/metadata.json" | awk '{print $1}')" == "${metadata_hash}" \
      && "$(sha256sum "${project_root}/taskspaces/${task_id}/task.env" | awk '{print $1}')" == "${task_env_hash}" ]] \
      || die "TaskSpace control files drifted during maintenance drain: ${slug}/${task_id}"
  done <"${manifest}"
}

restore_project_files() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/${slug}" source="${backup_root}/projects/${slug}"
  local task_id task_root exclude_target governance_name settings_source settings_target
  install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${source}/project.env" "${project_root}/ops/project.env" || return 1
  install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${source}/compose.yaml" "${project_root}/ops/compose.yaml" || return 1
  settings_source="${source}/harness-settings/project.settings.yaml"
  settings_target="${project_root}/dsh-home/settings.yaml"
  [[ -f "${settings_source}" && ! -L "${settings_source}" \
    && -d "${project_root}/dsh-home" && ! -L "${project_root}/dsh-home" \
    && ! -L "${settings_target}" ]] || return 1
  install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${settings_source}" "${settings_target}" || return 1
  if [[ -f "${source}/project-governance/root.missing" ]]; then
    [[ ! -L "${project_root}/governance" ]] || return 1
    rm -f -- \
      "${project_root}/governance/PROJECT_CONTEXT.md" \
      "${project_root}/governance/PROJECT_CONTEXT.sha256" || return 1
    rmdir -- "${project_root}/governance" 2>/dev/null || true
  elif [[ -f "${source}/project-governance/root.existed" ]]; then
    [[ ! -L "${project_root}/governance" ]] || return 1
    install -d -m 0750 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${project_root}/governance" || return 1
    for governance_name in PROJECT_CONTEXT.md PROJECT_CONTEXT.sha256; do
      if [[ -f "${source}/project-governance/${governance_name}" \
          && ! -L "${source}/project-governance/${governance_name}" ]]; then
        cp --no-dereference --remove-destination --preserve=mode,ownership,timestamps -- \
          "${source}/project-governance/${governance_name}" \
          "${project_root}/governance/${governance_name}" || return 1
      elif [[ -f "${source}/project-governance/${governance_name}.missing" ]]; then
        rm -f -- "${project_root}/governance/${governance_name}" || return 1
      else
        return 1
      fi
    done
  else
    return 1
  fi
  shopt -s nullglob
  for backup_env in "${source}"/task-env/*.env; do
    local task_id
    task_id="$(basename -- "${backup_env}" .env)"
    install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_env}" "${project_root}/taskspaces/${task_id}/task.env" \
      || { shopt -u nullglob; return 1; }
    if [[ -f "${source}/task-compose/${task_id}.yaml" ]]; then
      install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
        "${source}/task-compose/${task_id}.yaml" "${project_root}/taskspaces/${task_id}/compose.yaml" \
        || { shopt -u nullglob; return 1; }
    fi
    task_root="${project_root}/taskspaces/${task_id}"
    settings_source="${source}/harness-settings/taskspaces/${task_id}.settings.yaml"
    settings_target="${task_root}/dsh-home/settings.yaml"
    [[ -f "${settings_source}" && ! -L "${settings_source}" \
      && -d "${task_root}/dsh-home" && ! -L "${task_root}/dsh-home" \
      && ! -L "${settings_target}" ]] || { shopt -u nullglob; return 1; }
    install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${settings_source}" "${settings_target}" || { shopt -u nullglob; return 1; }
    exclude_target="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
      || { shopt -u nullglob; return 1; }
    if [[ -f "${source}/task-exclude/${task_id}.exclude" ]]; then
      [[ ! -L "${source}/task-exclude/${task_id}.exclude" ]] \
        || { shopt -u nullglob; return 1; }
      exclude_target="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
        || { shopt -u nullglob; return 1; }
      cp --no-dereference --remove-destination --preserve=mode,ownership,timestamps -- \
        "${source}/task-exclude/${task_id}.exclude" "${exclude_target}" \
        || { shopt -u nullglob; return 1; }
      taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}" >/dev/null \
        || { shopt -u nullglob; return 1; }
    elif [[ -f "${source}/task-exclude/${task_id}.missing" ]]; then
      exclude_target="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
        || { shopt -u nullglob; return 1; }
      rm -f -- "${exclude_target}" || { shopt -u nullglob; return 1; }
      exclude_target="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")" \
        || { shopt -u nullglob; return 1; }
      [[ ! -e "${exclude_target}" ]] || { shopt -u nullglob; return 1; }
    fi
  done
  shopt -u nullglob
}

container_matches_recorded_runtime() {
  local container_id="$1" expected_tag="$2" expected_image_id="$3" require_health="${4:-true}"
  [[ -n "${container_id}" \
    && "$(docker inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null)" == true \
    && "$(docker inspect --format '{{.Config.Image}}' "${container_id}" 2>/dev/null)" == "${expected_tag}" \
    && "$(docker inspect --format '{{.Image}}' "${container_id}" 2>/dev/null)" == "${expected_image_id}" ]] \
    || return 1
  [[ "${require_health}" != true \
    || "$(docker inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)" == healthy ]]
}

verify_restored_project_runtime() {
  local slug="$1" source="${backup_root}/projects/${slug}" service expected_tag expected_image_id
  local container_id task_id metadata_hash task_env_hash old_harness_container harness_image_id
  local old_upload_container upload_image_id task_tag harness_container upload_container
  while IFS=$'\t' read -r service expected_tag expected_image_id; do
    [[ "${service}" != service ]] || continue
    container_id="$(project_compose "${slug}" ps --quiet "${service}")"
    container_matches_recorded_runtime "${container_id}" "${expected_tag}" "${expected_image_id}" true \
      || return 1
  done <"${source}/control-runtime.before.tsv"
  while IFS=$'\t' read -r task_id metadata_hash task_env_hash \
      old_harness_container harness_image_id old_upload_container upload_image_id; do
    [[ "${task_id}" != taskId ]] || continue
    task_tag="$(awk -F= '$1 == "HARNESS_IMAGE" {sub(/^[^=]*=/, ""); print; exit}' \
      "${source}/task-env/${task_id}.env")"
    harness_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness)"
    upload_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness-upload)"
    container_matches_recorded_runtime "${harness_container}" "${task_tag}" "${harness_image_id}" false \
      && container_matches_recorded_runtime "${upload_container}" "${task_tag}" "${upload_image_id}" true \
      || return 1
  done <"${source}/active-taskspaces.manifest.tsv"
  project_release_is_idle "${slug}"
}

verify_restored_gateway_runtime() {
  local _service expected_tag expected_image_id gateway_container
  IFS=$'\t' read -r _service expected_tag expected_image_id \
    < <(tail -n 1 "${backup_root}/gateway-runtime.before.tsv")
  gateway_container="$(docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    ps --quiet conversation-gateway)"
  container_matches_recorded_runtime "${gateway_container}" "${expected_tag}" "${expected_image_id}" true
}

declare -A release_plane_stopped=()
switched=false
backup_ready=false
rollback() {
  local exit_code=$? rollback_ok=true task_id fence_state slug metadata
  trap - ERR EXIT
  ((exit_code != 0)) || return 0
  if [[ "${switched}" == true ]]; then
    fence_state="$(gateway_fence_transaction_state)"
    if [[ "${fence_state}" == committed ]]; then
      docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
        --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
        stop conversation-gateway >/dev/null 2>&1 || true
      printf 'status=committed-postcommit-failure-gateway-closed\nfailedExit=%s\nepoch=%s\n' \
        "${exit_code}" "${maintenance_epoch}" >"${backup_root}/rollback-status.txt" 2>/dev/null || true
      warn "Failure was observed after the committed fence; destructive rollback was suppressed and ingress was closed."
      exit "${exit_code}"
    fi
    if [[ "${fence_state}" != maintenance ]]; then
      docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
        --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
        stop conversation-gateway >/dev/null 2>&1 || true
      printf 'status=ambiguous-commit-gateway-closed\nfailedExit=%s\nepoch=%s\n' \
        "${exit_code}" "${maintenance_epoch}" >"${backup_root}/rollback-status.txt" 2>/dev/null || true
      warn "The transaction fence is not provably pre-commit; destructive rollback was suppressed and ingress remains closed."
      exit "${exit_code}"
    fi
    if [[ "${backup_ready}" != true ]]; then
      # Before the complete post-drain backup exists, no project/runtime
      # mutation is allowed. Roll back only the admission fences; never invoke
      # destructive file/runtime restoration from a partial backup.
      for slug in "${project_slugs[@]}"; do
        shopt -s nullglob
        for metadata in "${DELIVERY_ROOT}/projects/${slug}"/taskspaces/*/metadata.json; do
          [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
          task_id="$(jq -er '.taskId' "${metadata}")" || { rollback_ok=false; continue; }
          write_taskspace_fence "${slug}" "${task_id}" committed || rollback_ok=false
        done
        shopt -u nullglob
      done
      write_gateway_fence committed || rollback_ok=false
      if [[ "${rollback_ok}" == true ]]; then
        printf 'status=aborted-prebackup-ingress-reopened\nfailedExit=%s\nepoch=%s\n' \
          "${exit_code}" "${maintenance_epoch}" >"${backup_root}/rollback-status.txt" 2>/dev/null || true
        warn "Maintenance aborted before project mutation; deterministic admission fences were reopened without destructive rollback."
      else
        docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
          --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
          stop conversation-gateway >/dev/null 2>&1 || true
        printf 'status=prebackup-fence-rollback-incomplete-gateway-closed\nfailedExit=%s\nepoch=%s\n' \
          "${exit_code}" "${maintenance_epoch}" >"${backup_root}/rollback-status.txt" 2>/dev/null || true
        warn "Pre-backup fence rollback was incomplete; Conversation Gateway ingress remains closed."
      fi
      warn "Rollback evidence is retained at ${backup_root}."
      exit "${exit_code}"
    fi
    warn "Project material isolation cutover failed; restoring prior files and runtimes with ingress fenced closed."
    write_gateway_fence maintenance || rollback_ok=false
    for slug in "${project_slugs[@]}"; do
      while IFS= read -r task_id; do
        [[ -n "${task_id}" ]] || continue
        write_taskspace_fence "${slug}" "${task_id}" maintenance || rollback_ok=false
      done <"${backup_root}/projects/${slug}/active-taskspaces.before"
    done
    docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
      --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
      stop conversation-gateway >/dev/null 2>&1 || rollback_ok=false
    if ! install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/control-plane.env" "${control_env}"; then rollback_ok=false; fi
    for slug in "${project_slugs[@]}"; do
      if ! restore_project_files "${slug}"; then rollback_ok=false; fi
      if [[ "${release_plane_stopped[${slug}]:-false}" == true ]]; then
        if project_compose "${slug}" up --detach --force-recreate --no-deps release-runner \
          && wait_project_service_health "${slug}" release-runner; then :; else rollback_ok=false; fi
        if project_compose "${slug}" up --detach --force-recreate --no-deps taskspace-broker \
          && wait_project_service_health "${slug}" taskspace-broker; then :; else rollback_ok=false; fi
      elif runner_release_is_idle "${slug}"; then
        if project_compose "${slug}" up --detach --no-deps release-runner \
          && wait_project_service_health "${slug}" release-runner; then :; else rollback_ok=false; fi
        if project_compose "${slug}" up --detach --no-deps taskspace-broker \
          && wait_project_service_health "${slug}" taskspace-broker; then :; else rollback_ok=false; fi
      else
        rollback_ok=false
        project_compose "${slug}" stop taskspace-broker >/dev/null 2>&1 || true
        warn "Release Runner remained active for ${slug}; it was not recreated and all conversation ingress remains closed."
        continue
      fi
      while IFS= read -r task_id; do
        [[ -n "${task_id}" ]] || continue
        if task_compose "${slug}" "${task_id}" up --detach \
          && wait_taskspace_runtime "${slug}" "${task_id}"; then :; else rollback_ok=false; fi
      done <"${backup_root}/projects/${slug}/active-taskspaces.before"
      if project_compose "${slug}" up --detach --force-recreate --no-deps conversation-manager \
        && wait_project_manager "${slug}"; then :; else rollback_ok=false; fi
      if ! verify_restored_project_runtime "${slug}"; then rollback_ok=false; fi
      : >"${backup_root}/projects/${slug}/application-container-ids.rollback"
      for service in forge-admin forge-app forge-flow forge-ui; do
        project_compose "${slug}" ps --quiet "${service}" | xargs -r docker inspect --format '{{.Id}}' \
          >>"${backup_root}/projects/${slug}/application-container-ids.rollback"
      done
      if ! cmp "${backup_root}/projects/${slug}/application-container-ids.before" \
          "${backup_root}/projects/${slug}/application-container-ids.rollback"; then rollback_ok=false; fi
    done
    if [[ "${rollback_ok}" == true ]]; then
      printf 'status=restored-gateway-closed\nfailedExit=%s\nepoch=%s\n' \
        "${exit_code}" "${maintenance_epoch}" >"${backup_root}/rollback-status.txt"
      warn "Rollback restored the prior project runtimes; the Conversation Gateway intentionally remains closed for operator review."
    else
      docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
        --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
        stop conversation-gateway >/dev/null 2>&1 || true
      printf 'status=incomplete-gateway-closed\nfailedExit=%s\nepoch=%s\n' \
        "${exit_code}" "${maintenance_epoch}" >"${backup_root}/rollback-status.txt"
      warn "Rollback was incomplete; the Conversation Gateway remains closed for operator recovery."
    fi
  fi
  warn "Rollback evidence is retained at ${backup_root}."
  exit "${exit_code}"
}
trap rollback ERR EXIT

postcommit_failure() {
  local message="$1" slug task_id
  for slug in "${project_slugs[@]}"; do
    while IFS= read -r task_id; do
      [[ -n "${task_id}" ]] || continue
      write_taskspace_fence "${slug}" "${task_id}" maintenance >/dev/null 2>&1 || true
    done <"${backup_root}/projects/${slug}/active-taskspaces.before"
  done
  docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
    --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
    stop conversation-gateway >/dev/null 2>&1 || true
  printf 'status=committed-postcheck-failed-gateway-closed\nepoch=%s\nimageId=%s\n' \
    "${maintenance_epoch}" "${target_image_id}" >"${backup_root}/cutover-status.txt" 2>/dev/null || true
  warn "${message} The committed runtime was not rolled back; Conversation Gateway ingress is closed."
  exit 1
}

assert_control_runtime_ready
assert_runtime_inventory_exact
switched=true
write_gateway_fence maintenance \
  || die "Conversation Gateway maintenance fence could not be written atomically."
wait_conversation_gateway_maintenance \
  || die "Conversation Gateway did not drain every admitted TCP/HTTP/upgrade connection; no runtime was stopped."

# The central fence closes every conversation-authorized admission path. Each
# active TaskSpace receives its own host-owned fence as well, covering direct
# token access in the upgraded proxy. A legacy proxy has no accept-time latch,
# so every active legacy TaskSpace fails closed and must be stopped gracefully
# before this upgrade; connection or session snapshots cannot close that race.
for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  shopt -s nullglob
  for metadata in "${project_root}"/taskspaces/*/metadata.json; do
    [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
    task_id="$(jq -er '.taskId' "${metadata}")"
    [[ "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ \
      && "${task_id}" == "$(basename -- "$(dirname -- "${metadata}")")" ]] \
      || { shopt -u nullglob; die "Active TaskSpace identity is invalid before drain: ${slug}"; }
    write_taskspace_fence "${slug}" "${task_id}" maintenance \
      || { shopt -u nullglob; die "TaskSpace maintenance fence could not be written: ${slug}/${task_id}"; }
  done
  shopt -u nullglob
done
for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  shopt -s nullglob
  for metadata in "${project_root}"/taskspaces/*/metadata.json; do
    [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
    task_id="$(jq -er '.taskId' "${metadata}")"
    wait_taskspace_maintenance "${slug}" "${task_id}" \
      || { shopt -u nullglob; die "TaskSpace ${slug}/${task_id} retained an active TCP/WebSocket/request; the long-running work was left running and the upgrade was aborted."; }
  done
  shopt -u nullglob
done

# Only after every ingress is fenced and every admitted connection is gone do
# we re-evaluate session quiescence and create the complete rollback/session
# backup. A hash manifest on both sides of the archive closes the prior mtime
# and backup TOCTOU window.
backup_gateway_runtime
for slug in "${project_slugs[@]}"; do
  assert_project_sessions_idle "${slug}"
  assert_project_release_idle "${slug}"
  capture_project_session_manifest "${slug}" \
    "${backup_root}/projects/${slug}.sessions-before.tsv"
  backup_project "${slug}"
  backup_project_sessions "${slug}"
  capture_project_session_manifest "${slug}" \
    "${backup_root}/projects/${slug}.sessions-after.tsv"
  cmp "${backup_root}/projects/${slug}.sessions-before.tsv" \
    "${backup_root}/projects/${slug}.sessions-after.tsv" \
    || die "Harness session state changed during the complete backup: ${slug}"
  assert_project_sessions_idle "${slug}"
  assert_project_release_idle "${slug}"
done
backup_ready=true

# Network metadata is additive rollback protection: validate every existing
# TaskSpace after its complete backup, preserve any legacy filename, and create
# the canonical filename only for TaskSpaces already carrying a fixed-subnet
# override. No-override predecessors retain their original allocation model.
for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  shopt -s nullglob
  for task_env in "${project_root}"/taskspaces/*/task.env; do
    task_root="$(dirname -- "${task_env}")"
    task_id="$(basename -- "${task_root}")"
    migrate_taskspace_network_override "${task_root}" "${slug}/${task_id}" \
      || { shopt -u nullglob; die "TaskSpace network override migration failed: ${slug}/${task_id}"; }
  done
  shopt -u nullglob
done

# Governance migration is a project mutation and therefore occurs only after
# its rollback state is complete. It never edits AGENTS.md.
for slug in "${project_slugs[@]}"; do
  prepare_project_governance_context "${slug}"
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    [[ "$(taskspace_fence_transaction_state "${slug}" "${task_id}")" == maintenance ]] \
      || die "TaskSpace maintenance fence drifted before cutover: ${slug}/${task_id}"
    wait_taskspace_maintenance "${slug}" "${task_id}" \
      || die "TaskSpace ${slug}/${task_id} was no longer drained before cutover."
  done <"${backup_root}/projects/${slug}/active-taskspaces.before"
  capture_project_session_manifest "${slug}" \
    "${backup_root}/projects/${slug}.sessions-pre-stop.tsv"
  cmp "${backup_root}/projects/${slug}.sessions-after.tsv" \
    "${backup_root}/projects/${slug}.sessions-pre-stop.tsv" \
    || die "Harness session state changed after backup but before cutover: ${slug}"
  assert_project_sessions_idle "${slug}"
  assert_project_release_idle "${slug}"
done

# The complete backup now exists and the drained state has been re-proven.
# Stop control ingress only at this point; no long request is hard-killed.
docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" \
  --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
  stop conversation-gateway
assert_conversation_gateway_stopped
for slug in "${project_slugs[@]}"; do
  project_compose "${slug}" stop conversation-manager
done
for slug in "${project_slugs[@]}"; do
  # Broker is the only release admission path. Stop it before the second
  # Runner observation so no TaskSpace can win the former idle-check race.
  project_compose "${slug}" stop taskspace-broker
done
for slug in "${project_slugs[@]}"; do
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    task_compose "${slug}" "${task_id}" down --remove-orphans
    assert_taskspace_runtime_removed "${slug}" "${task_id}"
    assert_task_sessions_idle "${slug}" "${task_id}"
  done <"${backup_root}/projects/${slug}/active-taskspaces.before"
  verify_active_manifest_unchanged "${slug}"
  capture_project_session_manifest "${slug}" \
    "${backup_root}/projects/${slug}.sessions-post-stop.tsv"
  cmp "${backup_root}/projects/${slug}.sessions-pre-stop.tsv" \
    "${backup_root}/projects/${slug}.sessions-post-stop.tsv" \
    || die "Harness session state changed while stopping a drained TaskSpace: ${slug}"
  wait_project_runner_idle "${slug}" \
    || die "Release Runner did not drain after Broker admission closed for ${slug}; no Runner was recreated."
  project_compose "${slug}" stop release-runner
  release_plane_stopped["${slug}"]=true
done

upsert_env "${control_env}" HARNESS_IMAGE_SOURCE "${harness_image_source}"
upsert_env "${control_env}" HARNESS_IMAGE "${target_image_id}"
for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  env_file="${project_root}/ops/project.env"
  intake_root="${DELIVERY_ROOT}/file-gateway/data/${slug}"
  [[ -d "${intake_root}" ]] || die "Project intake is missing for ${slug}; run file-gatewayctl.sh sync-projects first."
  install -d -m 0750 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${project_root}/shared-inputs" "${project_root}/shared-inputs/accepted"
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${project_root}/shared-inputs/governance"
  upsert_env "${env_file}" PROJECT_SHARED_INPUT_ROOT "${project_root}/shared-inputs/accepted"
  upsert_env "${env_file}" PROJECT_MATERIAL_ACCESS_MODE direct
  upsert_env "${env_file}" DELIVERY_ROOT "${DELIVERY_ROOT}"
  upsert_env "${env_file}" DELIVERY_OWNER "${DELIVERY_OWNER}"
  upsert_env "${env_file}" DELIVERY_GROUP "${DELIVERY_GROUP}"
  upsert_env "${env_file}" GLM_KEY_FILE "${GLM_KEY_FILE}"
  upsert_env "${env_file}" HARNESS_IMAGE_SOURCE "${harness_image_source}"
  upsert_env "${env_file}" RELEASE_RUNNER_IMAGE_SOURCE "${release_runner_image_source}"
  upsert_env "${env_file}" HARNESS_IMAGE "${target_image_id}"
  upsert_env "${env_file}" RELEASE_RUNNER_IMAGE "${target_image_id}"
  upsert_env "${env_file}" FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED "${ordinary_final_verification_supported}"
  chmod 0600 "${env_file}"
  install_managed_harness_settings "${project_root}/dsh-home/settings.yaml"
  install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${REPO_ROOT}/templates/project/compose.yaml" "${project_root}/ops/compose.yaml"
  project_compose "${slug}" config --quiet

  shopt -s nullglob
  for task_env in "${project_root}"/taskspaces/*/task.env; do
    task_root="$(dirname -- "${task_env}")"
    taskspace_git_exclude_path "${task_root}" "${slug}/$(basename -- "${task_root}")" >/dev/null \
      || die "TaskSpace Git exclude path is unsafe; material mutation was blocked."
    install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${task_root}/cache" \
      "${task_root}/cache/m2" \
      "${task_root}/cache/npm" \
      "${task_root}/cache/pnpm" \
      "${task_root}/cache/pnpm/data" \
      "${task_root}/cache/pnpm/home" \
      "${task_root}/cache/general" \
      "${task_root}/cache/general/jansi" \
      "${task_root}/cache/general/state" \
      "${task_root}/workspace/.forge-cache" \
      "${task_root}/workspace/.forge-cache/m2" \
      "${task_root}/workspace/.forge-cache/npm" \
      "${task_root}/workspace/.forge-cache/pnpm" \
      "${task_root}/workspace/.forge-cache/general"
    exclude_file="$(ensure_taskspace_git_exclude_contract \
      "${task_root}" "${slug}/$(basename -- "${task_root}")")" \
      || die "TaskSpace Git exclude contract could not be established during material upgrade."
    exclude_file="$(taskspace_git_exclude_path \
      "${task_root}" "${slug}/$(basename -- "${task_root}")")" \
      || die "TaskSpace Git exclude path changed before ownership repair."
    chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${exclude_file}"
    taskspace_git_exclude_path "${task_root}" "${slug}/$(basename -- "${task_root}")" >/dev/null \
      || die "TaskSpace Git exclude path changed during ownership repair."
    upsert_env "${task_env}" PROJECT_FTP_INPUT_ROOT "${intake_root}"
    upsert_env "${task_env}" PROJECT_SHARED_INPUT_ROOT "${project_root}/shared-inputs/accepted"
    upsert_env "${task_env}" GLM_KEY_FILE "${GLM_KEY_FILE}"
    upsert_env "${task_env}" HARNESS_IMAGE_SOURCE "${harness_image_source}"
    upsert_env "${task_env}" HARNESS_IMAGE "${target_image_id}"
    upsert_env "${task_env}" FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED true
    upsert_env "${task_env}" FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED "${format_maintenance_supported}"
    upsert_env "${task_env}" FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED "${contract_continuation_supported}"
    upsert_env "${task_env}" FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED "${review_suspension_supported}"
    upsert_env "${task_env}" FORGE_CHANGED_VERIFICATION_SUPPORTED "${changed_verification_supported}"
    upsert_env "${task_env}" FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED "${focused_backend_verification_supported}"
    upsert_env "${task_env}" FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED "${ordinary_final_verification_supported}"
    chmod 0600 "${task_env}"
    install_managed_harness_settings "${task_root}/dsh-home/settings.yaml"
  done
  shopt -u nullglob

  # Runner and Broker share the versioned runtime image.  Updating them only
  # after both report idle prevents mixed historical images from accumulating
  # and keeps copied projects on one reviewed execution contract.
  project_compose "${slug}" up --detach --force-recreate --no-deps release-runner
  wait_project_service_health "${slug}" release-runner \
    || die "Release Runner did not become healthy for ${slug}."
  project_compose "${slug}" up --detach --force-recreate --no-deps taskspace-broker
  wait_project_service_health "${slug}" taskspace-broker \
    || die "TaskSpace Broker did not become healthy for ${slug}."
done

for slug in "${project_slugs[@]}"; do
  project_root="${DELIVERY_ROOT}/projects/${slug}"
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    task_compose "${slug}" "${task_id}" up --detach
    wait_taskspace_runtime "${slug}" "${task_id}" \
      || die "Active TaskSpace ${slug}/${task_id} did not become healthy after cutover."
    harness_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness)"
    upload_container="$(task_compose "${slug}" "${task_id}" ps --quiet harness-upload)"
    [[ -n "${harness_container}" && -n "${upload_container}" \
      && "$(docker inspect --format '{{.Config.Image}}' "${harness_container}")" == "${target_image_id}" \
      && "$(docker inspect --format '{{.Config.Image}}' "${upload_container}")" == "${target_image_id}" \
      && "$(docker inspect --format '{{.Image}}' "${harness_container}")" == "${target_image_id}" \
      && "$(docker inspect --format '{{.Image}}' "${upload_container}")" == "${target_image_id}" ]] \
      || die "Active TaskSpace ${slug}/${task_id} did not converge to ${target_image_id}."
    docker exec "${harness_container}" node /usr/local/lib/validate-skill-bundle.mjs \
      --skills-root /usr/local/share/dsh-skills \
      --catalog /usr/local/share/dsh-skills.catalog.json \
      --strict >/dev/null \
      || die "Active TaskSpace ${slug}/${task_id} failed the strict Skill bundle probe."
    docker exec "${harness_container}" forge-delivery --help >/dev/null \
      || die "Active TaskSpace ${slug}/${task_id} does not expose forge-delivery."
  done <"${backup_root}/projects/${slug}/active-taskspaces.before"
  project_compose "${slug}" up --detach --force-recreate --no-deps conversation-manager
  wait_project_manager "${slug}" || die "Conversation Manager did not become healthy for ${slug}."
  : >"${backup_root}/projects/${slug}/application-container-ids.after"
  for service in forge-admin forge-app forge-flow forge-ui; do
    project_compose "${slug}" ps --quiet "${service}" | xargs -r docker inspect --format '{{.Id}}' \
      >>"${backup_root}/projects/${slug}/application-container-ids.after"
  done
  cmp "${backup_root}/projects/${slug}/application-container-ids.before" \
      "${backup_root}/projects/${slug}/application-container-ids.after" \
    || die "Application containers changed unexpectedly for ${slug}."
done

bash "${SCRIPT_DIR}/conversation-control-planectl.sh" up
wait_conversation_gateway_maintenance \
  || die "Conversation Gateway did not remain fenced in maintenance after cutover."
verify_target_control_runtime
verify_target_active_taskspaces
for slug in "${project_slugs[@]}"; do
  assert_project_release_idle "${slug}"
done
assert_runtime_inventory_exact

for slug in "${project_slugs[@]}"; do
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    [[ "$(taskspace_fence_transaction_state "${slug}" "${task_id}")" == maintenance ]] \
      || die "Target TaskSpace fence drifted before transaction commit: ${slug}/${task_id}"
    wait_taskspace_maintenance "${slug}" "${task_id}" \
      || die "Target TaskSpace was not deterministically drained before transaction commit: ${slug}/${task_id}"
  done <"${backup_root}/projects/${slug}/active-taskspaces.before"
done

# The persistent fence is the transaction commit. Every runtime, image,
# worker, release-idle and inventory assertion above remains inside the armed
# rollback region. Docker restart or process SIGKILL before this atomic rename
# therefore leaves the Gateway returning maintenance instead of reopening.
for slug in "${project_slugs[@]}"; do
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    write_taskspace_fence "${slug}" "${task_id}" committed \
      || die "TaskSpace commit fence could not be written atomically: ${slug}/${task_id}"
  done <"${backup_root}/projects/${slug}/active-taskspaces.before"
done
write_gateway_fence committed \
  || die "Conversation Gateway commit fence could not be written atomically."

# The committed fence is irreversible within this transaction. Disarm the
# destructive rollback before any post-commit observation can fail.
trap - ERR EXIT
switched=false

wait_conversation_gateway \
  || postcommit_failure "Conversation Gateway did not open on the committed epoch."
if ! (
  verify_target_control_runtime
  verify_target_active_taskspaces
  assert_runtime_inventory_exact
  for slug in "${project_slugs[@]}"; do
    assert_project_release_idle "${slug}"
    while IFS= read -r task_id; do
      [[ -n "${task_id}" ]] || continue
      wait_taskspace_open "${slug}" "${task_id}" || exit 1
    done <"${backup_root}/projects/${slug}/active-taskspaces.before"
  done
); then
  postcommit_failure "Post-commit runtime observation did not match the pre-commit target."
fi
if ! printf 'status=committed\nepoch=%s\nimageId=%s\nsourceHarnessImage=%s\nsourceRunnerImage=%s\nbuildDigest=%s\n' \
    "${maintenance_epoch}" "${target_image_id}" "${harness_image_source}" \
    "${release_runner_image_source}" "${FORGE_VERIFIED_HARNESS_BUILD_DIGEST}" \
    >"${backup_root}/cutover-status.txt"; then
  postcommit_failure "The committed cutover receipt could not be persisted."
fi

flock --unlock 8
exec 8>&-
log "Direct project folder inputs are active for all registered projects."
log "Each project's SFTP root is preserved and mounted read-only at /project-ftp-inputs in its TaskSpaces."
log "The reviewed /project-shared-inputs workflow remains available as a reserved mode."
log "Backup and rollback evidence: ${backup_root}"
