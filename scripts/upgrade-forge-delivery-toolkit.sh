#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"
source "${SCRIPT_DIR}/lib/container-image-cutover.sh"
runtime_template_filter="${SCRIPT_DIR}/lib/runtime-template-compose.jq"
[[ -f "${runtime_template_filter}" && ! -L "${runtime_template_filter}" \
  && "$(stat -c '%h' -- "${runtime_template_filter}")" == 1 ]] \
  || die "Runtime-template Compose filter is missing or unsafe."

usage() { printf 'Usage: %s --confirm-maintenance-window forge-delivery-toolkit\n' "$0"; }
confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == forge-delivery-toolkit ]] || die "This upgrade requires --confirm-maintenance-window forge-delivery-toolkit."
for command_name in awk basename chmod chown cmp cp curl date dirname docker find flock getent grep id install jq ln mkdir mktemp mv readlink rm rmdir sha256sum sort stat systemctl tar; do require_command "${command_name}"; done
upgrade_script_sha256="$(sha256sum "${SCRIPT_DIR}/upgrade-forge-delivery-toolkit.sh" | awk '{print $1}')"
upgrade_versions_sha256="$(sha256sum "${REPO_ROOT}/config/versions.env" | awk '{print $1}')"
require_docker_access
acquire_harness_image_upgrade_lock
repair_harness_deepseek_secret_access

registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
control_env="${DELIVERY_ROOT}/conversation-control-plane/control-plane.env"
[[ -f "${registry_file}" && -f "${control_env}" ]] || die "Unified conversation control plane is not prepared."
control_plane_project_name="$(control_plane_compose_project_name "${control_env}")"
projects_lock="${DELIVERY_ROOT}/registry/projects.lock"
prepare_delivery_lock "${projects_lock}"
exec 5>>"${projects_lock}"
flock --exclusive --nonblock 5 || die "A project create, clone, or registry action is active."
taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"
prepare_delivery_lock "${taskspaces_lock}"
exec 6>>"${taskspaces_lock}"
flock --exclusive --nonblock 6 || die "A TaskSpace lifecycle action is active."
mapfile -t project_slugs < <(awk -F '\t' 'NR > 1 {print $1}' "${registry_file}" | sort)
((${#project_slugs[@]} > 0)) || die "No registered projects exist."
declare -a recovery_lock_fds=()
for slug in "${project_slugs[@]}"; do
  recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
  prepare_delivery_lock "${recovery_lock}"
  exec {recovery_lock_fd}>>"${recovery_lock}"
  flock --exclusive --nonblock "${recovery_lock_fd}" || die "A backup or restore operation owns the recovery lock for ${slug}."
  recovery_lock_fds+=("${recovery_lock_fd}")
done

glm_provider_status=''
glm_canonical_key_file="${DELIVERY_ROOT}/secrets/glm-api-key"
glm_unconfigured_key_file="${DELIVERY_ROOT}/secrets/glm-api-key-unconfigured"
glm_unconfigured_marker_needed=false
glm_unconfigured_marker_created_by_operation=false
glm_unconfigured_marker_is_exact() {
  local metadata
  metadata="$(stat -Lc '%u:%g:%a:%h' -- "${glm_unconfigured_key_file}" 2>/dev/null || true)"
  [[ -f "${glm_unconfigured_key_file}" && ! -L "${glm_unconfigured_key_file}" \
    && "${metadata}" == '0:0:400:1' && ! -s "${glm_unconfigured_key_file}" ]]
}
prepare_glm_provider_compatibility() {
  local configured_path="${GLM_KEY_FILE:-${glm_canonical_key_file}}" metadata
  [[ -d "${DELIVERY_ROOT}/secrets" && ! -L "${DELIVERY_ROOT}/secrets" ]] \
    || die "Provider secret root is missing or unsafe."
  [[ "$(readlink -m -- "${configured_path}")" == "${configured_path}" ]] \
    || die "GLM key path is not canonical."
  if [[ -f "${configured_path}" && ! -L "${configured_path}" ]]; then
    metadata="$(stat -Lc '%u:%g:%a:%h' -- "${configured_path}")"
    if [[ "${configured_path}" == "${glm_unconfigured_key_file}" ]]; then
      [[ "${metadata}" == '0:0:400:1' && ! -s "${configured_path}" ]] \
        || die "Unconfigured GLM marker is not an exact root-only zero-byte ordinary file."
      glm_provider_status=unconfigured
    else
      [[ "${configured_path}" == "${glm_canonical_key_file}" \
        && "${metadata}" == '0:0:600:1' && -s "${configured_path}" ]] \
        || die "Configured GLM key is not the canonical non-empty root:root mode-0600 secret."
      glm_provider_status=configured
    fi
  elif [[ ! -e "${configured_path}" && ! -L "${configured_path}" \
    && "${configured_path}" == "${glm_canonical_key_file}" ]]; then
    if [[ -e "${glm_unconfigured_key_file}" || -L "${glm_unconfigured_key_file}" ]]; then
      glm_unconfigured_marker_is_exact \
        || die "Existing unconfigured GLM marker is unsafe."
    else
      glm_unconfigured_marker_needed=true
    fi
    configured_path="${glm_unconfigured_key_file}"
    glm_provider_status=unconfigured
  else
    die "GLM key path is missing, unsafe, or outside the supported compatibility contract."
  fi
  GLM_KEY_FILE="${configured_path}"
  export GLM_KEY_FILE
}
prepare_glm_provider_compatibility

establish_glm_provider_compatibility() {
  [[ "${glm_provider_status}" == unconfigured ]] || return 0
  if [[ "${glm_unconfigured_marker_needed}" == true ]]; then
    [[ ! -e "${glm_unconfigured_key_file}" && ! -L "${glm_unconfigured_key_file}" ]] \
      || die "Unconfigured GLM marker appeared after preflight."
    install -m 0400 -o root -g root /dev/null "${glm_unconfigured_key_file}"
    glm_unconfigured_marker_created_by_operation=true
  fi
  glm_unconfigured_marker_is_exact \
    || die "Unconfigured GLM marker could not be established safely."
}

remove_operation_glm_unconfigured_marker() {
  [[ "${glm_unconfigured_marker_created_by_operation}" == true ]] || return 0
  glm_unconfigured_marker_is_exact || return 1
  rm -- "${glm_unconfigured_key_file}" || return 1
  glm_unconfigured_marker_created_by_operation=false
}

declare -A project_git_root_needed=() project_git_root_created_by_operation=() project_verification_mode=()
project_git_root_is_exact() {
  local slug="$1" host_uid="$2" root metadata
  root="${DELIVERY_ROOT}/git-remotes/${slug}"
  metadata="$(stat -Lc '%u:%a' -- "${root}" 2>/dev/null || true)"
  [[ -d "${root}" && ! -L "${root}" && "${metadata}" == "${host_uid}:700" ]]
}
establish_project_git_roots() {
  local slug env_file host_uid host_gid root
  [[ -d "${DELIVERY_ROOT}/git-remotes" && ! -L "${DELIVERY_ROOT}/git-remotes" ]] \
    || die "Project Git credential root is missing or unsafe."
  for slug in "${project_slugs[@]}"; do
    [[ "${project_git_root_needed[${slug}]:-false}" == true ]] || continue
    env_file="${DELIVERY_ROOT}/projects/${slug}/ops/project.env"
    host_uid="$(env_value "${env_file}" HOST_UID)"
    host_gid="$(env_value "${env_file}" HOST_GID)"
    [[ "${host_uid}" =~ ^[1-9][0-9]*$ && "${host_gid}" =~ ^[1-9][0-9]*$ ]] \
      || die "Project ${slug} has no safe host identity for its empty Git credential directory."
    root="${DELIVERY_ROOT}/git-remotes/${slug}"
    [[ ! -e "${root}" && ! -L "${root}" ]] \
      || die "Project Git credential directory appeared after preflight for ${slug}."
    install -d -m 0700 -o "${host_uid}" -g "${host_gid}" "${root}"
    project_git_root_created_by_operation["${slug}"]=true
    project_git_root_is_exact "${slug}" "${host_uid}" \
      || die "Project Git credential directory could not be established safely for ${slug}."
  done
}
remove_operation_project_git_roots() {
  local slug env_file host_uid root
  for slug in "${project_slugs[@]}"; do
    [[ "${project_git_root_created_by_operation[${slug}]:-false}" == true ]] || continue
    env_file="${DELIVERY_ROOT}/projects/${slug}/ops/project.env"
    host_uid="$(env_value "${env_file}" HOST_UID)"
    root="${DELIVERY_ROOT}/git-remotes/${slug}"
    project_git_root_is_exact "${slug}" "${host_uid}" || return 1
    rmdir -- "${root}" || return 1
    project_git_root_created_by_operation["${slug}"]=false
  done
}

env_value() { local file="$1" key="$2"; awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${file}"; }
upsert_env() {
  local file="$1" key="$2" value="$3" temporary
  temporary="${file}.toolkit.$$"
  [[ -f "${file}" && ! -L "${file}" && ! -L "${temporary}" ]] || die "Project environment is missing or unsafe: ${file}"
  awk -F= -v key="${key}" -v value="${value}" 'BEGIN {found=0} $1 == key {print key "=" value;found=1;next} {print} END {if (!found) print key "=" value}' "${file}" >"${temporary}"
  chmod --reference="${file}" "${temporary}"; chown --reference="${file}" "${temporary}"; mv -- "${temporary}" "${file}"
}
probe_project_verification_mode() {
  local slug="$1" root override contract runner_env state unit_state marker marker_count=0
  root="${DELIVERY_ROOT}/projects/${slug}"
  override="${root}/ops/compose.host-verification.yaml"
  contract="${root}/verification/host-contract.json"
  runner_env="${root}/verification/host-runner.env"
  state="${root}/verification/host-state"
  for marker in "${override}" "${contract}" "${runner_env}" "${state}"; do
    if [[ -e "${marker}" || -L "${marker}" ]]; then marker_count=$((marker_count + 1)); fi
  done
  unit_state="$(systemctl is-active "forge-host-verification@${slug}.service" 2>/dev/null || true)"
  if [[ "${marker_count}" -eq 0 ]]; then
    if [[ "${unit_state}" == active ]]; then printf '%s\n' invalid; else printf '%s\n' legacy; fi
    return 0
  fi
  if [[ "${marker_count}" -eq 4 \
    && -f "${override}" && ! -L "${override}" && "$(stat -c '%h' -- "${override}")" == 1 \
    && -f "${contract}" && ! -L "${contract}" && "$(stat -c '%h' -- "${contract}")" == 1 \
    && -f "${runner_env}" && ! -L "${runner_env}" && "$(stat -c '%h' -- "${runner_env}")" == 1 \
    && -d "${state}" && ! -L "${state}" ]] \
    && cmp -- "${REPO_ROOT}/templates/project/compose.host-verification.yaml" "${override}" >/dev/null; then
    printf '%s\n' host
  else
    printf '%s\n' invalid
  fi
}
freeze_project_verification_modes() {
  local slug mode
  for slug in "${project_slugs[@]}"; do
    mode="$(probe_project_verification_mode "${slug}")"
    case "${mode}" in
      host|legacy) project_verification_mode["${slug}"]="${mode}" ;;
      *) die "Project ${slug} Host Verification wiring is partial, unsafe, or drifted." ;;
    esac
  done
}
project_uses_host_verification() {
  local slug="$1"
  [[ "${project_verification_mode[${slug}]:-}" == host ]]
}
project_compose() {
  local slug="$1" root mode
  local -a compose=(docker compose)
  shift
  root="${DELIVERY_ROOT}/projects/${slug}"
  mode="${project_verification_mode[${slug}]:-}"
  compose+=(--env-file "${root}/ops/project.env" --file "${root}/ops/compose.yaml")
  case "${mode}" in
    host) compose+=(--file "${root}/ops/compose.host-verification.yaml") ;;
    legacy) ;;
    *) die "Project ${slug} Verification mode was not frozen before Compose access." ;;
  esac
  "${compose[@]}" "$@"
}
project_broker_inventory_contract_ready() {
  local slug="$1" root env_file expected_mode expected_contract
  root="${DELIVERY_ROOT}/projects/${slug}"
  env_file="${root}/ops/project.env"
  if project_uses_host_verification "${slug}"; then
    expected_mode=host-toolchain
    expected_contract="${root}/verification/host-contract.json"
  else
    expected_mode=container-toolchain
    expected_contract="${root}/verification/contract.json"
  fi
  [[ "$(env_value "${env_file}" PROJECT_VERIFICATION_MODE)" == "${expected_mode}" \
    && "$(env_value "${env_file}" PROJECT_VERIFICATION_CONTRACT)" == "${expected_contract}" \
    && -f "${expected_contract}" && ! -L "${expected_contract}" \
    && "$(stat -c '%h' -- "${expected_contract}")" == 1 ]]
}
control_compose() { docker compose --project-name "${control_plane_project_name}" --env-file "${control_env}" --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" "$@"; }
control_runtime_template_compose() {
  local env_file="$1" project_name="$2" compose_file="$3"
  shift 3
  docker compose --project-name "${project_name}" \
    --env-file "${env_file}" \
    --file "${compose_file}" "$@"
}
render_runtime_template_compose() {
  local output="$1" services_json="$2" temporary="${1}.tmp.$$"
  [[ "$(dirname -- "${output}")" == "${runtime_template_root}" \
    && ! -e "${output}" && ! -L "${output}" \
    && ! -e "${temporary}" && ! -L "${temporary}" ]] || return 1
  if ! jq --argjson services "${services_json}" --from-file "${runtime_template_filter}" >"${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  chmod 0600 "${temporary}"
  mv --no-target-directory -- "${temporary}" "${output}"
}
# Existing TaskSpaces are a preserved generation in this cutover. Inventory is
# resolved from their existing Compose labels so a newer TaskSpace template is
# never rendered against legacy task.env files. This upgrade does not migrate or
# recreate TaskSpace containers or networks.
task_compose() {
  local slug="$1" task_id="$2" task_root task_env compose_project expected_project service inventory expected_name candidate candidate_name selected=''
  local include_all=false
  local -a ps_args=(ps --no-trunc)
  shift 2
  task_root="${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}"
  task_env="${task_root}/task.env"
  if [[ "$#" -eq 3 && "$1" == ps && "$2" == --quiet ]]; then
    service="$3"
  elif [[ "$#" -eq 4 && "$1" == ps && "$2" == --all && "$3" == --quiet ]]; then
    include_all=true
    service="$4"
  else
    printf 'Unsupported preserved TaskSpace inventory operation: %s/%s\n' "${slug}" "${task_id}" >&2
    return 1
  fi
  case "${service}" in harness|harness-upload) ;; *)
    printf 'Unsupported preserved TaskSpace inventory service: %s/%s/%s\n' "${slug}" "${task_id}" "${service}" >&2
    return 1
  esac
  [[ -f "${task_env}" && ! -L "${task_env}" ]] || {
    printf 'TaskSpace environment is missing or unsafe: %s\n' "${task_env}" >&2
    return 1
  }
  compose_project="$(env_value "${task_env}" TASKSPACE_COMPOSE_PROJECT_NAME)"
  expected_project="forge-${slug}-task-${task_id}"
  [[ "${compose_project}" == "${expected_project}" ]] || {
    printf 'TaskSpace Compose project identity is invalid: %s/%s\n' "${slug}" "${task_id}" >&2
    return 1
  }
  [[ "${include_all}" == false ]] || ps_args+=(--all)
  ps_args+=(
    --filter "label=com.docker.compose.project=${compose_project}"
    --filter "label=com.docker.compose.service=${service}"
    --format '{{.ID}}'
  )
  inventory="$(docker "${ps_args[@]}")" || return 1
  expected_name="${compose_project}-${service}-1"
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    candidate_name="$(docker inspect --format '{{.Name}}' "${candidate}" 2>/dev/null)" || return 1
    if [[ "${candidate_name#/}" != "${expected_name}" ]]; then
      [[ "$(docker inspect --format '{{.State.Running}}' "${candidate}" 2>/dev/null)" != true ]] || {
        printf 'Unexpected running TaskSpace candidate: %s/%s/%s\n' "${slug}" "${task_id}" "${service}" >&2
        return 1
      }
      continue
    fi
    [[ -z "${selected}" ]] || return 1
    selected="${candidate}"
  done <<<"${inventory}"
  printf '%s\n' "${selected}"
}
container_running_healthy() { local id="$1"; [[ -n "${id}" && "$(docker inspect --format '{{.State.Running}}' "${id}" 2>/dev/null)" == true && "$(docker inspect --format '{{.State.Health.Status}}' "${id}" 2>/dev/null)" == healthy ]]; }
host_verification_is_ready() {
  local slug="$1" root contract runner_env socket source_socket expected_revision
  root="${DELIVERY_ROOT}/projects/${slug}"
  contract="${root}/verification/host-contract.json"
  runner_env="${root}/verification/host-runner.env"
  socket="${root}/verification/ipc/runner.sock"
  source_socket="${root}/verification/source-ipc/source.sock"
  project_uses_host_verification "${slug}" || return 1
  [[ "$(probe_project_verification_mode "${slug}")" == host ]] || return 1
  jq -e --arg slug "${slug}" --arg taskspaces "${root}/taskspaces" --arg state "${root}/verification/host-state" '
    .schemaVersion==2 and .executionMode=="host-toolchain" and .projectSlug==$slug
    and .taskspacesRoot==$taskspaces and .stateRoot==$state
    and (.runnerRevision|type=="string" and startswith("forge-host-runner-"))
  ' "${contract}" >/dev/null || return 1
  [[ "$(env_value "${runner_env}" VERIFICATION_PROJECT_SLUG)" == "${slug}" \
    && "$(env_value "${runner_env}" VERIFICATION_CONTRACT)" == "${contract}" \
    && "$(env_value "${runner_env}" VERIFICATION_RUNNER_SOCKET)" == "${socket}" \
    && "$(env_value "${runner_env}" VERIFICATION_SOURCE_SOCKET)" == "${root}/verification/source-ipc/source.sock" \
    && "$(env_value "${runner_env}" PROTECTED_ACCEPTANCE_ISSUER_SOCKET)" == "${root}/acceptance/ipc-issuer/issuer.sock" ]] \
    || return 1
  expected_revision="$(jq -er '.runnerRevision' "${contract}")" || return 1
  systemctl is-active --quiet "forge-host-verification@${slug}.service" || return 1
  [[ -S "${socket}" && -S "${source_socket}" ]] || return 1
  curl -fsS --max-time 5 --unix-socket "${socket}" http://localhost/healthz \
    | jq -e --arg slug "${slug}" --arg revision "${expected_revision}" '
      .ok==true and .projectSlug==$slug and .runnerRevision==$revision
      and .activeJobs==0 and .acceptingJobs==true and .safetyHold==null
    ' >/dev/null || return 1
  curl -fsS --max-time 5 --unix-socket "${source_socket}" http://localhost/healthz \
    | jq -e --arg slug "${slug}" '
      .ok==true and .projectSlug==$slug and .capability=="controlled-source-observer"
    ' >/dev/null
}
host_retained_legacy_is_stopped() {
  local slug="$1" id="${2:-}"
  if [[ -z "${id}" ]]; then
    id="$(project_compose "${slug}" ps --all --quiet verification-runner 2>/dev/null || true)"
  fi
  [[ "${id}" =~ ^[0-9a-f]{12,64}$ && "${id}" != *$'\n'* \
    && "$(docker inspect --format '{{.State.Status}}' "${id}" 2>/dev/null)" == exited \
    && "$(docker inspect --format '{{.State.Running}}' "${id}" 2>/dev/null)" == false ]]
}
broker_uses_host_verification() {
  local slug="$1" root contract expected_revision broker_id
  root="${DELIVERY_ROOT}/projects/${slug}"
  contract="${root}/verification/host-contract.json"
  project_uses_host_verification "${slug}" || return 1
  expected_revision="$(jq -er '.runnerRevision' "${contract}")" || return 1
  broker_id="$(project_compose "${slug}" ps --quiet taskspace-broker)"
  container_running_healthy "${broker_id}" || return 1
  docker exec "${broker_id}" node -e '
    const h=require("node:http");
    const [slug,revision]=process.argv.slice(1);
    const q=h.request({socketPath:"/run/forge-verify/runner.sock",path:"/healthz"},r=>{
      let body="";
      r.on("data",chunk=>body+=chunk);
      r.on("end",()=>{
        try {
          const value=JSON.parse(body);
          process.exit(r.statusCode===200 && value.ok===true && value.projectSlug===slug
            && value.runnerRevision===revision && value.activeJobs===0
            && value.acceptingJobs===true && value.safetyHold===null ? 0 : 1);
        } catch { process.exit(1); }
      });
    });
    q.on("error",()=>process.exit(1));
    q.end();
  ' "${slug}" "${expected_revision}"
}
wait_container_health() {
  local id="$1" deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do container_running_healthy "${id}" && return 0; sleep 2; done
  return 1
}
wait_project_service_health() {
  local slug="$1" service="$2" id deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do id="$(project_compose "${slug}" ps --quiet "${service}")"; container_running_healthy "${id}" && return 0; sleep 2; done
  return 1
}
runtime_template_compose() {
  local slug="$1" project_name="$2" compose_file="$3"
  shift 3
  docker compose --project-name "${project_name}" \
    --env-file "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" \
    --file "${compose_file}" "$@"
}
compose_hash_value() {
  local value
  value="$(awk 'NF {print $NF; exit}')"
  [[ "${value}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "${value}"
}

expected_base_image_id="$(resolve_configured_harness_foundation_image_id)"
if docker image inspect "${HARNESS_IMAGE}" >/dev/null 2>&1; then
  verify_target_harness_image "${HARNESS_IMAGE}" "${expected_base_image_id}"
else
  foundation_image_build_ref="$(resolve_local_docker_build_ref "${HARNESS_FOUNDATION_IMAGE}" "${expected_base_image_id}")"
  docker build \
    --build-arg "HARNESS_BASE_IMAGE=${foundation_image_build_ref}" --build-arg "HARNESS_BASE_IMAGE_ID=${expected_base_image_id}" \
    --build-arg "DSH_VERSION=${DSH_VERSION}" --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
    --build-arg "HARNESS_RUNTIME_PROFILE=${HARNESS_RUNTIME_PROFILE}" --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
    --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
    --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" --build-arg INSTALL_DOCUMENT_DEPENDENCIES=false \
    --tag "${HARNESS_IMAGE}" --file "${REPO_ROOT}/docker/harness/Dockerfile.overlay" "${REPO_ROOT}"
  verify_target_harness_image "${HARNESS_IMAGE}" "${expected_base_image_id}"
fi
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
[[ "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Verified Harness image has no immutable image ID."
target_cache_image_id="${target_image_id#sha256:}"
verify_target_harness_image "${CONVERSATION_MANAGER_IMAGE}" "${expected_base_image_id}"
conversation_manager_image_id="${FORGE_VERIFIED_HARNESS_IMAGE_ID}"
[[ "${conversation_manager_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "Verified Conversation Manager image has no immutable image ID."

validate_managed_contract() {
  local contract="$1" slug="$2" root="$3"
  jq -e --arg slug "${slug}" --arg cacheBase "${root}/cache-packs" --arg state "${root}/state" '
    type=="object" and (keys|sort)==["cacheRoot","limits","profiles","projectSlug","runnerRevision","schemaVersion","stateRoot","toolchainImage"]
    and .schemaVersion==1 and .projectSlug==$slug
    and (.runnerRevision|type=="string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"))
    and (.toolchainImage|type=="string" and test("^sha256:[0-9a-f]{64}$"))
    and (.cacheRoot==$cacheBase or .cacheRoot==($cacheBase+"/images/"+(.toolchainImage|sub("^sha256:";""))))
    and .stateRoot==$state
    and (.profiles==["governance","backend-red-test","frontend-red-test","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-build","frontend-h5-build","changed-safe","full-regression"]
      or .profiles==["governance","backend-red-test","frontend-red-test","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-typecheck","frontend-admin-build","frontend-h5-build","changed-safe","full-regression"]
      or .profiles==["governance","backend-red-test","frontend-red-test","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-typecheck","frontend-admin-build","frontend-h5-test","frontend-h5-build","changed-safe","full-regression"])
    and .limits=={maxFiles:250000,maxBytes:4294967296,maxLogBytes:8388608,defaultTimeoutSeconds:900}' "${contract}" >/dev/null
}
prepare_verification_tree() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/$1" root contract tmp directory unsafe owner_uid owner_gid image_cache_root
  root="${project_root}/verification"; contract="${root}/contract.json"
  image_cache_root="${root}/cache-packs/images/${target_cache_image_id}"
  [[ -d "${project_root}" && ! -L "${project_root}" && ! -L "${root}" \
    && ! -L "${root}/ipc" && ! -L "${root}/source-ipc" && ! -L "${root}/empty-manager-mask" && ! -L "${root}/state" && ! -L "${root}/cache-packs" \
    && ! -L "${root}/cache-packs/images" && ! -L "${image_cache_root}" ]] || die "Verification root is unsafe for ${slug}."
  install -d -m 2700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${root}" "${root}/ipc" "${root}/source-ipc" "${root}/empty-manager-mask" "${root}/state" "${root}/cache-packs" "${root}/cache-packs/images" "${image_cache_root}"
  [[ "$(readlink -f -- "${root}")" == "$(readlink -f -- "${project_root}")/verification" ]] || die "Verification root escaped ${slug}."
  for directory in "${root}/state" "${root}/cache-packs"; do
    unsafe="$(find "${directory}" -xdev -type l -print -quit)"; [[ -z "${unsafe}" ]] || die "Verification state contains a symlink: ${unsafe}"
    unsafe="$(find "${directory}" -xdev ! -type d ! -type f -print -quit)"; [[ -z "${unsafe}" ]] || die "Verification state contains an unsupported node: ${unsafe}"
    unsafe="$(find "${directory}" -xdev -type f ! -links 1 -print -quit)"; [[ -z "${unsafe}" ]] || die "Verification state contains a multiply linked file: ${unsafe}"
    find "${directory}" -xdev \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) -exec chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" {} +
    if [[ "${directory}" == "${root}/state" ]]; then
      find "${directory}" -xdev -type d -exec chmod 2700 {} +
      find "${directory}" -xdev -type f -exec chmod 0600 {} +
    fi
  done
  chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${root}" "${root}/ipc" "${root}/source-ipc" "${root}/empty-manager-mask" "${root}/state" "${root}/cache-packs" "${root}/cache-packs/images" "${image_cache_root}"
  chmod 2700 "${root}" "${root}/ipc" "${root}/source-ipc" "${root}/empty-manager-mask" "${root}/state" "${root}/cache-packs" "${root}/cache-packs/images" "${image_cache_root}"
  if [[ -e "${contract}" || -L "${contract}" ]]; then
    [[ -f "${contract}" && ! -L "${contract}" && "$(stat -c '%h' -- "${contract}")" == 1 ]] || die "Verification contract is unsafe for ${slug}."
    validate_managed_contract "${contract}" "${slug}" "${root}" || die "Verification contract is unmanaged for ${slug}."
  fi
  tmp="$(mktemp "${root}/.contract.XXXXXX")"
  if ! jq --null-input --arg slug "${slug}" --arg revision "${HARNESS_IMAGE_REVISION}" --arg image "${target_image_id}" --arg cache "${image_cache_root}" --arg state "${root}/state" '
    {schemaVersion:1,projectSlug:$slug,runnerRevision:$revision,toolchainImage:$image,cacheRoot:$cache,stateRoot:$state,
     profiles:["governance","backend-red-test","frontend-red-test","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-typecheck","frontend-admin-build","frontend-h5-test","frontend-h5-build","changed-safe","full-regression"],
     limits:{maxFiles:250000,maxBytes:4294967296,maxLogBytes:8388608,defaultTimeoutSeconds:900}}' >"${tmp}" \
    || ! chmod 0600 "${tmp}" || ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${tmp}" || ! mv -- "${tmp}" "${contract}"; then
    rm -f -- "${tmp}" 2>/dev/null || true; die "Verification contract publication failed for ${slug}."
  fi
  owner_uid="$(id -u "${DELIVERY_OWNER}")"; owner_gid="$(getent group "${DELIVERY_GROUP}"|awk -F: '{print $3;exit}')"
  for directory in "${root}" "${root}/ipc" "${root}/source-ipc" "${root}/empty-manager-mask" "${root}/state" "${root}/cache-packs" "${root}/cache-packs/images" "${image_cache_root}"; do
    [[ "$(stat -c '%u:%g:%a' -- "${directory}")" == "${owner_uid}:${owner_gid}:2700" ]] || die "Verification ownership/mode drifted: ${directory}"
  done
}

acceptance_writer_scopes_ready() {
  local config="$1"
  [[ -f "${config}" && ! -L "${config}" ]] || return 1
  jq -e '
    has("conversationWriterScopes")
    and (.conversationWriterScopes|type=="array")
    and all(.conversationWriterScopes[];
      type=="object"
      and (.taskProfile|type=="string" and length>0)
      and (.ownedPaths|type=="array")
      and all(.ownedPaths[]; type=="string" and length>0)
      and (.ownedPaths == (.ownedPaths | sort | unique)))
  ' "${config}" >/dev/null
}

render_project_compose_with_managed_files() {
  local slug="$1" applications="$2" registry temporary result
  registry="$(env_value "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" PROJECT_MANAGED_FILE_TARGETS_FILE)"
  if [[ -z "${registry}" ]]; then
    release_contract_render_project_compose "${REPO_ROOT}/templates/project/compose.yaml" "${applications}"
    return
  fi
  require_command node
  temporary="$(mktemp)"
  if ! release_contract_render_project_compose "${REPO_ROOT}/templates/project/compose.yaml" "${applications}" >"${temporary}"; then
    rm -f -- "${temporary}"; return 1
  fi
  node "${REPO_ROOT}/scripts/lib/managed-file-compose.mjs" render "${slug}" "${registry}" "${temporary}" && result=0 || result=$?
  rm -f -- "${temporary}"
  return "${result}"
}

migrate_acceptance_writer_scopes() {
  local config="$1" temporary
  [[ -f "${config}" && ! -L "${config}" && "$(stat -c '%h' -- "${config}")" == 1 ]] \
    || die "Protected acceptance config is missing or unsafe: ${config}"
  if jq -e 'has("conversationWriterScopes")' "${config}" >/dev/null \
    && ! jq -e '
      (.conversationWriterScopes == [{taskProfile:"frontend-admin",ownedPaths:["forge-admin-ui/src"]}])
      or (.conversationWriterScopes == [{taskProfile:"frontend-admin",ownedPaths:["forge-admin-ui/src","forge-admin-ui/package.json","forge-admin-ui/pnpm-lock.yaml","forge-admin-ui/jsconfig.json"]}])
      or (.conversationWriterScopes == [{taskProfile:"frontend-admin",ownedPaths:["forge-admin-ui/jsconfig.json","forge-admin-ui/package.json","forge-admin-ui/pnpm-lock.yaml","forge-admin-ui/src"]}]
        and (has("conversationTaskPreparation")|not))
      or (.conversationTaskPreparation == true and .conversationWriterScopes == [
        {taskProfile:"frontend-admin",ownedPaths:["forge-admin-ui/jsconfig.json","forge-admin-ui/package.json","forge-admin-ui/pnpm-lock.yaml","forge-admin-ui/src"]},
        {taskProfile:"backend",ownedPaths:["forge-server/forge-business/forge-business-core/src"]},
        {taskProfile:"migration",ownedPaths:["forge-server/db/migration"]}])
      or (.conversationTaskPreparation == true and .conversationWriterScopes == [
        {taskProfile:"frontend-admin",ownedPaths:["forge-admin-ui/jsconfig.json","forge-admin-ui/package.json","forge-admin-ui/pnpm-lock.yaml","forge-admin-ui/src"]},
        {taskProfile:"backend",ownedPaths:["docker-forge-admin/Dockerfile.admin","forge-server/forge-business/forge-business-core/src"]},
        {taskProfile:"migration",ownedPaths:["forge-server/db/migration"]}])
      or (.conversationTaskPreparation == true and .conversationWriterScopes == [
        {taskProfile:"frontend-admin",ownedPaths:["forge-admin-ui/jsconfig.json","forge-admin-ui/package.json","forge-admin-ui/pnpm-lock.yaml","forge-admin-ui/src"]},
        {taskProfile:"backend",ownedPaths:["docker-forge-admin/Dockerfile.admin","forge-server/forge-business/forge-business-core/src"]},
        {taskProfile:"migration",ownedPaths:["forge-server/db/migration"]},
        {taskProfile:"shared-owner",ownedPaths:["forge-h5-ui/src"]}])
    ' "${config}" >/dev/null; then
    return 0
  fi
  temporary="$(mktemp "$(dirname -- "${config}")/.service-scopes.XXXXXX")"
  if ! jq --slurpfile template "${REPO_ROOT}/templates/project/acceptance-service.json.tpl" \
      '. + {conversationWriterScopes:$template[0].conversationWriterScopes,
        conversationTaskPreparation: (if has("conversationTaskPreparation") then .conversationTaskPreparation else $template[0].conversationTaskPreparation end)}' \
      "${config}" >"${temporary}" \
    || ! chmod 0600 "${temporary}" \
    || ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}" \
    || ! mv -- "${temporary}" "${config}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    die "Protected acceptance writer-scope migration failed: ${config}"
  fi
}

migrate_acceptance_h5_test_profile() {
  local config="$1" temporary
  # Exact prior default only: preserve custom allowed-profile policies.
  jq -e '.allowedVerificationProfiles == ["governance","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-typecheck","frontend-admin-build","frontend-h5-build","changed-safe","full-regression"] or .allowedVerificationProfiles == ["governance","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-build","frontend-h5-build","changed-safe","full-regression"]' "${config}" >/dev/null || return 0
  temporary="$(mktemp "$(dirname -- "${config}")/.service-profiles.XXXXXX")"
  if ! jq '.allowedVerificationProfiles = ["governance","backend-module-compile","backend-module-test","backend-test-class","frontend-admin-lint","frontend-admin-test","frontend-admin-typecheck","frontend-admin-build","frontend-h5-test","frontend-h5-build","changed-safe","full-regression"]' "${config}" >"${temporary}" \
    || ! chmod 0600 "${temporary}" || ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}" \
    || ! mv -- "${temporary}" "${config}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    die "Protected acceptance H5 test profile migration failed: ${config}"
  fi
}

prepare_acceptance_tree() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/$1" root config temporary role issued_at expires_at unsafe
  root="${project_root}/acceptance"; config="${root}/service.json"
  [[ ! -L "${root}" && ! -L "${root}/state" && ! -L "${root}/secrets" \
    && ! -L "${root}/empty-secret-mask" && ! -L "${root}/ipc-control" && ! -L "${root}/ipc-issuer" && ! -L "${root}/ipc-resolver" && ! -L "${root}/ipc-scope" ]] \
    || die "Protected acceptance tree contains a symbolic link for ${slug}."
  install -d -m 2700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${root}" "${root}/state" "${root}/secrets" "${root}/empty-secret-mask" "${root}/ipc-control" "${root}/ipc-issuer" "${root}/ipc-resolver" "${root}/ipc-scope"
  for directory in state secrets; do
    unsafe="$(find "${root}/${directory}" -xdev -type l -print -quit)"; [[ -z "${unsafe}" ]] || die "Protected acceptance state contains a symlink."
    unsafe="$(find "${root}/${directory}" -xdev ! -type d ! -type f -print -quit)"; [[ -z "${unsafe}" ]] || die "Protected acceptance state contains an unsupported node."
    find "${root}/${directory}" -xdev -type d -exec chmod 2700 {} +
    find "${root}/${directory}" -xdev -type f -exec chmod 0600 {} +
    find "${root}/${directory}" -xdev \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) -exec chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" {} +
  done
  for role in platform governance verification semantic verdict; do
    if [[ ! -e "${root}/secrets/${role}.pem" && ! -L "${root}/secrets/${role}.pem" ]]; then
      temporary="$(mktemp "${root}/secrets/.${role}.XXXXXX")"
      openssl genpkey -algorithm ED25519 -out "${temporary}" || { rm -f -- "${temporary}"; die "Protected acceptance key generation failed for ${slug}."; }
      chmod 0600 "${temporary}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; mv -- "${temporary}" "${root}/secrets/${role}.pem"
    fi
    [[ -f "${root}/secrets/${role}.pem" && ! -L "${root}/secrets/${role}.pem" \
      && "$(stat -c '%a' "${root}/secrets/${role}.pem")" == 600 ]] || die "Protected acceptance key is unsafe for ${slug}."
    openssl pkey -in "${root}/secrets/${role}.pem" -noout -check >/dev/null 2>&1 || die "Protected acceptance key is invalid for ${slug}."
  done
  if [[ ! -e "${config}" && ! -L "${config}" ]]; then
    issued_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"; expires_at="$(date -u -d '+365 days' +%Y-%m-%dT%H:%M:%S.000Z)"
    temporary="$(mktemp "${root}/.service.XXXXXX")"
    sed -e "s|__PROJECT_SLUG__|${slug}|g" \
      -e "s|__TRUST_ISSUED_AT__|${issued_at}|g" -e "s|__TRUST_EXPIRES_AT__|${expires_at}|g" \
      "${REPO_ROOT}/templates/project/acceptance-service.json.tpl" >"${temporary}"
    chmod 0600 "${temporary}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; mv -- "${temporary}" "${config}"
  fi
  jq -e --arg slug "${slug}" '
    def canonical_utc_timestamp:
      type=="string"
      and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.000Z$")
      and (try (sub("\\.000Z$"; "Z") | fromdateiso8601 | type=="number") catch false);
    .schemaVersion==1 and .serviceType=="forge-protected-acceptance-service/v1"
    and .projectSlug==$slug and .stateRoot=="/var/lib/forge-acceptance"
    and (.allowedVerificationProfiles|type=="array" and length>0)
    and (.trustWindow.issuedAt|canonical_utc_timestamp)
    and (.trustWindow.expiresAt|canonical_utc_timestamp)
  ' "${config}" >/dev/null || die "Protected acceptance config is unmanaged for ${slug}."
  migrate_acceptance_h5_test_profile "${config}"
  migrate_acceptance_writer_scopes "${config}"
  acceptance_writer_scopes_ready "${config}" \
    || die "Protected acceptance conversation writer scopes are invalid for ${slug}."
  chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${root}" "${root}"/ipc-* "${root}/state" "${root}/secrets" "${root}/empty-secret-mask" "${config}"
  chmod 2700 "${root}" "${root}"/ipc-* "${root}/state" "${root}/secrets"; chmod 0500 "${root}/empty-secret-mask"; chmod 0600 "${config}"
}

active_task_ids() {
  local slug="$1" metadata task_id
  shopt -s nullglob
  for metadata in "${DELIVERY_ROOT}/projects/${slug}"/taskspaces/*/metadata.json; do
    [[ "$(jq -r '.status' "${metadata}")" == active ]] || continue
    task_id="$(basename -- "$(dirname -- "${metadata}")")"
    [[ "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ && "$(jq -er '.taskId' "${metadata}")" == "${task_id}" ]] || { shopt -u nullglob; die "Invalid active TaskSpace identity for ${slug}."; }
    printf '%s\n' "${task_id}"
  done
  shopt -u nullglob
}
write_generation_ledger() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/$1" root tmp task_id image harness_id upload_id first=true
  root="${project_root}/verification"; tmp="$(mktemp "${root}/.generations.XXXXXX")"
  printf '{"schemaVersion":1,"targetHarnessImage":"%s","generationPolicy":"new-taskspaces-only","recordedAt":"%s","deferredActiveTaskspaces":[' "${target_image_id}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${tmp}"
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    image="$(env_value "${project_root}/taskspaces/${task_id}/task.env" HARNESS_IMAGE)"; [[ "${image}" != "${target_image_id}" ]] || continue
    harness_id="$(task_compose "${slug}" "${task_id}" ps --all --quiet harness)"; upload_id="$(task_compose "${slug}" "${task_id}" ps --all --quiet harness-upload)"
    [[ "${first}" == true ]] || printf ',' >>"${tmp}"; first=false
    jq -nc --arg task "${task_id}" --arg image "${image}" --arg hid "${harness_id}" --arg hs "$(docker inspect --format '{{.State.Status}}' "${harness_id}")" --arg uid "${upload_id}" --arg us "$(docker inspect --format '{{.State.Status}}' "${upload_id}")" \
      '{taskId:$task,generation:"deferred-active",currentHarnessImage:$image,harness:{containerId:$hid,status:$hs},upload:{containerId:$uid,status:$us}}' >>"${tmp}"
  done < <(active_task_ids "${slug}")
  printf ']}\n' >>"${tmp}"
  jq -e '.schemaVersion==1 and .generationPolicy=="new-taskspaces-only" and (.deferredActiveTaskspaces|type=="array")' "${tmp}" >/dev/null || { rm -f -- "${tmp}"; die "Invalid generation ledger for ${slug}."; }
  chmod 0600 "${tmp}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${tmp}"; mv -- "${tmp}" "${root}/taskspace-generations.json"
}

capture_preserved_topology() {
  local output="$1" slug service id status task_id task_hash metadata_hash
  : >"${output}"
  for slug in "${project_slugs[@]}"; do
    for service in forge-admin forge-app forge-flow forge-ui; do
      id="$(project_compose "${slug}" ps --all --quiet "${service}")"
      if [[ -z "${id}" ]]; then printf '%s\t%s\tabsent\tabsent\t-\n' "${slug}" "${service}" >>"${output}"; else
        [[ "${id}" != *$'\n'* ]] || die "Duplicate topology for ${slug}/${service}."; status="$(docker inspect --format '{{.State.Status}}' "${id}")"; printf '%s\t%s\t%s\t%s\t-\n' "${slug}" "${service}" "${id}" "${status}" >>"${output}"
      fi
    done
    while IFS= read -r task_id; do
      [[ -n "${task_id}" ]] || continue
      task_hash="$(sha256sum "${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}/task.env"|awk '{print $1}')"
      metadata_hash="$(sha256sum "${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}/metadata.json"|awk '{print $1}')"
      for service in harness harness-upload; do
        id="$(task_compose "${slug}" "${task_id}" ps --all --quiet "${service}")"; [[ -n "${id}" && "${id}" != *$'\n'* ]] || die "Missing active TaskSpace runtime ${slug}/${task_id}/${service}."
        status="$(docker inspect --format '{{.State.Status}}' "${id}")"; printf '%s/%s\t%s\t%s\t%s\t%s:%s\n' "${slug}" "${task_id}" "${service}" "${id}" "${status}" "${metadata_hash}" "${task_hash}" >>"${output}"
      done
    done < <(active_task_ids "${slug}")
  done
}
runner_release_is_idle() { local socket="${DELIVERY_ROOT}/projects/$1/ops/release-ipc/runner.sock"; [[ -S "${socket}" ]] && curl -fsS --max-time 5 --unix-socket "${socket}" http://localhost/healthz | jq -e '.ok==true and .active==false' >/dev/null; }
verification_is_idle() {
  local slug="$1" id socket
  if project_uses_host_verification "${slug}"; then
    host_verification_is_ready "${slug}"
    return
  fi
  id="$(project_compose "${slug}" ps --quiet verification-runner 2>/dev/null || true)"; [[ -n "${id}" ]] || return 0
  socket="${DELIVERY_ROOT}/projects/${slug}/verification/ipc/runner.sock"; [[ -S "${socket}" ]] && curl -fsS --max-time 5 --unix-socket "${socket}" http://localhost/healthz | jq -e '.ok==true and .activeJobs==0' >/dev/null
}
acceptance_is_healthy() {
  local slug="$1" socket="${DELIVERY_ROOT}/projects/$1/acceptance/ipc-resolver/resolver.sock"
  [[ -S "${socket}" ]] && curl -fsS --max-time 5 --unix-socket "${socket}" http://localhost/healthz \
    | jq -e '.ok==true and .capability=="resolver"' >/dev/null
}
maintenance_file() { printf '%s\n' "${DELIVERY_ROOT}/projects/$1/taskspaces/.broker/maintenance.json"; }
release_lock_root() { printf '%s\n' "${DELIVERY_ROOT}/projects/$1/taskspaces/.broker/release.lock"; }
enter_project_maintenance() {
  local slug="$1" maintenance lock_root state operation owner_tmp tmp broker_id
  maintenance="$(maintenance_file "${slug}")"; lock_root="$(release_lock_root "${slug}")"; state="$(dirname -- "${maintenance}")"; operation="toolkit-${slug}-$$"
  install -d -m 2700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${state}"
  [[ ! -e "${maintenance}" && ! -L "${maintenance}" && ! -e "${lock_root}" && ! -L "${lock_root}" ]] || die "A release/maintenance fence exists for ${slug}."
  run_as_delivery_owner mkdir -m 2700 -- "${lock_root}" || die "A release won the maintenance race for ${slug}."
  owner_tmp="$(mktemp "${lock_root}/.owner.XXXXXX")"; jq -n --arg op "${operation}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{schemaVersion:1,instanceId:"platform-maintenance",operationId:$op,taskId:"platform-maintenance",actorId:"platform-operator",createdAt:$at}' >"${owner_tmp}"
  chmod 0600 "${owner_tmp}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${owner_tmp}"; mv -- "${owner_tmp}" "${lock_root}/owner.json"
  tmp="$(mktemp "${state}/.maintenance.XXXXXX")"; jq -n --arg op "${operation}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{schemaVersion:1,operationId:$op,startedAt:$at}' >"${tmp}"
  chmod 0600 "${tmp}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${tmp}"; mv -- "${tmp}" "${maintenance}"; printf '%s\n' "${operation}" >"${backup_root}/projects/${slug}/maintenance-operation"
  broker_id="$(project_compose "${slug}" ps --quiet taskspace-broker)"; docker exec "${broker_id}" node -e 'fetch("http://127.0.0.1:3100/healthz").then(async r=>{const v=await r.json();if(!r.ok||v.active!==false||v.maintenance?.active!==true)process.exit(1)}).catch(()=>process.exit(1))' || die "Broker did not enter maintenance for ${slug}."
}
leave_project_maintenance() {
  local slug="$1" maintenance lock_root operation observed; maintenance="$(maintenance_file "${slug}")"; lock_root="$(release_lock_root "${slug}")"; operation="$(<"${backup_root}/projects/${slug}/maintenance-operation")"
  observed="$(jq -r '.operationId//""' "${maintenance}" 2>/dev/null||true)"; [[ "${observed}" == "${operation}" ]] || return 1
  observed="$(jq -r '.operationId//""' "${lock_root}/owner.json" 2>/dev/null||true)"; [[ "${observed}" == "${operation}" ]] || return 1
  rm -f -- "${lock_root}/owner.json"; rmdir -- "${lock_root}"; rm -f -- "${maintenance}"
}

generation_ready() {
  local slug="$1" root ledger contract task_id image harness_id upload_id harness_status upload_status deferred=0 expected_cache_root
  root="${DELIVERY_ROOT}/projects/${slug}/verification"; contract="${root}/contract.json"; ledger="${root}/taskspace-generations.json"
  expected_cache_root="${root}/cache-packs/images/${target_cache_image_id}"
  validate_managed_contract "${contract}" "${slug}" "${root}" || return 1
  jq -e --arg image "${target_image_id}" --arg revision "${HARNESS_IMAGE_REVISION}" --arg cache "${expected_cache_root}" '.toolchainImage==$image and .runnerRevision==$revision and .cacheRoot==$cache' "${contract}" >/dev/null || return 1
  jq -e --arg image "${target_image_id}" '.schemaVersion==1 and .targetHarnessImage==$image and .generationPolicy=="new-taskspaces-only" and (.deferredActiveTaskspaces|type=="array")' "${ledger}" >/dev/null || return 1
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue; image="$(env_value "${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}/task.env" HARNESS_IMAGE)"
    [[ "${image}" != "${target_image_id}" ]] || continue; deferred=$((deferred + 1))
    harness_id="$(task_compose "${slug}" "${task_id}" ps --all --quiet harness)"; upload_id="$(task_compose "${slug}" "${task_id}" ps --all --quiet harness-upload)"
    harness_status="$(docker inspect --format '{{.State.Status}}' "${harness_id}" 2>/dev/null)"; upload_status="$(docker inspect --format '{{.State.Status}}' "${upload_id}" 2>/dev/null)"
    jq -e --arg task "${task_id}" --arg image "${image}" --arg hid "${harness_id}" --arg hs "${harness_status}" --arg uid "${upload_id}" --arg us "${upload_status}" '
      any(.deferredActiveTaskspaces[];.taskId==$task and .generation=="deferred-active" and .currentHarnessImage==$image
        and .harness=={containerId:$hid,status:$hs} and .upload=={containerId:$uid,status:$us})' "${ledger}" >/dev/null || return 1
  done < <(active_task_ids "${slug}")
  [[ "$(jq '.deferredActiveTaskspaces|length' "${ledger}")" -eq "${deferred}" ]]
}

release_runtime_contract_ready() {
  local slug="$1" project_root="${DELIVERY_ROOT}/projects/$1" contract expected_release_services expected_compose_applications
  contract="${project_root}/ops/runtime-contract.json"
  expected_release_services="${project_release_services_json[${slug}]:-}"
  expected_compose_applications="${project_compose_application_services_json[${slug}]:-}"
  [[ -n "${expected_release_services}" && -n "${expected_compose_applications}" ]] || return 1
  [[ -f "${contract}" && ! -L "${contract}" && "$(stat -c '%h' -- "${contract}")" == 1 ]] || return 1
  jq -e --arg slug "${slug}" --arg root "${project_root}" \
    --argjson expected_release_services "${expected_release_services}" \
    --argjson expected_compose_applications "${expected_compose_applications}" '
    .schemaVersion==3 and .projectSlug==$slug
    and .composeProjectName==("forge-"+$slug)
    and .projectRoot==$root and .workspaceRoot==($root+"/workspace")
    and .release.fixedComposeFile==($root+"/ops/compose.yaml")
    and ((.release.allowedComposeServices|sort)==([
      "conversation-manager","forge-admin","forge-app","forge-flow","forge-ui",
      "protected-acceptance","release-runner","taskspace-broker","verification-runner"
    ] | if ($expected_compose_applications | index("forge-app")) == null
      then map(select(. != "forge-app")) else . end))
    and ((.release.allowedReleaseServices|sort)==($expected_release_services|sort))
  ' "${contract}" >/dev/null
}

runtime_compose_project_is_managed() {
  local observed_project="$1" slug registered_project
  [[ "${observed_project}" == "${control_plane_project_name}" ]] && return 0
  for slug in "${project_slugs[@]}"; do
    registered_project="$(env_value "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" COMPOSE_PROJECT_NAME)"
    if [[ "${observed_project}" == "${registered_project}" || "${observed_project}" == "${registered_project}-task-"* ]]; then return 0; fi
  done
  return 1
}

runtime_inventory_exact() {
  local slug project_name service task_id inventory id compose_project key state
  declare -A expected=() observed=()
  expected["${control_plane_project_name}|conversation-gateway"]=1
  for slug in "${project_slugs[@]}"; do
    project_name="$(env_value "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" COMPOSE_PROJECT_NAME)"; [[ "${project_name}" == "forge-${slug}" ]] || return 1
    for service in conversation-manager release-runner taskspace-broker; do expected["${project_name}|${service}"]=1; done
    id="$(project_compose "${slug}" ps --all --quiet verification-runner 2>/dev/null || true)"
    [[ -z "${id}" ]] || expected["${project_name}|verification-runner"]=1
    id="$(project_compose "${slug}" ps --all --quiet protected-acceptance 2>/dev/null || true)"
    [[ -z "${id}" ]] || expected["${project_name}|protected-acceptance"]=1
    while IFS= read -r task_id; do
      [[ -n "${task_id}" ]] || continue; project_name="$(env_value "${DELIVERY_ROOT}/projects/${slug}/taskspaces/${task_id}/task.env" TASKSPACE_COMPOSE_PROJECT_NAME)"
      for service in harness harness-upload; do
        id="$(task_compose "${slug}" "${task_id}" ps --all --quiet "${service}")"; [[ -n "${id}" ]] || return 1
        [[ "$(docker inspect --format '{{.State.Running}}' "${id}" 2>/dev/null)" != true ]] || expected["${project_name}|${service}"]=1
      done
    done < <(active_task_ids "${slug}")
  done
  inventory="$(docker ps -a --format '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}')" || return 1
  while IFS=$'\t' read -r id compose_project service state; do
    [[ -n "${id}" ]] || continue
    case "${service}" in conversation-gateway|conversation-manager|release-runner|taskspace-broker|verification-runner|protected-acceptance|harness|harness-upload) ;; *) continue ;; esac
    runtime_compose_project_is_managed "${compose_project}" || continue
    if [[ "${service}" == harness || "${service}" == harness-upload ]]; then [[ "${state}" == running ]] || continue; fi
    key="${compose_project}|${service}"; [[ -n "${expected[${key}]+present}" ]] || return 1; observed["${key}"]=$(( ${observed[${key}]:-0} + 1 ))
  done <<<"${inventory}"
  for key in "${!expected[@]}"; do [[ "${observed[${key}]:-0}" -eq 1 ]] || return 1; done
}

all_runtime_ready() {
  local slug root env_file service id task_id expected
  [[ "${glm_unconfigured_marker_needed}" != true ]] || return 1
  [[ "$(env_value "${control_env}" HARNESS_IMAGE)" == "${target_image_id}" ]] || return 1
  id="$(control_compose ps --quiet conversation-gateway)"
  container_running_healthy "${id}" && [[ "$(docker inspect --format '{{.Image}}' "${id}")" == "${target_image_id}" ]] || return 1
  for slug in "${project_slugs[@]}"; do
    root="${DELIVERY_ROOT}/projects/${slug}"; env_file="${root}/ops/project.env"
    acceptance_writer_scopes_ready "${root}/acceptance/service.json" || return 1
    project_broker_inventory_contract_ready "${slug}" || return 1
    [[ "$(sha256sum "${root}/ops/compose.yaml"|awk '{print $1}')" == "${project_target_compose_hash[${slug}]}" \
      && "$(env_value "${env_file}" HARNESS_IMAGE)" == "${target_image_id}" \
      && "$(env_value "${env_file}" FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED)" == true \
      && "$(env_value "${env_file}" FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED)" == "${format_maintenance_supported}" \
      && "$(env_value "${env_file}" FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED)" == "${contract_continuation_supported}" \
      && "$(env_value "${env_file}" FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED)" == "${review_suspension_supported}" \
      && "$(env_value "${env_file}" FORGE_CHANGED_VERIFICATION_SUPPORTED)" == "${changed_verification_supported}" \
      && "$(env_value "${env_file}" FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED)" == "${focused_backend_verification_supported}" \
      && "$(env_value "${env_file}" FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED)" == "${ordinary_final_verification_supported}" \
      && "$(env_value "${env_file}" CONVERSATION_MANAGER_IMAGE)" == "${conversation_manager_image_id}" \
      && "$(env_value "${env_file}" RELEASE_RUNNER_IMAGE)" == "${target_image_id}" \
      && "$(env_value "${env_file}" TASKSPACE_BROKER_IMAGE)" == "${target_image_id}" \
      && "$(env_value "${env_file}" VERIFICATION_RUNNER_IMAGE)" == "${target_image_id}" \
      && "$(env_value "${env_file}" VERIFICATION_TOOLCHAIN_IMAGE)" == "${target_image_id}" \
      && "$(env_value "${env_file}" PROJECT_VERIFY_ROOT)" == "${root}/verification" \
      && "$(env_value "${env_file}" PROJECT_VERIFY_IPC_ROOT)" == "${root}/verification/ipc" \
      && "$(env_value "${env_file}" PROJECT_VERIFY_SOURCE_IPC_ROOT)" == "${root}/verification/source-ipc" \
      && "$(env_value "${env_file}" PROJECT_VERIFY_STATE_ROOT)" == "${root}/verification/state" \
      && "$(env_value "${env_file}" PROJECT_VERIFY_CACHE_ROOT)" == "${root}/verification/cache-packs" \
      && "$(env_value "${env_file}" PROJECT_ACCEPTANCE_ROOT)" == "${root}/acceptance" \
      && "$(env_value "${env_file}" PROJECT_ACCEPTANCE_CONFIG)" == "${root}/acceptance/service.json" \
      && "$(env_value "${env_file}" FORGE_SKILL_BUNDLE_ROOT)" == "${DELIVERY_ROOT}/skill-bundles" \
      && "$(env_value "${env_file}" TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED)" == true \
      && "$(env_value "${env_file}" PROTECTED_ACCEPTANCE_IMAGE)" == "${target_image_id}" ]] || return 1
    generation_ready "${slug}" || return 1
    release_runtime_contract_ready "${slug}" || return 1
    for service in conversation-manager release-runner taskspace-broker; do
      id="$(project_compose "${slug}" ps --quiet "${service}")"; container_running_healthy "${id}" || return 1
      if [[ "${service}" == conversation-manager ]]; then
        [[ "$(docker inspect --format '{{.Image}}' "${id}")" == "${conversation_manager_image_id}" ]] || return 1
      elif [[ "${service}" == release-runner || "${service}" == taskspace-broker ]]; then
        [[ "$(docker inspect --format '{{.Image}}' "${id}")" == "${target_image_id}" ]] || return 1
      fi
    done
    if project_uses_host_verification "${slug}"; then
      id="$(project_compose "${slug}" ps --all --quiet verification-runner 2>/dev/null || true)"
      host_retained_legacy_is_stopped "${slug}" "${id}" \
        && host_verification_is_ready "${slug}" \
        && broker_uses_host_verification "${slug}" || return 1
    else
      id="$(project_compose "${slug}" ps --quiet verification-runner 2>/dev/null || true)"
      [[ -n "${id}" ]] && container_running_healthy "${id}" \
        && [[ "$(docker inspect --format '{{.Image}}' "${id}")" == "${target_image_id}" ]] || return 1
    fi
    id="$(project_compose "${slug}" ps --quiet protected-acceptance 2>/dev/null || true)"
    container_running_healthy "${id}" && [[ "$(docker inspect --format '{{.Image}}' "${id}")" == "${target_image_id}" ]] || return 1
    acceptance_is_healthy "${slug}" || return 1
    [[ ! -e "$(maintenance_file "${slug}")" && ! -e "$(release_lock_root "${slug}")" ]] || return 1
    runner_release_is_idle "${slug}" && verification_is_idle "${slug}" || return 1
    while IFS= read -r task_id; do
      [[ -n "${task_id}" ]] || continue; expected="$(env_value "${root}/taskspaces/${task_id}/task.env" HARNESS_IMAGE)"
      [[ "$(env_value "${root}/taskspaces/${task_id}/task.env" FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED)" == "${format_maintenance_supported}" ]] || return 1
      [[ "$(env_value "${root}/taskspaces/${task_id}/task.env" FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED)" == "${contract_continuation_supported}" ]] || return 1
      [[ "$(env_value "${root}/taskspaces/${task_id}/task.env" FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED)" == "${review_suspension_supported}" ]] || return 1
      [[ "$(env_value "${root}/taskspaces/${task_id}/task.env" FORGE_CHANGED_VERIFICATION_SUPPORTED)" == "${changed_verification_supported}" ]] || return 1
      [[ "$(env_value "${root}/taskspaces/${task_id}/task.env" FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED)" == "${focused_backend_verification_supported}" ]] || return 1
      [[ "$(env_value "${root}/taskspaces/${task_id}/task.env" FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED)" == "${ordinary_final_verification_supported}" ]] || return 1
      for service in harness harness-upload; do id="$(task_compose "${slug}" "${task_id}" ps --all --quiet "${service}")"; [[ -n "${id}" && "$(docker inspect --format '{{.Config.Image}}' "${id}")" == "${expected}" ]] || return 1; done
    done < <(active_task_ids "${slug}")
  done
  runtime_inventory_exact
}

capture_selected_topology() {
  local output="$1" slug service id status name image
  : >"${output}"
  id="$(control_compose ps --all --quiet conversation-gateway)"
  [[ -n "${id}" && "${id}" != *$'\n'* ]] || die "Conversation Gateway topology is invalid."
  name="$(docker inspect --format '{{.Name}}' "${id}")"; status="$(docker inspect --format '{{.State.Status}}' "${id}")"; image="$(docker inspect --format '{{.Image}}' "${id}")"
  printf 'platform\tconversation-gateway\t%s\t%s\t%s\t%s\n' "${id}" "${name#/}" "${status}" "${image}" >>"${output}"
  for slug in "${project_slugs[@]}"; do
    for service in conversation-manager release-runner taskspace-broker verification-runner protected-acceptance; do
      id="$(project_compose "${slug}" ps --all --quiet "${service}" 2>/dev/null || true)"
      if [[ -z "${id}" ]]; then
        [[ "${service}" == verification-runner || "${service}" == protected-acceptance ]] || die "Required control service is absent: ${slug}/${service}."
        printf '%s\t%s\tabsent\tabsent\tabsent\tabsent\n' "${slug}" "${service}" >>"${output}"
        continue
      fi
      [[ "${id}" != *$'\n'* ]] || die "Duplicate topology for ${slug}/${service}."
      name="$(docker inspect --format '{{.Name}}' "${id}")"; status="$(docker inspect --format '{{.State.Status}}' "${id}")"; image="$(docker inspect --format '{{.Image}}' "${id}")"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${slug}" "${service}" "${id}" "${name#/}" "${status}" "${image}" >>"${output}"
    done
  done
}

selected_id() {
  local scope="$1" service="$2" value
  value="$(awk -F '\t' -v scope="${scope}" -v service="${service}" '$1==scope && $2==service {print $3; exit}' "${backup_root}/selected.before.tsv")"
  [[ -n "${value}" ]] || return 1
  printf '%s\n' "${value}"
}

write_gateway_fence() {
  local state="$1" temporary
  [[ "${state}" == maintenance || "${state}" == committed ]] || return 1
  [[ ! -L "${maintenance_root}" && ! -L "${maintenance_fence}" ]] || return 1
  install -d -m 0755 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${maintenance_root}" || return 1
  temporary="$(mktemp "${maintenance_root}/.gateway-fence.XXXXXX")" || return 1
  if ! jq --null-input --arg state "${state}" --arg epoch "${maintenance_epoch}" \
      '{schemaVersion:1,state:$state,epoch:$epoch}' >"${temporary}" \
    || ! chmod 0644 "${temporary}" \
    || ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}" \
    || ! mv -- "${temporary}" "${maintenance_fence}"; then
    rm -f -- "${temporary}" 2>/dev/null || true; return 1
  fi
}

wait_gateway_maintenance() {
  local deadline=$((SECONDS + 120)) response status
  response="${backup_root}/gateway-maintenance.json"
  while ((SECONDS < deadline)); do
    status="$(curl --silent --show-error --max-time 3 --output "${response}" --write-out '%{http_code}' \
      "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" 2>/dev/null || true)"
    if [[ "${status}" == 503 ]] && jq -e --arg epoch "${maintenance_epoch}" '
      .ok==false and .status=="maintenance" and .code=="GATEWAY_MAINTENANCE"
      and .state=="maintenance" and .epoch==$epoch and .drain.mode=="connection-tracked"
      and .drain.drained==true and .drain.activeTcpConnections==0
      and .drain.activeHttpRequests==0 and .drain.activeUpgradeConnections==0' "${response}" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

wait_gateway_open() {
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error --max-time 3 \
      --output "${backup_root}/gateway-committed-health.json" \
      "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" \
      && jq -e --arg epoch "${maintenance_epoch}" '.ok==true and .status=="open" and .epoch==$epoch' \
        "${backup_root}/gateway-committed-health.json" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

gateway_maintenance_contract() {
  local id="$1" expected_source
  expected_source="$(readlink -f -- "${maintenance_root}")" || return 1
  [[ -n "${expected_source}" ]] || return 1
  docker inspect "${id}" | jq -er --arg source "${expected_source}" '
    .[0] as $container
    | any($container.Config.Env[]?;
        . == "CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE=/run/forge-maintenance/gateway-fence.json") as $hasEnv
    | any($container.Mounts[]?;
        .Type=="bind" and .Source==$source and .Destination=="/run/forge-maintenance" and .RW==false) as $hasMount
    | any($container.Mounts[]?; .Destination=="/run/forge-maintenance") as $hasDestination
    | if $hasEnv and $hasMount then "tracked"
      elif ($hasEnv|not) and ($hasDestination|not) then "legacy"
      else error("partial maintenance contract")
      end
  '
}

gateway_open_protocol_matches() {
  local protocol="$1" response status
  [[ "${protocol}" == tracked || "${protocol}" == legacy ]] || return 1
  response="${backup_root}/gateway-open-capability.json"
  status="$(curl --silent --show-error --max-time 3 --output "${response}" --write-out '%{http_code}' \
    "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" 2>/dev/null || true)"
  [[ "${status}" == 200 ]] || return 1
  if [[ "${protocol}" == tracked ]]; then
    jq -e '.ok==true and .status=="open" and has("epoch")' "${response}" >/dev/null 2>&1
  else
    jq -e '.ok==true and (has("status")|not) and (has("epoch")|not) and (has("drain")|not)' \
      "${response}" >/dev/null 2>&1
  fi
}

wait_restored_gateway_open() {
  local expected_id="$1" deadline=$((SECONDS + 120)) response status
  response="${backup_root}/gateway-rollback-health.json"
  while ((SECONDS < deadline)); do
    status="$(curl --silent --show-error --max-time 3 --output "${response}" --write-out '%{http_code}' \
      "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" 2>/dev/null || true)"
    if container_running_healthy "${expected_id}" && [[ "${status}" == 200 ]] \
      && jq -e '.ok==true' "${response}" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

optional_service_inventory_matches_baseline() {
  local slug="$1" service="$2" baseline_id="$3" project_name inventory id count=0
  project_name="$(env_value "${backup_root}/projects/${slug}/project.env" COMPOSE_PROJECT_NAME)" || return 1
  [[ "${project_name}" == "forge-${slug}" ]] || return 1
  inventory="$(docker ps --all --no-trunc \
    --filter "label=com.docker.compose.project=${project_name}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}')" || return 1
  if [[ "${baseline_id}" == absent ]]; then
    [[ -z "${inventory}" ]]
    return
  fi
  baseline_id="$(docker inspect --format '{{.Id}}' "${baseline_id}" 2>/dev/null)" || return 1
  [[ "${baseline_id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    [[ "${id}" == "${baseline_id}" ]] || return 1
    count=$((count + 1))
  done <<<"${inventory}"
  [[ "${count}" -eq 1 ]]
}

gateway_container_is_stopped() {
  local id="$1" inventory state
  [[ "${id}" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  inventory="$(docker ps --all --no-trunc --filter "id=${id}" --format '{{.ID}}')" || return 1
  if [[ -z "${inventory}" ]]; then
    return 0
  fi
  [[ "${inventory}" != *$'\n'* && "${inventory}" == "${id}"* ]] || return 1
  state="$(docker inspect --format '{{.State.Status}}' "${inventory}" 2>/dev/null)" || return 1
  if [[ "${state}" == running || "${state}" == paused || "${state}" == restarting ]]; then
    docker stop --time 30 "${inventory}" >/dev/null 2>&1 \
      || docker kill "${inventory}" >/dev/null 2>&1 \
      || return 1
    state="$(docker inspect --format '{{.State.Status}}' "${inventory}" 2>/dev/null)" || return 1
  fi
  [[ "${state}" != running && "${state}" != paused && "${state}" != restarting ]]
}

fail_close_gateway_for_operator_review() {
  local record="${FORGE_CUTOVER_RECORD_ROOT}/gateway.json" record_ids='' id status safe=true
  local -a gateway_ids=("${gateway_before_id:-}" "${gateway_template_id:-}")
  local -A seen=()
  write_gateway_fence maintenance >/dev/null 2>&1 || true
  if [[ -f "${record}" && ! -L "${record}" ]]; then
    record_ids="$(jq -er '[.original.id,.candidate.id][] | select(type=="string" and test("^[0-9a-f]{12,64}$"))' "${record}" 2>/dev/null)" \
      || safe=false
    while IFS= read -r id; do [[ -n "${id}" ]] && gateway_ids+=("${id}"); done <<<"${record_ids}"
  elif [[ -e "${record}" || -L "${record}" ]]; then
    safe=false
  fi
  for id in "${gateway_ids[@]}"; do
    [[ -n "${id}" ]] || continue
    if [[ ! "${id}" =~ ^[0-9a-f]{12,64}$ ]]; then safe=false; continue; fi
    [[ -z "${seen[${id}]:-}" ]] || continue
    seen["${id}"]=true
    gateway_container_is_stopped "${id}" || safe=false
  done
  status="$(curl --silent --show-error --max-time 3 --output /dev/null --write-out '%{http_code}' \
    "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" 2>/dev/null || true)"
  [[ "${status}" != 200 ]] || safe=false
  [[ "${safe}" == true ]]
}

snapshot_gateway_fence() {
  if [[ -f "${maintenance_fence}" && ! -L "${maintenance_fence}" ]]; then
    cp -p -- "${maintenance_fence}" "${backup_root}/gateway-fence.before.json"
  elif [[ ! -e "${maintenance_fence}" && ! -L "${maintenance_fence}" ]]; then
    : >"${backup_root}/gateway-fence.absent"
  else
    die "Conversation Gateway maintenance fence baseline is unsafe."
  fi
}

restore_gateway_fence() {
  local temporary
  [[ ! -L "${maintenance_root}" && ! -L "${maintenance_fence}" ]] || return 1
  if [[ -f "${backup_root}/gateway-fence.before.json" && ! -L "${backup_root}/gateway-fence.before.json" ]]; then
    install -d -m 0755 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${maintenance_root}" || return 1
    temporary="$(mktemp "${maintenance_root}/.gateway-fence-restore.XXXXXX")" || return 1
    if ! cp --preserve=mode,ownership -- "${backup_root}/gateway-fence.before.json" "${temporary}" \
      || ! mv -- "${temporary}" "${maintenance_fence}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      return 1
    fi
  elif [[ -f "${backup_root}/gateway-fence.absent" && ! -L "${backup_root}/gateway-fence.absent" ]]; then
    rm -f -- "${maintenance_fence}" || return 1
  else
    return 1
  fi
}

backup_control_state() {
  local state_root="${DELIVERY_ROOT}/conversation-control-plane/state" slug audit verification_state
  [[ -d "${state_root}" && ! -L "${state_root}" \
    && -z "$(find "${state_root}" -xdev -type l -print -quit)" ]] || die "Conversation control-plane state is unsafe to back up."
  tar --create --gzip --file "${backup_root}/control-plane-state.tar.gz" \
    --directory "${DELIVERY_ROOT}/conversation-control-plane" -- state
  for slug in "${project_slugs[@]}"; do
    audit="${DELIVERY_ROOT}/projects/${slug}/ops/conversation-manager-audit.jsonl"
    if [[ -f "${audit}" && ! -L "${audit}" ]]; then cp -p -- "${audit}" "${backup_root}/projects/${slug}/conversation-manager-audit.jsonl"; else : >"${backup_root}/projects/${slug}/conversation-manager-audit.absent"; fi
    verification_state="${DELIVERY_ROOT}/projects/${slug}/verification/state"
    if [[ -d "${verification_state}" && ! -L "${verification_state}" \
      && -z "$(find "${verification_state}" -xdev -type l -print -quit)" ]]; then
      tar --create --gzip --file "${backup_root}/projects/${slug}/verification-state.tar.gz" \
        --directory "${DELIVERY_ROOT}/projects/${slug}/verification" -- state
    else
      : >"${backup_root}/projects/${slug}/verification-state.absent"
    fi
  done
}

restore_control_state() {
  local slug audit source verification_root
  tar --extract --gzip --file "${backup_root}/control-plane-state.tar.gz" \
    --directory "${DELIVERY_ROOT}/conversation-control-plane" || return 1
  for slug in "${project_slugs[@]}"; do
    audit="${DELIVERY_ROOT}/projects/${slug}/ops/conversation-manager-audit.jsonl"; source="${backup_root}/projects/${slug}"
    if [[ -f "${source}/conversation-manager-audit.jsonl" ]]; then cp -p -- "${source}/conversation-manager-audit.jsonl" "${audit}" || return 1; else rm -f -- "${audit}" || return 1; fi
    verification_root="${DELIVERY_ROOT}/projects/${slug}/verification"
    if [[ -f "${source}/verification-state.tar.gz" ]]; then
      tar --extract --gzip --file "${source}/verification-state.tar.gz" --directory "${verification_root}" || return 1
    fi
  done
}

freeze_project_verification_modes
target_compose_hash="$(sha256sum "${REPO_ROOT}/templates/project/compose.yaml"|awk '{print $1}')"
readonly approved_pre_broker_phase_catalog_compose_hash='9d048ae009be583c58dd5db10bc262e4b30a1c61ae22989b15ea83aa99b10e3d'
readonly approved_pre_external_skill_manager_compose_hash='afb484b6ce9543897ff27380c41aeebe8c98c63516032b242f113ffb26e72e41'
readonly approved_pre_verification_compose_hash='7d84b443ec0708256ff4053b9549a875152504de2432125050258636b8274787'
readonly approved_pre_manager_image_compose_hash='e2c1820036707ace50b7114af4cf08fd94084365ad60e8f320c0a310681155c7'
readonly approved_pre_server_baseline_forge_base_compose_hash='4e6c277dd5769c7f3dd29977dbebf2599f56e396c46c0f6b937fce9d18db7c24'
readonly approved_pre_server_baseline_replica_compose_hash='f9e2d9085bd43ee7c11e11ebbafe0095f6cf04df696bb285aefe6f5bf1756d76'
declare -A project_release_services_json=()
declare -A project_compose_application_services_json=()
declare -A project_target_compose_hash=()
declare -A project_base_compose_hash=()
for slug in "${project_slugs[@]}"; do
  root="${DELIVERY_ROOT}/projects/${slug}"
  runtime_contract="${root}/ops/runtime-contract.json"
  [[ -f "${runtime_contract}" && ! -L "${runtime_contract}" && "$(stat -c '%h' -- "${runtime_contract}")" == 1 ]] \
    || die "Release runtime contract is missing or unsafe for ${slug}."
  allowed_release_services="$(jq --compact-output '.release.allowedReleaseServices' "${runtime_contract}")"
  release_contract_validate_allowed_release_services_json "${allowed_release_services}" \
    || die "Release runtime contract has an unsupported application service set for ${slug}."
  release_contract_validate_protected_inputs "${root}/workspace" "${allowed_release_services}" \
    || die "Release protected deployment inputs are incomplete for ${slug}."
  project_release_services_json["${slug}"]="${allowed_release_services}"
  compose_application_services="$(jq --compact-output --argjson applications \
    "$(release_contract_default_allowed_release_services_json)" '
    [.release.allowedComposeServices[] as $service | select($applications | index($service)) | $service] | sort
  ' "${runtime_contract}")"
  release_contract_validate_allowed_release_services_json "${compose_application_services}" \
    || die "Release runtime contract has an unsupported Compose application set for ${slug}."
  jq --exit-status --argjson compose "${compose_application_services}" \
    '(. - $compose) | length == 0' <<<"${allowed_release_services}" >/dev/null \
    || die "Release runtime contract Compose omits a required release service for ${slug}."
  project_compose_application_services_json["${slug}"]="${compose_application_services}"
  project_base_compose_hash["${slug}"]="$(release_contract_render_project_compose \
    "${REPO_ROOT}/templates/project/compose.yaml" "${compose_application_services}" | sha256sum | awk '{print $1}')"
  project_target_compose_hash["${slug}"]="$(render_project_compose_with_managed_files \
    "${slug}" "${compose_application_services}" | sha256sum | awk '{print $1}')"
done
if all_runtime_ready; then
  log "Forge Delivery Toolkit is already active for future TaskSpaces; deferred active TaskSpaces were not recreated."
  exit 0
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"; backup_root="${DELIVERY_ROOT}/platform-backups/pre-forge-delivery-toolkit-${timestamp}-$$"
maintenance_epoch="toolkit-${timestamp}-$$"
maintenance_root="${DELIVERY_ROOT}/conversation-control-plane/maintenance"
maintenance_fence="${maintenance_root}/gateway-fence.json"
FORGE_CUTOVER_OPERATION="toolkit-${timestamp,,}"
FORGE_CUTOVER_OPERATION="${FORGE_CUTOVER_OPERATION//z/}"
FORGE_CUTOVER_RECORD_ROOT="${backup_root}/container-cutover"
export FORGE_CUTOVER_OPERATION FORGE_CUTOVER_RECORD_ROOT
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${backup_root}/projects" "${FORGE_CUTOVER_RECORD_ROOT}" "${backup_root}/runtime-templates"
runtime_template_root="${backup_root}/runtime-templates"
install -m 0600 "${control_env}" "${backup_root}/control-plane.env"
for slug in "${project_slugs[@]}"; do
  printf '%s\t%s\n' "${slug}" "${project_verification_mode[${slug}]}"
done >"${backup_root}/verification-modes.tsv"
chmod 0600 "${backup_root}/verification-modes.tsv"
snapshot_gateway_fence
printf '%s\n' "${glm_provider_status}" >"${backup_root}/glm-provider-status.txt"
chmod 0600 "${backup_root}/glm-provider-status.txt"

for slug in "${project_slugs[@]}"; do
  root="${DELIVERY_ROOT}/projects/${slug}"; env_file="${root}/ops/project.env"; verify_root="${root}/verification"; acceptance_root="${root}/acceptance"; hash="$(sha256sum "${root}/ops/compose.yaml"|awk '{print $1}')"
  original_compose_hash="${hash}"
  managed_registry="$(env_value "${env_file}" PROJECT_MANAGED_FILE_TARGETS_FILE)"
  if [[ -n "${managed_registry}" ]]; then
    # Compare only the registered block's removal against the existing reviewed
    # predecessor hashes; do not admit arbitrary custom Compose modifications.
    hash="$(node "${REPO_ROOT}/scripts/lib/managed-file-compose.mjs" strip \
      "${slug}" "${managed_registry}" "${root}/ops/compose.yaml" | sha256sum | awk '{print $1}')"
  fi
  [[ "${original_compose_hash}" == "${project_target_compose_hash[${slug}]}" \
    || "${hash}" == "${project_base_compose_hash[${slug}]}" || "${hash}" == "${target_compose_hash}" \
    || "${hash}" == "${approved_pre_broker_phase_catalog_compose_hash}" \
    || "${hash}" == "${approved_pre_external_skill_manager_compose_hash}" \
    || "${hash}" == "${approved_pre_verification_compose_hash}" \
    || "${hash}" == "${approved_pre_manager_image_compose_hash}" \
    || "${hash}" == "${approved_pre_server_baseline_forge_base_compose_hash}" \
    || "${hash}" == "${approved_pre_server_baseline_replica_compose_hash}" ]] || die "Project ${slug} Compose is not a reviewed predecessor/target."
  [[ "$(env_value "${env_file}" PROJECT_MATERIAL_ACCESS_MODE)" == direct ]] || die "Project ${slug} lacks the TaskSpace material baseline."
  host_uid="$(env_value "${env_file}" HOST_UID)"
  host_gid="$(env_value "${env_file}" HOST_GID)"
  if [[ "${glm_provider_status}" == unconfigured ]]; then
    [[ "${host_uid}" =~ ^[1-9][0-9]*$ ]] \
      || die "Project ${slug} must use an explicit non-root HOST_UID while GLM is unconfigured."
  fi
  git_root="${DELIVERY_ROOT}/git-remotes/${slug}"
  git_root_count="$(awk -F= '$1 == "PROJECT_GIT_SSH_ROOT" {count++} END {print count+0}' "${env_file}")"
  git_root_value="$(env_value "${env_file}" PROJECT_GIT_SSH_ROOT)"
  [[ "${git_root_count}" -le 1 && ( "${git_root_count}" == 0 || "${git_root_value}" == "${git_root}" ) ]] \
    || die "Project ${slug} has an unsafe or duplicate PROJECT_GIT_SSH_ROOT."
  if [[ -e "${git_root}" || -L "${git_root}" ]]; then
    project_git_root_is_exact "${slug}" "${host_uid}" \
      || die "Project Git credential directory is unsafe for ${slug}."
  else
    [[ "${host_uid}" =~ ^[1-9][0-9]*$ && "${host_gid}" =~ ^[1-9][0-9]*$ ]] \
      || die "Project ${slug} has no safe host identity for its empty Git credential directory."
    project_git_root_needed["${slug}"]=true
  fi
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}/projects/${slug}"
  install -m 0600 "${env_file}" "${backup_root}/projects/${slug}/project.env"; install -m 0640 "${root}/ops/compose.yaml" "${backup_root}/projects/${slug}/compose.yaml"
  runtime_contract="${root}/ops/runtime-contract.json"
  [[ -f "${runtime_contract}" && ! -L "${runtime_contract}" && "$(stat -c '%h' -- "${runtime_contract}")" == 1 ]] \
    || die "Release runtime contract is missing or unsafe for ${slug}."
  install -m 0640 "${runtime_contract}" "${backup_root}/projects/${slug}/runtime-contract.json"
  [[ ! -L "${verify_root}" && ! -L "${verify_root}/ipc" && ! -L "${verify_root}/source-ipc" && ! -L "${verify_root}/empty-manager-mask" && ! -L "${verify_root}/state" && ! -L "${verify_root}/cache-packs" ]] || die "Verification tree contains a symbolic link for ${slug}."
  if [[ -f "${verify_root}/contract.json" && ! -L "${verify_root}/contract.json" ]]; then
    cp -p -- "${verify_root}/contract.json" "${backup_root}/projects/${slug}/contract.json"
  elif [[ ! -e "${verify_root}/contract.json" && ! -L "${verify_root}/contract.json" ]]; then : >"${backup_root}/projects/${slug}/contract.absent"
  else die "Verification contract path is unsafe for ${slug}."; fi
  if [[ -f "${verify_root}/taskspace-generations.json" && ! -L "${verify_root}/taskspace-generations.json" ]]; then
    cp -p -- "${verify_root}/taskspace-generations.json" "${backup_root}/projects/${slug}/generations.json"
  elif [[ ! -e "${verify_root}/taskspace-generations.json" && ! -L "${verify_root}/taskspace-generations.json" ]]; then : >"${backup_root}/projects/${slug}/generations.absent"
  else die "TaskSpace generation ledger path is unsafe for ${slug}."; fi
  verification_before_id="$(project_compose "${slug}" ps --all --quiet verification-runner 2>/dev/null || true)"
  if project_uses_host_verification "${slug}"; then
    host_retained_legacy_is_stopped "${slug}" "${verification_before_id}" \
      || die "Host Verification requires exactly one retained, stopped legacy Verification Runner for ${slug}."
    host_verification_is_ready "${slug}" && broker_uses_host_verification "${slug}" \
      || die "Host Verification is not ready through both its host socket and Broker for ${slug}."
    printf '%s\n' exited >"${backup_root}/projects/${slug}/verification.before-status"
  elif [[ -n "${verification_before_id}" ]]; then
    [[ "$(docker inspect --format '{{.State.Status}}' "${verification_before_id}")" == running \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${verification_before_id}")" == healthy ]] \
      || die "Existing optional Verification Runner must be running and healthy or absent for ${slug}; it will not be started implicitly."
    printf '%s\n' running >"${backup_root}/projects/${slug}/verification.before-status"
  else
    : >"${backup_root}/projects/${slug}/verification.absent"
  fi
  acceptance_before_id="$(project_compose "${slug}" ps --all --quiet protected-acceptance 2>/dev/null || true)"
  if [[ -n "${acceptance_before_id}" ]]; then
    container_running_healthy "${acceptance_before_id}" && acceptance_is_healthy "${slug}" \
      || die "Existing Protected Acceptance service must be healthy for ${slug}."
    printf '%s\n' running >"${backup_root}/projects/${slug}/acceptance.before-status"
  else
    : >"${backup_root}/projects/${slug}/acceptance.absent"
  fi
  if [[ -d "${acceptance_root}" && ! -L "${acceptance_root}" ]]; then
    [[ -z "$(find "${acceptance_root}" -xdev -type l -print -quit)" ]] || die "Protected acceptance tree contains a symbolic link for ${slug}."
    tar --create --gzip --file "${backup_root}/projects/${slug}/acceptance.tar.gz" --directory "${root}" -- acceptance
    chmod 0600 "${backup_root}/projects/${slug}/acceptance.tar.gz"
  elif [[ ! -e "${acceptance_root}" && ! -L "${acceptance_root}" ]]; then
    : >"${backup_root}/projects/${slug}/acceptance-root.absent"
  else
    die "Protected acceptance root is unsafe for ${slug}."
  fi
  [[ -d "${verify_root}" ]] || : >"${backup_root}/projects/${slug}/verification-root.absent"; for directory in ipc source-ipc empty-manager-mask state cache-packs; do [[ -d "${verify_root}/${directory}" ]] || : >"${backup_root}/projects/${slug}/${directory}.absent"; done
  wait_project_service_health "${slug}" conversation-manager \
    || die "conversation-manager is not healthy for ${slug}."
  for service in release-runner taskspace-broker; do id="$(project_compose "${slug}" ps --quiet "${service}")"; container_running_healthy "${id}" || die "${service} is not healthy for ${slug}."; done
  runner_release_is_idle "${slug}" || die "Release Runner is active/unhealthy for ${slug}."; verification_is_idle "${slug}" || die "Verification Runner is active/unhealthy for ${slug}."
done
capture_preserved_topology "${backup_root}/preserved.before.tsv"
capture_selected_topology "${backup_root}/selected.before.tsv"
gateway_before_id="$(selected_id platform conversation-gateway)"
container_running_healthy "${gateway_before_id}" || die "Conversation Gateway is not healthy before maintenance."
runtime_inventory_exact || die "Governed runtime inventory is not exact before maintenance."

declare -A mutated=() maintenance_entered=()
committed=false
commit_started=false
state_backed_up=false
gateway_candidate_activated=false
staged_control="${control_env}.toolkit-stage.$$"
gateway_template_project=''
gateway_template_file=''
runtime_template_project=''
runtime_template_slug=''
runtime_template_file=''
cleanup_gateway_template() {
  [[ -n "${gateway_template_project}" && -n "${gateway_template_file}" ]] || return 0
  control_runtime_template_compose "${staged_control}" "${gateway_template_project}" "${gateway_template_file}" down --remove-orphans >/dev/null
  rm -- "${gateway_template_file}"
  gateway_template_project=''
  gateway_template_file=''
}
cleanup_runtime_template() {
  [[ -n "${runtime_template_project}" && -n "${runtime_template_slug}" && -n "${runtime_template_file}" ]] || return 0
  runtime_template_compose "${runtime_template_slug}" "${runtime_template_project}" "${runtime_template_file}" down --remove-orphans >/dev/null
  rm -- "${runtime_template_file}"
  runtime_template_project=''
  runtime_template_slug=''
  runtime_template_file=''
}
write_upgrade_terminal_receipt() {
  local outcome="$1" exit_code="$2" output temporary relative file digest bytes
  local artifacts='[]' projects script_sha versions_sha
  case "${outcome}" in committed|rolled-back|rollback-incomplete|manual-recovery-required) ;; *) return 1 ;; esac
  [[ "${exit_code}" =~ ^[0-9]+$ && "${backup_root}" == "${DELIVERY_ROOT}/platform-backups/pre-forge-delivery-toolkit-"* \
    && -d "${backup_root}" && ! -L "${backup_root}" ]] || return 1
  output="${backup_root}/upgrade-receipt.json"
  [[ ! -e "${output}" && ! -L "${output}" ]] || return 1
  for relative in selected.before.tsv selected.rollback.tsv selected.committed.tsv \
    preserved.before.tsv preserved.after.tsv preserved.rollback.tsv preserved.committed.tsv \
    gateway-maintenance.json gateway-rollback-health.json gateway-committed-health.json \
    verification-modes.tsv gateway-cutover-mode.txt; do
    file="${backup_root}/${relative}"
    [[ -e "${file}" || -L "${file}" ]] || continue
    [[ -f "${file}" && ! -L "${file}" && "$(stat -c '%h' -- "${file}")" == 1 ]] || return 1
    digest="$(sha256sum "${file}" | awk '{print $1}')" || return 1
    bytes="$(stat -c '%s' -- "${file}")" || return 1
    artifacts="$(jq -c --arg path "${relative}" --arg sha256 "${digest}" --argjson bytes "${bytes}" \
      '. + [{path:$path,sha256:$sha256,bytes:$bytes}]' <<<"${artifacts}")" || return 1
  done
  projects="$(printf '%s\n' "${project_slugs[@]}" | jq -Rsc 'split("\n") | map(select(length>0))')" || return 1
  script_sha="$(sha256sum "${SCRIPT_DIR}/upgrade-forge-delivery-toolkit.sh" | awk '{print $1}')" || return 1
  versions_sha="$(sha256sum "${REPO_ROOT}/config/versions.env" | awk '{print $1}')" || return 1
  [[ "${script_sha}" == "${upgrade_script_sha256}" && "${versions_sha}" == "${upgrade_versions_sha256}" ]] || return 1
  if [[ "${outcome}" == rolled-back ]]; then
    cmp "${backup_root}/selected.before.tsv" "${backup_root}/selected.rollback.tsv" || return 1
    cmp "${backup_root}/preserved.before.tsv" "${backup_root}/preserved.rollback.tsv" || return 1
    jq -e '.ok==true' "${backup_root}/gateway-rollback-health.json" >/dev/null || return 1
  elif [[ "${outcome}" == committed ]]; then
    [[ -s "${backup_root}/selected.committed.tsv" ]] || return 1
    cmp "${backup_root}/preserved.before.tsv" "${backup_root}/preserved.committed.tsv" || return 1
    jq -e --arg epoch "${maintenance_epoch}" '.ok==true and .status=="open" and .epoch==$epoch' \
      "${backup_root}/gateway-committed-health.json" >/dev/null || return 1
  fi
  temporary="$(mktemp "${backup_root}/.upgrade-receipt.XXXXXX")" || return 1
  if ! jq -n --arg operationId "${maintenance_epoch}" --arg outcome "${outcome}" --argjson exitCode "${exit_code}" \
    --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg confirmation "${confirmation}" \
    --arg harnessImage "${target_image_id}" --arg managerImage "${conversation_manager_image_id}" \
    --arg foundationImage "${expected_base_image_id}" --arg scriptSha256 "${script_sha}" --arg versionsSha256 "${versions_sha}" \
    --argjson projects "${projects}" --argjson artifacts "${artifacts}" \
    '{schemaVersion:1,receiptType:"forge-platform-upgrade-terminal/v1",operationId:$operationId,
      outcome:$outcome,exitCode:$exitCode,finishedAt:$finishedAt,maintenanceConfirmation:$confirmation,
      upgradeSucceeded:($outcome=="committed"),rollbackVerified:($outcome=="rolled-back"),
      target:{harnessImage:$harnessImage,managerImage:$managerImage,foundationImage:$foundationImage},
      producer:{scriptSha256:$scriptSha256,versionsSha256:$versionsSha256},projects:$projects,artifacts:$artifacts}' >"${temporary}" \
    || ! chmod 0444 "${temporary}" || ! ln -- "${temporary}" "${output}"; then
    rm -f -- "${temporary}"; return 1
  fi
  rm -- "${temporary}"
}
rollback() {
  local code=$?
  trap - ERR EXIT
  set +e
  local slug root verify_root acceptance_root source marker directory record created_id gateway_record
  local acceptance_original_id acceptance_restart baseline_id id service
  local rollback_ok=true runtime_rollback_safe=true
  [[ "${committed}" == false ]] || exit "${code}"
  if [[ "${commit_started}" == true ]]; then
    if fail_close_gateway_for_operator_review; then
      warn "Control-plane commit became ambiguous; the Gateway was stopped and remains fail-closed for operator review."
    else
      warn "Control-plane commit became ambiguous and a fail-closed Gateway state could not be proven; urgent operator review is required."
    fi
    write_upgrade_terminal_receipt manual-recovery-required "${code}" || warn "Upgrade terminal receipt could not be written at ${backup_root}."
    exit "${code}"
  fi
  warn "Control-plane cutover failed; restoring original container IDs, states, optional absence, configuration, and backed-up state."
  shopt -s nullglob
  for record in "${FORGE_CUTOVER_RECORD_ROOT}"/*.json; do
    if ! forge_cutover_rollback "${record}" true; then rollback_ok=false; runtime_rollback_safe=false; fi
  done
  shopt -u nullglob
  cleanup_gateway_template || rollback_ok=false
  cleanup_runtime_template || rollback_ok=false
  rm -f -- "${staged_control}" "${staged_control}.toolkit.$$" 2>/dev/null || true
  install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}/control-plane.env" "${control_env}" || rollback_ok=false
  for slug in "${project_slugs[@]}"; do
    root="${DELIVERY_ROOT}/projects/${slug}"; verify_root="${root}/verification"; acceptance_root="${root}/acceptance"; source="${backup_root}/projects/${slug}"
    if [[ -f "${source}/verification.created-id" ]]; then
      created_id="$(<"${source}/verification.created-id")"
      if [[ ! "${created_id}" =~ ^[0-9a-f]{12,64}$ ]] \
        || [[ "$(docker inspect --format '{{.Id}}' "${created_id}" 2>/dev/null)" != "${created_id}" ]] \
        || ! docker rm --force "${created_id}" >/dev/null 2>&1; then
        rollback_ok=false; runtime_rollback_safe=false
      fi
    fi
    if [[ -f "${source}/acceptance.created-id" ]]; then
      created_id="$(<"${source}/acceptance.created-id")"
      if [[ ! "${created_id}" =~ ^[0-9a-f]{12,64}$ ]] \
        || [[ "$(docker inspect --format '{{.Id}}' "${created_id}" 2>/dev/null)" != "${created_id}" ]] \
        || ! docker rm --force "${created_id}" >/dev/null 2>&1; then
        rollback_ok=false; runtime_rollback_safe=false
      fi
    fi
  done
  for slug in "${project_slugs[@]}"; do
    for service in verification-runner protected-acceptance; do
      baseline_id="$(selected_id "${slug}" "${service}" 2>/dev/null || true)"
      if [[ -z "${baseline_id}" ]] \
        || ! optional_service_inventory_matches_baseline "${slug}" "${service}" "${baseline_id}"; then
        rollback_ok=false
        runtime_rollback_safe=false
      fi
    done
  done
  for slug in "${project_slugs[@]}"; do
    root="${DELIVERY_ROOT}/projects/${slug}"; verify_root="${root}/verification"; acceptance_root="${root}/acceptance"; source="${backup_root}/projects/${slug}"
    if [[ "${mutated[${slug}]:-false}" == true ]]; then
      rm -f -- "${root}/ops/project.env.toolkit-stage.$$" "${root}/ops/compose.yaml.toolkit-stage.$$" 2>/dev/null || true
      install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${source}/project.env" "${root}/ops/project.env" || rollback_ok=false
      install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${source}/compose.yaml" "${root}/ops/compose.yaml" || rollback_ok=false
      install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${source}/runtime-contract.json" "${root}/ops/runtime-contract.json" || rollback_ok=false
      if [[ -f "${source}/contract.json" && ! -L "${source}/contract.json" \
        && ! -e "${source}/contract.absent" && ! -L "${source}/contract.absent" ]]; then
        cp -p -- "${source}/contract.json" "${verify_root}/contract.json" || rollback_ok=false
      elif [[ -f "${source}/contract.absent" && ! -L "${source}/contract.absent" \
        && ! -e "${source}/contract.json" && ! -L "${source}/contract.json" ]]; then
        rm -f -- "${verify_root}/contract.json" || rollback_ok=false
      else
        rollback_ok=false
      fi
      if [[ -f "${source}/generations.json" && ! -L "${source}/generations.json" \
        && ! -e "${source}/generations.absent" && ! -L "${source}/generations.absent" ]]; then
        cp -p -- "${source}/generations.json" "${verify_root}/taskspace-generations.json" || rollback_ok=false
      elif [[ -f "${source}/generations.absent" && ! -L "${source}/generations.absent" \
        && ! -e "${source}/generations.json" && ! -L "${source}/generations.json" ]]; then
        rm -f -- "${verify_root}/taskspace-generations.json" || rollback_ok=false
      else
        rollback_ok=false
      fi
      for marker in cache-packs state empty-manager-mask source-ipc ipc verification-root; do [[ -f "${source}/${marker}.absent" ]] || continue; [[ "${marker}" == verification-root ]] && directory="${verify_root}" || directory="${verify_root}/${marker}"; [[ ! -L "${directory}" ]] && rmdir -- "${directory}" 2>/dev/null || true; done
    fi
    if [[ "${runtime_rollback_safe}" != true ]]; then
      rollback_ok=false
      continue
    fi
    acceptance_original_id="$(selected_id "${slug}" protected-acceptance 2>/dev/null || true)"
    acceptance_restart=false
    if [[ -n "${acceptance_original_id}" && "${acceptance_original_id}" != absent ]]; then
      if docker stop --time 30 "${acceptance_original_id}" >/dev/null 2>&1; then
        acceptance_restart=true
      else
        rollback_ok=false
      fi
    fi
    if [[ "${rollback_ok}" == true \
      && "$(readlink -f -- "${acceptance_root}")" == "$(readlink -f -- "${root}")/acceptance" \
      && ! -L "${acceptance_root}" ]]; then
      find "${acceptance_root}" -xdev -depth -mindepth 1 -delete 2>/dev/null || rollback_ok=false
      if [[ -f "${source}/acceptance.tar.gz" ]]; then
        tar --extract --gzip --file "${source}/acceptance.tar.gz" --directory "${root}" || rollback_ok=false
        elif [[ -f "${source}/acceptance-root.absent" ]]; then
          rmdir -- "${acceptance_root}" 2>/dev/null || true
        fi
    else
      rollback_ok=false
    fi
    if [[ "${acceptance_restart}" == true ]]; then
      docker start "${acceptance_original_id}" >/dev/null 2>&1 \
        && wait_container_health "${acceptance_original_id}" \
        && acceptance_is_healthy "${slug}" || rollback_ok=false
    fi
  done
  if [[ "${runtime_rollback_safe}" == true ]]; then
    if [[ "${state_backed_up}" == true ]]; then restore_control_state || rollback_ok=false; fi
    shopt -s nullglob
    for record in "${FORGE_CUTOVER_RECORD_ROOT}"/*.json; do
      [[ "$(jq -r '.logicalName' "${record}")" == gateway ]] && continue
      if ! forge_cutover_restore_original_state "${record}"; then rollback_ok=false; runtime_rollback_safe=false; break; fi
    done
    gateway_record="${FORGE_CUTOVER_RECORD_ROOT}/gateway.json"
    if [[ "${runtime_rollback_safe}" == true && -f "${gateway_record}" && ! -L "${gateway_record}" ]]; then
      if ! forge_cutover_restore_original_state "${gateway_record}"; then rollback_ok=false; runtime_rollback_safe=false; fi
    elif [[ "${runtime_rollback_safe}" == true && ( -e "${gateway_record}" || -L "${gateway_record}" ) ]]; then
      rollback_ok=false
      runtime_rollback_safe=false
    fi
    shopt -u nullglob
  else
    rollback_ok=false
  fi
  for slug in "${project_slugs[@]}"; do
    source="${backup_root}/projects/${slug}"
    root="${DELIVERY_ROOT}/projects/${slug}"
    cmp "${source}/project.env" "${root}/ops/project.env" || rollback_ok=false
    cmp "${source}/compose.yaml" "${root}/ops/compose.yaml" || rollback_ok=false
    cmp "${source}/runtime-contract.json" "${root}/ops/runtime-contract.json" || rollback_ok=false
    [[ "${runtime_rollback_safe}" == true ]] || continue
    for service in conversation-manager release-runner taskspace-broker; do
      id="$(selected_id "${slug}" "${service}" 2>/dev/null || true)"
      [[ "${id}" =~ ^[0-9a-f]{12,64}$ ]] && wait_container_health "${id}" || rollback_ok=false
    done
    runner_release_is_idle "${slug}" || rollback_ok=false
    id="$(selected_id "${slug}" protected-acceptance 2>/dev/null || true)"
    if [[ "${id}" != absent ]]; then
      [[ "${id}" =~ ^[0-9a-f]{12,64}$ ]] && wait_container_health "${id}" \
        && acceptance_is_healthy "${slug}" || rollback_ok=false
    fi
    id="$(selected_id "${slug}" verification-runner 2>/dev/null || true)"
    if project_uses_host_verification "${slug}"; then
      host_retained_legacy_is_stopped "${slug}" "${id}" \
        && host_verification_is_ready "${slug}" \
        && broker_uses_host_verification "${slug}" || rollback_ok=false
    elif [[ "${id}" != absent ]]; then
      [[ "${id}" =~ ^[0-9a-f]{12,64}$ ]] && wait_container_health "${id}" || rollback_ok=false
    fi
  done
  ( capture_preserved_topology "${backup_root}/preserved.rollback.tsv" ) 2>/dev/null || rollback_ok=false
  ( capture_selected_topology "${backup_root}/selected.rollback.tsv" ) 2>/dev/null || rollback_ok=false
  cmp "${backup_root}/preserved.before.tsv" "${backup_root}/preserved.rollback.tsv" || rollback_ok=false
  cmp "${backup_root}/selected.before.tsv" "${backup_root}/selected.rollback.tsv" || rollback_ok=false
  remove_operation_project_git_roots || rollback_ok=false
  remove_operation_glm_unconfigured_marker || rollback_ok=false
  if [[ "${rollback_ok}" != true ]]; then
    if fail_close_gateway_for_operator_review; then
      warn "Rollback was incomplete; the Gateway was stopped and remains fail-closed for operator review."
    else
      warn "Rollback was incomplete and a fail-closed Gateway state could not be proven; urgent operator review is required."
    fi
    write_upgrade_terminal_receipt rollback-incomplete "${code}" || warn "Upgrade terminal receipt could not be written at ${backup_root}."
    warn "Rollback evidence is retained at ${backup_root}."
    exit "${code}"
  fi
  for slug in "${project_slugs[@]}"; do
    if [[ "${maintenance_entered[${slug}]:-false}" == true ]]; then
      leave_project_maintenance "${slug}" || rollback_ok=false
    fi
  done
  if [[ "${rollback_ok}" == true ]]; then
    restore_gateway_fence || rollback_ok=false
    wait_restored_gateway_open "${gateway_before_id}" || rollback_ok=false
  fi
  if [[ "${rollback_ok}" != true ]]; then
    if fail_close_gateway_for_operator_review; then
      warn "Rollback restored runtime identity but could not safely reopen; the Gateway was stopped for operator review."
    else
      warn "Rollback restored runtime identity but neither safe reopen nor fail-close could be proven; urgent operator review is required."
    fi
    write_upgrade_terminal_receipt rollback-incomplete "${code}" || warn "Upgrade terminal receipt could not be written at ${backup_root}."
  else
    write_upgrade_terminal_receipt rolled-back "${code}" || warn "Upgrade terminal receipt could not be written at ${backup_root}."
  fi
  warn "Rollback evidence is retained at ${backup_root}."; exit "${code}"
}
trap rollback ERR EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
establish_glm_provider_compatibility
establish_project_git_roots

[[ ! -e "${staged_control}" && ! -L "${staged_control}" ]] \
  || die "Staged Conversation Gateway environment already exists."
cp --preserve=mode,ownership -- "${control_env}" "${staged_control}"
upsert_env "${staged_control}" HARNESS_IMAGE_SOURCE "${HARNESS_IMAGE}"
upsert_env "${staged_control}" HARNESS_IMAGE "${target_image_id}"
chmod 0600 "${staged_control}"
chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${staged_control}"
gateway_template_project="forge-template-$(printf '%s' "${FORGE_CUTOVER_OPERATION}:gateway:$$" | sha256sum | awk '{print substr($1,1,20)}')"
gateway_template_file="${runtime_template_root}/conversation-gateway.json"
docker compose --project-name "${control_plane_project_name}" --env-file "${staged_control}" \
  --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" config --format json \
  | render_runtime_template_compose "${gateway_template_file}" '["conversation-gateway"]'
control_runtime_template_compose "${staged_control}" "${gateway_template_project}" "${gateway_template_file}" config --quiet
gateway_hash="$(docker compose --project-name "${gateway_template_project}" \
  --env-file "${staged_control}" \
  --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
  config --hash conversation-gateway | compose_hash_value)"
control_runtime_template_compose "${staged_control}" "${gateway_template_project}" "${gateway_template_file}" create --no-build conversation-gateway >/dev/null
gateway_template_id="$(control_runtime_template_compose "${staged_control}" "${gateway_template_project}" "${gateway_template_file}" ps --all --quiet conversation-gateway)"
[[ "${gateway_template_id}" =~ ^[0-9a-f]{12,64}$ \
  && "$(docker inspect --format '{{.Image}}' "${gateway_template_id}")" == "${target_image_id}" \
  && "$(docker inspect --format '{{.State.Status}}' "${gateway_template_id}")" == created ]] \
  || die "Target Conversation Gateway runtime template is not an exact stopped candidate."
forge_cutover_prepare gateway "${gateway_before_id}" "${target_image_id}" "${gateway_hash}" "${gateway_template_id}"
cleanup_gateway_template || die "Conversation Gateway runtime template could not be removed."

activate_gateway_candidate() {
  [[ "${gateway_candidate_activated}" == false ]] || return 1
  forge_cutover_activate "${FORGE_CUTOVER_RECORD_ROOT}/gateway.json" || return 1
  gateway_candidate_activated=true
}

gateway_contract="$(gateway_maintenance_contract "${gateway_before_id}")" \
  || die "Conversation Gateway has a partial or unrecognised maintenance contract."
gateway_open_protocol_matches "${gateway_contract}" \
  || die "Conversation Gateway runtime contract and open health protocol do not agree."
if [[ "${gateway_contract}" == tracked ]]; then
  printf 'tracked-source-drain\n' >"${backup_root}/gateway-cutover-mode.txt"
  write_gateway_fence maintenance || die "Conversation Gateway maintenance fence could not be entered."
  wait_gateway_maintenance || die "Conversation Gateway did not drain every tracked HTTP/WebSocket connection."
else
  printf 'legacy-source-maintenance-cutover-no-pre-drain-claim\n' >"${backup_root}/gateway-cutover-mode.txt"
  write_gateway_fence maintenance || die "Conversation Gateway maintenance fence could not be entered."
  activate_gateway_candidate || die "Legacy Conversation Gateway could not switch to the maintenance-capable candidate."
  wait_gateway_maintenance || die "Candidate Gateway did not enter tracked maintenance after the legacy cutover."
  log "Legacy Gateway lacked the tracked-maintenance contract; the approved maintenance window used one bounded candidate cutover without claiming a source-side drain."
fi
chmod 0600 "${backup_root}/gateway-cutover-mode.txt"
for slug in "${project_slugs[@]}"; do enter_project_maintenance "${slug}"; maintenance_entered["${slug}"]=true; done
for slug in "${project_slugs[@]}"; do runner_release_is_idle "${slug}" || die "Release changed after fencing for ${slug}."; verification_is_idle "${slug}" || die "Verification changed after fencing for ${slug}."; done
backup_control_state
state_backed_up=true

chmod 0600 "${staged_control}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${staged_control}"; mv -- "${staged_control}" "${control_env}"

for slug in "${project_slugs[@]}"; do
  root="${DELIVERY_ROOT}/projects/${slug}"; env_file="${root}/ops/project.env"; verify_root="${root}/verification"; acceptance_root="${root}/acceptance"; mutated["${slug}"]=true
  prepare_verification_tree "${slug}"; prepare_acceptance_tree "${slug}"; write_generation_ledger "${slug}"
  staged_env="${env_file}.toolkit-stage.$$"; [[ ! -e "${staged_env}" && ! -L "${staged_env}" ]] || die "Staged project environment already exists for ${slug}."
  cp --preserve=mode,ownership -- "${env_file}" "${staged_env}"
  upsert_env "${staged_env}" GLM_KEY_FILE "${GLM_KEY_FILE}"
  upsert_env "${staged_env}" FORGE_SKILL_BUNDLE_ROOT "${DELIVERY_ROOT}/skill-bundles"
  upsert_env "${staged_env}" TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED true
  upsert_env "${staged_env}" PROJECT_GIT_SSH_ROOT "${DELIVERY_ROOT}/git-remotes/${slug}"
  upsert_env "${staged_env}" PROJECT_VERIFY_ROOT "${verify_root}"; upsert_env "${staged_env}" PROJECT_VERIFY_IPC_ROOT "${verify_root}/ipc"; upsert_env "${staged_env}" PROJECT_VERIFY_SOURCE_IPC_ROOT "${verify_root}/source-ipc"; upsert_env "${staged_env}" PROJECT_VERIFY_STATE_ROOT "${verify_root}/state"; upsert_env "${staged_env}" PROJECT_VERIFY_CACHE_ROOT "${verify_root}/cache-packs"
  if project_uses_host_verification "${slug}"; then
    upsert_env "${staged_env}" PROJECT_VERIFICATION_MODE host-toolchain
    upsert_env "${staged_env}" PROJECT_VERIFICATION_CONTRACT "${verify_root}/host-contract.json"
  else
    upsert_env "${staged_env}" PROJECT_VERIFICATION_MODE container-toolchain
    upsert_env "${staged_env}" PROJECT_VERIFICATION_CONTRACT "${verify_root}/contract.json"
  fi
  upsert_env "${staged_env}" PROJECT_ACCEPTANCE_ROOT "${acceptance_root}"; upsert_env "${staged_env}" PROJECT_ACCEPTANCE_CONFIG "${acceptance_root}/service.json"; upsert_env "${staged_env}" PROJECT_ACCEPTANCE_STATE_ROOT "${acceptance_root}/state"; upsert_env "${staged_env}" PROJECT_ACCEPTANCE_SECRET_ROOT "${acceptance_root}/secrets"
  upsert_env "${staged_env}" PROJECT_ACCEPTANCE_CONTROL_IPC_ROOT "${acceptance_root}/ipc-control"; upsert_env "${staged_env}" PROJECT_ACCEPTANCE_ISSUER_IPC_ROOT "${acceptance_root}/ipc-issuer"; upsert_env "${staged_env}" PROJECT_ACCEPTANCE_RESOLVER_IPC_ROOT "${acceptance_root}/ipc-resolver"
  upsert_env "${staged_env}" HARNESS_IMAGE_SOURCE "${HARNESS_IMAGE}"; upsert_env "${staged_env}" HARNESS_IMAGE "${target_image_id}"
  upsert_env "${staged_env}" FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED true
  upsert_env "${staged_env}" FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED "${format_maintenance_supported}"
  upsert_env "${staged_env}" FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED "${contract_continuation_supported}"
  upsert_env "${staged_env}" FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED "${review_suspension_supported}"
  upsert_env "${staged_env}" FORGE_CHANGED_VERIFICATION_SUPPORTED "${changed_verification_supported}"
  upsert_env "${staged_env}" FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED "${focused_backend_verification_supported}"
  upsert_env "${staged_env}" FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED "${ordinary_final_verification_supported}"
  upsert_env "${staged_env}" CONVERSATION_MANAGER_IMAGE "${conversation_manager_image_id}"
  upsert_env "${staged_env}" RELEASE_RUNNER_IMAGE "${target_image_id}"
  upsert_env "${staged_env}" TASKSPACE_BROKER_IMAGE "${target_image_id}"; upsert_env "${staged_env}" VERIFICATION_RUNNER_IMAGE "${target_image_id}"; upsert_env "${staged_env}" VERIFICATION_TOOLCHAIN_IMAGE "${target_image_id}"
  upsert_env "${staged_env}" PROTECTED_ACCEPTANCE_IMAGE "${target_image_id}"
  chmod 0600 "${staged_env}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${staged_env}"; mv -- "${staged_env}" "${env_file}"
  staged_compose="${root}/ops/compose.yaml.toolkit-stage.$$"; [[ ! -e "${staged_compose}" && ! -L "${staged_compose}" ]] || die "Staged project Compose already exists for ${slug}."
  (umask 0027; render_project_compose_with_managed_files \
    "${slug}" "${project_compose_application_services_json[${slug}]}" >"${staged_compose}")
  [[ "$(sha256sum "${staged_compose}" | awk '{print $1}')" == "${project_target_compose_hash[${slug}]}" ]] \
    || die "Managed target configuration changed after project Compose preflight for ${slug}."
  chmod 0640 "${staged_compose}"; chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${staged_compose}"
  mv -- "${staged_compose}" "${root}/ops/compose.yaml"
  render_release_contract "${slug}" "${root}" "${root}/workspace" "${env_file}" \
    "${root}/ops/runtime-contract.json" "${root}/workspace" "${project_release_services_json[${slug}]}" \
    "${project_compose_application_services_json[${slug}]}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${root}/ops/runtime-contract.json"; chmod 0640 "${root}/ops/runtime-contract.json"
  release_runtime_contract_ready "${slug}" || die "Release runtime contract did not converge for ${slug}."
  project_compose "${slug}" config --quiet
done
control_compose config --quiet

for slug in "${project_slugs[@]}"; do
  manager_id="$(selected_id "${slug}" conversation-manager)"; release_id="$(selected_id "${slug}" release-runner)"; broker_id="$(selected_id "${slug}" taskspace-broker)"; verification_id="$(selected_id "${slug}" verification-runner)"; acceptance_id="$(selected_id "${slug}" protected-acceptance)"
  if [[ "${acceptance_id}" == absent ]]; then
    project_compose "${slug}" up --detach --no-deps protected-acceptance
    acceptance_id="$(project_compose "${slug}" ps --quiet protected-acceptance)"
    [[ "${acceptance_id}" =~ ^[0-9a-f]{12,64}$ ]] || die "Protected Acceptance service was not created for ${slug}."
    printf '%s\n' "${acceptance_id}" >"${backup_root}/projects/${slug}/acceptance.created-id"
    chmod 0600 "${backup_root}/projects/${slug}/acceptance.created-id"
  else
    forge_cutover_prepare "${slug}-acceptance" "${acceptance_id}" "${target_image_id}" "$(project_compose "${slug}" config --hash protected-acceptance | compose_hash_value)"
  fi
  runtime_template_slug="${slug}"
  runtime_template_project="forge-template-$(printf '%s' "${FORGE_CUTOVER_OPERATION}:${slug}:$$" | sha256sum | awk '{print substr($1,1,20)}')"
  runtime_template_file="${runtime_template_root}/project-${slug}.json"
  project_compose "${slug}" config --format json \
    | render_runtime_template_compose "${runtime_template_file}" '["conversation-manager","release-runner","taskspace-broker"]'
  runtime_template_compose "${slug}" "${runtime_template_project}" "${runtime_template_file}" up --no-start --no-build --no-deps conversation-manager release-runner taskspace-broker >/dev/null
  manager_template_id="$(runtime_template_compose "${slug}" "${runtime_template_project}" "${runtime_template_file}" ps --all --quiet conversation-manager)"
  release_template_id="$(runtime_template_compose "${slug}" "${runtime_template_project}" "${runtime_template_file}" ps --all --quiet release-runner)"
  broker_template_id="$(runtime_template_compose "${slug}" "${runtime_template_project}" "${runtime_template_file}" ps --all --quiet taskspace-broker)"
  [[ "${manager_template_id}" =~ ^[0-9a-f]{12,64}$ && "${release_template_id}" =~ ^[0-9a-f]{12,64}$ && "${broker_template_id}" =~ ^[0-9a-f]{12,64}$ ]] \
    || die "Compose runtime templates were not created exactly for ${slug}."
  forge_cutover_prepare "${slug}-manager" "${manager_id}" "${conversation_manager_image_id}" "$(project_compose "${slug}" config --hash conversation-manager | compose_hash_value)" "${manager_template_id}"
  forge_cutover_prepare "${slug}-release" "${release_id}" "${target_image_id}" "$(project_compose "${slug}" config --hash release-runner | compose_hash_value)" "${release_template_id}"
  forge_cutover_prepare "${slug}-broker" "${broker_id}" "${target_image_id}" "$(project_compose "${slug}" config --hash taskspace-broker | compose_hash_value)" "${broker_template_id}"
  cleanup_runtime_template || die "Compose runtime templates could not be removed for ${slug}."
  if project_uses_host_verification "${slug}"; then
    host_retained_legacy_is_stopped "${slug}" "${verification_id}" \
      && host_verification_is_ready "${slug}" \
      || die "Host Verification changed before control-plane cutover for ${slug}."
  else
    if [[ "${verification_id}" != absent ]]; then
      forge_cutover_prepare "${slug}-verification" "${verification_id}" "${target_image_id}" "$(project_compose "${slug}" config --hash verification-runner | compose_hash_value)"
    fi
  fi
done

if [[ "${gateway_candidate_activated}" == false ]]; then
  activate_gateway_candidate || die "Conversation Gateway candidate could not be activated."
  wait_gateway_maintenance || die "Candidate Gateway did not retain the unified maintenance fence."
fi
for slug in "${project_slugs[@]}"; do
  if [[ -f "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-acceptance.json" ]]; then forge_cutover_activate "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-acceptance.json"; fi
  acceptance_id="$(project_compose "${slug}" ps --quiet protected-acceptance)"
  wait_container_health "${acceptance_id}" || die "Target Protected Acceptance service unhealthy for ${slug}."
  acceptance_is_healthy "${slug}" || die "Target Protected Acceptance resolver unavailable for ${slug}."
  forge_cutover_activate "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-release.json"
  release_id="$(jq -r '.candidate.id' "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-release.json")"
  wait_container_health "${release_id}" || die "Target Release Runner unhealthy for ${slug}."
  runner_release_is_idle "${slug}" || die "Target Release Runner is active or unavailable for ${slug}."
  forge_cutover_activate "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-broker.json"
  if project_uses_host_verification "${slug}"; then
    verification_id="$(selected_id "${slug}" verification-runner)"
    host_retained_legacy_is_stopped "${slug}" "${verification_id}" \
      || die "Retained legacy Verification Runner changed during Host-mode cutover for ${slug}."
  else
    if [[ -f "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-verification.json" ]]; then
      forge_cutover_activate "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-verification.json"
      verification_id="$(jq -r '.candidate.id' "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-verification.json")"
    else
      project_compose "${slug}" up --detach --no-deps verification-runner
      verification_id="$(project_compose "${slug}" ps --quiet verification-runner)"
      [[ "${verification_id}" =~ ^[0-9a-f]{12,64}$ ]] \
        || die "Verification Runner was not created for ${slug}."
      printf '%s\n' "${verification_id}" >"${backup_root}/projects/${slug}/verification.created-id"
      chmod 0600 "${backup_root}/projects/${slug}/verification.created-id"
    fi
  fi
  forge_cutover_activate "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-manager.json"
  broker_id="$(jq -r '.candidate.id' "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-broker.json")"
  manager_id="$(jq -r '.candidate.id' "${FORGE_CUTOVER_RECORD_ROOT}/${slug}-manager.json")"
  wait_container_health "${broker_id}" || die "Target Broker unhealthy for ${slug}."
  wait_container_health "${manager_id}" || die "Target Conversation Manager unhealthy for ${slug}."
  docker exec "${broker_id}" node -e 'const h=require("node:http");const q=h.request({socketPath:"/run/forge-acceptance-resolver/resolver.sock",path:"/healthz"},r=>process.exit(r.statusCode===200?0:1));q.on("error",()=>process.exit(1));q.end()' || die "Broker cannot reach Protected Acceptance resolver for ${slug}."
  docker exec "${broker_id}" node -e 'fetch("http://127.0.0.1:3100/healthz").then(async r=>{const v=await r.json();if(!r.ok||v.active!==false||v.maintenance?.active!==true)process.exit(1)}).catch(()=>process.exit(1))' || die "Target Broker lost the maintenance fence for ${slug}."
  if project_uses_host_verification "${slug}"; then
    host_verification_is_ready "${slug}" && broker_uses_host_verification "${slug}" \
      || die "Broker cannot reach the contract-bound Host Verification Runner for ${slug}."
  else
    wait_container_health "${verification_id}" || die "Target Verification Runner unhealthy for ${slug}."
    docker exec "${broker_id}" node -e 'const h=require("node:http");const q=h.request({socketPath:"/run/forge-verify/runner.sock",path:"/healthz"},r=>process.exit(r.statusCode===200?0:1));q.on("error",()=>process.exit(1));q.end()' || die "Broker cannot reach Verification Runner for ${slug}."
  fi
done
capture_preserved_topology "${backup_root}/preserved.after.tsv"; cmp "${backup_root}/preserved.before.tsv" "${backup_root}/preserved.after.tsv" || die "A preserved container ID/state or active task.env changed."
for slug in "${project_slugs[@]}"; do generation_ready "${slug}" || die "Generation ledger/verification contract did not converge for ${slug}."; done

for record in "${FORGE_CUTOVER_RECORD_ROOT}"/*.json; do forge_cutover_promote "${record}"; done
commit_started=true
for record in "${FORGE_CUTOVER_RECORD_ROOT}"/*.json; do forge_cutover_discard_original "${record}"; done
runtime_inventory_exact || die "Governed runtime inventory did not converge exactly after control-plane commit."
for slug in "${project_slugs[@]}"; do leave_project_maintenance "${slug}" || die "Maintenance ownership changed for ${slug}."; maintenance_entered["${slug}"]=false; done
for slug in "${project_slugs[@]}"; do broker_id="$(project_compose "${slug}" ps --quiet taskspace-broker)"; docker exec "${broker_id}" node -e 'fetch("http://127.0.0.1:3100/healthz").then(async r=>{const v=await r.json();if(!r.ok||v.active!==false||v.maintenance?.active!==false)process.exit(1)}).catch(()=>process.exit(1))' || die "Broker did not reopen for ${slug}."; done
write_gateway_fence committed || die "Candidate Gateway could not commit the maintenance epoch."
wait_gateway_open || die "Candidate Gateway did not reopen after the committed cutover."
capture_preserved_topology "${backup_root}/preserved.committed.tsv"; cmp "${backup_root}/preserved.before.tsv" "${backup_root}/preserved.committed.tsv" || die "A preserved container changed while reopening maintenance."
capture_selected_topology "${backup_root}/selected.committed.tsv"
committed=true; trap - ERR EXIT
write_upgrade_terminal_receipt committed 0 || die "Upgrade committed, but its terminal receipt could not be written at ${backup_root}."
log "Forge Delivery Toolkit control-plane closure is active. Gateway, Manager, Release Runner, and Broker changed; legacy-mode Verification Runner containers were cut over, while Host-mode runner wiring and stopped rollback containers were preserved. Applications, active TaskSpaces, optional absence, and task.env remained unchanged."
