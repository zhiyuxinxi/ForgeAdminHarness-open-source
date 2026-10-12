#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf 'Usage: %s --confirm-maintenance-window glm-provider\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == glm-provider ]] \
  || die 'This upgrade requires --confirm-maintenance-window glm-provider.'
[[ "${EUID}" -eq 0 ]] || die 'GLM provider maintenance must run as root.'

for command_name in docker stat; do require_command "${command_name}"; done
require_docker_access

: "${GLM_KEY_FILE:?GLM_KEY_FILE is required; install the root-owned secret first}"
glm_secret_metadata="$(stat -Lc '%u:%g:%a:%F' -- "${GLM_KEY_FILE}" 2>/dev/null || true)"
[[ -f "${GLM_KEY_FILE}" && ! -L "${GLM_KEY_FILE}" \
  && -s "${GLM_KEY_FILE}" && "${glm_secret_metadata}" == '0:0:600:regular file' ]] \
  || die "GLM API key must be a non-empty root:root mode-0600 regular secret: ${GLM_KEY_FILE}"

# This delegates the actual cutover to the reviewed all-project maintenance
# transaction. It fences gateway/TaskSpace traffic, verifies release idleness,
# backs up settings/env/Compose/session state, preserves application container
# identities, and rolls back pre-commit failures.  The transaction now updates
# GLM_KEY_FILE and the managed settings for every existing TaskSpace.
exec bash "${SCRIPT_DIR}/upgrade-forge-delivery-toolkit.sh" \
  --confirm-maintenance-window forge-delivery-toolkit
