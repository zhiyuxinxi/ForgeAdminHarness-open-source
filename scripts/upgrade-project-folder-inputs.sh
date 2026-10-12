#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  printf 'Usage: %s --confirm-maintenance-window project-folder-inputs\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ "${confirmation}" == project-folder-inputs ]] || {
  printf '%s\n' 'This upgrade requires --confirm-maintenance-window project-folder-inputs.' >&2
  exit 1
}

# The archive upgrade owns the pinned parser/image build and the common
# rollback-capable all-project cutover. vpn46 additionally verifies and mounts
# direct SFTP folder inputs, so this alias preserves one implementation path.
exec bash "${SCRIPT_DIR}/upgrade-prototype-archive-support.sh" \
  --confirm-maintenance-window prototype-archive-support
