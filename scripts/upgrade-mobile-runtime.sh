#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
load_platform_config

usage() {
  printf '%s\n' \
    "Usage: $0 <project-slug> --candidate-taskspace <taskspace-id> --confirm-maintenance-window mobile-runtime"
}

slug="${1:-}"
shift || true
candidate_taskspace=''
confirmation=''
while (($# > 0)); do
  case "$1" in
    --candidate-taskspace)
      candidate_taskspace="${2:-}"
      shift 2
      ;;
    --confirm-maintenance-window)
      confirmation="${2:-}"
      shift 2
      ;;
    *)
      usage >&2
      die "Unknown mobile runtime upgrade argument: $1"
      ;;
  esac
done

[[ -n "${slug}" && -n "${candidate_taskspace}" ]] || { usage >&2; exit 2; }
validate_slug "${slug}"
[[ "${candidate_taskspace}" =~ ^c-[a-f0-9]{24}$ ]] \
  || die "Candidate TaskSpace id is invalid."
[[ "${confirmation}" == 'mobile-runtime' ]] \
  || die "Explicit maintenance confirmation is required: --confirm-maintenance-window mobile-runtime"

for command_name in awk chmod chown curl diff docker flock git grep install jq mv sha256sum sleep; do
  require_command "${command_name}"
done
require_docker_access

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
contract_file="${ops_root}/runtime-contract.json"
template_compose="${REPO_ROOT}/templates/project/compose.yaml"
candidate_root="${project_root}/taskspaces/${candidate_taskspace}"
candidate_workspace="${candidate_root}/workspace"
candidate_metadata="${candidate_root}/metadata.json"
[[ -f "${env_file}" && -f "${compose_file}" && -f "${contract_file}" \
  && -f "${candidate_metadata}" && -d "${candidate_workspace}/.git" ]] \
  || die "Project or candidate TaskSpace is incomplete."
assert_managed_path "${project_root}"

upgrade_lock="${DELIVERY_ROOT}/registry/${slug}.mobile-runtime-upgrade.lock"
prepare_delivery_lock "${upgrade_lock}"
exec 9>>"${upgrade_lock}"
flock --exclusive --nonblock 9 || die "Another mobile runtime upgrade is active for ${slug}."

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

env_value() {
  release_contract_env_value "${env_file}" "$1"
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
  for service in forge-admin forge-flow forge-ui forge-app; do
    container_id="$(compose ps --quiet "${service}")"
    if [[ -n "${container_id}" ]]; then
      printf '%s=%s\n' "${service}" "$(docker inspect --format '{{.Id}}' "${container_id}")"
    else
      printf '%s=\n' "${service}"
    fi
  done
}

wait_healthy() {
  local service="$1" deadline=$((SECONDS + 120)) container_id
  while ((SECONDS < deadline)); do
    container_id="$(compose ps --quiet "${service}")"
    if [[ -n "${container_id}" \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)" == healthy ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_release_idle() {
  local runner_socket="${ops_root}/release-ipc/runner.sock" broker_container
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
[[ "$(jq -r '.taskId' "${candidate_metadata}")" == "${candidate_taskspace}" \
  && "$(jq -r '.projectSlug' "${candidate_metadata}")" == "${slug}" \
  && "$(jq -r '.status' "${candidate_metadata}")" == active ]] \
  || die "Candidate TaskSpace metadata does not match the active project task."
[[ -z "$(project_git_readonly "${candidate_workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Candidate TaskSpace is dirty; commit the reviewed mobile runtime changes first."
candidate_head="$(project_git_readonly "${candidate_workspace}" rev-parse HEAD)"
integration_head="$(project_git_readonly "${project_root}/workspace" rev-parse HEAD)"
[[ "${candidate_head}" =~ ^[a-f0-9]{40}$ && "${integration_head}" =~ ^[a-f0-9]{40}$ ]] \
  || die "Candidate or integration commit is invalid."
project_git_readonly "${candidate_workspace}" merge-base --is-ancestor "${integration_head}" "${candidate_head}" \
  || die "Candidate does not include the current integration commit."

for required_input in \
  docker-forge-admin/Dockerfile.admin \
  docker-forge-admin/Dockerfile.app \
  docker-forge-admin/Dockerfile.flow \
  docker-forge-admin/Dockerfile.ui \
  docker-forge-admin/application-datasource.yml \
  docker-forge-admin/docker-compose.yml \
  docker-forge-admin/nginx.conf; do
  [[ -f "${candidate_workspace}/${required_input}" \
    && ! -L "${candidate_workspace}/${required_input}" ]] \
    || die "Candidate deployment input is missing or unsafe: ${required_input}"
done

current_compose_hash="$(sha256sum "${compose_file}" | awk '{print $1}')"
target_compose_hash="$(sha256sum "${template_compose}" | awk '{print $1}')"
vpn50_compose_hash='6883bd1ec63b8c04fe91c747f8ae337941785c7bea04ab571e6f8e9a3470ce08'
[[ "${current_compose_hash}" == "${vpn50_compose_hash}" \
  || "${current_compose_hash}" == "${target_compose_hash}" ]] \
  || die "Project Compose has unreviewed local changes; do not overwrite it."

docker image inspect "${RELEASE_RUNNER_IMAGE}" >/dev/null 2>&1 \
  || die "Target mobile runtime image is not present: ${RELEASE_RUNNER_IMAGE}"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${RELEASE_RUNNER_IMAGE}")" \
    == "${HARNESS_IMAGE_REVISION}" ]] \
  || die "Target image revision does not match config/versions.env."
[[ "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${RELEASE_RUNNER_IMAGE}")" \
    == "${HARNESS_SKILL_BUNDLE_VERSION}" ]] \
  || die "Target image Skill bundle does not match config/versions.env."

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="${DELIVERY_ROOT}/platform-backups/pre-mobile-runtime-${slug}-${timestamp}"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}"
install -m 0600 "${env_file}" "${backup_root}/project.env"
install -m 0640 "${compose_file}" "${backup_root}/compose.yaml"
install -m 0640 "${contract_file}" "${backup_root}/runtime-contract.json"
application_container_ids >"${backup_root}/application-container-ids.before"
chmod 0600 "${backup_root}/application-container-ids.before"
jq --null-input \
  --arg projectSlug "${slug}" \
  --arg taskspaceId "${candidate_taskspace}" \
  --arg candidateCommit "${candidate_head}" \
  --arg integrationCommit "${integration_head}" \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion: 1, projectSlug: $projectSlug, taskspaceId: $taskspaceId,
    candidateCommit: $candidateCommit, integrationCommit: $integrationCommit, createdAt: $createdAt}' \
  >"${backup_root}/candidate-binding.json"
chmod 0600 "${backup_root}/candidate-binding.json"

switched=false
rollback() {
  local exit_code=$?
  trap - ERR EXIT
  ((exit_code != 0)) || return 0
  if [[ "${switched}" == true ]]; then
    warn "Mobile runtime upgrade failed; restoring the prior env, Compose, contract and control plane."
    install -m 0600 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/project.env" "${env_file}" || true
    install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/compose.yaml" "${compose_file}" || true
    install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${backup_root}/runtime-contract.json" "${contract_file}" || true
    compose up --detach --force-recreate --no-deps release-runner taskspace-broker >/dev/null 2>&1 || true
  fi
  warn "Rollback evidence is retained at ${backup_root}."
  exit "${exit_code}"
}
trap rollback ERR EXIT

switched=true
upsert_env HARNESS_IMAGE "${HARNESS_IMAGE}"
upsert_env RELEASE_RUNNER_IMAGE "${RELEASE_RUNNER_IMAGE}"
upsert_env APP_JAVA_OPTS '-Xms256m -Xmx768m'
upsert_env FORGE_APP_IMAGE "forge-${slug}/forge-app:mobile-runtime-pending"
install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${template_compose}" "${compose_file}"
render_release_contract \
  "${slug}" "${project_root}" "${project_root}/workspace" "${env_file}" "${contract_file}" \
  "${candidate_workspace}"
chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${contract_file}"
chmod 0640 "${contract_file}"
compose config --quiet
compose up --detach --force-recreate --no-deps release-runner
wait_healthy release-runner || die "Release Runner did not become healthy after the mobile runtime upgrade."
compose up --detach --force-recreate --no-deps taskspace-broker
wait_healthy taskspace-broker || die "TaskSpace Broker did not become healthy after the mobile runtime upgrade."

runner_socket="${ops_root}/release-ipc/runner.sock"
contract_probe="$(curl --fail --silent --show-error --max-time 10 \
  --unix-socket "${runner_socket}" \
  --header 'content-type: application/json' \
  --data '{"action":"contract"}' \
  http://localhost/v1/actions)"
jq -e '.ok == true
  and (.result.release.allowedReleaseServices | index("forge-app")) != null
  and (.result.release.allowedComposeServices | index("forge-app")) != null' \
  <<<"${contract_probe}" >/dev/null \
  || die "Release Runner did not expose the reviewed forge-app contract."

application_container_ids >"${backup_root}/application-container-ids.after"
chmod 0600 "${backup_root}/application-container-ids.after"
diff -- "${backup_root}/application-container-ids.before" "${backup_root}/application-container-ids.after" >/dev/null \
  || die "A Forge application container changed during the control-plane-only mobile upgrade."

install -m 0640 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
  "${backup_root}/candidate-binding.json" "${ops_root}/mobile-runtime-candidate.json"

trap - ERR EXIT
log "Mobile runtime contract is active for ${slug}; no application container was recreated."
log "Candidate ${candidate_head} is bound to TaskSpace ${candidate_taskspace} for the next Broker release."
log "Rollback evidence is retained at ${backup_root}."
