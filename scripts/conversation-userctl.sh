#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 <command> [options]" \
    "" \
    "Commands:" \
    "  list" \
    "  create --username <name> --display-name <name> [--role member|admin|auditor] [--project <slug> ...]" \
    "  projects <username> <slug>..." \
    "  reset-password <username>" \
    "  status <username> <active|disabled>" \
    "" \
    "Temporary passwords are printed once. Deliver them through an approved secure channel."
}

action="${1:-}"
[[ -n "${action}" ]] || { usage >&2; exit 2; }
shift
for command_name in curl jq mktemp; do require_command "${command_name}"; done

control_root="${DELIVERY_ROOT}/conversation-control-plane"
socket_root="${control_root}/ipc"
token_file="${control_root}/operator-token"
socket_path="${socket_root}/operator.sock"
[[ -S "${socket_path}" && -f "${token_file}" ]] \
  || die "Conversation Gateway operator socket is unavailable; start or upgrade the project first."

temporary_root="$(mktemp -d "${control_root}/.conversation-userctl.XXXXXX")"
header_file="${temporary_root}/authorization.header"
response_file="${temporary_root}/response.json"
cleanup() {
  rm -f -- "${header_file}" "${response_file}"
  rmdir -- "${temporary_root}" 2>/dev/null || true
}
trap cleanup EXIT
chmod 0700 "${temporary_root}"
printf 'Authorization: Bearer %s\n' "$(<"${token_file}")" >"${header_file}"
chmod 0600 "${header_file}"

request() {
  local method="$1" path="$2" body="${3:-}" status
  local -a arguments=(
    --noproxy '*'
    --silent
    --show-error
    --unix-socket "${socket_path}"
    --header "@${header_file}"
    --header 'Accept: application/json'
    --request "${method}"
    --output "${response_file}"
    --write-out '%{http_code}'
  )
  if [[ -n "${body}" ]]; then
    arguments+=(--header 'Content-Type: application/json' --data-binary "${body}")
  fi
  status="$(curl "${arguments[@]}" "http://localhost${path}")" \
    || die "Conversation Gateway operator request failed."
  [[ "${status}" =~ ^2[0-9][0-9]$ ]] || {
    jq -r '.message // "Conversation Gateway operator request was rejected."' "${response_file}" >&2 || true
    exit 1
  }
  cat "${response_file}"
}

resolve_user_id() {
  local username="$1" users user_id
  users="$(request GET /v1/users)"
  user_id="$(jq -r --arg username "${username}" '.users[] | select(.username == $username) | .id' <<<"${users}")"
  [[ -n "${user_id}" ]] || die "Conversation user does not exist: ${username}"
  printf '%s' "${user_id}"
}

case "${action}" in
  list)
    (($# == 0)) || { usage >&2; exit 2; }
    request GET /v1/users | jq -r '.users[] | [.username,.displayName,.role,.status,(.projectSlugs|join(",")),(.mustChangePassword|tostring)] | @tsv' \
      | { printf 'USERNAME\tDISPLAY_NAME\tROLE\tSTATUS\tPROJECTS\tMUST_CHANGE_PASSWORD\n'; cat; }
    ;;
  create)
    username=''
    display_name=''
    role='member'
    project_slugs=()
    while (($# > 0)); do
      case "$1" in
        --username) username="${2:-}"; shift 2 ;;
        --display-name) display_name="${2:-}"; shift 2 ;;
        --role) role="${2:-}"; shift 2 ;;
        --project) validate_slug "${2:-}"; project_slugs+=("${2:-}"); shift 2 ;;
        *) usage >&2; die "Unknown create option: $1" ;;
      esac
    done
    [[ -n "${username}" && -n "${display_name}" ]] || die "Username and display name are required."
    projects_json='[]'
    if ((${#project_slugs[@]} > 0)); then
      projects_json="$(printf '%s\n' "${project_slugs[@]}" | jq -R . | jq -s 'unique')"
    fi
    body="$(jq --null-input --arg username "${username}" --arg displayName "${display_name}" --arg role "${role}" --argjson projectSlugs "${projects_json}" \
      '{username: $username, displayName: $displayName, role: $role, projectSlugs: $projectSlugs}')"
    result="$(request POST /v1/users "${body}")"
    jq -r '"Username: \(.user.username)\nTemporary password: \(.temporaryPassword)\nRole: \(.user.role)\nMust change password: yes"' <<<"${result}"
    ;;
  projects)
    username="${1:-}"
    [[ -n "${username}" ]] || { usage >&2; exit 2; }
    shift
    project_slugs=()
    for slug in "$@"; do validate_slug "${slug}"; project_slugs+=("${slug}"); done
    projects_json='[]'
    if ((${#project_slugs[@]} > 0)); then
      projects_json="$(printf '%s\n' "${project_slugs[@]}" | jq -R . | jq -s 'unique')"
    fi
    user_id="$(resolve_user_id "${username}")"
    request POST "/v1/users/${user_id}/projects" "$(jq --null-input --argjson projectSlugs "${projects_json}" '{projectSlugs: $projectSlugs}')" \
      | jq -r '"Username: \(.user.username)\nProjects: \(.user.projectSlugs | join(", "))"'
    ;;
  reset-password)
    username="${1:-}"
    [[ -n "${username}" && $# -eq 1 ]] || { usage >&2; exit 2; }
    user_id="$(resolve_user_id "${username}")"
    result="$(request POST "/v1/users/${user_id}/reset-password" '{}')"
    jq -r '"Username: \(.user.username)\nTemporary password: \(.temporaryPassword)\nAll previous sessions revoked: yes"' <<<"${result}"
    ;;
  status)
    username="${1:-}"
    next_status="${2:-}"
    [[ -n "${username}" && $# -eq 2 && ("${next_status}" == active || "${next_status}" == disabled) ]] \
      || { usage >&2; exit 2; }
    user_id="$(resolve_user_id "${username}")"
    request POST "/v1/users/${user_id}/status" "$(jq --null-input --arg status "${next_status}" '{status: $status}')" \
      | jq -r '"Username: \(.user.username)\nStatus: \(.user.status)"'
    ;;
  *)
    usage >&2
    die "Unknown command: ${action}"
    ;;
esac
