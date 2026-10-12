#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 <project-slug> list [--include-intake]" \
    "       $0 <project-slug> promote --source <relative-path> --category <business|standards/ui|reference> [--actor <operator-id>]" \
    "" \
    "The promote command copies a verified file from project intake into the approved project-shared area." \
    "It never moves or deletes the intake file."
}

slug="${1:-}"
action="${2:-}"
[[ -n "${slug}" && -n "${action}" ]] || { usage >&2; exit 2; }
shift 2
validate_slug "${slug}"
for command_name in curl jq sha256sum; do require_command "${command_name}"; done

project_root="${DELIVERY_ROOT}/projects/${slug}"
env_file="${project_root}/ops/project.env"
[[ -f "${env_file}" ]] || die "Project environment is missing: ${env_file}"
env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}
intake_root="$(env_value PROJECT_UPLOAD_ROOT)"
manager_socket="$(env_value CONVERSATION_MANAGER_SOCKET)"
manager_token_file="$(env_value CONVERSATION_MANAGER_TOKEN_FILE)"
[[ "${intake_root}" == "${DELIVERY_ROOT}/file-gateway/data/${slug}" ]] \
  || die "Unexpected project intake root: ${intake_root}"
[[ "${manager_socket}" == "${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}/ipc/manager.sock" ]] \
  || die "Unexpected manager socket: ${manager_socket}"
[[ "${manager_token_file}" == "${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}/manager-token" ]] \
  || die "Unexpected manager token path: ${manager_token_file}"
[[ -S "${manager_socket}" && -f "${manager_token_file}" ]] \
  || die "Project Manager capability is not ready for ${slug}."
manager_token="$(<"${manager_token_file}")"

request() {
  local method="$1" path_name="$2" body="${3:-}"
  local args=(
    --fail-with-body --silent --show-error --max-time 120
    --unix-socket "${manager_socket}"
    --request "${method}"
    --header "Authorization: Bearer ${manager_token}"
    --header 'Accept: application/json'
  )
  if [[ -n "${body}" ]]; then
    args+=(--header 'Content-Type: application/json' --data-binary "${body}")
  fi
  curl "${args[@]}" "http://localhost${path_name}"
}

case "${action}" in
  list)
    include_intake=false
    if (($# > 0)); then
      [[ "$1" == --include-intake && $# -eq 1 ]] || { usage >&2; exit 2; }
      include_intake=true
    fi
    request GET "/v1/materials?includeIntake=${include_intake}&limit=500" | jq .
    ;;
  promote)
    source_relative=''
    category=''
    actor='platform-operator'
    while (($# > 0)); do
      case "$1" in
        --source) source_relative="${2:-}"; shift 2 ;;
        --category) category="${2:-}"; shift 2 ;;
        --actor) actor="${2:-}"; shift 2 ;;
        *) usage >&2; die "Unknown promote option: $1" ;;
      esac
    done
    [[ -n "${source_relative}" && -n "${category}" ]] || { usage >&2; exit 2; }
    [[ "${source_relative}" != /* && "${source_relative}" != *\\* && "${source_relative}" != *'../'* \
      && "${source_relative}" != '..' && "${source_relative}" != *'/..' ]] \
      || die "Source must be a project-intake relative path without traversal."
    [[ "${category}" == business || "${category}" == standards/ui || "${category}" == reference ]] \
      || die "Invalid material category: ${category}"
    [[ "${actor}" =~ ^[a-z0-9][a-z0-9._-]{1,63}$ ]] || die "Invalid actor identifier."
    source_path="${intake_root}/${source_relative}"
    [[ -f "${source_path}" && ! -L "${source_path}" ]] || die "Source is not a regular non-symlink file: ${source_relative}"
    resolved_source="$(realpath -e -- "${source_path}")"
    [[ "${resolved_source}" == "${intake_root}/"* ]] || die "Source resolves outside project intake."
    expected_sha256="$(sha256sum -- "${resolved_source}" | awk '{print $1}')"
    request_id="materialctl:$(date -u +%Y%m%dT%H%M%SZ):$$"
    body="$(jq --null-input \
      --arg actorId "${actor}" \
      --arg actorUsername "${actor}" \
      --arg category "${category}" \
      --arg expectedSha256 "${expected_sha256}" \
      --arg requestId "${request_id}" \
      --arg sourcePath "${source_relative}" \
      '{actorId: $actorId, actorUsername: $actorUsername, category: $category,
        expectedSha256: $expectedSha256, requestId: $requestId, sourcePath: $sourcePath}')"
    request POST /v1/materials/promote "${body}" | jq .
    ;;
  *)
    usage >&2
    die "Unknown action: ${action}"
    ;;
esac
