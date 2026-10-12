#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
umask 077

slug="${1:-}"
shift || true
confirm_slug=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirm_slug="${2:-}"; shift 2 ;;
    --help|-h)
      printf 'Usage: %s <project-slug> --confirm-maintenance-window <project-slug>\n' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${slug}" ]] || die "Project slug is required."
validate_slug "${slug}"
[[ "${confirm_slug}" == "${slug}" ]] \
  || die "A consistent project backup requires --confirm-maintenance-window ${slug}."
for command_name in docker flock git gzip jq mktemp python3 sha256sum tar; do require_command "${command_name}"; done
require_docker_access

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
upload_root="${DELIVERY_ROOT}/file-gateway/data/${slug}"
[[ -d "${project_root}" && -f "${env_file}" && -f "${compose_file}" ]] \
  || die "Project is missing or incomplete: ${project_root}"
[[ -f "${registry_file}" ]] || die "Project registry is missing."
[[ -d "${upload_root}" ]] || die "Project shared upload root is missing: ${upload_root}"
recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
prepare_delivery_lock "${recovery_lock}"
exec 8>>"${recovery_lock}"
flock --exclusive --nonblock 8 \
  || die "Another backup or restore operation already owns the project recovery lock."
# Protected recovery holds this same project lock while it owns a TaskSpace
# maintenance fence. If the worker is killed, the process lock vanishes but the
# durable fence must continue to block project-wide lifecycle mutation.
assert_project_taskspace_mutation_fences_committed "${project_root}" "${slug}"
[[ -z "$(project_git_readonly "${project_root}/workspace" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Integration workspace must be clean before backup."
[[ ! -d "${project_root}/taskspaces/.broker/release.lock" ]] \
  || die "A project release lock exists; backup did not stop any service."
if [[ -f "${ops_root}/release-state.json" ]] \
  && [[ "$(jq -r '.status // ""' "${ops_root}/release-state.json")" == running ]]; then
  die "Release Runner reports an active job; backup did not stop any service."
fi

env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}
compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}
registry_field() {
  local field="$1"
  awk -F '\t' -v value="${slug}" -v field="${field}" \
    'NR > 1 && $1 == value {print $field; found=1; exit} END {exit !found}' "${registry_file}"
}

mysql_database="$(registry_field 9)"
mysql_test_database="$(registry_field 10)"
redis_database="$(registry_field 11)"
redis_test_database="$(registry_field 12)"
shared_env="$(env_value SHARED_SERVICES_ENV_FILE)"
operator_image="$(env_value RELEASE_DB_OPERATOR_IMAGE)"
harness_image="$(env_value HARNESS_IMAGE)"
compose_project="$(env_value COMPOSE_PROJECT_NAME)"
[[ "${mysql_database}" =~ ^[a-z0-9_]{1,64}$ && "${mysql_test_database}" == "${mysql_database}_test" ]] \
  || die "Registered MySQL identity is invalid."
[[ "${redis_database}" =~ ^([0-9]|1[0-5])$ && "${redis_test_database}" =~ ^([0-9]|1[0-5])$ ]] \
  || die "Registered Redis identity is invalid."
[[ "${compose_project}" == "forge-${slug}" ]] || die "Compose identity does not match the project slug."
[[ -f "${shared_env}" ]] || die "Shared-service credentials are unavailable."
[[ "${operator_image}" =~ @sha256:[a-f0-9]{64}$ ]] || die "MySQL operator image is not digest pinned."
[[ -n "${harness_image}" ]] || die "Harness image is missing from project configuration."

mapfile -t running_services < <(compose ps --status running --services | sort -u)
active_taskspaces=()
shopt -s nullglob
for metadata in "${project_root}/taskspaces"/*/metadata.json; do
  if [[ "$(jq -r '.status' "${metadata}")" == active ]]; then
    active_taskspaces+=("$(basename -- "$(dirname -- "${metadata}")")")
  fi
done
shopt -u nullglob

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
backup_root="${DELIVERY_ROOT}/backups/${slug}"
stage_path="${backup_root}/${timestamp}.incomplete"
final_path="${backup_root}/${timestamp}"
[[ ! -e "${stage_path}" && ! -e "${final_path}" ]] || die "Backup target already exists."
mkdir -p -- "${backup_root}"
chmod 0700 "${backup_root}"
mkdir -m 0700 -- "${stage_path}"

services_stopped=false
resume_runtime() {
  local status=$?
  trap - EXIT
  if [[ "${services_stopped}" == true ]]; then
    if ((${#running_services[@]} > 0)); then
      compose up --detach --no-build "${running_services[@]}" >/dev/null 2>&1 \
        || warn "Backup runtime resume could not restart every project service."
    fi
    for task_id in "${active_taskspaces[@]}"; do
      bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" start "${task_id}" >/dev/null 2>&1 \
        || warn "Backup runtime resume could not restart TaskSpace ${task_id}."
    done
  fi
  if ((status != 0)); then
    warn "Backup failed; incomplete evidence remains at ${stage_path}."
  fi
  exit "${status}"
}
trap resume_runtime EXIT

for task_id in "${active_taskspaces[@]}"; do
  bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" stop "${task_id}"
done
if ((${#running_services[@]} > 0)); then compose stop "${running_services[@]}"; fi
services_stopped=true

mysql_dump() {
  local database="$1" output="$2"
  docker run --rm --network host --env-file "${shared_env}" --env "BACKUP_DATABASE=${database}" --entrypoint sh "${operator_image}" -c \
    'h=$(printf %s "$MYSQL_HOST" | tr -d "'\''\""); p=$(printf %s "$MYSQL_PORT" | tr -d "'\''\""); u=$(printf %s "$MYSQL_USER" | tr -d "'\''\""); pw=$(printf %s "$MYSQL_PASSWORD" | tr -d "'\''\""); export MYSQL_PWD="$pw"; exec mysqldump --protocol=TCP -h "$h" -P "$p" -u "$u" --single-transaction --quick --routines --events --triggers --hex-blob --set-gtid-purged=OFF --no-tablespaces --add-drop-table "$BACKUP_DATABASE"' \
    | gzip -9 >"${output}"
  gzip -t "${output}"
}

log "Dumping the registered main and test schemas while the project is quiesced."
mysql_dump "${mysql_database}" "${stage_path}/mysql-main.sql.gz"
mysql_dump "${mysql_test_database}" "${stage_path}/mysql-test.sql.gz"

set -a
# shellcheck disable=SC1090
source "${shared_env}"
set +a
log "Archiving only the two registered Redis logical databases."
python3 "${SCRIPT_DIR}/redis-logical-state.py" backup --database "${redis_database}" \
  --output "${stage_path}/redis-runtime.jsonl" >"${stage_path}/redis-runtime-summary.json"
python3 "${SCRIPT_DIR}/redis-logical-state.py" backup --database "${redis_test_database}" \
  --output "${stage_path}/redis-test.jsonl" >"${stage_path}/redis-test-summary.json"

log "Archiving the complete project bind-state and project-owned shared uploads."
tar --acls --xattrs --numeric-owner --create --gzip \
  --exclude='*.sock' \
  --file "${stage_path}/project-state.tar.gz" --directory "${project_root}" .
tar --acls --xattrs --numeric-owner --create --gzip \
  --file "${stage_path}/shared-uploads.tar.gz" --directory "${upload_root}" .

crypto_volume="${compose_project}_crypto-secrets"
docker volume inspect "${crypto_volume}" >/dev/null 2>&1 || die "Project crypto volume is missing: ${crypto_volume}"
docker run --rm --user 0:0 --mount "type=volume,source=${crypto_volume},target=/source,readonly" \
  --mount "type=bind,source=${stage_path},target=/backup" --entrypoint sh "${harness_image}" \
  -c 'exec tar -C /source -czf /backup/crypto-secrets.tar.gz .'

running_json="$(printf '%s\n' "${running_services[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
tasks_json="$(printf '%s\n' "${active_taskspaces[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
registry_row="$(awk -F '\t' -v value="${slug}" 'NR > 1 && $1 == value {print; exit}' "${registry_file}")"
git_head="$(project_git_readonly "${project_root}/workspace" rev-parse 'HEAD^{commit}')"
manifest_temp="$(mktemp "${stage_path}/.manifest.XXXXXX")"
jq --null-input \
  --arg projectSlug "${slug}" --arg createdAt "$(date --iso-8601=seconds)" \
  --arg gitHead "${git_head}" --arg registryRow "${registry_row}" \
  --arg mysqlMain "${mysql_database}" --arg mysqlTest "${mysql_test_database}" \
  --argjson redisRuntime "${redis_database}" --argjson redisTest "${redis_test_database}" \
  --arg cryptoVolume "${crypto_volume}" --argjson runningServices "${running_json}" \
  --argjson activeTaskspaces "${tasks_json}" \
  '{schemaVersion:1,projectSlug:$projectSlug,createdAt:$createdAt,gitHead:$gitHead,registryRow:$registryRow,databases:{main:$mysqlMain,test:$mysqlTest},redis:{runtime:$redisRuntime,test:$redisTest},cryptoVolume:$cryptoVolume,runtimeBefore:{services:$runningServices,activeTaskspaces:$activeTaskspaces},rebuildableState:{taskspaceCacheVolumes:"not-backed-up; recreated on demand",runtimeSockets:"not-backed-up; recreated by services"},payloads:["project-state.tar.gz","shared-uploads.tar.gz","mysql-main.sql.gz","mysql-test.sql.gz","redis-runtime.jsonl","redis-test.jsonl","redis-runtime-summary.json","redis-test-summary.json","crypto-secrets.tar.gz"]}' \
  >"${manifest_temp}"
mv -- "${manifest_temp}" "${stage_path}/manifest.json"
(
  cd -- "${stage_path}"
  sha256sum manifest.json project-state.tar.gz shared-uploads.tar.gz mysql-main.sql.gz mysql-test.sql.gz \
    redis-runtime.jsonl redis-test.jsonl redis-runtime-summary.json redis-test-summary.json crypto-secrets.tar.gz \
    >SHA256SUMS
)
find "${stage_path}" -type f -exec chmod 0600 {} +
if [[ "${EUID}" -eq 0 ]]; then chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${backup_root}"; fi
mv -- "${stage_path}" "${final_path}"
log "Consistent project recovery bundle completed: ${final_path}"
warn "The mode-0700/0600 bundle contains project credentials and data. Encrypt it before any off-host transfer."
