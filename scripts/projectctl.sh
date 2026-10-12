#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 <project-slug> <command> [service...]" \
    "" \
    "Commands:" \
    "  validate       Validate Compose without printing resolved secrets" \
    "  up             Build Forge Admin from locally available base images and start" \
    "  start|stop     Start or stop existing containers" \
    "  restart        Restart existing containers" \
    "  down           Remove containers/network; preserve data volumes" \
    "  status         Show service status" \
    "  logs [service] Follow recent logs" \
    "  harness-logs   Follow this project's Manager and the unified Gateway logs" \
    "  harness-capabilities  Upgrade the versioned Harness capability/Skill bundle" \
    "  glm-provider  Enable the GLM provider across all registered projects in a maintenance window" \
    "  harness-vpn-access  Upgrade Harness for trusted company-VPN settings access" \
    "  controlled-release  Remove Docker from Harness and enable the project-scoped release runner" \
    "  taskspace <command>  Create and operate isolated per-task Harness workers" \
    "  taskspace-isolation  Upgrade an existing project to isolated Harness workers" \
    "  taskspace-tool-cache  Repair per-TaskSpace cache ownership and sandbox paths" \
    "  prototype-archive-support  Enable safe Axure/frontend ZIP indexing for all projects" \
    "  project-folder-inputs  Enable direct read-only SFTP folders and safe frontend indexing" \
    "  conversation-isolation  Upgrade all registered projects to the unified conversation control plane" \
    "  conversation-gateway-ui  Upgrade only the unified Gateway image and preserve project/TaskSpace containers" \
    "  project-material-isolation  Separate raw intake from administrator-approved project material" \
    "  git <command>   Prepare, attach, or verify this project's private Git remote" \
    "  git-remote-runtime  Activate private Git push enforcement after reviewed attachment" \
    "  mobile-runtime <args>  Upgrade a reviewed H5/App candidate into the four-service runtime" \
    "  materials <command>  List or approve this project's governed material" \
    "  users <command>  List and administer platform accounts and project memberships" \
    "  backup --confirm-maintenance-window <slug>  Create a quiesced project recovery bundle" \
    "  restore <backup-dir> --confirm-destructive-restore <slug>  Restore exact registered project" \
    "  access         Print the direct VPN access URLs"
}

slug="${1:-}"
action="${2:-}"
[[ -n "${slug}" && -n "${action}" ]] || { usage >&2; exit 2; }
shift 2
validate_slug "${slug}"

project_path="${DELIVERY_ROOT}/projects/${slug}"
ops_path="${project_path}/ops"
env_file="${ops_path}/project.env"
compose_file="${ops_path}/compose.yaml"
[[ -d "${project_path}" && -f "${env_file}" && -f "${compose_file}" ]] \
  || die "Project is missing or incomplete: ${project_path}"

env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

validate_project_upload_root() {
  local configured_upload_root expected_upload_root configured_shared_root expected_shared_root
  configured_upload_root="$(env_value PROJECT_UPLOAD_ROOT)"
  [[ -n "${configured_upload_root}" ]] || return 0
  expected_upload_root="${DELIVERY_ROOT}/file-gateway/data/${slug}"
  [[ "${configured_upload_root}" == "${expected_upload_root}" ]] \
    || die "Unexpected PROJECT_UPLOAD_ROOT for ${slug}: ${configured_upload_root}"
  [[ -d "${configured_upload_root}" ]] \
    || die "Project upload directory is missing. Run file-gatewayctl.sh sync-projects first."
  configured_shared_root="$(env_value PROJECT_SHARED_INPUT_ROOT)"
  expected_shared_root="${project_path}/shared-inputs/accepted"
  [[ "${configured_shared_root}" == "${expected_shared_root}" ]] \
    || die "Unexpected PROJECT_SHARED_INPUT_ROOT for ${slug}: ${configured_shared_root}"
  [[ -d "${configured_shared_root}" ]] \
    || die "Approved project material directory is missing. Run the project material isolation upgrade first."
}

validate_project_git_remote() {
  bash "${SCRIPT_DIR}/project-gitctl.sh" "${slug}" status --require-synchronized >/dev/null
}

validate_project_application_runtime() {
  local contract_file="${ops_path}/runtime-contract.json" configured_services actual_applications expected_applications
  require_command jq
  [[ -f "${contract_file}" && ! -L "${contract_file}" ]] \
    || die "Release runtime contract is missing or unsafe for ${slug}."
  application_services_json="$(jq --compact-output --exit-status \
    --arg slug "${slug}" --arg compose "${compose_file}" '
      select(.projectSlug == $slug and .composeProjectName == ("forge-" + $slug)
        and .release.fixedComposeFile == $compose)
      | .release.allowedReleaseServices
    ' "${contract_file}")" || die "Release runtime contract identity differs from ${slug}."
  release_contract_validate_allowed_release_services_json "${application_services_json}" \
    || die "Release runtime contract has an unsupported application service set for ${slug}."
  configured_services="$(compose config --services | jq --raw-input --slurp --compact-output \
    'split("\n") | map(select(length > 0))')" \
    || die "Unable to read the configured Compose services for ${slug}."
  actual_applications="$(jq --compact-output --argjson applications \
    "$(release_contract_default_allowed_release_services_json)" \
    '[.[] as $service | select($applications | index($service)) | $service] | sort' \
    <<<"${configured_services}")"
  expected_applications="$(jq --compact-output --argjson applications \
    "$(release_contract_default_allowed_release_services_json)" '
      [.release.allowedComposeServices[] as $service | select($applications | index($service)) | $service] | sort
    ' "${contract_file}")"
  release_contract_validate_allowed_release_services_json "${expected_applications}" \
    || die "Release runtime contract has an unsupported Compose application set for ${slug}."
  jq --exit-status --argjson compose "${expected_applications}" \
    '(. - $compose) | length == 0' <<<"${application_services_json}" >/dev/null \
    || die "Compose application set omits a required release service for ${slug}."
  [[ "${actual_applications}" == "${expected_applications}" ]] \
    || die "Compose application services differ from the release runtime contract for ${slug}."
  startup_services_json="$(jq --compact-output --exit-status --argjson configured "${configured_services}" '
    .release.allowedComposeServices as $allowed
    | select(($allowed | type) == "array" and all($allowed[]; type == "string"))
    | [$configured[] as $service | select($allowed | index($service)) | $service]
    | select(length > 0)
  ' "${contract_file}")" || die "Release runtime contract has no supported Compose services for ${slug}."
  mapfile -t application_services < <(jq --raw-output '.[]' <<<"${application_services_json}")
  mapfile -t startup_services < <(jq --raw-output '.[]' <<<"${startup_services_json}")
}

case "${action}" in
  validate)
    require_docker_access
    validate_project_upload_root
    validate_project_git_remote
    compose config --quiet
    validate_project_application_runtime
    log "Compose configuration is valid for ${slug}."
    ;;
  up)
    require_docker_access
    validate_project_upload_root
    validate_project_git_remote
    compose config --quiet
    validate_project_application_runtime
    compose build "${application_services[@]}"
    compose up --detach --no-build "${startup_services[@]}"
    compose ps
    ;;
  start|stop|restart)
    require_docker_access
    if [[ "${action}" != 'stop' ]]; then
      validate_project_upload_root
      validate_project_git_remote
    fi
    compose "${action}" "$@"
    ;;
  down)
    require_docker_access
    require_command jq
    if [[ -d "${project_path}/taskspaces" ]]; then
      shopt -s nullglob
      for task_metadata in "${project_path}/taskspaces"/*/metadata.json; do
        task_id="$(basename -- "$(dirname -- "${task_metadata}")")"
        task_status="$(jq -r '.status' "${task_metadata}")"
        if [[ "${task_status}" != closed ]]; then
          bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" stop "${task_id}"
        fi
      done
    fi
    compose down --remove-orphans
    log "Containers and the project network were removed; persistent volumes were preserved."
    ;;
  status)
    require_docker_access
    compose ps --all
    ;;
  logs)
    require_docker_access
    compose logs --follow --tail 200 "$@"
    ;;
  harness-logs)
    require_docker_access
    control_env="${DELIVERY_ROOT}/conversation-control-plane/control-plane.env"
    [[ -f "${control_env}" ]] || die "Unified conversation control plane is not prepared."
    docker compose \
      --env-file "${control_env}" \
      --file "${REPO_ROOT}/templates/conversation-control-plane/compose.yaml" \
      logs --tail 200 conversation-gateway
    compose logs --follow --tail 200 conversation-manager
    ;;
  harness-capabilities|harness-vpn-access)
    exec bash "${SCRIPT_DIR}/upgrade-harness-vpn-access.sh" "${slug}"
    ;;
  glm-provider)
    exec bash "${SCRIPT_DIR}/upgrade-glm-provider.sh" "$@"
    ;;
  controlled-release)
    exec bash "${SCRIPT_DIR}/upgrade-controlled-release.sh" "${slug}"
    ;;
  taskspace-isolation)
    exec bash "${SCRIPT_DIR}/upgrade-taskspace-isolation.sh" "${slug}"
    ;;
  taskspace-tool-cache)
    exec bash "${SCRIPT_DIR}/upgrade-taskspace-tool-cache.sh" "$@"
    ;;
  prototype-archive-support)
    exec bash "${SCRIPT_DIR}/upgrade-prototype-archive-support.sh" "$@"
    ;;
  project-folder-inputs)
    exec bash "${SCRIPT_DIR}/upgrade-project-folder-inputs.sh" "$@"
    ;;
  conversation-isolation)
    exec bash "${SCRIPT_DIR}/upgrade-unified-conversation-control-plane.sh" "$@"
    ;;
  conversation-gateway-ui)
    exec bash "${SCRIPT_DIR}/upgrade-conversation-gateway-ui.sh" "$@"
    ;;
  project-material-isolation)
    exec bash "${SCRIPT_DIR}/upgrade-project-material-isolation.sh" "$@"
    ;;
  git)
    (($# > 0)) || { usage >&2; die "git requires a subcommand"; }
    exec bash "${SCRIPT_DIR}/project-gitctl.sh" "${slug}" "$@"
    ;;
  git-remote-runtime)
    exec bash "${SCRIPT_DIR}/upgrade-project-git-remote.sh" "${slug}" "$@"
    ;;
  mobile-runtime)
    exec bash "${SCRIPT_DIR}/upgrade-mobile-runtime.sh" "${slug}" "$@"
    ;;
  materials)
    (($# > 0)) || { usage >&2; die "materials requires a subcommand"; }
    exec bash "${SCRIPT_DIR}/project-materialctl.sh" "${slug}" "$@"
    ;;
  users)
    (($# > 0)) || { usage >&2; die "users requires a subcommand"; }
    exec bash "${SCRIPT_DIR}/conversation-userctl.sh" "$@"
    ;;
  taskspace)
    (($# > 0)) || { usage >&2; die "taskspace requires a subcommand"; }
    exec bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" "$@"
    ;;
  backup)
    exec bash "${SCRIPT_DIR}/backup-project.sh" "${slug}" "$@"
    ;;
  restore)
    (($# > 0)) || { usage >&2; die "restore requires a recovery bundle directory"; }
    backup_path="$1"
    shift
    exec bash "${SCRIPT_DIR}/restore-project.sh" "${slug}" "${backup_path}" "$@"
    ;;
  access)
    bind_address="$(env_value FORGE_BIND_ADDRESS)"
    ui_port="$(env_value FORGE_UI_PORT)"
    printf 'Forge UI: http://%s:%s/forge/login\n' "${bind_address}" "${ui_port}"
    if jq --exit-status '.release.allowedReleaseServices | index("forge-app") != null' \
        "${ops_path}/runtime-contract.json" >/dev/null; then
      printf 'Forge Mobile: http://%s:%s/forge-h5/\n' "${bind_address}" "${ui_port}"
    fi
    printf 'Unified Harness Gateway: http://%s:%s/forge-gateway/\n' \
      "${CONVERSATION_GATEWAY_BIND_ADDRESS}" "${CONVERSATION_GATEWAY_PORT}"
    printf 'The project is selected after login. Administer platform users and memberships with:\n  bash %s %s users list\n' "$0" "${slug}"
    ;;
  *)
    usage >&2
    die "Unknown command: ${action}"
    ;;
esac
