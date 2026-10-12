#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

: "${FILE_GATEWAY_BIND_ADDRESS:?FILE_GATEWAY_BIND_ADDRESS is required}"
: "${FILE_GATEWAY_HTTP_PORT:?FILE_GATEWAY_HTTP_PORT is required}"
: "${FILE_GATEWAY_SFTP_PORT:?FILE_GATEWAY_SFTP_PORT is required}"
: "${FILE_GATEWAY_ADMIN_USERNAME:?FILE_GATEWAY_ADMIN_USERNAME is required}"
: "${FILE_GATEWAY_BOOTSTRAP_USERS:?FILE_GATEWAY_BOOTSTRAP_USERS is required}"
: "${SFTPGO_IMAGE:?SFTPGO_IMAGE is required}"
: "${SFTPGO_IMAGE_ID:?SFTPGO_IMAGE_ID is required}"
: "${SFTPGO_ROOTFS_FINGERPRINT:?SFTPGO_ROOTFS_FINGERPRINT is required}"

gateway_root="${DELIVERY_ROOT}/file-gateway"
data_root="${gateway_root}/data"
state_root="${gateway_root}/state"
backup_root="${gateway_root}/backups"
gateway_env="${gateway_root}/file-gateway.env"
credential_receipt="${gateway_root}/bootstrap-credentials.txt"
compose_file="${REPO_ROOT}/templates/file-gateway/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
upload_group='forge-all-projects-upload'

usage() {
  printf '%s\n' \
    "Usage: $0 <command> [arguments]" \
    "" \
    "Commands:" \
    "  bootstrap                 Create state, sync projects, start SFTPGo and create initial users" \
    "  sync-projects             Add missing registered project upload directories and group permissions" \
    "  add-user <username>       Create one upload user with a generated password" \
    "  validate                  Validate configuration, paths, permissions and Compose interpolation" \
    "  up | down | status | logs Manage the shared file gateway; down preserves all data" \
    "  access                    Print the VPN-only WebAdmin, WebClient and SFTP addresses"
}

require_owner_or_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi
  [[ "$(id -un)" == "${DELIVERY_OWNER}" ]] \
    || die "Run as root or the configured delivery owner ${DELIVERY_OWNER}."
}

install_owned_dir() {
  local mode="$1"
  local path="$2"
  if [[ "${EUID}" -eq 0 ]]; then
    install -d -m "${mode}" -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${path}"
  else
    install -d -m "${mode}" "${path}"
  fi
}

load_gateway_env() {
  [[ -f "${gateway_env}" ]] || die "File gateway is not bootstrapped: ${gateway_env}"
  # This owner-managed 0600 file contains generated bootstrap credentials.
  # shellcheck disable=SC1090
  set -a
  source "${gateway_env}"
  set +a
  # Docker image IDs can be represented differently by different image stores.
  # Select and verify the locally present image, then run its immutable local ID.
  select_runtime_image || export SFTPGO_RUNTIME_IMAGE="${SFTPGO_IMAGE_ID}"
}

compose() {
  docker compose --env-file "${gateway_env}" --file "${compose_file}" "$@"
}

registered_projects() {
  [[ -f "${registry_file}" ]] || die "Project registry is missing: ${registry_file}"
  awk -F '\t' 'NR > 1 && $1 != "" {print $1}' "${registry_file}"
}

sync_project_directories() {
  local slug
  local count=0
  while IFS= read -r slug; do
    validate_slug "${slug}"
    install_owned_dir 0750 "${data_root}/${slug}"
    count=$((count + 1))
  done < <(registered_projects)
  ((count > 0)) || die "No registered projects were found in ${registry_file}."
  log "Synchronized ${count} project upload directories under ${data_root}."
}

write_gateway_env() {
  [[ ! -e "${gateway_env}" ]] || return 0
  local owner_uid owner_gid admin_password previous_umask
  owner_uid="$(id -u "${DELIVERY_OWNER}")"
  owner_gid="$(getent group "${DELIVERY_GROUP}" | cut -d: -f3)"
  [[ -n "${owner_gid}" ]] || die "Configured group does not exist: ${DELIVERY_GROUP}"
  admin_password="$(generate_secret)"
  previous_umask="$(umask)"
  umask 077
  printf '%s\n' \
    "SFTPGO_IMAGE=${SFTPGO_IMAGE}" \
    "SFTPGO_RUNTIME_IMAGE=${SFTPGO_IMAGE_ID}" \
    "FILE_GATEWAY_BIND_ADDRESS=${FILE_GATEWAY_BIND_ADDRESS}" \
    "FILE_GATEWAY_HTTP_PORT=${FILE_GATEWAY_HTTP_PORT}" \
    "FILE_GATEWAY_SFTP_PORT=${FILE_GATEWAY_SFTP_PORT}" \
    "FILE_GATEWAY_UID=${owner_uid}" \
    "FILE_GATEWAY_GID=${owner_gid}" \
    "FILE_GATEWAY_DATA_ROOT=${data_root}" \
    "FILE_GATEWAY_STATE_ROOT=${state_root}" \
    "FILE_GATEWAY_BACKUP_ROOT=${backup_root}" \
    "FILE_GATEWAY_ENDPOINT=http://${FILE_GATEWAY_BIND_ADDRESS}:${FILE_GATEWAY_HTTP_PORT}" \
    "SFTPGO_DEFAULT_ADMIN_USERNAME=${FILE_GATEWAY_ADMIN_USERNAME}" \
    "SFTPGO_DEFAULT_ADMIN_PASSWORD=${admin_password}" \
    "TZ=Asia/Shanghai" >"${gateway_env}"
  printf '%s\t%s\t%s\n' \
    'account_type' 'username' 'one_time_password' >"${credential_receipt}"
  printf '%s\t%s\t%s\n' \
    'admin' "${FILE_GATEWAY_ADMIN_USERNAME}" "${admin_password}" >>"${credential_receipt}"
  umask "${previous_umask}"
  chmod 0600 "${gateway_env}" "${credential_receipt}"
  if [[ "${EUID}" -eq 0 ]]; then
    chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${gateway_env}" "${credential_receipt}"
  fi
  log "Generated the file gateway environment and protected credential receipt."
}

ensure_image() {
  if select_runtime_image; then
    return
  fi
  log "Pinned SFTPGo image is absent; attempting an exact digest pull."
  docker pull "${SFTPGO_IMAGE}" \
    || die "Unable to pull ${SFTPGO_IMAGE}. Import the pinned image offline, then retry."
  select_runtime_image \
    || die "The pulled SFTPGo image failed immutable content verification."
}

verify_runtime_image() {
  local candidate="$1"
  local revision rootfs_hash
  require_command awk
  require_command sha256sum
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${candidate}")"
  [[ "${revision}" == "${SFTPGO_COMMIT}" ]] \
    || die "SFTPGo image revision mismatch for ${candidate}: expected ${SFTPGO_COMMIT}, got ${revision}."
  rootfs_hash="$(docker image inspect --format '{{json .RootFS.Layers}}' "${candidate}" \
    | sha256sum | awk '{print "sha256:" $1}')"
  [[ "${rootfs_hash}" == "${SFTPGO_ROOTFS_FINGERPRINT}" ]] \
    || die "SFTPGo root filesystem fingerprint mismatch for ${candidate}."
  export SFTPGO_RUNTIME_IMAGE
  SFTPGO_RUNTIME_IMAGE="$(docker image inspect --format '{{.Id}}' "${candidate}")"
}

select_runtime_image() {
  local tagged_image
  tagged_image="${SFTPGO_IMAGE%%@sha256:*}"
  if docker image inspect "${SFTPGO_IMAGE}" >/dev/null 2>&1; then
    verify_runtime_image "${SFTPGO_IMAGE}"
    return
  fi
  if docker image inspect "${tagged_image}" >/dev/null 2>&1; then
    verify_runtime_image "${tagged_image}"
    return
  fi
  return 1
}

wait_for_gateway() {
  local attempt
  for attempt in {1..30}; do
    if compose exec -T sftpgo sftpgo ping >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  compose ps >&2 || true
  die "SFTPGo did not become ready within 60 seconds."
}

sync_upload_group() {
  local -a projects=()
  mapfile -t projects < <(registered_projects)
  ((${#projects[@]} > 0)) || die "Cannot create upload group without registered projects."
  python3 "${SCRIPT_DIR}/file_gateway_admin.py" sync-group \
    --group "${upload_group}" --projects "${projects[@]}"
}

append_user_credential() {
  local username="$1"
  local password="$2"
  printf '%s\t%s\t%s\n' 'user' "${username}" "${password}" >>"${credential_receipt}"
  chmod 0600 "${credential_receipt}"
}

ensure_upload_user() {
  local username="$1"
  local password result
  password="$(generate_secret)"
  result="$(FILE_GATEWAY_USER_PASSWORD="${password}" \
    python3 "${SCRIPT_DIR}/file_gateway_admin.py" ensure-user \
      --username "${username}" --group "${upload_group}" \
      --description "Forge delivery VPN upload account: ${username}")"
  case "${result}" in
    created)
      append_user_credential "${username}" "${password}"
      log "Created upload user ${username}."
      ;;
    exists)
      log "Upload user ${username} already exists; password was not changed."
      ;;
    *) die "Unexpected provisioning result for ${username}: ${result}" ;;
  esac
}

bootstrap_users() {
  local username
  IFS=',' read -ra usernames <<<"${FILE_GATEWAY_BOOTSTRAP_USERS}"
  for username in "${usernames[@]}"; do
    username="${username//[[:space:]]/}"
    [[ -n "${username}" ]] || continue
    ensure_upload_user "${username}"
  done
}

validate_gateway() {
  require_owner_or_root
  require_command docker
  validate_port "${FILE_GATEWAY_HTTP_PORT}"
  validate_port "${FILE_GATEWAY_SFTP_PORT}"
  [[ "${FILE_GATEWAY_HTTP_PORT}" != "${FILE_GATEWAY_SFTP_PORT}" ]] \
    || die "File gateway HTTP and SFTP ports must differ."
  [[ "${FILE_GATEWAY_BIND_ADDRESS}" == "${DEFAULT_BIND_ADDRESS}" ]] \
    || die "File gateway must use the reviewed VPN bind address ${DEFAULT_BIND_ADDRESS}."
  [[ "${SFTPGO_IMAGE}" == *@sha256:* ]] \
    || die "SFTPGO_IMAGE must be pinned by an immutable manifest digest."
  [[ "${SFTPGO_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "SFTPGO_IMAGE_ID must be a sha256 image content ID."
  [[ "${SFTPGO_ROOTFS_FINGERPRINT}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "SFTPGO_ROOTFS_FINGERPRINT must be a sha256 root filesystem fingerprint."
  [[ -f "${compose_file}" ]] || die "Missing Compose template: ${compose_file}"
  if [[ -f "${gateway_env}" ]]; then
    local mode
    mode="$(stat -c '%a' "${gateway_env}")"
    [[ "${mode}" == '600' ]] || die "Expected mode 0600 for ${gateway_env}, got ${mode}."
    load_gateway_env
    compose config --quiet
  fi
  log "File gateway validation passed."
}

command_name="${1:-}"
case "${command_name}" in
  bootstrap)
    require_owner_or_root
    require_command awk
    require_command curl
    require_command docker
    require_command openssl
    require_command python3
    require_docker_access
    install_owned_dir 0700 "${gateway_root}"
    install_owned_dir 0750 "${data_root}"
    install_owned_dir 0700 "${state_root}"
    install_owned_dir 0700 "${backup_root}"
    sync_project_directories
    write_gateway_env
    load_gateway_env
    validate_gateway
    ensure_image
    compose up --detach
    wait_for_gateway
    sync_upload_group
    bootstrap_users
    log "File gateway bootstrap completed."
    "$0" access
    ;;
  sync-projects)
    require_owner_or_root
    require_command python3
    require_docker_access
    load_gateway_env
    sync_project_directories
    wait_for_gateway
    sync_upload_group
    ;;
  add-user)
    require_owner_or_root
    [[ -n "${2:-}" ]] || die "Usage: $0 add-user <username>"
    require_command python3
    require_docker_access
    load_gateway_env
    wait_for_gateway
    ensure_upload_user "$2"
    ;;
  validate)
    validate_gateway
    ;;
  up)
    require_owner_or_root
    require_docker_access
    load_gateway_env
    ensure_image
    compose up --detach
    wait_for_gateway
    ;;
  down)
    require_owner_or_root
    require_docker_access
    load_gateway_env
    compose down
    warn "File gateway containers stopped; state and uploaded files were preserved."
    ;;
  status)
    require_docker_access
    load_gateway_env
    compose ps
    ;;
  logs)
    require_docker_access
    load_gateway_env
    compose logs --tail 200 sftpgo
    ;;
  access)
    printf '%s\n' \
      "WebAdmin: http://${FILE_GATEWAY_BIND_ADDRESS}:${FILE_GATEWAY_HTTP_PORT}/web/admin" \
      "WebClient: http://${FILE_GATEWAY_BIND_ADDRESS}:${FILE_GATEWAY_HTTP_PORT}/web/client" \
      "SFTP: ${FILE_GATEWAY_BIND_ADDRESS}:${FILE_GATEWAY_SFTP_PORT}" \
      "Credential receipt on server: ${credential_receipt}"
    ;;
  --help|-h|help|'') usage ;;
  *) usage >&2; die "Unknown command: ${command_name}" ;;
esac
