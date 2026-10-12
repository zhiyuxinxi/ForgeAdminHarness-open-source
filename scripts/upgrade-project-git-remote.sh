#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config

slug="${1:-}"
confirmation="${2:-}"
[[ -n "${slug}" ]] || die "Usage: $0 <project-slug> --confirm-maintenance-window project-git-remote"
validate_slug "${slug}"
[[ "${confirmation}" == '--confirm-maintenance-window' && "${3:-}" == 'project-git-remote' ]] \
  || die "Explicit maintenance confirmation is required: --confirm-maintenance-window project-git-remote"
[[ $# -eq 3 ]] || die "Unexpected arguments."

for command_name in awk chmod chown curl diff docker flock grep install jq mv sleep; do
  require_command "${command_name}"
done
require_docker_access
docker image inspect "${RELEASE_RUNNER_IMAGE}" >/dev/null 2>&1 \
  || die "Target Broker image is not present: ${RELEASE_RUNNER_IMAGE}"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${RELEASE_RUNNER_IMAGE}")" \
    == "${HARNESS_IMAGE_REVISION}" ]] \
  || die "Target Broker image revision does not match config/versions.env."
[[ "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${RELEASE_RUNNER_IMAGE}")" \
    == "${HARNESS_SKILL_BUNDLE_VERSION}" ]] \
  || die "Target Broker image Skill bundle does not match config/versions.env."

project_root="${DELIVERY_ROOT}/projects/${slug}"
env_file="${project_root}/ops/project.env"
compose_file="${project_root}/ops/compose.yaml"
template="${REPO_ROOT}/templates/project/compose.yaml"
git_root="${DELIVERY_ROOT}/git-remotes/${slug}"
[[ -f "${env_file}" && -f "${compose_file}" && -d "${git_root}" ]] \
  || die "Project or project Git credential root is missing: ${slug}"

upgrade_lock="${DELIVERY_ROOT}/registry/${slug}.git-remote-upgrade.lock"
prepare_delivery_lock "${upgrade_lock}"
exec 9>>"${upgrade_lock}"
flock --exclusive --nonblock 9 || die "Another Git remote runtime upgrade is active for ${slug}."

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

upsert_env() {
  local key="$1" value="$2" temporary
  temporary="${env_file}.tmp.$$"
  awk -F= -v key="${key}" -v value="${value}" '
    BEGIN {found=0}
    $1 == key {print key "=" value; found=1; next}
    {print}
    END {if (!found) print key "=" value}
  ' "${env_file}" >"${temporary}"
  chmod --reference="${env_file}" "${temporary}"
  chown --reference="${env_file}" "${temporary}"
  mv -- "${temporary}" "${env_file}"
}

application_container_ids() {
  local service container_id
  for service in forge-admin forge-flow forge-ui; do
    container_id="$(compose ps --quiet "${service}")"
    [[ -n "${container_id}" ]] || die "Application service is not running: ${service}"
    printf '%s=%s\n' "${service}" "$(docker inspect --format '{{.Id}}' "${container_id}")"
  done
}

wait_broker_healthy() {
  local deadline=$((SECONDS + 120)) container_id
  while ((SECONDS < deadline)); do
    container_id="$(compose ps --quiet taskspace-broker)"
    if [[ -n "${container_id}" \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)" == healthy ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_release_idle() {
  local runner_socket="${project_root}/ops/release-ipc/runner.sock" broker_container
  [[ -S "${runner_socket}" ]] || die "Release Runner socket is unavailable for ${slug}."
  curl --fail --silent --show-error --max-time 5 --unix-socket "${runner_socket}" \
      http://localhost/healthz \
    | jq -e '.ok == true and .active == false' >/dev/null \
    || die "Release Runner is active or unhealthy for ${slug}."
  broker_container="$(compose ps --quiet taskspace-broker)"
  [[ -n "${broker_container}" ]] || die "TaskSpace Broker is unavailable for ${slug}."
  docker exec "${broker_container}" node -e \
    "fetch('http://127.0.0.1:3100/healthz').then(async r=>{const v=await r.json();if(!r.ok||v.active!==false)process.exit(1)}).catch(()=>process.exit(1))" \
    || die "TaskSpace Broker is active or unhealthy for ${slug}."
}

bash "${SCRIPT_DIR}/project-gitctl.sh" "${slug}" status --require-synchronized >/dev/null
assert_release_idle

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="${DELIVERY_ROOT}/platform-backups/pre-project-git-remote-${slug}-${timestamp}"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}"
install -m 0600 "${env_file}" "${backup_root}/project.env"
install -m 0640 "${compose_file}" "${backup_root}/compose.yaml"
application_container_ids >"${backup_root}/application-container-ids.before"
chmod 0600 "${backup_root}/application-container-ids.before"

switched=false
rollback() {
  local exit_code=$?
  trap - ERR EXIT
  ((exit_code != 0)) || return 0
  if [[ "${switched}" == true ]]; then
    warn "Project Git remote runtime upgrade failed; restoring prior env, Compose, and Broker."
    install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/project.env" "${env_file}" || true
    install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/compose.yaml" "${compose_file}" || true
    compose up --detach --force-recreate --no-deps taskspace-broker >/dev/null 2>&1 || true
  fi
  warn "Rollback evidence is retained at ${backup_root}."
  exit "${exit_code}"
}
trap rollback ERR EXIT

switched=true
upsert_env RELEASE_RUNNER_IMAGE "${RELEASE_RUNNER_IMAGE}"
install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${template}" "${compose_file}"
compose config --quiet
compose up --detach --force-recreate --no-deps taskspace-broker
wait_broker_healthy || die "TaskSpace Broker did not become healthy after the Git remote upgrade."

broker_container="$(compose ps --quiet taskspace-broker)"
target_image_id="$(docker image inspect --format '{{.Id}}' "${RELEASE_RUNNER_IMAGE}")"
[[ "$(docker inspect --format '{{.Image}}' "${broker_container}")" == "${target_image_id}" ]] \
  || die "TaskSpace Broker is not running the reviewed target image."
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/forge-git"}}{{.Source}}|{{.RW}}{{end}}{{end}}' \
    "${broker_container}" | grep -Fx -- "${git_root}|false" >/dev/null \
  || die "TaskSpace Broker Git credential mount is not the exact read-only project root."
compose exec -T taskspace-broker node -e \
  "const fs=require('node:fs');if(process.env.TASKSPACE_GIT_REMOTE_REQUIRED!=='true'||process.env.TASKSPACE_GIT_REMOTE_READY!=='true'||!process.env.TASKSPACE_GIT_SSH_COMMAND?.includes('StrictHostKeyChecking=yes'))process.exit(2);for(const p of ['/run/forge-git/id_ed25519','/run/forge-git/known_hosts']){const s=fs.statSync(p);if((s.mode&0o077)!==0)process.exit(3)}"
bash "${SCRIPT_DIR}/project-gitctl.sh" "${slug}" status --require-synchronized >/dev/null
application_container_ids >"${backup_root}/application-container-ids.after"
chmod 0600 "${backup_root}/application-container-ids.after"
diff -- "${backup_root}/application-container-ids.before" "${backup_root}/application-container-ids.after" >/dev/null \
  || die "A Forge application container changed during the Broker-only upgrade."

trap - ERR EXIT
log "Project Git remote runtime is active for ${slug}; only taskspace-broker was recreated."
log "Rollback evidence is retained at ${backup_root}."
