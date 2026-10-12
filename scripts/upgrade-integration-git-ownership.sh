#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
umask 077

readonly PATCH_VERSION='integration-git-ownership-v1'

slug="${1:-}"
confirmation="${2:-}"
[[ -n "${slug}" ]] \
  || die "Usage: $0 <project-slug> --confirm-maintenance-window integration-git-ownership"
validate_slug "${slug}"
[[ "${confirmation}" == '--confirm-maintenance-window' \
  && "${3:-}" == 'integration-git-ownership' && $# -eq 3 ]] \
  || die "Explicit maintenance confirmation is required: --confirm-maintenance-window integration-git-ownership"
[[ "${EUID}" -eq 0 ]] || die "The integration Git ownership upgrade must run as root."

for command_name in awk chmod chown curl date diff docker find flock getent git grep id install jq \
    mktemp mv readlink rm rmdir runuser sh sha256sum sleep stat; do
  require_command "${command_name}"
done
require_docker_access
acquire_harness_image_upgrade_lock

project_root="${DELIVERY_ROOT}/projects/${slug}"
workspace="${project_root}/workspace"
git_dir="${workspace}/.git"
env_file="${project_root}/ops/project.env"
compose_file="${project_root}/ops/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
template="${REPO_ROOT}/templates/project/compose.yaml"
overlay="${REPO_ROOT}/docker/harness/Dockerfile.taskspace-broker-ownership"
[[ -d "${project_root}" && ! -L "${project_root}" \
  && -d "${workspace}" && ! -L "${workspace}" \
  && -d "${git_dir}" && ! -L "${git_dir}" \
  && -f "${git_dir}/index" && ! -L "${git_dir}/index" \
  && -f "${env_file}" && ! -L "${env_file}" \
  && -f "${compose_file}" && ! -L "${compose_file}" \
  && -f "${registry_file}" && ! -L "${registry_file}" \
  && -f "${template}" && -f "${overlay}" ]] \
  || die "Project integration Git state or upgrade inputs are missing or unsafe: ${slug}"
project_real="$(readlink -f -- "${project_root}")"
workspace_real="$(readlink -f -- "${workspace}")"
git_real="$(readlink -f -- "${git_dir}")"
[[ "${project_real}" == "$(readlink -f -- "${DELIVERY_ROOT}/projects")/${slug}" \
  && "${workspace_real}" == "${project_real}/workspace" \
  && "${git_real}" == "${workspace_real}/.git" ]] \
  || die "Project integration Git path escaped the registered project root."

env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

upsert_env() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp "${project_root}/ops/.project.env.integration-git.XXXXXX")"
  awk -F= -v key="${key}" -v value="${value}" '
    BEGIN {found=0}
    $1 == key {print key "=" value; found=1; next}
    {print}
    END {if (!found) print key "=" value}
  ' "${env_file}" >"${temporary}"
  chmod --reference="${env_file}" "${temporary}"
  chown --reference="${env_file}" "${temporary}"
  mv -- "${temporary}" "${env_file}"
}

patch_project_compose_broker_image() {
  local temporary broker_image_line
  broker_image_line='    image: ${TASKSPACE_BROKER_IMAGE:-${RELEASE_RUNNER_IMAGE:-${HARNESS_IMAGE:?HARNESS_IMAGE is required}}}'
  grep -Fx -- "${broker_image_line}" "${template}" >/dev/null \
    || die "Reusable project template does not contain the reviewed Broker image override."
  temporary="$(mktemp "${project_root}/ops/.compose.yaml.integration-git.XXXXXX")"
  if ! awk -v replacement="${broker_image_line}" '
      /^  taskspace-broker:$/ {inside=1}
      inside && /^    image:/ {print replacement; replaced+=1; next}
      inside && /^  [A-Za-z0-9_-]+:$/ && $0 != "  taskspace-broker:" {inside=0}
      {print}
      END {if (replaced != 1) exit 42}
    ' "${compose_file}" >"${temporary}"; then
    rm -f -- "${temporary}"
    die "Existing project Compose file has no unique TaskSpace Broker image field."
  fi
  chmod --reference="${compose_file}" "${temporary}"
  chown --reference="${compose_file}" "${temporary}"
  mv -- "${temporary}" "${compose_file}"
}

application_container_ids() {
  local service container_id container_state task_env task_compose_project
  for service in forge-admin forge-app forge-flow forge-ui; do
    container_id="$(compose ps --all --quiet "${service}")"
    if [[ -z "${container_id}" ]]; then
      printf '%s=absent\n' "${service}"
      continue
    fi
    container_state="$(docker inspect --format '{{.State.Status}}' "${container_id}")"
    printf '%s=%s|%s\n' "${service}" \
      "$(docker inspect --format '{{.Id}}' "${container_id}")" "${container_state}"
  done
  while IFS= read -r -d '' task_env; do
    task_compose_project="$(awk -F= '$1 == "TASKSPACE_COMPOSE_PROJECT_NAME" {sub(/^[^=]*=/, ""); print; exit}' "${task_env}")"
    [[ "${task_compose_project}" =~ ^[a-z0-9][a-z0-9_-]{2,95}$ ]] \
      || die "Active TaskSpace has an invalid Compose project identity: ${task_env}"
    while IFS='|' read -r container_id service; do
      [[ -n "${container_id}" ]] || continue
      printf 'taskspace:%s:%s=%s\n' \
        "${task_compose_project}" "${service}" \
        "$(docker inspect --format '{{.Id}}' "${container_id}")"
    done < <(docker ps \
      --filter "label=com.docker.compose.project=${task_compose_project}" \
      --format '{{.ID}}|{{.Label "com.docker.compose.service"}}' | LC_ALL=C sort)
  done < <(find "${project_root}/taskspaces" -mindepth 2 -maxdepth 2 \
    -type f -name task.env -print0 | sort -z)
}

assert_runner_idle() {
  local runner_socket="${project_root}/ops/release-ipc/runner.sock"
  [[ -S "${runner_socket}" ]] || die "Release Runner socket is unavailable for ${slug}."
  curl --fail --silent --show-error --max-time 5 --unix-socket "${runner_socket}" \
      http://localhost/healthz \
    | jq -e '.ok == true and .active == false' >/dev/null \
    || die "Release Runner is active or unhealthy for ${slug}."
}

maintenance_file="${project_root}/taskspaces/.broker/maintenance.json"
release_lock_root="${project_root}/taskspaces/.broker/release.lock"
release_lock_owner="${release_lock_root}/owner.json"
maintenance_operation_id="integration-git-ownership-${slug}-$$"
maintenance_entered=false
release_fence_entered=false

enter_broker_maintenance() {
  local state_root maintenance_temporary owner_temporary
  state_root="$(dirname -- "${maintenance_file}")"
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${state_root}"
  [[ ! -e "${maintenance_file}" && ! -L "${maintenance_file}" ]] \
    || die "A Broker maintenance fence already exists for ${slug}."
  if ! run_as_delivery_owner mkdir -m 0700 -- "${release_lock_root}"; then
    die "A TaskSpace release started before the maintenance fence was acquired."
  fi
  release_fence_entered=true
  owner_temporary="$(mktemp "${release_lock_root}/.owner.XXXXXX")"
  jq --null-input \
    --arg instanceId platform-maintenance \
    --arg operationId "${maintenance_operation_id}" \
    --arg taskId platform-maintenance \
    --arg actorId platform-operator \
    --arg createdAt "$(date --iso-8601=seconds)" \
    '{schemaVersion:1,instanceId:$instanceId,operationId:$operationId,taskId:$taskId,actorId:$actorId,createdAt:$createdAt}' \
    >"${owner_temporary}"
  chmod 0600 "${owner_temporary}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${owner_temporary}"
  mv -- "${owner_temporary}" "${release_lock_owner}"

  maintenance_temporary="$(mktemp "${state_root}/.maintenance.XXXXXX")"
  jq --null-input \
    --arg operationId "${maintenance_operation_id}" \
    --arg startedAt "$(date --iso-8601=seconds)" \
    '{schemaVersion:1,operationId:$operationId,startedAt:$startedAt}' \
    >"${maintenance_temporary}"
  chmod 0600 "${maintenance_temporary}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${maintenance_temporary}"
  mv -- "${maintenance_temporary}" "${maintenance_file}"
  maintenance_entered=true
}

release_platform_release_fence() {
  local owner_operation
  [[ "${release_fence_entered}" == true ]] || return 0
  owner_operation="$(jq -r '.operationId // ""' "${release_lock_owner}" 2>/dev/null || true)"
  [[ "${owner_operation}" == "${maintenance_operation_id}" ]] \
    || die "Platform release fence ownership changed during maintenance."
  rm -f -- "${release_lock_owner}"
  rmdir -- "${release_lock_root}"
  release_fence_entered=false
}

leave_broker_maintenance() {
  local operation
  [[ "${maintenance_entered}" == true ]] || return 0
  operation="$(jq -r '.operationId // ""' "${maintenance_file}" 2>/dev/null || true)"
  [[ "${operation}" == "${maintenance_operation_id}" ]] \
    || die "Broker maintenance fence ownership changed during maintenance."
  rm -f -- "${maintenance_file}"
  maintenance_entered=false
}

wait_broker_healthy() {
  local deadline=$((SECONDS + 120)) container_id
  while ((SECONDS < deadline)); do
    container_id="$(compose ps --quiet taskspace-broker)"
    if [[ -n "${container_id}" \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)" == healthy ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

repair_git_metadata_ownership() {
  local owner_uid owner_gid unsafe_link
  owner_uid="$(id -u "${DELIVERY_OWNER}")"
  owner_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
  [[ "${owner_uid}" =~ ^[0-9]+$ && "${owner_gid}" =~ ^[0-9]+$ ]] \
    || die "Delivery owner or group identity is unavailable."
  unsafe_link="$(find "${git_dir}" -xdev -type l -print -quit)"
  [[ -z "${unsafe_link}" ]] \
    || die "Integration Git metadata contains a symbolic link: ${unsafe_link}"
  [[ ! -e "${git_dir}/index.lock" ]] \
    || die "Integration Git index.lock exists; no lock was removed automatically."
  find "${git_dir}" -xdev \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) \
    -exec chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" {} +
  chmod u+rw "${git_dir}/index"
  [[ "$(stat -c '%u' "${git_dir}/index")" == "${owner_uid}" \
    && "$(stat -c '%g' "${git_dir}/index")" == "${owner_gid}" ]] \
    || die "Integration Git index ownership repair did not persist."
  [[ -z "$(project_git_readonly "${workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Integration workspace is dirty after Git metadata ownership repair: ${slug}"
  run_as_delivery_owner sh -c 'set -eu; umask 077; p="$1/.git/.forge-write-probe-$$"; : >"$p"; rm -f -- "$p"' sh "${workspace}"
}

repair_taskspace_git_ownership() {
  local task_git task_root task_env task_host_uid task_host_gid task_compose_project
  local container_id configured_user active_lock drift attempt
  local owner_uid owner_gid
  owner_uid="$(id -u "${DELIVERY_OWNER}")"
  owner_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
  [[ "${owner_uid}" =~ ^[0-9]+$ && "${owner_gid}" =~ ^[0-9]+$ ]] \
    || die "Delivery owner or group identity is unavailable."
  shopt -s nullglob
  for task_git in "${project_root}/taskspaces"/*/workspace/.git; do
    [[ -d "${task_git}" && ! -L "${task_git}" ]] \
      || die "TaskSpace Git metadata path is missing or unsafe: ${task_git}"
    task_root="$(dirname -- "$(dirname -- "${task_git}")")"
    task_env="${task_root}/task.env"
    [[ -f "${task_env}" && ! -L "${task_env}" ]] \
      || die "TaskSpace environment is missing or unsafe: ${task_root}"
    task_host_uid="$(awk -F= '$1 == "HOST_UID" {print $2; exit}' "${task_env}")"
    task_host_gid="$(awk -F= '$1 == "HOST_GID" {print $2; exit}' "${task_env}")"
    task_compose_project="$(awk -F= '$1 == "TASKSPACE_COMPOSE_PROJECT_NAME" {print $2; exit}' "${task_env}")"
    [[ "${task_host_uid}" == "${owner_uid}" && "${task_host_gid}" == "${owner_gid}" \
      && "${task_compose_project}" =~ ^[a-z0-9][a-z0-9_-]{2,95}$ ]] \
      || die "TaskSpace runtime identity does not match the delivery owner: ${task_root}"
    while IFS= read -r container_id; do
      [[ -n "${container_id}" ]] || continue
      configured_user="$(docker inspect --format '{{.Config.User}}' "${container_id}")"
      [[ "${configured_user}" == "${owner_uid}:${owner_gid}" ]] \
        || die "Running TaskSpace container has an unsafe user identity: ${container_id}"
    done < <(docker ps --filter "label=com.docker.compose.project=${task_compose_project}" \
      --format '{{.ID}}')

    drift=''
    for attempt in 1 2 3; do
      active_lock="$(find "${task_git}" -xdev -type f -name '*.lock' -print -quit)"
      if [[ -n "${active_lock}" ]]; then
        sleep 1
        continue
      fi
      repair_delivery_owned_regular_tree "${task_git}"
      find "${task_git}" -xdev -type d -exec chmod g+s {} +
      drift="$(find "${task_git}" -xdev \
        \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) -print -quit)"
      [[ -z "${drift}" ]] && break
      sleep 1
    done
    [[ -z "${active_lock}" ]] \
      || die "TaskSpace Git operation stayed active during bounded ownership repair: ${active_lock}"
    [[ -z "${drift}" ]] \
      || die "TaskSpace Git ownership repair did not converge: ${drift}"
  done
  shopt -u nullglob
}

repair_published_project_control_ownership() {
  local managed_root
  for managed_root in \
      "${workspace}" \
      "${project_root}/ops" \
      "${project_root}/governance" \
      "${project_root}/taskspaces/.broker"; do
    [[ ! -e "${managed_root}" || -d "${managed_root}" ]] \
      || die "Published project control path is unsafe: ${managed_root}"
    [[ -d "${managed_root}" ]] || continue
    find "${managed_root}" -xdev ! -type s \
      \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) \
      -exec chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" {} +
  done
}

first_published_control_ownership_drift() {
  local managed_root drift
  for managed_root in \
      "${workspace}" \
      "${project_root}/ops" \
      "${project_root}/governance" \
      "${project_root}/taskspaces/.broker"; do
    [[ -d "${managed_root}" ]] || continue
    drift="$(find "${managed_root}" -xdev ! -type s \
      \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) -print -quit)"
    if [[ -n "${drift}" ]]; then
      printf '%s\n' "${drift}"
      return 0
    fi
  done
  return 1
}

repair_known_delivery_locks() {
  local registered_slug lock_path
  local -a lock_paths=(
    "${DELIVERY_ROOT}/registry/projects.lock"
    "${DELIVERY_ROOT}/registry/taskspaces.lock"
    "${DELIVERY_ROOT}/registry/harness-image-upgrade.lock"
    "${DELIVERY_ROOT}/registry/foundation.lock"
    "${DELIVERY_ROOT}/registry/conversation-control-plane.recovery.lock"
    "${DELIVERY_ROOT}/registry/project-material-isolation.lock"
    "${DELIVERY_ROOT}/registry/unified-conversation-upgrade.lock"
    "${DELIVERY_ROOT}/registry/conversation-gateway-ui-upgrade.lock"
  )
  while IFS= read -r registered_slug; do
    [[ -n "${registered_slug}" ]] || continue
    validate_slug "${registered_slug}"
    lock_paths+=(
      "${DELIVERY_ROOT}/registry/${registered_slug}.recovery.lock"
      "${DELIVERY_ROOT}/registry/${registered_slug}.git-remote-upgrade.lock"
      "${DELIVERY_ROOT}/registry/${registered_slug}.mobile-runtime-upgrade.lock"
      "${DELIVERY_ROOT}/registry/${registered_slug}.integration-git-ownership.lock"
    )
  done < <(awk -F '\t' 'NR > 1 {print $1}' "${registry_file}")

  for lock_path in "${lock_paths[@]}"; do
    [[ -e "${lock_path}" || -L "${lock_path}" ]] || continue
    prepare_delivery_lock "${lock_path}"
  done
}

source_sha256="$(sha256sum "${REPO_ROOT}/docker/harness/taskspace-broker.mjs" | awk '{print $1}')"
configured_broker_image="$(env_value TASKSPACE_BROKER_IMAGE)"
broker_patch_current=false
if [[ -n "${configured_broker_image}" ]] \
  && docker image inspect "${configured_broker_image}" >/dev/null 2>&1 \
  && [[ "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.taskspace-broker-ownership-patch"}}' "${configured_broker_image}")" == "${PATCH_VERSION}" ]] \
  && [[ "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.taskspace-broker-source-sha256"}}' "${configured_broker_image}")" == "${source_sha256}" ]]; then
  target_image="${configured_broker_image}"
  base_image_id="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.taskspace-broker-base-image-id"}}' "${target_image}")"
  [[ "${base_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Configured Broker patch has no immutable base image provenance: ${target_image}"
  broker_patch_current=true
fi

if [[ "${broker_patch_current}" != true ]]; then
  base_image="${configured_broker_image}"
  [[ -n "${base_image}" ]] || base_image="$(env_value RELEASE_RUNNER_IMAGE)"
  [[ -n "${base_image}" ]] || base_image="$(env_value HARNESS_IMAGE)"
  [[ -n "${base_image}" ]] || die "Project Broker base image is not configured."
  base_image_id="$(docker image inspect --format '{{.Id}}' "${base_image}" 2>/dev/null || true)"
  [[ "${base_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Project Broker base image is unavailable or mutable identity could not be resolved: ${base_image}"
  base_build_ref="$(resolve_local_docker_build_ref "${base_image}" "${base_image_id}")"
  target_image="forge-delivery/taskspace-broker:${PATCH_VERSION}-${source_sha256:0:12}-${base_image_id:7:12}"
fi

if [[ "${broker_patch_current}" == true ]]; then
  log "Configured Broker already contains the reviewed ownership patch: ${target_image}."
elif docker image inspect "${target_image}" >/dev/null 2>&1; then
  [[ "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.taskspace-broker-ownership-patch"}}' "${target_image}")" == "${PATCH_VERSION}" \
    && "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.taskspace-broker-source-sha256"}}' "${target_image}")" == "${source_sha256}" \
    && "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.taskspace-broker-base-image-id"}}' "${target_image}")" == "${base_image_id}" ]] \
    || die "Existing target Broker tag has unexpected provenance: ${target_image}"
  log "Reusing verified Broker compatibility image ${target_image}."
else
  log "Building Broker compatibility image ${target_image}."
  docker build \
    --build-arg "TASKSPACE_BROKER_BASE_IMAGE=${base_build_ref}" \
    --build-arg "TASKSPACE_BROKER_BASE_IMAGE_ID=${base_image_id}" \
    --build-arg "TASKSPACE_BROKER_OWNERSHIP_PATCH_VERSION=${PATCH_VERSION}" \
    --build-arg "TASKSPACE_BROKER_SOURCE_SHA256=${source_sha256}" \
    --tag "${target_image}" \
    --file "${overlay}" \
    "${REPO_ROOT}"
fi
docker run --rm --entrypoint node "${target_image}" \
  --check /usr/local/lib/taskspace-broker.mjs \
  || die "Target Broker image failed its syntax probe."

upgrade_lock="${DELIVERY_ROOT}/registry/${slug}.integration-git-ownership.lock"
recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"
prepare_delivery_lock "${upgrade_lock}"
prepare_delivery_lock "${recovery_lock}"
prepare_delivery_lock "${taskspaces_lock}"
repair_known_delivery_locks
exec 7>>"${taskspaces_lock}"
flock --exclusive --nonblock 7 \
  || die "A concurrent TaskSpace create/start/stop operation is active."
exec 8>>"${recovery_lock}"
flock --exclusive --nonblock 8 \
  || die "A backup or restore operation owns the project recovery lock for ${slug}."
exec 9>>"${upgrade_lock}"
flock --exclusive --nonblock 9 \
  || die "Another integration Git ownership upgrade is active for ${slug}."

assert_runner_idle
[[ ! -e "${release_lock_root}" && ! -L "${release_lock_root}" ]] \
  || die "A TaskSpace release lock exists; the upgrade did not interrupt it."
broker_container_before="$(compose ps --quiet taskspace-broker)"
[[ -n "${broker_container_before}" ]] || die "TaskSpace Broker container is unavailable for ${slug}."
target_image_id="$(docker image inspect --format '{{.Id}}' "${target_image}")"
if [[ "${broker_patch_current}" == true \
  && "$(env_value TASKSPACE_BROKER_IMAGE)" == "${target_image}" \
  && "$(docker inspect --format '{{.Image}}' "${broker_container_before}")" == "${target_image_id}" \
  && ! -e "${maintenance_file}" \
  && -z "$(first_published_control_ownership_drift || true)" ]]; then
  repair_taskspace_git_ownership
  if docker exec "${broker_container_before}" node -e \
      "fetch('http://127.0.0.1:3100/healthz').then(async r=>{const v=await r.json();if(!r.ok||v.ok!==true||v.active!==false||v.maintenance?.active!==false||v.integration?.ok!==true)process.exit(1)}).catch(()=>process.exit(1))"; then
    log "Integration Git ownership and Broker readiness are already current for ${slug}; no container was recreated."
    exit 0
  fi
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="${DELIVERY_ROOT}/platform-backups/pre-integration-git-ownership-${slug}-${timestamp}"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}"
install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${env_file}" "${backup_root}/project.env"
install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${compose_file}" "${backup_root}/compose.yaml"
stat -c '%n|%U|%G|%a|%s|%y' "${git_dir}/index" >"${backup_root}/git-index.before"
application_container_ids >"${backup_root}/application-container-ids.before"
chmod 0600 "${backup_root}/git-index.before" "${backup_root}/application-container-ids.before"
chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" \
  "${backup_root}/git-index.before" "${backup_root}/application-container-ids.before"

broker_stopped=false
switched=false
rollback() {
  local exit_code=$?
  trap - ERR EXIT
  ((exit_code != 0)) || return 0
  warn "Integration Git ownership upgrade failed; retaining repaired Git ownership and restoring prior runtime configuration."
  if [[ "${switched}" == true ]]; then
    install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/project.env" "${env_file}" || true
    install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/compose.yaml" "${compose_file}" || true
  fi
  if [[ "${release_fence_entered}" == true ]]; then
    rm -f -- "${release_lock_owner}" 2>/dev/null || true
    rmdir -- "${release_lock_root}" 2>/dev/null || true
    release_fence_entered=false
  fi
  if [[ "${maintenance_entered}" == true ]]; then
    rm -f -- "${maintenance_file}" 2>/dev/null || true
    maintenance_entered=false
  fi
  if [[ "${broker_stopped}" == true ]]; then
    compose up --detach --force-recreate --no-deps taskspace-broker >/dev/null 2>&1 || true
  fi
  warn "Rollback evidence is retained at ${backup_root}."
  exit "${exit_code}"
}
trap rollback ERR EXIT

enter_broker_maintenance
assert_runner_idle
repair_taskspace_git_ownership
broker_stopped=true
compose stop taskspace-broker
assert_runner_idle
repair_git_metadata_ownership
repair_published_project_control_ownership
stat -c '%n|%U|%G|%a|%s|%y' "${git_dir}/index" >"${backup_root}/git-index.after"
chmod 0600 "${backup_root}/git-index.after"
chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${backup_root}/git-index.after"

switched=true
upsert_env TASKSPACE_BROKER_IMAGE "${target_image}"
patch_project_compose_broker_image
compose config --quiet
release_platform_release_fence
compose up --detach --force-recreate --no-deps taskspace-broker
wait_broker_healthy \
  || die "TaskSpace Broker did not become healthy after the integration Git ownership repair."
leave_broker_maintenance

broker_container="$(compose ps --quiet taskspace-broker)"
[[ "$(docker inspect --format '{{.Image}}' "${broker_container}")" == "${target_image_id}" ]] \
  || die "TaskSpace Broker is not running the reviewed compatibility image."
docker exec "${broker_container}" node -e \
  "fetch('http://127.0.0.1:3100/healthz').then(async r=>{const v=await r.json();if(!r.ok||v.ok!==true||v.active!==false||v.maintenance?.active!==false||v.integration?.ok!==true)process.exit(1)}).catch(()=>process.exit(1))" \
  || die "Updated Broker did not prove integration Git readiness."
project_git_readonly "${workspace}" status --porcelain=v1 --untracked-files=all >/dev/null
application_container_ids >"${backup_root}/application-container-ids.after"
chmod 0600 "${backup_root}/application-container-ids.after"
chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${backup_root}/application-container-ids.after"
diff -- "${backup_root}/application-container-ids.before" \
  "${backup_root}/application-container-ids.after" >/dev/null \
  || die "A Forge application container changed during the Broker-only upgrade."

trap - ERR EXIT
log "Integration Git ownership is repaired for ${slug}; only taskspace-broker was recreated."
log "Broker image: ${target_image}; rollback evidence: ${backup_root}."
