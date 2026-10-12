#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

slug="${1:-}"
[[ -n "${slug}" && $# -eq 1 ]] || die "Usage: $0 <project-slug>"
validate_slug "${slug}"

for command_name in awk curl docker find git grep jq mktemp sha256sum; do
  require_command "${command_name}"
done
require_docker_access
acquire_harness_image_upgrade_lock

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
contract_file="${ops_root}/runtime-contract.json"
ipc_root="${ops_root}/release-ipc"
template_compose="${REPO_ROOT}/templates/project/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
[[ -d "${project_root}/workspace" && -d "${project_root}/dsh-home" \
  && -f "${env_file}" && -f "${compose_file}" && -f "${registry_file}" ]] \
  || die "Project is missing or incomplete: ${project_root}"
assert_managed_path "${project_root}"

env_value() {
  release_contract_env_value "${env_file}" "$1"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

current_image="$(env_value HARNESS_IMAGE)"
target_image="${HARNESS_IMAGE}"
compose_project="$(env_value COMPOSE_PROJECT_NAME)"
[[ -n "${current_image}" && -n "${target_image}" ]] || die "Harness image configuration is incomplete."
[[ "${compose_project}" == "forge-${slug}" ]] || die "Unexpected Compose project name for ${slug}."

current_compose_hash="$(sha256sum "${compose_file}" | awk '{print $1}')"
target_compose_hash="$(sha256sum "${template_compose}" | awk '{print $1}')"
vpn11_compose_hash='2472bfbfed4b74158a5e7c5577416bfc7871318d578af39b7dcdd856d95b2bca'
vpn14_compose_hash='176a45f65ef17fcc434d5c3e1279e31a1bf8c8eec8375f31a55f43f328b2a1b7'
vpn20_compose_hash='ef96f87a0b25c2a0b9792284f194350537e302761127937b4cae4951f7899234'
vpn21_compose_hash='cfd253a5b8d2348e8db45119fdddeca55ba1c1c2497ee5f960d4b70527f25802'
if [[ "${current_compose_hash}" != "${vpn11_compose_hash}" \
  && "${current_compose_hash}" != "${vpn14_compose_hash}" \
  && "${current_compose_hash}" != "${vpn20_compose_hash}" \
  && "${current_compose_hash}" != "${vpn21_compose_hash}" \
  && "${current_compose_hash}" != "${target_compose_hash}" ]]; then
  die "Project Compose has unreviewed local changes; do not overwrite it: ${compose_file}"
fi

current_image_id="$(docker image inspect --format '{{.Id}}' "${current_image}")"
[[ "${current_image_id}" == sha256:* ]] || die "Current Harness image has no immutable image ID."
current_image_build_ref="$(resolve_local_docker_build_ref "${current_image}" "${current_image_id}")"
if docker image inspect "${target_image}" >/dev/null 2>&1; then
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image}")"
  maven_opts="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${target_image}" \
    | awk -F= '$1 == "MAVEN_OPTS" {sub(/^[^=]*=/, ""); print; exit}')"
  skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${target_image}")"
  [[ "${revision}" == "${HARNESS_IMAGE_REVISION}" \
    && "${skill_bundle}" == "${HARNESS_SKILL_BUNDLE_VERSION}" \
    && "${maven_opts}" == '-Dmaven.repo.local=/home/node/.m2/repository -Djansi.tmpdir=/home/node/.cache/jansi' ]] \
    || die "Target image tag has unexpected provenance: ${target_image}"
  log "Reusing verified controlled-release image ${target_image}."
else
  log "Building immutable controlled-release image ${target_image} from ${current_image}."
  docker build \
    --build-arg "HARNESS_BASE_IMAGE=${current_image_build_ref}" \
    --build-arg "HARNESS_BASE_IMAGE_ID=${current_image_id}" \
    --build-arg "DSH_VERSION=${DSH_VERSION}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "INSTALL_DOCUMENT_DEPENDENCIES=true" \
    --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" \
    --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
    --build-arg "HARNESS_RUNTIME_PROFILE=${HARNESS_RUNTIME_PROFILE}" \
    --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
    --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" \
    --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
    --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" \
    --tag "${target_image}" \
    --file "${REPO_ROOT}/docker/harness/Dockerfile.overlay" \
    "${REPO_ROOT}"
fi
verify_target_harness_image "${target_image}" "${current_image_id}"
docker run --rm --entrypoint sh "${target_image}" -c \
  'test -r /usr/local/share/dsh-skills/forge-controlled-release/SKILL.md && test -r /usr/local/share/dsh-skills/forge-git-checkpoint/SKILL.md && command -v forge-release >/dev/null && test "${MAVEN_OPTS:-}" = "-Dmaven.repo.local=/home/node/.m2/repository -Djansi.tmpdir=/home/node/.cache/jansi" && node --check /usr/local/lib/release-runner.mjs && node --check /usr/local/lib/release-policy.mjs' \
  || die "Target image does not contain the controlled release capability."

# Image preparation is safe while Harness is in use. Everything below this
# point changes project runtime state, so refuse before taking backups or
# touching Compose/env when a model turn may still be writing session data.
if find "${project_root}/dsh-home/sessions" -type f -name 'session.jsonl.zstd' -mmin -2 -print -quit 2>/dev/null | grep -q .; then
  die "Harness session state changed in the last two minutes; no project runtime files or containers were changed."
fi

[[ "$(project_git_readonly "${project_root}/workspace" rev-parse --is-inside-work-tree)" == true ]] \
  || die "Project workspace is not a Git worktree: ${project_root}/workspace"
project_git "${project_root}/workspace" config --local forge-delivery.managed true
project_git "${project_root}/workspace" config --local forge-delivery.project-slug "${slug}"

timestamp="$(date '+%Y%m%d%H%M%S')"
backup_env="${env_file}.pre-controlled-release-${timestamp}-$$"
backup_compose="${compose_file}.pre-controlled-release-${timestamp}-$$"
backup_registry="${registry_file}.pre-controlled-release-${timestamp}-$$"
backup_contract=''
install -m 0600 -- "${env_file}" "${backup_env}"
chown --reference="${env_file}" "${backup_env}"
install --preserve-timestamps -- "${compose_file}" "${backup_compose}"
chown --reference="${compose_file}" "${backup_compose}"
install --preserve-timestamps -- "${registry_file}" "${backup_registry}"
chown --reference="${registry_file}" "${backup_registry}"
if [[ -f "${contract_file}" ]]; then
  backup_contract="${contract_file}.pre-controlled-release-${timestamp}-$$"
  install --preserve-timestamps -- "${contract_file}" "${backup_contract}"
  chown --reference="${contract_file}" "${backup_contract}"
fi

rollback_armed=false
rollback_attempted=false
harness_recreate_started=false
runner_container=''
ipc_root_preexisting=false
temp_env="$(mktemp "${ops_root}/.project.env.controlled-release.XXXXXX")"
cleanup() {
  rm -f -- "${temp_env}"
}
rollback() {
  if [[ "${rollback_armed}" != true || "${rollback_attempted}" == true ]]; then return; fi
  rollback_attempted=true
  set +e
  warn "Controlled release activation failed; restoring the previous project runtime."
  install -m 0600 -- "${backup_env}" "${env_file}"
  chown --reference="${backup_env}" "${env_file}"
  install --preserve-timestamps -- "${backup_compose}" "${compose_file}"
  chown --reference="${backup_compose}" "${compose_file}"
  install --preserve-timestamps -- "${backup_registry}" "${registry_file}"
  chown --reference="${backup_registry}" "${registry_file}"
  if [[ -n "${backup_contract}" ]]; then
    install --preserve-timestamps -- "${backup_contract}" "${contract_file}"
    chown --reference="${backup_contract}" "${contract_file}"
  else
    rm -f -- "${contract_file}"
  fi
  if [[ "${harness_recreate_started}" == true ]]; then
    compose up --detach --force-recreate --remove-orphans release-runner harness-upload harness
  else
    if [[ -n "${runner_container}" ]]; then docker rm --force "${runner_container}" >/dev/null 2>&1; fi
    docker network rm "${compose_project}_release" >/dev/null 2>&1 || true
    if compose config --services 2>/dev/null | grep -Fxq 'release-runner'; then
      compose up --detach release-runner
    fi
  fi
  if [[ "${ipc_root_preexisting}" != true && -d "${ipc_root}" ]]; then
    rm -f -- "${ipc_root}/runner.sock"
    rmdir -- "${ipc_root}" 2>/dev/null || true
  fi
}
on_exit() {
  local status=$?
  if ((status != 0)); then rollback; fi
  cleanup
  return "${status}"
}
trap on_exit EXIT
rollback_armed=true

redis_database="$(env_value REDIS_DATABASE)"
redis_test_database="$(env_value REDIS_TEST_DATABASE)"
if [[ -z "${redis_test_database}" ]]; then
  for candidate in {15..0}; do
    [[ "${candidate}" != "${redis_database}" ]] || continue
    if ! awk -F '\t' -v value="${candidate}" \
      'NR > 1 && ($11 == value || $12 == value) {found=1} END {exit !found}' \
      "${registry_file}"; then
      redis_test_database="${candidate}"
      break
    fi
  done
fi
[[ "${redis_test_database}" =~ ^([0-9]|1[0-5])$ && "${redis_test_database}" != "${redis_database}" ]] \
  || die "No distinct Redis test database is available for ${slug}."

if [[ -d "${ipc_root}" ]]; then
  ipc_root_preexisting=true
else
  mkdir -m 0700 -- "${ipc_root}"
  chown --reference="${ops_root}" "${ipc_root}"
fi
chmod 0700 "${ipc_root}"

awk \
  -v image="${target_image}" \
  -v ipc_root="${ipc_root}" \
  -v redis_test="${redis_test_database}" '
  BEGIN { image_found=0; runner_image_found=0; ipc_found=0; redis_test_found=0 }
  /^HARNESS_IMAGE=/ { print "HARNESS_IMAGE=" image; image_found=1; next }
  /^RELEASE_RUNNER_IMAGE=/ { print "RELEASE_RUNNER_IMAGE=" image; runner_image_found=1; next }
  /^RELEASE_RUNNER_TOKEN=/ { next }
  /^PROJECT_RUNTIME_CONTRACT=/ { next }
  /^PROJECT_RELEASE_IPC_ROOT=/ { print "PROJECT_RELEASE_IPC_ROOT=" ipc_root; ipc_found=1; next }
  /^REDIS_TEST_DATABASE=/ { print "REDIS_TEST_DATABASE=" redis_test; redis_test_found=1; next }
  { print }
  END {
    if (!image_found) print "HARNESS_IMAGE=" image
    if (!runner_image_found) print "RELEASE_RUNNER_IMAGE=" image
    if (!ipc_found) print "PROJECT_RELEASE_IPC_ROOT=" ipc_root
    if (!redis_test_found) print "REDIS_TEST_DATABASE=" redis_test
  }
' "${env_file}" >"${temp_env}"
chmod 0600 "${temp_env}"
chown --reference="${env_file}" "${temp_env}"
mv -- "${temp_env}" "${env_file}"
install --preserve-timestamps -- "${template_compose}" "${compose_file}"
chown --reference="${backup_compose}" "${compose_file}"

registry_header="$(head -n 1 "${registry_file}")"
if [[ "${registry_header}" != *$'\tredis_test_database' ]]; then
  registry_temp="$(mktemp "${DELIVERY_ROOT}/registry/.projects.tsv.XXXXXX")"
  awk 'NR == 1 {print $0 "\tredis_test_database"; next} {print $0 "\t"}' \
    "${registry_file}" >"${registry_temp}"
  chown --reference="${registry_file}" "${registry_temp}"
  chmod --reference="${registry_file}" "${registry_temp}"
  mv -- "${registry_temp}" "${registry_file}"
fi
registry_temp="$(mktemp "${DELIVERY_ROOT}/registry/.projects.tsv.XXXXXX")"
awk -F '\t' -v OFS='\t' -v slug="${slug}" -v redis_test="${redis_test_database}" '
  $1 == slug {$12 = redis_test}
  {print}
' "${registry_file}" >"${registry_temp}"
chown --reference="${registry_file}" "${registry_temp}"
chmod --reference="${registry_file}" "${registry_temp}"
mv -- "${registry_temp}" "${registry_file}"

render_release_contract \
  "${slug}" "${project_root}" "${project_root}/workspace" "${env_file}" "${contract_file}"
chown --reference="${env_file}" "${contract_file}"
chmod 0640 "${contract_file}"
compose config --quiet || die "Controlled release Compose validation failed."
compose up --detach release-runner
runner_container="$(compose ps --quiet release-runner)"
[[ -n "${runner_container}" ]] || die "Controlled release runner container was not created."
runner_ready=false
for _attempt in {1..30}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${runner_container}" 2>/dev/null)" == 'healthy' ]]; then
    runner_ready=true
    break
  fi
  sleep 1
done
[[ "${runner_ready}" == true ]] || die "Controlled release runner did not become healthy."

runner_capability="$(docker exec "${runner_container}" forge-release capability)" \
  || die "Controlled release capability socket did not pass its black-box probe."
jq --exit-status '.ok == true' <<<"${runner_capability}" >/dev/null \
  || die "Controlled release capability probe returned an invalid response."

harness_recreate_started=true
compose up --detach --force-recreate harness-upload release-runner harness
base_url="http://$(env_value FORGE_BIND_ADDRESS):$(env_value HARNESS_PORT)"
ready=false
for _attempt in {1..45}; do
  if curl --noproxy '*' --silent --show-error --fail --max-time 2 "${base_url}/" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "${ready}" == true ]] || die "Harness did not recover after controlled release activation."

harness_container="$(compose ps --quiet harness)"
runner_container="$(compose ps --quiet release-runner)"
[[ -n "${harness_container}" && -n "${runner_container}" ]] || die "Controlled release containers are missing."
if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "${harness_container}" \
  | grep -Eq '^(/var/run/docker.sock|/srv/forge-delivery/secrets|/srv/forge-delivery/projects/'"${slug}"'/ops)$'; then
  die "Harness still exposes a forbidden Docker, secret or ops mount."
fi
docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "${runner_container}" \
  | grep -Fxq '/var/run/docker.sock' \
  || die "Controlled release runner does not have its required Docker endpoint."
docker network rm "${compose_project}_release" >/dev/null 2>&1 || true

rollback_armed=false
trap - EXIT
cleanup
log "Controlled release is active for ${slug}; Harness no longer receives Docker or shared-service secrets."
log "Runner capability socket passed its black-box probe; normal project preflight remains a Harness-visible release gate."
log "Rollback environment: ${backup_env}; Compose: ${backup_compose}; registry: ${backup_registry}."
