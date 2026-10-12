#!/usr/bin/env bash

set -Eeuo pipefail

CONFIG_FILE=/etc/forge-delivery-mobile-runtime-deploy.conf
[[ "${EUID}" -eq 0 ]] || { printf 'Root deployment helper must run through sudo.\n' >&2; exit 2; }
[[ -f "${CONFIG_FILE}" && ! -L "${CONFIG_FILE}" ]] \
  || { printf 'Mobile runtime deployment helper configuration is missing or unsafe.\n' >&2; exit 2; }
[[ "$(stat -c '%U:%G:%a' "${CONFIG_FILE}")" == 'root:root:600' ]] \
  || { printf 'Mobile runtime deployment helper configuration permissions are invalid.\n' >&2; exit 2; }
# Root-owned configuration installed by the reviewed one-time bootstrap.
# shellcheck disable=SC1090
source "${CONFIG_FILE}"

for required_name in \
  DEPLOY_USER DELIVERY_OWNER DELIVERY_GROUP PROJECT_SLUG CANDIDATE_TASKSPACE_ID \
  CANDIDATE_COMMIT ARTIFACT_NAME EXPECTED_ARTIFACT_SHA256 INCOMING_ROOT \
  PLATFORM_ROOT DELIVERY_ROOT; do
  [[ -n "${!required_name:-}" ]] || { printf 'Missing helper setting: %s\n' "${required_name}" >&2; exit 2; }
done
[[ "${SUDO_USER:-}" == "${DEPLOY_USER}" ]] \
  || { printf 'Deployment helper caller is not authorized.\n' >&2; exit 2; }
[[ "${DEPLOY_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ \
  && "${DELIVERY_OWNER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ \
  && "${DELIVERY_GROUP}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ \
  && "${PROJECT_SLUG}" == 'forge-base' \
  && "${CANDIDATE_TASKSPACE_ID}" =~ ^c-[a-f0-9]{24}$ \
  && "${CANDIDATE_COMMIT}" =~ ^[a-f0-9]{40}$ \
  && "${ARTIFACT_NAME}" == 'forge-mobile-runtime-vpn51-predeploy.tar.gz' \
  && "${EXPECTED_ARTIFACT_SHA256}" =~ ^[a-f0-9]{64}$ \
  && "${INCOMING_ROOT}" == '/srv/forge-delivery/platform-releases/incoming' \
  && "${PLATFORM_ROOT}" == '/opt/forge-delivery-platform' \
  && "${DELIVERY_ROOT}" == '/srv/forge-delivery' ]] \
  || { printf 'Mobile runtime deployment helper configuration values are invalid.\n' >&2; exit 2; }

project_root="${DELIVERY_ROOT}/projects/${PROJECT_SLUG}"
workspace="${project_root}/workspace"
candidate_workspace="${project_root}/taskspaces/${CANDIDATE_TASKSPACE_ID}/workspace"
env_file="${project_root}/ops/project.env"
compose_file="${project_root}/ops/compose.yaml"
contract_file="${project_root}/ops/runtime-contract.json"
incoming_artifact="${INCOMING_ROOT}/${ARTIFACT_NAME}"
release_root="${DELIVERY_ROOT}/platform-releases/vpn51-${EXPECTED_ARTIFACT_SHA256:0:12}"
source_root="${release_root}/source"

die() {
  printf '[forge-mobile-deploy-root] ERROR: %s\n' "$*" >&2
  exit 1
}

require_commands() {
  local command_name
  for command_name in awk curl diff docker find flock git grep install jq rsync runuser sha256sum stat tar; do
    command -v "${command_name}" >/dev/null 2>&1 || die "Missing remote command: ${command_name}"
  done
}

acquire_harness_image_lock() {
  local lock_path="${DELIVERY_ROOT}/registry/harness-image-upgrade.lock"
  [[ -d "${DELIVERY_ROOT}/registry" && ! -L "${lock_path}" ]] \
    || die 'Harness image upgrade lock path is unsafe.'
  (umask 0007; : >>"${lock_path}")
  [[ -f "${lock_path}" && ! -L "${lock_path}" \
    && "$(stat -c '%h' -- "${lock_path}")" == 1 ]] \
    || die 'Harness image upgrade lock is unsafe.'
  chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${lock_path}"
  chmod 0660 -- "${lock_path}"
  exec 9>>"${lock_path}"
  flock --exclusive --nonblock 9 \
    || die 'Another Harness image build or platform cutover is active.'
}

env_value() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

credential_check() {
  require_commands
  docker info >/dev/null
  docker compose version >/dev/null
  [[ -d "${PLATFORM_ROOT}" && -d "${workspace}/.git" && -f "${env_file}" \
    && -d "${candidate_workspace}/.git" ]] \
    || die 'The platform, target project or candidate TaskSpace is incomplete.'
  [[ "$(stat -c '%U:%G:%a' "${PLATFORM_ROOT}")" == "${DELIVERY_OWNER}:${DELIVERY_GROUP}:750" ]] \
    || die 'The platform root ownership or traversal mode is invalid.'
  [[ -d "${INCOMING_ROOT}" \
    && "$(stat -c '%U:%G:%a' "${INCOMING_ROOT}")" == "${DEPLOY_USER}:${DELIVERY_GROUP}:2700" ]] \
    || die 'The root-managed deployment inbox is missing or has invalid permissions.'
}

preflight() {
  credential_check
  runuser -u "${DELIVERY_OWNER}" -- bash "${PLATFORM_ROOT}/scripts/project-gitctl.sh" \
    "${PROJECT_SLUG}" status --require-synchronized >/dev/null
  [[ -z "$(runuser -u "${DELIVERY_OWNER}" -- env GIT_OPTIONAL_LOCKS=0 git -C "${workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
    || die 'The integration workspace is dirty.'
  [[ -z "$(runuser -u "${DELIVERY_OWNER}" -- env GIT_OPTIONAL_LOCKS=0 git -C "${candidate_workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
    || die 'The mobile runtime candidate TaskSpace is dirty.'
  [[ "$(runuser -u "${DELIVERY_OWNER}" -- env GIT_OPTIONAL_LOCKS=0 git -C "${candidate_workspace}" rev-parse HEAD)" == "${CANDIDATE_COMMIT}" ]] \
    || die 'The mobile runtime candidate commit changed after review.'
  integration_head="$(runuser -u "${DELIVERY_OWNER}" -- env GIT_OPTIONAL_LOCKS=0 git -C "${workspace}" rev-parse HEAD)"
  runuser -u "${DELIVERY_OWNER}" -- env GIT_OPTIONAL_LOCKS=0 git -C "${candidate_workspace}" merge-base --is-ancestor \
    "${integration_head}" "${CANDIDATE_COMMIT}" \
    || die 'The mobile runtime candidate no longer includes the integration HEAD.'
  [[ ! -e "${project_root}/taskspaces/.broker/release.lock" ]] \
    || die 'A TaskSpace release lock is present.'
  runner_socket="${project_root}/ops/release-ipc/runner.sock"
  [[ -S "${runner_socket}" ]] || die 'Release Runner socket is unavailable.'
  curl --fail --silent --show-error --max-time 5 --unix-socket "${runner_socket}" \
    http://localhost/healthz | jq -e '.ok == true and .active == false' >/dev/null \
    || die 'Release Runner is active or unhealthy.'
  printf 'preflight project=%s integration=%s candidate=%s taskspace=%s\n' \
    "${PROJECT_SLUG}" "${integration_head}" "${CANDIDATE_COMMIT}" "${CANDIDATE_TASKSPACE_ID}"
}

prepare_release_source() {
  [[ -f "${incoming_artifact}" && ! -L "${incoming_artifact}" ]] \
    || die 'The fixed deployment inbox does not contain the reviewed artifact.'
  [[ "$(stat -c '%U:%G:%a' "${incoming_artifact}")" == "${DEPLOY_USER}:${DELIVERY_GROUP}:600" ]] \
    || die 'Incoming artifact ownership or mode is invalid.'
  install -d -m 0700 -o root -g root "${release_root}"
  root_artifact="${release_root}/${ARTIFACT_NAME}"
  install -m 0600 -o root -g root "${incoming_artifact}" "${root_artifact}.incoming"
  [[ "$(sha256sum "${root_artifact}.incoming" | awk '{print $1}')" == "${EXPECTED_ARTIFACT_SHA256}" ]] \
    || die 'Incoming artifact checksum does not match the root-pinned release hash.'
  mv -- "${root_artifact}.incoming" "${root_artifact}"
  if tar -tzf "${root_artifact}" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
    die 'Artifact contains an unsafe path.'
  fi
  if [[ -d "${source_root}" ]]; then
    [[ -f "${release_root}/artifact.sha256" \
      && "$(cat "${release_root}/artifact.sha256")" == "${EXPECTED_ARTIFACT_SHA256}" ]] \
      || die 'Existing release staging directory has different content.'
  else
    install -d -m 0700 -o root -g root "${source_root}"
    tar --extract --gzip --no-same-owner --file "${root_artifact}" --directory "${source_root}"
    printf '%s\n' "${EXPECTED_ARTIFACT_SHA256}" >"${release_root}/artifact.sha256"
    chmod 0600 "${release_root}/artifact.sha256"
  fi
  for required in \
    config/versions.env \
    docker/harness/Dockerfile.overlay \
    docker/harness/image-build-inputs.json \
    docker/harness/validate-image-build-inputs.mjs \
    scripts/lib/common.sh \
    scripts/lib/harness-image-verifier.sh \
    scripts/upgrade-mobile-runtime.sh \
    scripts/lib/release-contract.sh \
    templates/project/compose.yaml; do
    [[ -f "${source_root}/${required}" ]] || die "Artifact is missing ${required}."
  done
}

deploy() {
  preflight
  acquire_harness_image_lock
  prepare_release_source
  # shellcheck disable=SC1091
  source "${source_root}/config/versions.env"
  # shellcheck disable=SC1091
  source "${source_root}/scripts/lib/common.sh"
  # shellcheck disable=SC1091
  source "${source_root}/scripts/lib/harness-image-verifier.sh"
  target_image="${RELEASE_RUNNER_IMAGE}"
  current_image="$(env_value RELEASE_RUNNER_IMAGE)"
  [[ -n "${current_image}" && -n "${target_image}" ]] || die 'Image configuration is incomplete.'
  current_image_id="$(docker image inspect --format '{{.Id}}' "${current_image}")"
  [[ "${current_image_id}" == sha256:* ]] || die 'Current image has no immutable ID.'
  current_image_build_ref="$(resolve_local_docker_build_ref "${current_image}" "${current_image_id}")"
  if docker image inspect "${target_image}" >/dev/null 2>&1; then
    [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image}")" == "${HARNESS_IMAGE_REVISION}" \
      && "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${target_image}")" == "${HARNESS_SKILL_BUNDLE_VERSION}" ]] \
      || die 'Existing target image has unexpected provenance.'
  else
    docker image inspect "${current_image}" >/dev/null
    docker build \
      --build-arg "HARNESS_BASE_IMAGE=${current_image_build_ref}" \
      --build-arg "HARNESS_BASE_IMAGE_ID=${current_image_id}" \
      --build-arg "DSH_VERSION=${DSH_VERSION}" \
      --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
      --build-arg 'INSTALL_DOCUMENT_DEPENDENCIES=true' \
      --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" \
      --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
      --build-arg "HARNESS_RUNTIME_PROFILE=${HARNESS_RUNTIME_PROFILE}" \
      --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
      --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" \
      --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
      --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" \
      --tag "${target_image}" \
      --file "${source_root}/docker/harness/Dockerfile.overlay" \
      "${source_root}"
  fi
  verify_target_harness_image "${target_image}" "${current_image_id}"
  docker run --rm --entrypoint sh "${target_image}" -c \
    'command -v forge-release >/dev/null && node --check /usr/local/lib/taskspace-broker.mjs && node --check /usr/local/lib/release-runner.mjs && node --check /usr/local/lib/release-policy.mjs' \
    || die 'Target image mobile release capability verification failed.'

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_root="${DELIVERY_ROOT}/platform-backups/pre-mobile-runtime-vpn51-${timestamp}"
  install -d -m 0700 -o root -g root "${backup_root}/platform"
  rsync -a "${PLATFORM_ROOT}/" "${backup_root}/platform/"

  rollback_armed=true
  rollback() {
    status=$?
    trap - EXIT
    if ((status != 0)) && [[ "${rollback_armed}" == true ]]; then
      printf 'Mobile runtime deployment failed; restoring platform source from %s.\n' "${backup_root}" >&2
      rsync -a --checksum --delete "${backup_root}/platform/" "${PLATFORM_ROOT}/" || true
      chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${PLATFORM_ROOT}" || true
      chmod 0750 "${PLATFORM_ROOT}" || true
    fi
    exit "${status}"
  }
  trap rollback EXIT

  rsync -a --checksum "${source_root}/" "${PLATFORM_ROOT}/"
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${PLATFORM_ROOT}"
  chmod 0750 "${PLATFORM_ROOT}"
  bash "${PLATFORM_ROOT}/scripts/upgrade-mobile-runtime.sh" \
    "${PROJECT_SLUG}" \
    --candidate-taskspace "${CANDIDATE_TASKSPACE_ID}" \
    --confirm-maintenance-window mobile-runtime

  rollback_armed=false
  trap - EXIT
  printf 'deployed project=%s image=%s candidate=%s backup=%s\n' \
    "${PROJECT_SLUG}" "${target_image}" "${CANDIDATE_COMMIT}" "${backup_root}"
}

verify() {
  credential_check
  # shellcheck disable=SC1091
  source "${PLATFORM_ROOT}/config/versions.env"
  runuser -u "${DELIVERY_OWNER}" -- bash "${PLATFORM_ROOT}/scripts/project-gitctl.sh" \
    "${PROJECT_SLUG}" status --require-synchronized >/dev/null
  [[ "$(env_value RELEASE_RUNNER_IMAGE)" == "${RELEASE_RUNNER_IMAGE}" ]] \
    || die 'Project does not reference the vpn51 mobile Runner image.'
  [[ "$(jq -r '.taskspaceId' "${project_root}/ops/mobile-runtime-candidate.json")" == "${CANDIDATE_TASKSPACE_ID}" \
    && "$(jq -r '.candidateCommit' "${project_root}/ops/mobile-runtime-candidate.json")" == "${CANDIDATE_COMMIT}" ]] \
    || die 'The installed runtime contract is not bound to the reviewed candidate.'
  jq -e '.release.allowedReleaseServices == ["forge-admin", "forge-app", "forge-flow", "forge-ui"]
    and (.release.allowedComposeServices | index("forge-app")) != null' "${contract_file}" >/dev/null \
    || die 'The runtime contract does not expose the reviewed four-service application stack.'

  broker="$(compose ps --quiet taskspace-broker)"
  runner="$(compose ps --quiet release-runner)"
  [[ -n "${broker}" && -n "${runner}" ]] || die 'A mobile runtime control-plane container is missing.'
  target_image_id="$(docker image inspect --format '{{.Id}}' "${RELEASE_RUNNER_IMAGE}")"
  for container in "${broker}" "${runner}"; do
    [[ "$(docker inspect --format '{{.Image}}' "${container}")" == "${target_image_id}" \
      && "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" == healthy ]] \
      || die 'A mobile runtime control-plane container has the wrong image or health state.'
  done
  if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "${broker}" \
      | grep -Fxq '/var/run/docker.sock'; then
    die 'Broker unexpectedly receives the Docker socket.'
  fi
  if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "${runner}" \
      | grep -Fxq '/run/forge-git'; then
    die 'Runner unexpectedly receives the project Deploy Key.'
  fi
  [[ -z "$(compose ps --quiet forge-app)" ]] \
    || die 'forge-app started before the reviewed business candidate release.'
  for service in forge-admin forge-flow forge-ui; do
    [[ -n "$(compose ps --quiet "${service}")" ]] || die "Existing application service is missing: ${service}"
  done
  bind_address="$(env_value FORGE_BIND_ADDRESS)"
  forge_port="$(env_value FORGE_UI_PORT)"
  curl --noproxy '*' --fail --silent --show-error --max-time 10 \
    "http://${bind_address}:${forge_port}/forge/login" >/dev/null
  printf 'verified project=%s runnerImage=%s candidate=%s forgeUrl=http://%s:%s/forge/login\n' \
    "${PROJECT_SLUG}" "${RELEASE_RUNNER_IMAGE}" "${CANDIDATE_COMMIT}" "${bind_address}" "${forge_port}"
}

action="${1:-}"
[[ $# -eq 1 ]] || die 'Usage: forge-delivery-mobile-runtime-deploy <credential-check|preflight|deploy|verify>'
case "${action}" in
  credential-check) credential_check ;;
  preflight) preflight ;;
  deploy) deploy ;;
  verify) verify ;;
  *) die "Unsupported deployment helper command: ${action}" ;;
esac
