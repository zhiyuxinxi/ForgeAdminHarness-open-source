#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 <project-slug> --candidate-taskspace <c-id> --confirm frontend-typecheck-capability"
}

slug="${1:-}"
[[ -n "${slug}" && "${slug}" != --* ]] || { usage >&2; die "Project slug is required."; }
shift
candidate_taskspace=''
confirmation=''
while (($# > 0)); do
  case "$1" in
    --candidate-taskspace) candidate_taskspace="${2:-}"; shift 2 ;;
    --confirm) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

validate_slug "${slug}"
[[ "${candidate_taskspace}" =~ ^c-[a-f0-9]{24}$ ]] \
  || die "--candidate-taskspace must be an exact c-<24 lowercase hex> identity."
[[ "${confirmation}" == frontend-typecheck-capability ]] \
  || die "--confirm frontend-typecheck-capability is required."
for command_name in awk bash git jq readlink stat; do
  require_command "${command_name}"
done

project_root="${DELIVERY_ROOT}/projects/${slug}"
integration_workspace="${project_root}/workspace"
task_root="${project_root}/taskspaces/${candidate_taskspace}"
candidate_workspace="${task_root}/workspace"
candidate_metadata="${task_root}/metadata.json"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"

[[ -f "${registry_file}" ]] || die "Project registry is missing."
awk -F '\t' -v value="${slug}" 'NR > 1 && $1 == value {found=1} END {exit !found}' "${registry_file}" \
  || die "Project is not registered: ${slug}"
for directory in "${project_root}" "${integration_workspace}" "${task_root}" "${candidate_workspace}"; do
  [[ -d "${directory}" && ! -L "${directory}" ]] || die "Managed directory is missing or unsafe: ${directory}"
done
[[ "$(readlink -f -- "${task_root}")" == "$(readlink -f -- "${project_root}")/taskspaces/${candidate_taskspace}" \
  && "$(readlink -f -- "${candidate_workspace}")" == "$(readlink -f -- "${task_root}")/workspace" ]] \
  || die "Candidate TaskSpace escaped the selected project."
[[ -f "${candidate_metadata}" && ! -L "${candidate_metadata}" \
  && "$(stat -c '%h' -- "${candidate_metadata}")" == 1 ]] \
  || die "Candidate TaskSpace metadata is missing or unsafe."
jq -e --arg task_id "${candidate_taskspace}" --arg slug "${slug}" '
  type == "object"
  and .taskId == $task_id
  and .projectSlug == $slug
  and .status == "active"
  and .accessMode == "conversation"
' "${candidate_metadata}" >/dev/null \
  || die "Candidate TaskSpace metadata does not match the active project identity."

integration_head="$(project_git_readonly "${integration_workspace}" rev-parse 'HEAD^{commit}')"
candidate_head="$(project_git_readonly "${candidate_workspace}" rev-parse 'HEAD^{commit}')"
project_git_readonly "${candidate_workspace}" merge-base --is-ancestor "${integration_head}" "${candidate_head}" \
  || die "Candidate TaskSpace is not based on the current integration HEAD."

candidate_status="$(project_git_readonly "${candidate_workspace}" status --porcelain=v1 --untracked-files=all)"
case "${candidate_status}" in
  '') ;;
  $' M forge-admin-ui/package.json\n M forge-admin-ui/pnpm-lock.yaml') ;;
  *) die "Candidate TaskSpace contains changes outside the two reviewed frontend typecheck files." ;;
esac

run_as_delivery_owner bash -c '
  set -Eeuo pipefail
  source "$1"
  frontend_typecheck_capability apply --workspace "$2" --candidate-metadata "$3"
' forge-frontend-typecheck \
  "${SCRIPT_DIR}/lib/frontend-typecheck-capability.sh" \
  "${candidate_workspace}" \
  "${candidate_metadata}"

expected_status=$' M forge-admin-ui/package.json\n M forge-admin-ui/pnpm-lock.yaml'
actual_status="$(project_git_readonly "${candidate_workspace}" status --porcelain=v1 --untracked-files=all)"
[[ -z "${actual_status}" || "${actual_status}" == "${expected_status}" ]] \
  || die "Frontend typecheck upgrade changed files outside package.json and pnpm-lock.yaml."

log "Frontend typecheck is ready in candidate ${candidate_taskspace}."
log "Run the normal candidate verification; this script did not modify the integration workspace."
