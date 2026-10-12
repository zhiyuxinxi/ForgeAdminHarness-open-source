#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
load_platform_config

slug="${1:-}"
[[ -n "${slug}" && $# -eq 1 ]] || die "Usage: $0 <project-slug>"
validate_slug "${slug}"

project_root="${DELIVERY_ROOT}/projects/${slug}"
env_file="${project_root}/ops/project.env"
contract_file="${project_root}/ops/runtime-contract.json"
[[ -d "${project_root}/workspace" && -f "${env_file}" ]] \
  || die "Project is missing or incomplete: ${project_root}"
assert_managed_path "${project_root}"

render_release_contract \
  "${slug}" \
  "${project_root}" \
  "${project_root}/workspace" \
  "${env_file}" \
  "${contract_file}"
chown --reference="${env_file}" "${contract_file}"
chmod 0640 "${contract_file}"
log "Rendered controlled release contract for ${slug}: ${contract_file}"
