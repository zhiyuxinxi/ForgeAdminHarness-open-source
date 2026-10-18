#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

[[ "${EUID}" -eq 0 ]] || die "bootstrap-host.sh must run as root (for example: sudo bash scripts/bootstrap-host.sh)."

require_command git
require_command flock
require_command openssl
require_command ss
require_command python3
require_command sysctl
require_docker_access

getent passwd "${DELIVERY_OWNER}" >/dev/null \
  || die "Configured owner does not exist: ${DELIVERY_OWNER}"

if ! getent group "${DELIVERY_GROUP}" >/dev/null; then
  groupadd --system "${DELIVERY_GROUP}"
  log "Created group ${DELIVERY_GROUP}"
fi

if ! id -nG "${DELIVERY_OWNER}" | tr ' ' '\n' | grep -Fxq "${DELIVERY_GROUP}"; then
  usermod --append --groups "${DELIVERY_GROUP}" "${DELIVERY_OWNER}"
  warn "Added ${DELIVERY_OWNER} to ${DELIVERY_GROUP}; a new login is required before the membership is active."
fi

install -d -m 0750 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${DELIVERY_ROOT}" \
  "${DELIVERY_ROOT}/baselines" \
  "${DELIVERY_ROOT}/projects" \
  "${DELIVERY_ROOT}/registry" \
  "${DELIVERY_ROOT}/conversation-control-plane"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${DELIVERY_ROOT}/backups" \
  "${DELIVERY_ROOT}/file-gateway" \
  "${DELIVERY_ROOT}/file-gateway/state" \
  "${DELIVERY_ROOT}/file-gateway/backups" \
  "${DELIVERY_ROOT}/conversation-control-plane/state" \
  "${DELIVERY_ROOT}/conversation-control-plane/ipc" \
  "${DELIVERY_ROOT}/conversation-control-plane/auth-ipc" \
  "${DELIVERY_ROOT}/conversation-control-plane/projects"
install -d -m 0750 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${DELIVERY_ROOT}/file-gateway/data"
install -d -m 0700 -o root -g root \
  "${DELIVERY_ROOT}/secrets"
repair_harness_deepseek_secret_access

registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
taskspace_registry_file="${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
taskspaces_lock_file="${DELIVERY_ROOT}/registry/taskspaces.lock"
registry_header='slug\tdisplay_name\tui_port\tharness_port\tforge_ref\tforge_commit\tcreated_at\tproject_kind\tmysql_database\tmysql_test_database\tredis_database\tredis_test_database'
legacy_registry_header='slug\tdisplay_name\tui_port\tharness_port\tforge_ref\tforge_commit\tcreated_at\tproject_kind\tmysql_database\tmysql_test_database\tredis_database'
if [[ ! -f "${registry_file}" ]]; then
  printf '%b\n' "${registry_header}" >"${registry_file}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${registry_file}"
  chmod 0640 "${registry_file}"
else
  current_header="$(head -n 1 "${registry_file}")"
  if [[ "${current_header}" == "$(printf '%b' "${legacy_registry_header}")" ]]; then
    registry_temp="$(mktemp "${DELIVERY_ROOT}/registry/.projects.tsv.XXXXXX")"
    awk 'NR == 1 {print $0 "\tredis_test_database"; next} {print $0 "\t"}' \
      "${registry_file}" >"${registry_temp}"
    chown --reference="${registry_file}" "${registry_temp}"
    chmod --reference="${registry_file}" "${registry_temp}"
    mv -- "${registry_temp}" "${registry_file}"
    log "Extended the project registry with a dedicated Redis test database column."
  elif [[ "${current_header}" != "$(printf '%b' "${registry_header}")" ]]; then
    die "Project registry header is not a recognized platform version."
  fi
fi

if [[ ! -f "${taskspace_registry_file}" ]]; then
  printf 'project_slug\ttask_id\tharness_port\tcreated_at\n' >"${taskspace_registry_file}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${taskspace_registry_file}"
  chmod 0660 "${taskspace_registry_file}"
fi
if [[ ! -f "${taskspaces_lock_file}" ]]; then
  : >"${taskspaces_lock_file}"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${taskspaces_lock_file}"
  chmod 0660 "${taskspaces_lock_file}"
fi

if [[ -f /var/run/reboot-required ]]; then
  warn "The host reports that a reboot is required. Schedule maintenance before production use."
fi

python3 "${SCRIPT_DIR}/configure-host-inotify.py" apply \
  --backup-dir "${DELIVERY_ROOT}/backups/host-inotify-capacity"

log "Host directories are ready under ${DELIVERY_ROOT}."
log "Docker group membership was intentionally not granted; the Docker socket is root-equivalent."
