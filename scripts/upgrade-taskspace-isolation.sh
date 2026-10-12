#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/taskspace-compose-network.sh
source "${SCRIPT_DIR}/lib/taskspace-compose-network.sh"
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

slug="${1:-}"
[[ -n "${slug}" && $# -eq 1 ]] || die "Usage: $0 <project-slug>"
validate_slug "${slug}"

for command_name in awk docker find flock git grep jq mktemp sha256sum; do
  require_command "${command_name}"
done
require_docker_access
acquire_harness_image_upgrade_lock

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
contract_file="${ops_root}/runtime-contract.json"
template_compose="${REPO_ROOT}/templates/project/compose.yaml"
taskspace_template="${REPO_ROOT}/templates/taskspace/compose.yaml"
taskspaces_root="${project_root}/taskspaces"
[[ -d "${project_root}/workspace/.git" && -f "${env_file}" && -f "${compose_file}" ]] \
  || die "Project is missing or incomplete: ${project_root}"
[[ -f "${taskspace_template}" ]] || die "TaskSpace Compose template is unavailable."
assert_managed_path "${project_root}"

# Preserve the established upgrade -> recovery -> TaskSpace lifecycle lock
# order.  Hold the shared lifecycle lock before inspecting any TaskSpace state
# so create/recover cannot race the inventory, network migration, or restart.
taskspace_upgrade_lock="${ops_root}/taskspace-upgrade.lock"
prepare_delivery_lock "${taskspace_upgrade_lock}"
exec 9>>"${taskspace_upgrade_lock}"
flock --exclusive --nonblock 9 \
  || die "Another TaskSpace isolation upgrade is running for ${slug}."
recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
prepare_delivery_lock "${recovery_lock}"
exec 8>>"${recovery_lock}"
flock --exclusive --nonblock 8 \
  || die "A backup or restore operation owns the recovery lock for ${slug}."
taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"
prepare_delivery_lock "${taskspaces_lock}"
exec 7>>"${taskspaces_lock}"
flock --exclusive --nonblock 7 \
  || die "A TaskSpace lifecycle action is active; retry after it finishes."

env_value() {
  release_contract_env_value "${env_file}" "$1"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

compose_project="$(env_value COMPOSE_PROJECT_NAME)"
current_image="$(env_value HARNESS_IMAGE)"
target_image="${HARNESS_IMAGE}"
[[ "${compose_project}" == "forge-${slug}" && -n "${current_image}" && -n "${target_image}" ]] \
  || die "Project image or Compose identity is invalid."

# This is the reviewed vpn24/vpn25 predecessor template. Refuse arbitrary local
# Compose drift instead of overwriting an operator customization silently.
predecessor_compose_hash='9ed917273033dd58ac71d760cc9b1683f664c554f2068d46b9ff3c1af8156def'
current_compose_hash="$(sha256sum "${compose_file}" | awk '{print $1}')"
target_compose_hash="$(sha256sum "${template_compose}" | awk '{print $1}')"
[[ "${current_compose_hash}" == "${predecessor_compose_hash}" \
  || "${current_compose_hash}" == "${target_compose_hash}" ]] \
  || die "Project Compose has unreviewed local changes; refusing TaskSpace migration: ${compose_file}"

current_image_id="$(docker image inspect --format '{{.Id}}' "${current_image}")"
[[ "${current_image_id}" == sha256:* ]] || die "Current Harness image has no immutable image ID."
current_image_build_ref="$(resolve_local_docker_build_ref "${current_image}" "${current_image_id}")"
if docker image inspect "${target_image}" >/dev/null 2>&1; then
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image}")"
  skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${target_image}")"
  [[ "${revision}" == "${HARNESS_IMAGE_REVISION}" && "${skill_bundle}" == "${HARNESS_SKILL_BUNDLE_VERSION}" ]] \
    || die "Target image tag has unexpected provenance: ${target_image}"
  log "Reusing verified TaskSpace image ${target_image}."
else
  log "Building immutable TaskSpace image ${target_image} from ${current_image}."
  docker build \
    --build-arg "HARNESS_BASE_IMAGE=${current_image_build_ref}" \
    --build-arg "HARNESS_BASE_IMAGE_ID=${current_image_id}" \
    --build-arg "DSH_VERSION=${DSH_VERSION}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "INSTALL_DOCUMENT_DEPENDENCIES=true" \
    --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" \
    --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
    --build-arg "HARNESS_RUNTIME_PROFILE=${HARNESS_RUNTIME_PROFILE}" \
    --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
    --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" \
    --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
    --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" \
    --tag "${target_image}" \
    --file "${REPO_ROOT}/docker/harness/Dockerfile.overlay" \
    "${REPO_ROOT}"
fi
verify_target_harness_image "${target_image}" "${current_image_id}"
docker run --rm --entrypoint sh "${target_image}" -c \
  'node --check /usr/local/lib/taskspace-policy.mjs && node --check /usr/local/lib/taskspace-broker.mjs && node --check /usr/local/lib/release-runner.mjs && test -r /usr/local/share/dsh-skills/forge-taskspace-collaboration/SKILL.md && command -v forge-release >/dev/null' \
  || die "Target image does not contain the TaskSpace isolation capability."

# No mutable project runtime changes occur before the active-session and Git
# gates. This is the maintenance-window boundary for an existing project.
if find "${project_root}/dsh-home" "${taskspaces_root}" -type f -name 'session.jsonl.zstd' -mmin -2 -print -quit 2>/dev/null | grep -q .; then
  die "Harness or TaskSpace session state changed in the last two minutes; no project runtime files or containers were changed."
fi
[[ -z "$(project_git_readonly "${project_root}/workspace" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Canonical project workspace is active/dirty; TaskSpace migration is blocked."

runner_container="$(compose ps --quiet release-runner 2>/dev/null || true)"
if [[ -n "${runner_container}" ]]; then
  diagnosis="$(docker exec "${runner_container}" forge-release diagnose)" \
    || die "Release Runner diagnosis failed; no runtime files were changed."
  jq --exit-status '.ok == true and .result.active == false' <<<"${diagnosis}" >/dev/null \
    || die "A controlled release is active; no runtime files were changed."
fi
[[ ! -d "${taskspaces_root}/.broker/release.lock" ]] \
  || die "A TaskSpace release lock exists; no runtime files were changed."

task_compose() {
  local task_env="$1" task_root task_id
  local -a network_args=()
  shift
  task_root="$(dirname -- "${task_env}")"
  task_id="$(basename -- "${task_root}")"
  [[ "${task_env}" == "${task_root}/task.env" ]] \
    || { printf 'TaskSpace environment path is not canonical: %s/%s\n' "${slug}" "${task_id}" >&2; return 1; }
  taskspace_network_compose_args "${task_root}" "${slug}/${task_id}" network_args \
    || { printf 'TaskSpace network contract validation failed: %s/%s\n' "${slug}" "${task_id}" >&2; return 1; }
  docker compose --env-file "${task_env}" --file "${taskspace_template}" \
    "${network_args[@]}" "$@"
}

declare -a task_env_files=()
declare -a active_task_env_files=()
while IFS= read -r -d '' task_env; do
  task_root="$(dirname -- "${task_env}")"
  metadata="${task_root}/metadata.json"
  [[ -f "${metadata}" ]] || die "TaskSpace metadata is missing: ${task_root}"
  task_id="$(basename -- "${task_root}")"
  [[ "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ ]] || die "TaskSpace id is invalid: ${task_id}"
  status="$(jq -r '.status // empty' "${metadata}")"
  case "${status}" in
    active) active_task_env_files+=("${task_env}") ;;
    stopped|closed|provisioning-failed) ;;
    *) die "TaskSpace status is invalid for upgrade: ${task_id}" ;;
  esac
  task_env_files+=("${task_env}")
done < <(find "${taskspaces_root}" -mindepth 2 -maxdepth 2 -type f -name task.env -print0 2>/dev/null)

timestamp="$(date '+%Y%m%d%H%M%S')"
backup_env="${env_file}.pre-taskspace-isolation-${timestamp}-$$"
backup_compose="${compose_file}.pre-taskspace-isolation-${timestamp}-$$"
backup_contract=''
declare -a task_env_backups=()
install -m 0600 -- "${env_file}" "${backup_env}"
chown --reference="${env_file}" "${backup_env}"
install --preserve-timestamps -- "${compose_file}" "${backup_compose}"
chown --reference="${compose_file}" "${backup_compose}"
if [[ -f "${contract_file}" ]]; then
  backup_contract="${contract_file}.pre-taskspace-isolation-${timestamp}-$$"
  install --preserve-timestamps -- "${contract_file}" "${backup_contract}"
  chown --reference="${contract_file}" "${backup_contract}"
fi
for task_env in "${task_env_files[@]}"; do
  task_backup="${task_env}.pre-taskspace-isolation-${timestamp}-$$"
  install -m 0600 -- "${task_env}" "${task_backup}"
  chown --reference="${task_env}" "${task_backup}"
  task_env_backups+=("${task_backup}")
done

rollback_armed=true
rollback_attempted=false
temporary_env="$(mktemp "${ops_root}/.project.env.taskspace.XXXXXX")"
cleanup() {
  rm -f -- "${temporary_env}"
}
rollback() {
  if [[ "${rollback_armed}" != true || "${rollback_attempted}" == true ]]; then return; fi
  rollback_attempted=true
  set +e
  warn "TaskSpace activation failed; restoring the previous project runtime."
  install -m 0600 -- "${backup_env}" "${env_file}"
  chown --reference="${backup_env}" "${env_file}"
  install --preserve-timestamps -- "${backup_compose}" "${compose_file}"
  chown --reference="${backup_compose}" "${compose_file}"
  if [[ -n "${backup_contract}" ]]; then
    install --preserve-timestamps -- "${backup_contract}" "${contract_file}"
    chown --reference="${backup_contract}" "${contract_file}"
  fi
  compose up --detach --remove-orphans release-runner harness-upload harness >/dev/null 2>&1 || true
  for task_index in "${!task_env_files[@]}"; do
    install -m 0600 -- "${task_env_backups[task_index]}" "${task_env_files[task_index]}"
    chown --reference="${task_env_backups[task_index]}" "${task_env_files[task_index]}"
  done
  for task_env in "${active_task_env_files[@]}"; do
    task_compose "${task_env}" up --detach >/dev/null 2>&1 || true
  done
}
on_exit() {
  local status=$?
  if ((status != 0)); then rollback; fi
  cleanup
  return "${status}"
}
trap on_exit EXIT

mkdir -p -m 0700 -- "${taskspaces_root}"
if [[ "${EUID}" -eq 0 ]]; then
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${taskspaces_root}"
fi

# Existing workers are maintenance-window participants. Preserve their
# workspace, DSH_HOME, uploads and named volumes while replacing only the
# image-backed containers that were active before the upgrade.
# Fixed-subnet legacy TaskSpaces gain the canonical filename only after the
# rollback inputs exist. A TaskSpace with no override keeps its original Docker
# allocation model.
for task_env in "${task_env_files[@]}"; do
  task_root="$(dirname -- "${task_env}")"
  task_id="$(basename -- "${task_root}")"
  migrate_taskspace_network_override "${task_root}" "${slug}/${task_id}" \
    || die "TaskSpace network override migration failed: ${slug}/${task_id}"
done
for task_env in "${active_task_env_files[@]}"; do
  task_compose "${task_env}" down --remove-orphans
done
for task_env in "${task_env_files[@]}"; do
  task_temporary_env="$(mktemp "$(dirname -- "${task_env}")/.task.env.taskspace.XXXXXX")"
  awk -v image="${target_image}" '
    BEGIN { found=0 }
    /^HARNESS_IMAGE=/ { print "HARNESS_IMAGE=" image; found=1; next }
    { print }
    END { if (!found) print "HARNESS_IMAGE=" image }
  ' "${task_env}" >"${task_temporary_env}"
  chmod 0600 "${task_temporary_env}"
  chown --reference="${task_env}" "${task_temporary_env}"
  mv -- "${task_temporary_env}" "${task_env}"
  task_compose "${task_env}" config --quiet || die "Existing TaskSpace Compose validation failed: ${task_env}"
done

awk \
  -v image="${target_image}" '
  BEGIN { harness=0; runner=0; minimum=0; maximum=0 }
  /^HARNESS_IMAGE=/ { print "HARNESS_IMAGE=" image; harness=1; next }
  /^RELEASE_RUNNER_IMAGE=/ { print "RELEASE_RUNNER_IMAGE=" image; runner=1; next }
  /^TASKSPACE_PORT_MIN=/ { print "TASKSPACE_PORT_MIN=20000"; minimum=1; next }
  /^TASKSPACE_PORT_MAX=/ { print "TASKSPACE_PORT_MAX=29999"; maximum=1; next }
  { print }
  END {
    if (!harness) print "HARNESS_IMAGE=" image
    if (!runner) print "RELEASE_RUNNER_IMAGE=" image
    if (!minimum) print "TASKSPACE_PORT_MIN=20000"
    if (!maximum) print "TASKSPACE_PORT_MAX=29999"
  }
' "${env_file}" >"${temporary_env}"
chmod 0600 "${temporary_env}"
chown --reference="${env_file}" "${temporary_env}"
mv -- "${temporary_env}" "${env_file}"
install --preserve-timestamps -- "${template_compose}" "${compose_file}"
chown --reference="${backup_compose}" "${compose_file}"

render_release_contract \
  "${slug}" "${project_root}" "${project_root}/workspace" "${env_file}" "${contract_file}"
chown --reference="${env_file}" "${contract_file}"
chmod 0640 "${contract_file}"
compose config --quiet || die "TaskSpace project Compose validation failed."

# The shared writable Harness is retired. Its state and volumes remain intact
# for rollback/evidence, but no default project command starts it again.
compose --profile legacy-shared-harness rm --force --stop harness harness-upload >/dev/null 2>&1 || true
compose up --detach --force-recreate release-runner taskspace-broker

broker_container="$(compose ps --quiet taskspace-broker)"
runner_container="$(compose ps --quiet release-runner)"
[[ -n "${broker_container}" && -n "${runner_container}" ]] \
  || die "TaskSpace Broker or Release Runner container is missing."
broker_ready=false
for _attempt in {1..30}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${broker_container}" 2>/dev/null)" == healthy ]]; then
    broker_ready=true
    break
  fi
  sleep 1
done
[[ "${broker_ready}" == true ]] || die "TaskSpace Broker did not become healthy."

if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "${broker_container}" \
  | grep -Eq '^(/var/run/docker.sock|/srv/forge-delivery/secrets|/srv/forge-delivery/shared-services)'; then
  die "TaskSpace Broker exposes a forbidden Docker, secret, or shared-service mount."
fi
legacy_harness="$(compose --profile legacy-shared-harness ps --quiet harness 2>/dev/null || true)"
[[ -z "${legacy_harness}" ]] || die "Legacy shared Harness container still exists."

for task_env in "${active_task_env_files[@]}"; do
  task_compose "${task_env}" up --detach
  task_harness="$(task_compose "${task_env}" ps --quiet harness)"
  [[ -n "${task_harness}" \
    && "$(docker inspect --format '{{.State.Running}}' "${task_harness}")" == true \
    && "$(docker inspect --format '{{.Config.Image}}' "${task_harness}")" == "${target_image}" ]] \
    || die "Existing active TaskSpace did not restart on the target image: ${task_env}"
done

rollback_armed=false
trap - EXIT
cleanup
log "TaskSpace isolation is active for ${slug}; the legacy shared Harness is stopped and excluded from default startup."
log "Create isolated workers with: bash ${SCRIPT_DIR}/projectctl.sh ${slug} taskspace create --task <id> --actor <id> --conversation <id>"
log "Rollback evidence: ${backup_env}; ${backup_compose}${backup_contract:+; ${backup_contract}}."
