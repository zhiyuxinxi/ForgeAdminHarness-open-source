#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

: "${PLAYBOOK_BIND_ADDRESS:=${DEFAULT_BIND_ADDRESS}}"
: "${PLAYBOOK_HTTP_PORT:=15080}"
: "${PLAYBOOK_IMAGE:?PLAYBOOK_IMAGE is required}"
: "${PLAYBOOK_NODE_IMAGE:?PLAYBOOK_NODE_IMAGE is required}"
: "${PLAYBOOK_NGINX_IMAGE:?PLAYBOOK_NGINX_IMAGE is required}"
export PLAYBOOK_BIND_ADDRESS PLAYBOOK_HTTP_PORT

portal_root="${DELIVERY_ROOT}/playbook-portal"
portal_env="${portal_root}/playbook.env"
compose_file="${REPO_ROOT}/templates/playbook-portal/compose.yaml"
dockerfile="${REPO_ROOT}/docker/playbook-portal/Dockerfile"

usage() {
  printf '%s\n' \
    "Usage: $0 <command>" \
    "" \
    "Commands:" \
    "  bootstrap  Build the current playbook image, start it and verify health" \
    "  build      Build a versioned image and record its immutable local image ID" \
    "  validate   Validate bind address, port, files, image receipt and Compose" \
    "  up         Start the previously built immutable image" \
    "  down       Stop the portal; no playbook source or project data is removed" \
    "  status     Show the portal container status" \
    "  logs       Show the last 200 portal log lines" \
    "  access     Print the VPN-only portal address"
}

require_owner_or_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi
  [[ "$(id -un)" == "${DELIVERY_OWNER}" ]] \
    || die "Run as root or the configured delivery owner ${DELIVERY_OWNER}."
}

install_portal_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${portal_root}"
  else
    install -d -m 0700 "${portal_root}"
  fi
}

source_hash() {
  require_command find
  require_command sha256sum
  (
    cd -- "${REPO_ROOT}"
    find \
      playbook-portal \
      docs/ai-delivery-playbook \
      docker/playbook-portal \
      templates/playbook-portal \
      -type f ! -path '*/node_modules/*' ! -path '*/dist/*' -print0 \
      | sort -z \
      | xargs -0 sha256sum
    sha256sum DESIGN.md UX-CONTRACT.md premium-ui.json
  ) | sha256sum | awk '{print $1}'
}

load_portal_env() {
  [[ -f "${portal_env}" ]] || die "Playbook portal has not been built: ${portal_env}"
  # The receipt contains no secret, but mode 0600 prevents accidental edits.
  # shellcheck disable=SC1090
  set -a
  source "${portal_env}"
  set +a
}

compose() {
  docker compose --env-file "${portal_env}" --file "${compose_file}" "$@"
}

write_portal_env() {
  local image_id="$1"
  local revision="$2"
  local temp_file
  temp_file="$(mktemp "${portal_root}/.playbook.env.XXXXXX")"
  chmod 0600 "${temp_file}"
  printf '%s\n' \
    "PLAYBOOK_IMAGE=${PLAYBOOK_IMAGE}" \
    "PLAYBOOK_RUNTIME_IMAGE=${image_id}" \
    "PLAYBOOK_SOURCE_HASH=${revision}" \
    "PLAYBOOK_BIND_ADDRESS=${PLAYBOOK_BIND_ADDRESS}" \
    "PLAYBOOK_HTTP_PORT=${PLAYBOOK_HTTP_PORT}" >"${temp_file}"
  mv -f -- "${temp_file}" "${portal_env}"
  chmod 0600 "${portal_env}"
  if [[ "${EUID}" -eq 0 ]]; then
    chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${portal_env}"
  fi
}

verify_runtime_image() {
  local image_id="$1"
  local expected_revision="$2"
  local actual_revision
  docker image inspect "${image_id}" >/dev/null 2>&1 \
    || die "Recorded playbook image is absent: ${image_id}. Run build first."
  actual_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_id}")"
  [[ "${actual_revision}" == "${expected_revision}" ]] \
    || die "Playbook image revision mismatch: expected ${expected_revision}, got ${actual_revision}."
}

build_portal() {
  local revision image_id
  require_owner_or_root
  require_docker_access
  require_command awk
  require_command xargs
  install_portal_root
  revision="$(source_hash)"
  log "Building playbook portal revision ${revision}."
  docker build \
    --build-arg "NODE_IMAGE=${PLAYBOOK_NODE_IMAGE}" \
    --build-arg "NGINX_IMAGE=${PLAYBOOK_NGINX_IMAGE}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "SOURCE_REVISION=${revision}" \
    --file "${dockerfile}" \
    --tag "${PLAYBOOK_IMAGE}" \
    "${REPO_ROOT}"
  image_id="$(docker image inspect --format '{{.Id}}' "${PLAYBOOK_IMAGE}")"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Built playbook image did not return an immutable image ID."
  verify_runtime_image "${image_id}" "${revision}"
  write_portal_env "${image_id}" "${revision}"
  log "Recorded immutable playbook image ${image_id}."
}

validate_portal() {
  require_owner_or_root
  validate_port "${PLAYBOOK_HTTP_PORT}"
  [[ "${PLAYBOOK_BIND_ADDRESS}" == "${DEFAULT_BIND_ADDRESS}" ]] \
    || die "Playbook portal must use the reviewed VPN bind address ${DEFAULT_BIND_ADDRESS}."
  [[ "${PLAYBOOK_NODE_IMAGE}" =~ ^.+@sha256:[0-9a-f]{64}$ ]] \
    || die "PLAYBOOK_NODE_IMAGE must be pinned by a valid sha256 manifest digest."
  [[ "${PLAYBOOK_NGINX_IMAGE}" =~ ^.+@sha256:[0-9a-f]{64}$ ]] \
    || die "PLAYBOOK_NGINX_IMAGE must be pinned by a valid sha256 manifest digest."
  [[ -f "${compose_file}" ]] || die "Missing Compose template: ${compose_file}"
  [[ -f "${dockerfile}" ]] || die "Missing portal Dockerfile: ${dockerfile}"
  [[ -f "${REPO_ROOT}/playbook-portal/pnpm-lock.yaml" ]] \
    || die "Missing playbook package lock."
  if [[ -f "${portal_env}" ]]; then
    local mode
    mode="$(stat -c '%a' "${portal_env}")"
    [[ "${mode}" == '600' ]] || die "Expected mode 0600 for ${portal_env}, got ${mode}."
    require_docker_access
    load_portal_env
    verify_runtime_image "${PLAYBOOK_RUNTIME_IMAGE}" "${PLAYBOOK_SOURCE_HASH}"
    compose config --quiet
  fi
  log "Playbook portal validation passed."
}

wait_for_portal() {
  local attempt
  for attempt in {1..30}; do
    if compose exec -T portal wget -q -O /dev/null http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  compose ps >&2 || true
  die "Playbook portal did not become healthy within 60 seconds."
}

command_name="${1:-}"
case "${command_name}" in
  bootstrap)
    build_portal
    load_portal_env
    compose up --detach
    wait_for_portal
    log "Playbook portal bootstrap completed."
    printf 'Playbook portal: http://%s:%s\n' "${PLAYBOOK_BIND_ADDRESS}" "${PLAYBOOK_HTTP_PORT}"
    ;;
  build)
    build_portal
    ;;
  validate)
    validate_portal
    ;;
  up)
    require_owner_or_root
    require_docker_access
    load_portal_env
    verify_runtime_image "${PLAYBOOK_RUNTIME_IMAGE}" "${PLAYBOOK_SOURCE_HASH}"
    compose up --detach
    wait_for_portal
    ;;
  down)
    require_owner_or_root
    require_docker_access
    load_portal_env
    compose down
    warn "Playbook portal stopped; source documents and project data were not removed."
    ;;
  status)
    require_docker_access
    load_portal_env
    compose ps
    ;;
  logs)
    require_docker_access
    load_portal_env
    compose logs --tail 200 portal
    ;;
  access)
    printf 'Playbook portal: http://%s:%s\n' "${PLAYBOOK_BIND_ADDRESS}" "${PLAYBOOK_HTTP_PORT}"
    ;;
  --help|-h|help|'') usage ;;
  *) usage >&2; die "Unknown command: ${command_name}" ;;
esac
