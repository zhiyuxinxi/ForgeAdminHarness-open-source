#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

usage() {
  printf 'Usage: %s --confirm-maintenance-window taskspace-tool-cache\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == taskspace-tool-cache ]] \
  || die "This upgrade requires --confirm-maintenance-window taskspace-tool-cache."

# The material-isolation upgrader is the reviewed, rollback-capable all-project
# image/template cutover. It now creates uid-correct TaskSpace cache binds
# before recreating a worker. Reusing that state machine avoids a second,
# subtly different control-plane restart path. It is idempotent and never
# removes the historical named volumes.
exec bash "${SCRIPT_DIR}/upgrade-project-material-isolation.sh" \
  --confirm-maintenance-window project-material-isolation
