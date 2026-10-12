#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
umask 077

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h)
      printf 'Usage: %s --confirm-maintenance-window conversation-control-plane\n' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == conversation-control-plane ]] \
  || die "A consistent platform-account backup requires --confirm-maintenance-window conversation-control-plane."
for command_name in docker flock jq sha256sum tar; do require_command "${command_name}"; done
require_docker_access

control_root="${DELIVERY_ROOT}/conversation-control-plane"
control_env="${control_root}/control-plane.env"
compose_file="${REPO_ROOT}/templates/conversation-control-plane/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
[[ -f "${control_env}" && -f "${control_root}/state/state.json" \
   && -f "${control_root}/state/audit.jsonl" && -f "${control_root}/operator-token" \
   && -f "${registry_file}" ]] || die "Unified conversation control-plane state is incomplete."

compose() {
  docker compose --env-file "${control_env}" --file "${compose_file}" "$@"
}

lock_file="${DELIVERY_ROOT}/registry/conversation-control-plane.recovery.lock"
prepare_delivery_lock "${lock_file}"
exec 8>>"${lock_file}"
flock --exclusive --nonblock 8 || die "Another conversation control-plane backup or restore owns the recovery lock."

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
backup_root="${DELIVERY_ROOT}/backups/conversation-control-plane"
stage_path="${backup_root}/${timestamp}.incomplete"
final_path="${backup_root}/${timestamp}"
[[ ! -e "${stage_path}" && ! -e "${final_path}" ]] || die "Control-plane backup target already exists."
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}" "${stage_path}"

gateway_was_running=false
if compose ps --status running --services | grep -Fxq conversation-gateway; then
  gateway_was_running=true
fi
resume_gateway() {
  local status=$?
  trap - EXIT
  if [[ "${gateway_was_running}" == true ]]; then
    compose up --detach conversation-gateway >/dev/null 2>&1 \
      || warn "Conversation Gateway could not be restarted automatically after backup."
  fi
  if ((status != 0)); then warn "Control-plane backup failed; evidence remains at ${stage_path}."; fi
  exit "${status}"
}
trap resume_gateway EXIT

if [[ "${gateway_was_running}" == true ]]; then compose stop conversation-gateway; fi

tar --acls --xattrs --numeric-owner --create --gzip \
  --exclude='*.sock' --exclude='ipc/*' --exclude='auth-ipc/*' --exclude='projects/*/ipc/*' \
  --file "${stage_path}/control-plane-state.tar.gz" \
  --directory "${control_root}" state operator-token projects control-plane.env
install -m 0600 "${registry_file}" "${stage_path}/projects.tsv"
state_revision="$(jq -r '.revision' "${control_root}/state/state.json")"
user_count="$(jq -r '.users | length' "${control_root}/state/state.json")"
conversation_count="$(jq -r '.conversations | length' "${control_root}/state/state.json")"
jq --null-input \
  --arg createdAt "$(date --iso-8601=seconds)" \
  --argjson stateRevision "${state_revision}" \
  --argjson users "${user_count}" \
  --argjson conversations "${conversation_count}" \
  '{schemaVersion:1,kind:"unified-conversation-control-plane",createdAt:$createdAt,stateRevision:$stateRevision,users:$users,conversations:$conversations,sessionsQuiesced:true,payloads:["control-plane-state.tar.gz","projects.tsv"]}' \
  >"${stage_path}/manifest.json"
(
  cd -- "${stage_path}"
  sha256sum manifest.json control-plane-state.tar.gz projects.tsv >SHA256SUMS
)
find "${stage_path}" -type f -exec chmod 0600 {} +
if [[ "${EUID}" -eq 0 ]]; then chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${backup_root}"; fi
mv -- "${stage_path}" "${final_path}"
log "Unified conversation control-plane backup completed: ${final_path}"
warn "This mode-0700/0600 bundle contains password hashes, session state and capability tokens; encrypt it before off-host transfer."
