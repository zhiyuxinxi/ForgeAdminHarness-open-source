#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() {
  printf '%s\n' \
    "Usage: $0 <command>" \
    "" \
    "Commands:" \
    "  prepare   Create capability/state paths, migrate project account stores, and validate Compose" \
    "  up        Start or update the unified project directory on the fixed platform port" \
    "  down      Stop the unified entry while preserving account/conversation state" \
    "  status    Show container and HTTP health" \
    "  config    Render and validate the resolved Compose model"
}

action="${1:-}"
[[ -n "${action}" && $# -eq 1 ]] || { usage >&2; exit 2; }
for command_name in docker jq openssl; do require_command "${command_name}"; done
require_docker_access
validate_port "${CONVERSATION_GATEWAY_PORT}"
[[ "${CONVERSATION_GATEWAY_BIND_ADDRESS}" =~ ^[0-9a-fA-F:.]+$ ]] \
  || die "CONVERSATION_GATEWAY_BIND_ADDRESS must be an IP literal."

control_root="${DELIVERY_ROOT}/conversation-control-plane"
state_root="${control_root}/state"
ipc_root="${control_root}/ipc"
auth_ipc_root="${control_root}/auth-ipc"
projects_root="${control_root}/projects"
maintenance_root="${control_root}/maintenance"
maintenance_fence="${maintenance_root}/gateway-fence.json"
operator_token="${control_root}/operator-token"
control_env="${control_root}/control-plane.env"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
compose_file="${REPO_ROOT}/templates/conversation-control-plane/compose.yaml"
harness_image_id=''
control_plane_project_name="$(control_plane_compose_project_name "${control_env}")"
canonical_project="${CONVERSATION_CONTROL_PLANE_CANONICAL_PROJECT:-forge-base}"
validate_slug "${canonical_project}"

resolve_harness_runtime() {
  if [[ -z "${harness_image_id}" ]]; then
    harness_image_id="$(resolve_configured_harness_image_id)"
  fi
}

verify_control_env_harness_identity() {
  local persisted_image persisted_source
  resolve_harness_runtime
  persisted_image="$(awk -F= '$1 == "HARNESS_IMAGE" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1) print value; else exit 1}' "${control_env}")" \
    || die "Control-plane environment has no unique Harness image identity."
  persisted_source="$(awk -F= '$1 == "HARNESS_IMAGE_SOURCE" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1) print value; else exit 1}' "${control_env}")" \
    || die "Control-plane environment has no unique Harness source reference."
  [[ "${persisted_image}" == "${harness_image_id}" && "${persisted_source}" == "${HARNESS_IMAGE}" ]] \
    || die "Control-plane environment is not bound to the verified baseline Harness image ID; run '$0 prepare'."
}

compose() {
  local -a compose_args=(--project-name "${control_plane_project_name}" --env-file "${control_env}" --file "${compose_file}")
  local delivery_env="${control_root}/delivery-center/runtime.env"
  if [[ -f "${delivery_env}" ]]; then
    compose_args+=(--env-file "${delivery_env}" --file "${REPO_ROOT}/templates/conversation-control-plane/compose.delivery-center.yaml")
  fi
  docker compose "${compose_args[@]}" "$@"
}

run_migration() {
  local host_uid host_gid
  resolve_harness_runtime
  host_uid="$(id -u "${DELIVERY_OWNER}")"
  host_gid="$(getent group "${DELIVERY_GROUP}" | cut -d: -f3)"
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "${host_uid}:${host_gid}" \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --volume "${REPO_ROOT}/scripts:/opt/forge-tools:ro" \
    --volume "${REPO_ROOT}/docker/harness:/opt/docker/harness:ro" \
    --volume "${DELIVERY_ROOT}/registry:${DELIVERY_ROOT}/registry:ro" \
    --volume "${DELIVERY_ROOT}/projects:${DELIVERY_ROOT}/projects:ro" \
    --volume "${state_root}:${state_root}:rw" \
    --entrypoint node \
    "${harness_image_id}" \
    /opt/forge-tools/migrate-conversation-control-plane.mjs \
      --delivery-root "${DELIVERY_ROOT}" \
      --target-state-root "${state_root}" \
      --canonical-project "${canonical_project}"
}

write_control_env() {
  local host_uid host_gid temporary
  resolve_harness_runtime
  host_uid="$(id -u "${DELIVERY_OWNER}")"
  host_gid="$(getent group "${DELIVERY_GROUP}" | cut -d: -f3)"
  temporary="${control_env}.tmp.$$"
  umask 077
  printf '%s\n' \
    "CONVERSATION_CONTROL_PLANE_ROOT=${control_root}" \
    "CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=${control_plane_project_name}" \
    "CONVERSATION_GATEWAY_BIND_ADDRESS=${CONVERSATION_GATEWAY_BIND_ADDRESS}" \
    "CONVERSATION_GATEWAY_PORT=${CONVERSATION_GATEWAY_PORT}" \
    "CONVERSATION_GATEWAY_COOKIE_SECURE=false" \
    "PLATFORM_PROJECT_REGISTRY_FILE=${registry_file}" \
    "HARNESS_IMAGE=${harness_image_id}" \
    "HARNESS_IMAGE_SOURCE=${HARNESS_IMAGE}" \
    "HOST_UID=${host_uid}" \
    "HOST_GID=${host_gid}" \
    "TZ=Asia/Shanghai" >"${temporary}"
  chmod 0600 "${temporary}"
  if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; fi
  mv -- "${temporary}" "${control_env}"
}

ensure_gateway_fence() {
  local temporary epoch
  [[ ! -L "${maintenance_root}" && ! -L "${maintenance_fence}" ]] \
    || die "Conversation Gateway maintenance fence path is unsafe."
  install -d -m 0755 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${maintenance_root}"
  if [[ -e "${maintenance_fence}" ]]; then
    [[ -f "${maintenance_fence}" ]] \
      && jq -e '
        type == "object"
        and (keys | sort) == ["epoch", "schemaVersion", "state"]
        and .schemaVersion == 1
        and (.state == "maintenance" or .state == "committed")
        and (.epoch | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))
      ' "${maintenance_fence}" >/dev/null \
      || die "Conversation Gateway maintenance fence is invalid and was not overwritten."
    return 0
  fi
  epoch="bootstrap-$(date -u +%Y%m%dT%H%M%SZ)"
  temporary="${maintenance_root}/.gateway-fence.$$"
  (umask 022; jq --null-input --arg epoch "${epoch}" \
    '{schemaVersion: 1, state: "committed", epoch: $epoch}' >"${temporary}")
  chmod 0644 "${temporary}"
  if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; fi
  mv -- "${temporary}" "${maintenance_fence}"
}

prepare_paths() {
  install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
    "${control_root}" "${state_root}" "${ipc_root}" "${auth_ipc_root}" "${projects_root}"
  ensure_gateway_fence
  if [[ ! -f "${operator_token}" ]]; then
    umask 077
    openssl rand -hex 32 >"${operator_token}"
    chmod 0600 "${operator_token}"
    if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${operator_token}"; fi
  fi
  while IFS=$'\t' read -r slug _; do
    [[ "${slug}" == slug ]] && continue
    validate_slug "${slug}"
    local capability_root="${projects_root}/${slug}"
    install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${capability_root}" "${capability_root}/ipc"
    if [[ ! -f "${capability_root}/manager-token" ]]; then
      local legacy_token="${DELIVERY_ROOT}/projects/${slug}/ops/conversation-manager-token"
      [[ -f "${legacy_token}" ]] || die "Manager token is missing for registered project ${slug}."
      install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${legacy_token}" "${capability_root}/manager-token"
    fi
  done <"${registry_file}"
  write_control_env
}

case "${action}" in
  prepare)
    prepare_paths
    run_migration | jq .
    chmod 0600 "${state_root}/state.json" "${state_root}/audit.jsonl"
    if [[ "${EUID}" -eq 0 ]]; then
      chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${state_root}/state.json" "${state_root}/audit.jsonl"
    fi
    compose config --quiet
    log "Unified conversation control plane is prepared; all migrated browser sessions were revoked."
    ;;
  up)
    [[ -f "${control_env}" && -f "${state_root}/state.json" ]] \
      || die "Run '$0 prepare' before starting the unified entry."
    verify_control_env_harness_identity
    compose config --quiet
    compose up --detach
    log "Unified project directory: http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/forge-gateway/"
    ;;
  down)
    [[ -f "${control_env}" ]] || die "Control-plane environment is missing."
    compose down --remove-orphans
    log "Unified entry stopped; account, membership, conversation and audit state was preserved."
    ;;
  status)
    [[ -f "${control_env}" ]] || die "Control-plane environment is missing."
    compose ps --all
    curl --silent --show-error --max-time 5 \
      "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" | jq .
    ;;
  config)
    [[ -f "${control_env}" ]] || { prepare_paths; }
    verify_control_env_harness_identity
    compose config
    ;;
  *)
    usage >&2
    die "Unknown command: ${action}"
    ;;
esac
