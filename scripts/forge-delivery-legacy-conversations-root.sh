#!/usr/bin/env bash

set -Eeuo pipefail

CONFIG_FILE=/etc/forge-delivery-legacy-conversations-deploy.conf
[[ "${EUID}" -eq 0 ]] || { printf 'Root deployment helper must run through sudo.\n' >&2; exit 2; }
[[ -f "${CONFIG_FILE}" && ! -L "${CONFIG_FILE}" ]] \
  || { printf 'Legacy-conversation deployment helper configuration is missing or unsafe.\n' >&2; exit 2; }
[[ "$(stat -c '%U:%G:%a' "${CONFIG_FILE}")" == 'root:root:600' ]] \
  || { printf 'Legacy-conversation deployment helper configuration permissions are invalid.\n' >&2; exit 2; }
# shellcheck disable=SC1090
source "${CONFIG_FILE}"

for required_name in DEPLOY_USER DELIVERY_OWNER DELIVERY_GROUP PROJECT_SLUG PROJECT_DISPLAY_NAME \
  TARGET_IMAGE TARGET_REVISION ARTIFACT_NAME EXPECTED_ARTIFACT_SHA256 EXPECTED_GIT_COMMIT \
  CURRENT_GATEWAY_IMAGE_ID CURRENT_ARCHIVE_IMAGE_ID FOUNDATION_IMAGE ARCHIVE_BASE_IMAGE_ID \
  INCOMING_ROOT PLATFORM_ROOT DELIVERY_ROOT; do
  [[ -n "${!required_name:-}" ]] || { printf 'Missing helper setting: %s\n' "${required_name}" >&2; exit 2; }
done
[[ "${SUDO_USER:-}" == "${DEPLOY_USER}" ]] || { printf 'Deployment helper caller is not authorized.\n' >&2; exit 2; }
[[ "${DEPLOY_USER}" == forge && "${DELIVERY_OWNER}" == forge && "${DELIVERY_GROUP}" == forgeops \
  && "${PROJECT_SLUG}" == forge-base && "${PROJECT_DISPLAY_NAME}" == 示例客户 \
  && "${TARGET_IMAGE}" == forge-delivery/deepseek-harness:0.1.1-rc.2-vpn55 \
  && "${TARGET_REVISION}" == vpn-legacy-conversation-surface-55 \
  && "${ARTIFACT_NAME}" == forge-legacy-conversations-vpn55.tar.gz \
  && "${EXPECTED_ARTIFACT_SHA256}" =~ ^[a-f0-9]{64}$ && "${EXPECTED_GIT_COMMIT}" =~ ^[a-f0-9]{40}$ \
  && "${CURRENT_GATEWAY_IMAGE_ID}" =~ ^sha256:[a-f0-9]{64}$ \
  && "${CURRENT_ARCHIVE_IMAGE_ID}" =~ ^sha256:[a-f0-9]{64}$ \
  && "${FOUNDATION_IMAGE}" == forge-delivery/deepseek-harness:0.1.1-rc.2-vpn51 \
  && "${ARCHIVE_BASE_IMAGE_ID}" =~ ^sha256:[a-f0-9]{64}$ \
  && "${INCOMING_ROOT}" == /srv/forge-delivery/platform-releases/incoming \
  && "${PLATFORM_ROOT}" == /opt/forge-delivery-platform && "${DELIVERY_ROOT}" == /srv/forge-delivery ]] \
  || { printf 'Legacy-conversation deployment helper configuration values are invalid.\n' >&2; exit 2; }

incoming_artifact="${INCOMING_ROOT}/${ARTIFACT_NAME}"
release_root="${DELIVERY_ROOT}/platform-releases/vpn55-${EXPECTED_ARTIFACT_SHA256:0:12}"
source_root="${release_root}/source"
control_env="${DELIVERY_ROOT}/conversation-control-plane/control-plane.env"
control_compose="${PLATFORM_ROOT}/templates/conversation-control-plane/compose.yaml"
state_file="${DELIVERY_ROOT}/conversation-control-plane/state/state.json"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
archive_env="${DELIVERY_ROOT}/projects/${PROJECT_SLUG}/taskspaces/legacy-history-20260827/task.env"
source_home="${DELIVERY_ROOT}/projects/${PROJECT_SLUG}/dsh-home"

die() { printf '[forge-legacy-conversations-deploy-root] ERROR: %s\n' "$*" >&2; exit 1; }
require_commands() {
  local command_name
  for command_name in awk cmp curl docker find flock grep install jq rsync sha256sum stat tar zstd; do
    command -v "${command_name}" >/dev/null 2>&1 || die "Missing remote command: ${command_name}"
  done
}
env_value() { local key="$1" file="$2"; awk -F= -v key="${key}" '$1==key {sub(/^[^=]*=/,"");print;exit}' "${file}"; }
compose() { docker compose --env-file "${control_env}" --file "${control_compose}" "$@"; }

credential_check() {
  require_commands
  docker info >/dev/null
  docker compose version >/dev/null
  [[ -d "${PLATFORM_ROOT}" && -f "${control_env}" && -f "${control_compose}" \
    && -f "${state_file}" && -f "${registry_file}" && -f "${archive_env}" ]] \
    || die 'The platform or legacy archive control plane is incomplete.'
  [[ "$(stat -c '%U:%G:%a' "${PLATFORM_ROOT}")" == "${DELIVERY_OWNER}:${DELIVERY_GROUP}:750" ]] \
    || die 'The platform root ownership or traversal mode is invalid.'
  [[ -d "${INCOMING_ROOT}" && "$(stat -c '%U:%G:%a' "${INCOMING_ROOT}")" == "${DEPLOY_USER}:${DELIVERY_GROUP}:2700" ]] \
    || die 'The root-managed deployment inbox is missing or has invalid permissions.'
}

preflight() {
  credential_check
  current_gateway_image="$(env_value HARNESS_IMAGE "${control_env}")"
  current_archive_image="$(env_value HARNESS_IMAGE "${archive_env}")"
  [[ "$(docker image inspect --format '{{.Id}}' "${current_gateway_image}")" == "${CURRENT_GATEWAY_IMAGE_ID}" ]] \
    || die 'The current Gateway image changed after review.'
  [[ "$(docker image inspect --format '{{.Id}}' "${current_archive_image}")" == "${CURRENT_ARCHIVE_IMAGE_ID}" ]] \
    || die 'The current legacy archive image changed after review.'
  [[ "$(docker image inspect --format '{{.Id}}' "${FOUNDATION_IMAGE}")" == "${ARCHIVE_BASE_IMAGE_ID}" ]] \
    || die 'The reviewed legacy archive foundation image changed after review.'
  [[ "$(find "${source_home}/sessions" -type f -name session.jsonl.zstd | wc -l)" -eq 38 ]] \
    || die 'The reviewed pre-platform session corpus is no longer exactly 38 files.'
  while IFS= read -r session_file; do zstd -t -q -- "${session_file}"; done \
    < <(find "${source_home}/sessions" -type f -name session.jsonl.zstd -print | sort)
  gateway="$(compose ps --quiet conversation-gateway)"
  [[ -n "${gateway}" && "$(docker inspect --format '{{.State.Health.Status}}' "${gateway}")" == healthy ]] \
    || die 'Conversation Gateway is not healthy before deployment.'
  printf 'preflight project=%s sessions=38 gatewayImage=%s archiveImage=%s foundation=%s\n' \
    "${PROJECT_SLUG}" "${current_gateway_image}" "${current_archive_image}" "${FOUNDATION_IMAGE}"
}

expected_files() {
  printf '%s\n' \
    docker/harness/Dockerfile.legacy-conversation-surface \
    docker/harness/apply-legacy-conversation-surface.mjs \
    docker/harness/conversation-policy.mjs \
    docker/harness/conversation-gateway/change-password.html \
    docker/harness/conversation-gateway/change-password.js \
    docker/harness/conversation-gateway/forbidden.html \
    docker/harness/conversation-gateway/gateway.css \
    docker/harness/conversation-gateway/gateway.js \
    docker/harness/conversation-gateway/index.html \
    docker/harness/conversation-gateway/login.html \
    docker/harness/conversation-gateway/login.js \
    scripts/lib/common.sh \
    scripts/lib/harness-image-verifier.sh \
    scripts/recover-legacy-shared-conversations.sh \
    scripts/upgrade-conversation-gateway-ui.sh
}

prepare_release_source() {
  [[ -f "${incoming_artifact}" && ! -L "${incoming_artifact}" ]] || die 'The fixed deployment inbox does not contain the reviewed artifact.'
  [[ "$(stat -c '%U:%G:%a' "${incoming_artifact}")" == "${DEPLOY_USER}:${DELIVERY_GROUP}:600" ]] \
    || die 'Incoming artifact ownership or mode is invalid.'
  install -d -m 0700 -o root -g root "${release_root}"
  root_artifact="${release_root}/${ARTIFACT_NAME}"
  install -m 0600 -o root -g root "${incoming_artifact}" "${root_artifact}.incoming"
  [[ "$(sha256sum "${root_artifact}.incoming" | awk '{print $1}')" == "${EXPECTED_ARTIFACT_SHA256}" ]] \
    || die 'Incoming artifact checksum does not match the root-pinned release hash.'
  mv -- "${root_artifact}.incoming" "${root_artifact}"
  if tar -tzf "${root_artifact}" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then die 'Artifact contains an unsafe path.'; fi
  if [[ ! -d "${source_root}" ]]; then
    install -d -m 0700 -o root -g root "${source_root}"
    tar --extract --gzip --no-same-owner --file "${root_artifact}" --directory "${source_root}"
  fi
  find "${source_root}" -type l -print -quit | grep -q . && die 'Artifact contains a symbolic link.'
  expected_files | sort >"${release_root}/expected-files"
  find "${source_root}" -type f -printf '%P\n' | sort >"${release_root}/actual-files"
  cmp "${release_root}/expected-files" "${release_root}/actual-files" || die 'Artifact file inventory differs from the fixed deployment allowlist.'
  printf '%s\n' "${EXPECTED_ARTIFACT_SHA256}" >"${release_root}/artifact.sha256"
  printf '%s\n' "${EXPECTED_GIT_COMMIT}" >"${release_root}/git-commit"
  chmod 0600 "${release_root}/artifact.sha256" "${release_root}/git-commit" "${release_root}/expected-files" "${release_root}/actual-files"
}

deploy() {
  preflight
  prepare_release_source
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  platform_backup="${DELIVERY_ROOT}/platform-backups/pre-legacy-conversations-source-${timestamp}"
  install -d -m 0700 -o root -g root "${platform_backup}/platform"
  rsync -a "${PLATFORM_ROOT}/" "${platform_backup}/platform/"
  rollback_armed=true
  rollback() {
    status=$?
    trap - EXIT
    if ((status != 0)) && [[ "${rollback_armed}" == true ]]; then
      printf 'Legacy-conversation deployment failed; restoring platform source from %s.\n' "${platform_backup}" >&2
      rsync -a --checksum --delete "${platform_backup}/platform/" "${PLATFORM_ROOT}/" || true
      chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${PLATFORM_ROOT}" || true
      chmod 0750 "${PLATFORM_ROOT}" || true
    fi
    exit "${status}"
  }
  trap rollback EXIT
  rsync -a --checksum "${source_root}/" "${PLATFORM_ROOT}/"
  chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${PLATFORM_ROOT}"
  chmod 0750 "${PLATFORM_ROOT}"
  CONVERSATION_GATEWAY_FOUNDATION_IMAGE="${FOUNDATION_IMAGE}" \
    bash "${PLATFORM_ROOT}/scripts/upgrade-conversation-gateway-ui.sh" \
    --confirm-maintenance-window conversation-gateway-ui
  printf 'deployedAt=%s\ncommit=%s\nartifactSha256=%s\nsourceBackup=%s\n' \
    "$(date --iso-8601=seconds)" "${EXPECTED_GIT_COMMIT}" "${EXPECTED_ARTIFACT_SHA256}" "${platform_backup}" \
    >"${release_root}/deployment.receipt"
  chmod 0600 "${release_root}/deployment.receipt"
  rollback_armed=false
  trap - EXIT
  printf 'deployed project=%s image=%s commit=%s sourceBackup=%s\n' \
    "${PROJECT_SLUG}" "${TARGET_IMAGE}" "${EXPECTED_GIT_COMMIT}" "${platform_backup}"
}

verify() {
  credential_check
  [[ "$(env_value HARNESS_IMAGE "${control_env}")" == "${TARGET_IMAGE}" \
    && "$(env_value HARNESS_IMAGE "${archive_env}")" == "${TARGET_IMAGE}" ]] \
    || die 'Gateway or archive TaskSpace does not reference the vpn55 image.'
  target_image_id="$(docker image inspect --format '{{.Id}}' "${TARGET_IMAGE}")"
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image_id}")" == "${TARGET_REVISION}" \
    && "$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-base-image-id"}}' "${target_image_id}")" == "${ARCHIVE_BASE_IMAGE_ID}" ]] \
    || die 'The active vpn55 image provenance is invalid.'
  gateway="$(compose ps --quiet conversation-gateway)"
  [[ -n "${gateway}" && "$(docker inspect --format '{{.Image}}' "${gateway}")" == "${target_image_id}" \
    && "$(docker inspect --format '{{.State.Health.Status}}' "${gateway}")" == healthy ]] \
    || die 'Conversation Gateway is not healthy on the vpn55 image.'
  archive_compose_project="$(env_value TASKSPACE_COMPOSE_PROJECT_NAME "${archive_env}")"
  archive_container="$(docker ps --filter "label=com.docker.compose.project=${archive_compose_project}" \
    --filter 'label=com.docker.compose.service=harness' --format '{{.ID}}' | head -n1)"
  if [[ -n "${archive_container}" ]]; then
    [[ "$(docker inspect --format '{{.Image}}' "${archive_container}")" == "${target_image_id}" ]] \
      || die 'The running legacy archive TaskSpace is not using the vpn55 image.'
  fi
  [[ "$(awk -F $'\t' -v slug="${PROJECT_SLUG}" '$1==slug {print $2}' "${registry_file}")" == "${PROJECT_DISPLAY_NAME}" ]] \
    || die 'The project display name is not 示例客户.'
  jq -e --arg project "${PROJECT_SLUG}" '
    . as $state
    | ($state.users[] | select(.username=="admin" and .role=="admin" and .status=="active").id) as $admin
    | ([.conversations[] | select(.projectSlug==$project and .ownerUserId==$admin and .conversationKind=="legacy-session")] | length)==38
      and ([.conversations[] | select(.id=="legacy-shared-history-20260827" and .hiddenFromList==true)] | length)==1
      and ([.conversations[] | select(.title=="周长庆-测试-危废功能开发")] | length)==1
      and ([.conversations[] | select(.title=="周长庆-测试-APP功能")] | length)==1
  ' "${state_file}" >/dev/null || die 'Recovered legacy conversation ownership or titles are incomplete.'
  latest_backup="$(find "${DELIVERY_ROOT}/platform-backups" -maxdepth 1 -type d -name 'pre-conversation-gateway-ui-*' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
  [[ -n "${latest_backup}" && -f "${latest_backup}/deployment-result.json" ]] || die 'Deployment rollback evidence is unavailable.'
  cmp "${latest_backup}/protected-container-ids.before" "${latest_backup}/protected-container-ids.after" \
    || die 'Protected project or active TaskSpace container identities changed.'
  bind_address="$(env_value CONVERSATION_GATEWAY_BIND_ADDRESS "${control_env}")"
  gateway_port="$(env_value CONVERSATION_GATEWAY_PORT "${control_env}")"
  curl --noproxy '*' --fail --silent --show-error --max-time 10 \
    "http://${bind_address}:${gateway_port}/healthz" | jq -e '.ok==true' >/dev/null \
    || die 'Gateway health endpoint did not pass after deployment.'
  printf 'verified project=%s displayName=%s conversations=38 image=%s imageId=%s rollback=%s\n' \
    "${PROJECT_SLUG}" "${PROJECT_DISPLAY_NAME}" "${TARGET_IMAGE}" "${target_image_id}" "${latest_backup}"
}

action="${1:-}"
[[ $# -eq 1 ]] || die 'Usage: forge-delivery-legacy-conversations-deploy <credential-check|preflight|deploy|verify>'
case "${action}" in
  credential-check) credential_check ;;
  preflight) preflight ;;
  deploy) deploy ;;
  verify) verify ;;
  *) die "Unsupported deployment helper command: ${action}" ;;
esac
