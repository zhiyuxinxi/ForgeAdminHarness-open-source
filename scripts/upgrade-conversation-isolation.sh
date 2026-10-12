#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  printf '%s\n' \
    "Usage: $0 [legacy-project-slug] --confirm-maintenance-window unified-conversation-control-plane" \
    "" \
    "This command is a compatibility entry point. Conversation isolation is now" \
    "a platform-wide upgrade because one authenticated Gateway serves every" \
    "registered Forge Admin delivery project."
}

if [[ "${1:-}" =~ ^[a-z][a-z0-9-]{2,31}$ ]]; then
  warn "Ignoring legacy project slug '${1}'; the unified control-plane upgrade covers every registered project."
  shift
fi
if (($# == 0)) || [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  usage
  exit 0
fi
exec bash "${SCRIPT_DIR}/upgrade-unified-conversation-control-plane.sh" "$@"
