#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
umask 077

slug="${1:-}"
backup_input="${2:-}"
shift 2 || true
confirm_slug=''
while (($# > 0)); do
  case "$1" in
    --confirm-destructive-restore) confirm_slug="${2:-}"; shift 2 ;;
    --help|-h)
      printf 'Usage: %s <project-slug> <backup-directory> --confirm-destructive-restore <project-slug>\n' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${slug}" && -n "${backup_input}" ]] || die "Project slug and backup directory are required."
validate_slug "${slug}"
[[ "${confirm_slug}" == "${slug}" ]] \
  || die "--confirm-destructive-restore must exactly match ${slug}."
for command_name in curl docker flock git grep gzip jq mktemp python3 realpath sha256sum stat tar; do require_command "${command_name}"; done
require_docker_access

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
upload_root="${DELIVERY_ROOT}/file-gateway/data/${slug}"
backup_root="${DELIVERY_ROOT}/backups/${slug}"
backup_path="$(realpath -e -- "${backup_input}")"
[[ "${backup_path}" == "${backup_root}/"* ]] \
  || die "Backup must resolve below ${backup_root}."
[[ -d "${project_root}" && -f "${env_file}" && -f "${compose_file}" ]] \
  || die "Current project is missing or incomplete."
recovery_lock="${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
prepare_delivery_lock "${recovery_lock}"
exec 8>>"${recovery_lock}"
flock --exclusive --nonblock 8 \
  || die "Another backup or restore operation already owns the project recovery lock."
# Reject both a live recovery and its SIGKILL-persisted maintenance marker before
# validating or mutating recovery payloads. The dedicated reconcile path is the
# sole authority that may retire that marker.
assert_project_taskspace_mutation_fences_committed "${project_root}" "${slug}"
[[ -f "${backup_path}/manifest.json" && -f "${backup_path}/SHA256SUMS" ]] \
  || die "Recovery bundle is incomplete."
(
  cd -- "${backup_path}"
  sha256sum --check SHA256SUMS
)
[[ "$(jq -r '.schemaVersion' "${backup_path}/manifest.json")" == 1 ]] || die "Unsupported recovery schema."
[[ "$(jq -r '.projectSlug' "${backup_path}/manifest.json")" == "${slug}" ]] \
  || die "Recovery bundle belongs to another project."

registry_row="$(awk -F '\t' -v value="${slug}" 'NR > 1 && $1 == value {print; found=1; exit} END {exit !found}' "${registry_file}")"
[[ "$(jq -r '.registryRow' "${backup_path}/manifest.json")" == "${registry_row}" ]] \
  || die "Current registry identity differs from the recovery bundle."
[[ ! -d "${project_root}/taskspaces/.broker/release.lock" ]] \
  || die "A project release lock exists; restore did not stop any service."
if [[ -f "${ops_root}/release-state.json" ]] \
  && [[ "$(jq -r '.status // ""' "${ops_root}/release-state.json")" == running ]]; then
  die "Release Runner reports an active job; restore did not stop any service."
fi

env_value() {
  local file="$1" key="$2"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${file}"
}
compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}
mysql_database="$(jq -r '.databases.main' "${backup_path}/manifest.json")"
mysql_test_database="$(jq -r '.databases.test' "${backup_path}/manifest.json")"
redis_database="$(jq -r '.redis.runtime' "${backup_path}/manifest.json")"
redis_test_database="$(jq -r '.redis.test' "${backup_path}/manifest.json")"
crypto_volume="$(jq -r '.cryptoVolume' "${backup_path}/manifest.json")"
[[ "${mysql_database}" =~ ^[a-z0-9_]{1,64}$ && "${mysql_test_database}" == "${mysql_database}_test" ]] \
  || die "Recovery bundle MySQL identity is invalid."
[[ "${redis_database}" =~ ^([0-9]|1[0-5])$ && "${redis_test_database}" =~ ^([0-9]|1[0-5])$ ]] \
  || die "Recovery bundle Redis identity is invalid."
[[ "${crypto_volume}" == "forge-${slug}_crypto-secrets" ]] || die "Recovery bundle volume identity is invalid."
[[ "$(awk -F '\t' -v value="${slug}" 'NR > 1 && $1 == value {print $9; exit}' "${registry_file}")" == "${mysql_database}" ]] \
  || die "Registered main database differs from the recovery bundle."
[[ "$(awk -F '\t' -v value="${slug}" 'NR > 1 && $1 == value {print $11; exit}' "${registry_file}")" == "${redis_database}" ]] \
  || die "Registered Redis database differs from the recovery bundle."

shared_env="$(env_value "${env_file}" SHARED_SERVICES_ENV_FILE)"
operator_image="$(env_value "${env_file}" RELEASE_DB_OPERATOR_IMAGE)"
harness_image="$(env_value "${env_file}" HARNESS_IMAGE)"
[[ -f "${shared_env}" ]] || die "Shared-service credentials are unavailable."
[[ "${operator_image}" =~ @sha256:[a-f0-9]{64}$ ]] || die "MySQL operator image is not digest pinned."
docker volume inspect "${crypto_volume}" >/dev/null 2>&1 || die "Project crypto volume is missing."

mapfile -t current_services < <(compose ps --status running --services | sort -u)
current_taskspaces=()
shopt -s nullglob
for metadata in "${project_root}/taskspaces"/*/metadata.json; do
  if [[ "$(jq -r '.status' "${metadata}")" == active ]]; then
    current_taskspaces+=("$(basename -- "$(dirname -- "${metadata}")")")
  fi
done
shopt -u nullglob
jq --exit-status '
  (.runtimeBefore | type == "object") and
  (.runtimeBefore.services | type == "array") and
  (.runtimeBefore.activeTaskspaces | type == "array") and
  (all(.runtimeBefore.services[]; type == "string" and length > 0)) and
  (all(.runtimeBefore.activeTaskspaces[];
    type == "string" and test("^[a-z0-9][a-z0-9-]{1,47}$"))) and
  ((.runtimeBefore.services | length) == (.runtimeBefore.services | unique | length)) and
  ((.runtimeBefore.activeTaskspaces | length) ==
    (.runtimeBefore.activeTaskspaces | unique | length))
' "${backup_path}/manifest.json" >/dev/null \
  || die "Recovery runtime manifest has invalid or duplicate service/TaskSpace entries."
mapfile -t desired_services < <(jq -r '.runtimeBefore.services[]' "${backup_path}/manifest.json")
mapfile -t desired_taskspaces < <(jq -r '.runtimeBefore.activeTaskspaces[]' "${backup_path}/manifest.json")
mapfile -t allowed_services < <(compose config --services | sort -u)
for service in "${desired_services[@]}"; do
  printf '%s\n' "${allowed_services[@]}" | grep -Fxq -- "${service}" \
    || die "Recovery manifest requests a service outside the current project Compose model: ${service}"
done

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
recovery_root="${DELIVERY_ROOT}/recovery/${slug}/${timestamp}-pre-restore"
[[ ! -e "${recovery_root}" ]] || die "Pre-restore safety target already exists."
mkdir -p -- "$(dirname -- "${recovery_root}")"
chmod 0700 "$(dirname -- "${recovery_root}")"
mkdir -m 0700 -- "${recovery_root}"

for task_id in "${current_taskspaces[@]}"; do
  bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" stop "${task_id}"
done
if ((${#current_services[@]} > 0)); then compose stop "${current_services[@]}"; fi

mysql_dump() {
  local database="$1" output="$2"
  docker run --rm --network host --env-file "${shared_env}" --env "BACKUP_DATABASE=${database}" --entrypoint sh "${operator_image}" -c \
    'h=$(printf %s "$MYSQL_HOST" | tr -d "'\''\""); p=$(printf %s "$MYSQL_PORT" | tr -d "'\''\""); u=$(printf %s "$MYSQL_USER" | tr -d "'\''\""); pw=$(printf %s "$MYSQL_PASSWORD" | tr -d "'\''\""); export MYSQL_PWD="$pw"; exec mysqldump --protocol=TCP -h "$h" -P "$p" -u "$u" --single-transaction --quick --routines --events --triggers --hex-blob --set-gtid-purged=OFF --no-tablespaces --add-drop-table "$BACKUP_DATABASE"' \
    | gzip -9 >"${output}"
  gzip -t "${output}"
}
mysql_client() {
  docker run --rm --interactive --network host --env-file "${shared_env}" --entrypoint sh "${operator_image}" -c \
    'h=$(printf %s "$MYSQL_HOST" | tr -d "'\''\""); p=$(printf %s "$MYSQL_PORT" | tr -d "'\''\""); u=$(printf %s "$MYSQL_USER" | tr -d "'\''\""); pw=$(printf %s "$MYSQL_PASSWORD" | tr -d "'\''\""); export MYSQL_PWD="$pw"; exec mysql --protocol=TCP -h "$h" -P "$p" -u "$u" "$@"' sh "$@"
}
mysql_reset_from_dump() {
  local database="$1" dump="$2"
  mysql_client -e "DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
  gzip -dc -- "${dump}" | mysql_client "${database}"
}
volume_archive() {
  local output_directory="$1" output_name="$2"
  docker run --rm --user 0:0 --mount "type=volume,source=${crypto_volume},target=/source,readonly" \
    --mount "type=bind,source=${output_directory},target=/backup" --entrypoint sh "${harness_image}" \
    -c "exec tar -C /source -czf /backup/${output_name} ."
}
volume_restore() {
  local input_directory="$1" input_name="$2"
  docker run --rm --user 0:0 --mount "type=volume,source=${crypto_volume},target=/target" \
    --mount "type=bind,source=${input_directory},target=/backup,readonly" --entrypoint sh "${harness_image}" \
    -c "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && exec tar -C /target -xzf /backup/${input_name}"
}

mutation_started=false
restore_completed=false
rollback_on_failure() {
  local status=$?
  trap - EXIT
  if ((status == 0)) || [[ "${restore_completed}" == true ]]; then
    return
  fi
  warn "Restore failed; attempting to return the exact project to its pre-restore safety state."
  if [[ "${mutation_started}" == true ]]; then
    if [[ -f "${project_root}/ops/project.env" && -f "${project_root}/ops/compose.yaml" ]]; then
      env_file="${project_root}/ops/project.env"
      compose_file="${project_root}/ops/compose.yaml"
      compose stop >/dev/null 2>&1 || true
    fi
    if [[ -d "${project_root}" ]]; then
      mv -- "${project_root}" "${recovery_root}/failed-restored-project-state" || true
    fi
    if [[ -d "${recovery_root}/project-state" ]]; then
      mv -- "${recovery_root}/project-state" "${project_root}" || true
    fi
    if [[ -d "${upload_root}" ]]; then
      mv -- "${upload_root}" "${recovery_root}/failed-restored-shared-uploads" || true
    fi
    if [[ -d "${recovery_root}/shared-uploads" ]]; then
      mv -- "${recovery_root}/shared-uploads" "${upload_root}" || true
    fi
    env_file="${project_root}/ops/project.env"
    compose_file="${project_root}/ops/compose.yaml"
    mysql_reset_from_dump "${mysql_database}" "${recovery_root}/mysql-main.sql.gz" \
      || warn "Automatic pre-restore main database recovery failed."
    mysql_reset_from_dump "${mysql_test_database}" "${recovery_root}/mysql-test.sql.gz" \
      || warn "Automatic pre-restore test database recovery failed."
    python3 "${SCRIPT_DIR}/redis-logical-state.py" restore --database "${redis_database}" \
      --confirm-database "${redis_database}" --input "${recovery_root}/redis-runtime.jsonl" >/dev/null \
      || warn "Automatic pre-restore runtime Redis recovery failed."
    python3 "${SCRIPT_DIR}/redis-logical-state.py" restore --database "${redis_test_database}" \
      --confirm-database "${redis_test_database}" --input "${recovery_root}/redis-test.jsonl" >/dev/null \
      || warn "Automatic pre-restore test Redis recovery failed."
    volume_restore "${recovery_root}" crypto-secrets.tar.gz \
      || warn "Automatic pre-restore crypto-volume recovery failed."
  fi
  if [[ -f "${project_root}/ops/project.env" && -f "${project_root}/ops/compose.yaml" ]]; then
    env_file="${project_root}/ops/project.env"
    compose_file="${project_root}/ops/compose.yaml"
    if ((${#current_services[@]} > 0)); then
      compose up --detach --no-build --force-recreate "${current_services[@]}" >/dev/null 2>&1 \
        || warn "Automatic pre-restore service restart failed."
    fi
    for task_id in "${current_taskspaces[@]}"; do
      bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" start "${task_id}" >/dev/null 2>&1 \
        || warn "Automatic pre-restore TaskSpace restart failed for ${task_id}."
    done
  fi
  warn "Pre-restore safety evidence is retained at ${recovery_root}."
  exit "${status}"
}
trap rollback_on_failure EXIT

log "Capturing a pre-restore safety copy before mutating the exact registered target."
mysql_dump "${mysql_database}" "${recovery_root}/mysql-main.sql.gz"
mysql_dump "${mysql_test_database}" "${recovery_root}/mysql-test.sql.gz"
set -a
# shellcheck disable=SC1090
source "${shared_env}"
set +a
python3 "${SCRIPT_DIR}/redis-logical-state.py" backup --database "${redis_database}" \
  --output "${recovery_root}/redis-runtime.jsonl" >"${recovery_root}/redis-runtime-summary.json"
python3 "${SCRIPT_DIR}/redis-logical-state.py" backup --database "${redis_test_database}" \
  --output "${recovery_root}/redis-test.jsonl" >"${recovery_root}/redis-test-summary.json"
volume_archive "${recovery_root}" crypto-secrets.tar.gz
tar --acls --xattrs --numeric-owner --create --gzip \
  --file "${recovery_root}/shared-uploads.tar.gz" --directory "${upload_root}" .

restore_stage="${DELIVERY_ROOT}/projects/.${slug}.restoring.$$"
[[ ! -e "${restore_stage}" ]] || die "Restore staging path already exists."
mkdir -m 0750 -- "${restore_stage}"
tar --acls --xattrs --numeric-owner --extract --gzip \
  --file "${backup_path}/project-state.tar.gz" --directory "${restore_stage}"
# Historical bundles are admitted independently before they can replace the
# registered project. A bundle containing an active/ambiguous recovery marker is
# never converted into the current project state.
assert_project_taskspace_mutation_fences_committed "${restore_stage}" "${slug}/restore-candidate"
restored_env="${restore_stage}/ops/project.env"
[[ -f "${restored_env}" && "$(env_value "${restored_env}" PROJECT_SLUG)" == "${slug}" ]] \
  || die "Restored project state has the wrong identity."
[[ "$(project_git_readonly "${restore_stage}/workspace" rev-parse 'HEAD^{commit}')" == "$(jq -r '.gitHead' "${backup_path}/manifest.json")" ]] \
  || die "Restored Git HEAD differs from the recovery manifest."
for task_id in "${desired_taskspaces[@]}"; do
  metadata="${restore_stage}/taskspaces/${task_id}/metadata.json"
  task_env="${restore_stage}/taskspaces/${task_id}/task.env"
  [[ -f "${metadata}" && -f "${task_env}" ]] \
    || die "Recovery manifest references an absent TaskSpace: ${task_id}"
  jq --exit-status --arg project "${slug}" --arg task "${task_id}" \
    '.projectSlug == $project and .taskId == $task' "${metadata}" >/dev/null \
    || die "Restored TaskSpace metadata identity differs from the recovery manifest: ${task_id}"
done

mutation_started=true
mv -- "${project_root}" "${recovery_root}/project-state"
mv -- "${restore_stage}" "${project_root}"
mv -- "${upload_root}" "${recovery_root}/shared-uploads"
mkdir -m 0750 -- "${upload_root}"
tar --acls --xattrs --numeric-owner --extract --gzip \
  --file "${backup_path}/shared-uploads.tar.gz" --directory "${upload_root}"
if [[ "${EUID}" -eq 0 ]]; then chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${project_root}"; fi

env_file="${project_root}/ops/project.env"
compose_file="${project_root}/ops/compose.yaml"
log "Restoring the exact registered main/test schemas, Redis logical databases, and crypto volume."
mysql_reset_from_dump "${mysql_database}" "${backup_path}/mysql-main.sql.gz"
mysql_reset_from_dump "${mysql_test_database}" "${backup_path}/mysql-test.sql.gz"
python3 "${SCRIPT_DIR}/redis-logical-state.py" restore --database "${redis_database}" \
  --confirm-database "${redis_database}" --input "${backup_path}/redis-runtime.jsonl"
python3 "${SCRIPT_DIR}/redis-logical-state.py" restore --database "${redis_test_database}" \
  --confirm-database "${redis_test_database}" --input "${backup_path}/redis-test.jsonl"
volume_restore "${backup_path}" crypto-secrets.tar.gz

compose config --quiet
if ((${#desired_services[@]} > 0)); then
  compose up --detach --no-build --force-recreate "${desired_services[@]}"
fi
for task_id in "${desired_taskspaces[@]}"; do
  bash "${SCRIPT_DIR}/taskspacectl.sh" "${slug}" start "${task_id}"
done

taskspace_control_files_ready() {
  local host_uid host_gid task_id metadata identity
  host_uid="$(env_value "${env_file}" HOST_UID)"
  host_gid="$(env_value "${env_file}" HOST_GID)"
  [[ "${host_uid}" =~ ^[0-9]+$ && "${host_gid}" =~ ^[0-9]+$ ]] || return 1
  for task_id in "${desired_taskspaces[@]}"; do
    metadata="${project_root}/taskspaces/${task_id}/metadata.json"
    [[ -f "${metadata}" ]] || return 1
    identity="$(stat -c '%u:%g:%a' "${metadata}")"
    [[ "${identity}" == "${host_uid}:${host_gid}:600" ]] || return 1
  done
}

wait_for_restored_runtime() {
  local deadline=$((SECONDS + 180))
  local bind_address ui_port harness_port running
  bind_address="$(env_value "${env_file}" FORGE_BIND_ADDRESS)"
  ui_port="$(env_value "${env_file}" FORGE_UI_PORT)"
  harness_port="$(env_value "${env_file}" HARNESS_PORT)"
  while ((SECONDS < deadline)); do
    mapfile -t running < <(compose ps --status running --services | sort -u)
    local all_running=true service
    for service in "${desired_services[@]}"; do
      if ! printf '%s\n' "${running[@]}" | grep -Fxq -- "${service}"; then
        all_running=false
        break
      fi
    done
    if [[ "${all_running}" == true ]] \
      && taskspace_control_files_ready \
      && { ! printf '%s\n' "${desired_services[@]}" | grep -Fxq -- forge-ui \
        || { curl --fail --silent --show-error --max-time 5 \
               "http://${bind_address}:${ui_port}/forge/login" >/dev/null \
          && curl --fail --silent --show-error --max-time 5 \
               "http://${bind_address}:${ui_port}/forge-api/auth/captcha" >/dev/null; }; } \
      && { ! printf '%s\n' "${desired_services[@]}" | grep -Fxq -- conversation-gateway \
        || curl --fail --silent --show-error --max-time 5 \
             "http://${bind_address}:${harness_port}/healthz" >/dev/null; }; then
      return 0
    fi
    sleep 3
  done
  compose ps >&2 || true
  for task_id in "${desired_taskspaces[@]}"; do
    stat -c 'TaskSpace metadata ownership mismatch: %u:%g mode=%a path=%n' \
      "${project_root}/taskspaces/${task_id}/metadata.json" >&2 || true
  done
  die "Restored services did not pass the bounded running/UI/API/gateway health gate."
}
wait_for_restored_runtime

receipt_temp="$(mktemp "${project_root}/ops/.restore-receipt.XXXXXX")"
jq --null-input --arg projectSlug "${slug}" --arg backupPath "${backup_path}" \
  --arg restoredAt "$(date --iso-8601=seconds)" --arg safetyCopy "${recovery_root}" \
  --arg gitHead "$(project_git_readonly "${project_root}/workspace" rev-parse 'HEAD^{commit}')" \
  '{schemaVersion:1,projectSlug:$projectSlug,backupPath:$backupPath,restoredAt:$restoredAt,preRestoreSafetyCopy:$safetyCopy,gitHead:$gitHead,status:"restored"}' \
  >"${receipt_temp}"
chmod 0640 "${receipt_temp}"
if [[ "${EUID}" -eq 0 ]]; then chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${receipt_temp}"; fi
mv -- "${receipt_temp}" "${project_root}/ops/restore-receipt.json"

restore_completed=true
log "Project restore completed from ${backup_path}."
log "Pre-restore files and data safety artifacts remain at ${recovery_root}; no automatic deletion was performed."
