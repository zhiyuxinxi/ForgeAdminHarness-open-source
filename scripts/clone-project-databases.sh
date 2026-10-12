#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
umask 077

usage() {
  printf '%s\n' \
    "Usage: $0 --source <registered-slug> --target <registered-slug> --confirm-target <target-slug>" \
    "" \
    "Clones the exact source main/test schemas into an empty registered target." \
    "This is a root/DBA initialization action; Harness and normal releases cannot invoke it."
}

source_slug=''
target_slug=''
confirm_target=''
while (($# > 0)); do
  case "$1" in
    --source) source_slug="${2:-}"; shift 2 ;;
    --target) target_slug="${2:-}"; shift 2 ;;
    --confirm-target) confirm_target="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

validate_slug "${source_slug}"
validate_slug "${target_slug}"
[[ "${source_slug}" != "${target_slug}" ]] || die "Source and target projects must differ."
[[ "${confirm_target}" == "${target_slug}" ]] \
  || die "--confirm-target must exactly match the target slug."
require_docker_access
for command_name in awk docker flock git jq mktemp python3; do require_command "${command_name}"; done

registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
[[ -f "${registry_file}" ]] || die "Project registry is missing."
registry_field() {
  local project_slug="$1" field="$2"
  awk -F '\t' -v value="${project_slug}" -v field="${field}" \
    'NR > 1 && $1 == value {print $field; found=1; exit} END {exit !found}' "${registry_file}"
}
source_database="$(registry_field "${source_slug}" 9)"
source_test_database="$(registry_field "${source_slug}" 10)"
target_database="$(registry_field "${target_slug}" 9)"
target_test_database="$(registry_field "${target_slug}" 10)"
source_redis="$(registry_field "${source_slug}" 11)"
source_test_redis="$(registry_field "${source_slug}" 12)"
target_redis="$(registry_field "${target_slug}" 11)"
target_test_redis="$(registry_field "${target_slug}" 12)"
for database in "${source_database}" "${source_test_database}" "${target_database}" "${target_test_database}"; do
  [[ "${database}" =~ ^[a-z0-9_]{1,64}$ ]] || die "Registry contains an invalid MySQL database name."
done
[[ "${source_test_database}" == "${source_database}_test" ]] || die "Invalid source test database identity."
[[ "${target_test_database}" == "${target_database}_test" ]] || die "Invalid target test database identity."

source_root="${DELIVERY_ROOT}/projects/${source_slug}"
target_root="${DELIVERY_ROOT}/projects/${target_slug}"
source_env="${source_root}/ops/project.env"
target_env="${target_root}/ops/project.env"
[[ -d "${source_root}/workspace/.git" && -f "${source_env}" ]] || die "Source project is incomplete."
[[ -d "${target_root}/workspace/.git" && -f "${target_env}" ]] || die "Target project is incomplete."
[[ -z "$(project_git_readonly "${source_root}/workspace" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Source workspace must be clean before database cloning."
source_head="$(project_git_readonly "${source_root}/workspace" rev-parse 'HEAD^{commit}')"
target_source_commit="$(awk -F= '$1 == "PROJECT_SOURCE_COMMIT" {sub(/^[^=]*=/, ""); print; exit}' "${target_env}")"
target_source_slug="$(awk -F= '$1 == "PROJECT_SOURCE_SLUG" {sub(/^[^=]*=/, ""); print; exit}' "${target_env}")"
[[ "${target_source_slug}" == "${source_slug}" && "${target_source_commit}" == "${source_head}" ]] \
  || die "Target project was not created from the current exact source project commit."

shared_env="$(awk -F= '$1 == "SHARED_SERVICES_ENV_FILE" {sub(/^[^=]*=/, ""); print; exit}' "${target_env}")"
operator_image="$(awk -F= '$1 == "RELEASE_DB_OPERATOR_IMAGE" {sub(/^[^=]*=/, ""); print; exit}' "${target_env}")"
[[ -f "${shared_env}" ]] || die "Shared-service credentials are unavailable."
[[ "${operator_image}" =~ @sha256:[a-f0-9]{64}$ ]] || die "MySQL client image is not digest pinned."

mysql_client() {
  docker run --rm --network host --env-file "${shared_env}" --entrypoint sh "${operator_image}" -c \
    'h=$(printf %s "$MYSQL_HOST" | tr -d "'\''\""); p=$(printf %s "$MYSQL_PORT" | tr -d "'\''\""); u=$(printf %s "$MYSQL_USER" | tr -d "'\''\""); pw=$(printf %s "$MYSQL_PASSWORD" | tr -d "'\''\""); export MYSQL_PWD="$pw"; exec mysql --protocol=TCP -h "$h" -P "$p" -u "$u" "$@"' sh "$@"
}

database_exists() {
  local database="$1"
  [[ "$(mysql_client -Nse "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='${database}'")" == 1 ]]
}
database_object_count() {
  local database="$1"
  mysql_client -Nse "SELECT (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='${database}') + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA='${database}') + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA='${database}') + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.EVENTS WHERE EVENT_SCHEMA='${database}')"
}

database_exists "${source_database}" || die "Source main database is missing: ${source_database}"
database_exists "${source_test_database}" || die "Source test database is missing: ${source_test_database}"
! database_exists "${target_database}" || die "Target main database already exists: ${target_database}"
! database_exists "${target_test_database}" || die "Target test database already exists: ${target_test_database}"

set -a
# shellcheck disable=SC1090
source "${shared_env}"
set +a
for redis_database in "${target_redis}" "${target_test_redis}"; do
  size="$(python3 "${SCRIPT_DIR}/redis-logical-state.py" size --database "${redis_database}" | jq -r '.keys')"
  [[ "${size}" == 0 ]] || die "Target Redis database ${redis_database} is not empty."
done

projects_lock="${DELIVERY_ROOT}/registry/projects.lock"
prepare_delivery_lock "${projects_lock}"
exec 9>>"${projects_lock}"
flock --exclusive 9
target_recovery_lock="${DELIVERY_ROOT}/registry/${target_slug}.recovery.lock"
prepare_delivery_lock "${target_recovery_lock}"
exec 8>>"${target_recovery_lock}"
flock --exclusive --nonblock 8 \
  || die "A backup or restore operation already owns the target project recovery lock."
[[ -z "$(project_git_readonly "${source_root}/workspace" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Source workspace changed while database initialization was waiting for the registry lock."
[[ "$(project_git_readonly "${source_root}/workspace" rev-parse 'HEAD^{commit}')" == "${source_head}" ]] \
  || die "Source HEAD changed while database initialization was waiting for the registry lock."
! database_exists "${target_database}" || die "Target main database was created concurrently."
! database_exists "${target_test_database}" || die "Target test database was created concurrently."
created_main=false
created_test=false
rollback() {
  local status=$?
  if ((status != 0)); then
    warn "Database clone failed; removing only the newly created target schemas."
    if [[ "${created_test}" == true ]]; then mysql_client -e "DROP DATABASE IF EXISTS \`${target_test_database}\`" || true; fi
    if [[ "${created_main}" == true ]]; then mysql_client -e "DROP DATABASE IF EXISTS \`${target_database}\`" || true; fi
  fi
  exit "${status}"
}
trap rollback EXIT

mysql_client -e "CREATE DATABASE \`${target_database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
created_main=true
mysql_client -e "CREATE DATABASE \`${target_test_database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
created_test=true

clone_schema() {
  local source_database_name="$1" target_database_name="$2"
  docker run --rm --network host --env-file "${shared_env}" --env "SOURCE_DATABASE=${source_database_name}" --entrypoint sh "${operator_image}" -c \
    'h=$(printf %s "$MYSQL_HOST" | tr -d "'\''\""); p=$(printf %s "$MYSQL_PORT" | tr -d "'\''\""); u=$(printf %s "$MYSQL_USER" | tr -d "'\''\""); pw=$(printf %s "$MYSQL_PASSWORD" | tr -d "'\''\""); export MYSQL_PWD="$pw"; exec mysqldump --protocol=TCP -h "$h" -P "$p" -u "$u" --single-transaction --quick --routines --events --triggers --hex-blob --set-gtid-purged=OFF --no-tablespaces "$SOURCE_DATABASE"' \
    | docker run --rm --interactive --network host --env-file "${shared_env}" --env "TARGET_DATABASE=${target_database_name}" --entrypoint sh "${operator_image}" -c \
      'h=$(printf %s "$MYSQL_HOST" | tr -d "'\''\""); p=$(printf %s "$MYSQL_PORT" | tr -d "'\''\""); u=$(printf %s "$MYSQL_USER" | tr -d "'\''\""); pw=$(printf %s "$MYSQL_PASSWORD" | tr -d "'\''\""); export MYSQL_PWD="$pw"; exec mysql --protocol=TCP -h "$h" -P "$p" -u "$u" "$TARGET_DATABASE"'
}

log "Cloning ${source_database} into the isolated target ${target_database}."
clone_schema "${source_database}" "${target_database}"
log "Cloning ${source_test_database} into the isolated target ${target_test_database}."
clone_schema "${source_test_database}" "${target_test_database}"

source_main_objects="$(database_object_count "${source_database}")"
target_main_objects="$(database_object_count "${target_database}")"
source_test_objects="$(database_object_count "${source_test_database}")"
target_test_objects="$(database_object_count "${target_test_database}")"
[[ "${source_main_objects}" == "${target_main_objects}" ]] || die "Main database object count differs after clone."
[[ "${source_test_objects}" == "${target_test_objects}" ]] || die "Test database object count differs after clone."

receipt="${target_root}/ops/database-clone-receipt.json"
temporary="$(mktemp "${target_root}/ops/.database-clone-receipt.XXXXXX")"
jq --null-input \
  --arg sourceProject "${source_slug}" --arg sourceCommit "${source_head}" \
  --arg targetProject "${target_slug}" --arg sourceMain "${source_database}" \
  --arg sourceTest "${source_test_database}" --arg targetMain "${target_database}" \
  --arg targetTest "${target_test_database}" --argjson mainObjects "${target_main_objects}" \
  --argjson testObjects "${target_test_objects}" --argjson sourceRedis "${source_redis}" \
  --argjson sourceTestRedis "${source_test_redis}" --argjson targetRedis "${target_redis}" \
  --argjson targetTestRedis "${target_test_redis}" --arg createdAt "$(date --iso-8601=seconds)" \
  '{schemaVersion:1,sourceProject:$sourceProject,sourceCommit:$sourceCommit,targetProject:$targetProject,sourceDatabases:{main:$sourceMain,test:$sourceTest},targetDatabases:{main:$targetMain,test:$targetTest},objectCounts:{main:$mainObjects,test:$testObjects},redis:{sourceRuntime:$sourceRedis,sourceTest:$sourceTestRedis,targetRuntime:$targetRedis,targetTest:$targetTestRedis,strategy:"empty-rebuild"},createdAt:$createdAt}' \
  >"${temporary}"
chmod 0640 "${temporary}"
if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; fi
mv -- "${temporary}" "${receipt}"
trap - EXIT
log "Database clone completed with ${target_main_objects}/${target_test_objects} main/test objects; target Redis databases remain empty for safe cache rebuild."
