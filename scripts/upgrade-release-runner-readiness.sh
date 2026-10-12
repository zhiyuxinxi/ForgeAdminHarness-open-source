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

for command_name in awk docker git grep jq mktemp sha256sum stat; do
  require_command "${command_name}"
done
require_docker_access
acquire_harness_image_upgrade_lock

project_root="${DELIVERY_ROOT}/projects/${slug}"
ops_root="${project_root}/ops"
workspace_root="${project_root}/workspace"
env_file="${ops_root}/project.env"
compose_file="${ops_root}/compose.yaml"
contract_file="${ops_root}/runtime-contract.json"
template_compose_file="${REPO_ROOT}/templates/project/compose.yaml"
[[ -d "${workspace_root}" && -f "${env_file}" && -f "${compose_file}" ]] \
  || die "Project is missing or incomplete: ${project_root}"
assert_managed_path "${project_root}"

env_value() {
  release_contract_env_value "${env_file}" "$1"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

current_image="$(env_value RELEASE_RUNNER_IMAGE)"
if [[ -z "${current_image}" ]]; then current_image="$(env_value HARNESS_IMAGE)"; fi
target_image="${RELEASE_RUNNER_IMAGE}"
target_operator_image="${RELEASE_DB_OPERATOR_IMAGE}"
compose_project="$(env_value COMPOSE_PROJECT_NAME)"
[[ -n "${current_image}" && -n "${target_image}" ]] \
  || die "Release Runner image configuration is incomplete."
[[ "${target_operator_image}" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*(:[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$ ]] \
  || die "Release database operator image must be pinned by sha256 digest."
[[ "${compose_project}" == "forge-${slug}" ]] || die "Unexpected Compose project for ${slug}."
compose config --services | grep -Fxq 'release-runner' \
  || die "Project Compose does not provide the controlled release runner."
if [[ -n "$(project_git_readonly "${workspace_root}" status --porcelain=v1 --untracked-files=all)" ]]; then
  log "Project workspace is active/dirty; upgrading only the platform Runner without approving or deploying application inputs."
fi

docker image inspect "${current_image}" >/dev/null 2>&1 \
  || die "Current Release Runner image is unavailable: ${current_image}"
docker image inspect "${target_operator_image}" >/dev/null 2>&1 \
  || die "Pinned test-database operator image is unavailable: ${target_operator_image}"

# Migrate only an exact reviewed project Compose. vpn20/vpn21 precede the
# split Runner image; vpn22 is the deployed structured-diagnosis template.
vpn20_compose_hash='ef96f87a0b25c2a0b9792284f194350537e302761127937b4cae4951f7899234'
vpn21_compose_hash='cfd253a5b8d2348e8db45119fdddeca55ba1c1c2497ee5f960d4b70527f25802'
vpn22_compose_hash='ad54a64585364c29ac4578bce304df9e90666cba50f3bcea84a5e2786b8da7c7'
current_compose_hash="$(sha256sum "${compose_file}" | awk '{print $1}')"
target_compose_hash="$(sha256sum "${template_compose_file}" | awk '{print $1}')"
if [[ "${current_compose_hash}" != "${vpn20_compose_hash}" \
  && "${current_compose_hash}" != "${vpn21_compose_hash}" \
  && "${current_compose_hash}" != "${vpn22_compose_hash}" \
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
  log "Reusing verified release-runner image ${target_image}."
else
  log "Building immutable release-runner image ${target_image} from ${current_image}."
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
  'test -r /usr/local/lib/release-runner.mjs && node --check /usr/local/lib/release-runner.mjs && test -x /usr/local/lib/test-db-operator.sh && command -v forge-release >/dev/null && test "${MAVEN_OPTS:-}" = "-Dmaven.repo.local=/home/node/.m2/repository -Djansi.tmpdir=/home/node/.cache/jansi"' \
  || die "Target image does not contain the reviewed release-runner capability."

runner_container="$(compose ps --quiet release-runner)"
[[ -n "${runner_container}" ]] || die "Current release-runner container is missing."
harness_container_before="$(compose ps --quiet harness)"
upload_container_before="$(compose ps --quiet harness-upload)"
[[ -n "${harness_container_before}" && -n "${upload_container_before}" ]] \
  || die "Harness or upload container is missing; this Runner-only upgrade will not repair them implicitly."
capability="$(docker exec "${runner_container}" forge-release capability)" \
  || die "Current release-runner capability probe failed."
jq --exit-status '.ok == true and .active == false' <<<"${capability}" >/dev/null \
  || die "A controlled release is active; retry only after it completes."

timestamp="$(date '+%Y%m%d%H%M%S')"
backup_env="${env_file}.pre-release-readiness-${timestamp}-$$"
backup_contract="${contract_file}.pre-release-readiness-${timestamp}-$$"
backup_compose="${compose_file}.pre-release-readiness-${timestamp}-$$"
install -m 0600 -- "${env_file}" "${backup_env}"
chown --reference="${env_file}" "${backup_env}"
install --preserve-timestamps -- "${compose_file}" "${backup_compose}"
chown --reference="${compose_file}" "${backup_compose}"
if [[ -f "${contract_file}" ]]; then
  install --preserve-timestamps -- "${contract_file}" "${backup_contract}"
  chown --reference="${contract_file}" "${backup_contract}"
fi

temp_env="$(mktemp "${ops_root}/.project.env.release-readiness.XXXXXX")"
rollback_armed=false
rollback_attempted=false
cleanup() {
  rm -f -- "${temp_env}"
}
rollback() {
  if [[ "${rollback_armed}" != true || "${rollback_attempted}" == true ]]; then return; fi
  rollback_attempted=true
  set +e
  warn "Release-runner readiness upgrade failed; restoring the previous runtime."
  install -m 0600 -- "${backup_env}" "${env_file}"
  chown --reference="${backup_env}" "${env_file}"
  install --preserve-timestamps -- "${backup_compose}" "${compose_file}"
  chown --reference="${backup_compose}" "${compose_file}"
  if [[ -f "${backup_contract}" ]]; then
    install --preserve-timestamps -- "${backup_contract}" "${contract_file}"
    chown --reference="${backup_contract}" "${contract_file}"
  fi
  compose up --detach --force-recreate --no-deps release-runner >/dev/null 2>&1 || true
}
on_exit() {
  local status=$?
  if ((status != 0)); then rollback; fi
  cleanup
  return "${status}"
}
trap on_exit EXIT

awk -v image="${target_image}" -v operator_image="${target_operator_image}" '
  BEGIN { found=0; operator_found=0 }
  /^RELEASE_RUNNER_IMAGE=/ { print "RELEASE_RUNNER_IMAGE=" image; found=1; next }
  /^RELEASE_DB_OPERATOR_IMAGE=/ { print "RELEASE_DB_OPERATOR_IMAGE=" operator_image; operator_found=1; next }
  { print }
  END {
    if (!found) print "RELEASE_RUNNER_IMAGE=" image
    if (!operator_found) print "RELEASE_DB_OPERATOR_IMAGE=" operator_image
  }
' "${env_file}" >"${temp_env}"
chmod 0600 "${temp_env}"
chown --reference="${env_file}" "${temp_env}"
mv -- "${temp_env}" "${env_file}"
install -d -m 0700 -o "$(stat -c '%u' "${project_root}")" -g "$(stat -c '%g' "${project_root}")" \
  "${project_root}/backups/test-database-snapshots"
install --preserve-timestamps -- "${template_compose_file}" "${compose_file}"
chown --reference="${backup_compose}" "${compose_file}"
render_release_contract \
  "${slug}" "${project_root}" "${workspace_root}" "${env_file}" "${contract_file}"
chown --reference="${env_file}" "${contract_file}"
chmod 0640 "${contract_file}"
compose config --quiet || die "Compose validation failed after the Runner image update."
rollback_armed=true
compose up --detach --force-recreate --no-deps release-runner

runner_container="$(compose ps --quiet release-runner)"
[[ -n "${runner_container}" ]] || die "Updated release-runner container is missing."
runner_ready=false
for _attempt in {1..30}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${runner_container}" 2>/dev/null)" == 'healthy' ]]; then
    runner_ready=true
    break
  fi
  sleep 1
done
[[ "${runner_ready}" == true ]] || die "Updated release-runner did not become healthy."
capability="$(docker exec "${runner_container}" forge-release capability)" \
  || die "Updated release-runner capability probe failed."
jq --exit-status '.ok == true and .active == false' <<<"${capability}" >/dev/null \
  || die "Updated release-runner returned an invalid capability result."
set +e
preflight="$(docker exec "${runner_container}" forge-release preflight 2>&1)"
preflight_status=$?
set -e
jq --exit-status '
  (.ok == true
    and (.result.workspaceClean | type) == "boolean"
    and .result.testDatabaseLifecycle.mode == "snapshot-restore-on-failure"
    and .result.testDatabaseLifecycle.backupRequired == true
    and .result.testDatabaseLifecycle.restoreOnFailure == true
    and .result.testDatabaseLifecycle.fullReplaySupported == false) or
  (.ok == false and .error.stage == "preflight" and (.error.code | type) == "string")
' <<<"${preflight}" >/dev/null \
  || die "Updated release-runner did not return a structured preflight result."
if ((preflight_status != 0)); then
  log "Updated Runner correctly retained the application preflight gate; no application release was attempted."
fi
diagnosis="$(docker exec "${runner_container}" forge-release diagnose)" \
  || die "Updated release-runner diagnosis probe failed."
jq --exit-status '.ok == true and .result.active == false' <<<"${diagnosis}" >/dev/null \
  || die "Updated release-runner returned an invalid diagnosis result."
[[ "$(compose ps --quiet harness)" == "${harness_container_before}" \
  && "$(compose ps --quiet harness-upload)" == "${upload_container_before}" ]] \
  || die "Harness or upload container changed during the Runner-only upgrade."

rollback_armed=false
trap - EXIT
cleanup
log "Release-runner readiness upgrade is active for ${slug}; Harness and upload containers were not recreated."
log "Rollback environment: ${backup_env}; Compose: ${backup_compose}; contract: ${backup_contract}."
