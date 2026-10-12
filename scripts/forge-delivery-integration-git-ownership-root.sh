#!/usr/bin/env bash

set -Eeuo pipefail

CONFIG_FILE=/etc/forge-delivery-integration-git-ownership-deploy.conf
[[ "${EUID}" -eq 0 ]] || { printf 'Root deployment helper must run through sudo.\n' >&2; exit 2; }
[[ -f "${CONFIG_FILE}" && ! -L "${CONFIG_FILE}" ]] \
  || { printf 'Integration Git ownership deployment configuration is missing or unsafe.\n' >&2; exit 2; }
[[ "$(stat -c '%U:%G:%a' "${CONFIG_FILE}")" == 'root:root:600' ]] \
  || { printf 'Integration Git ownership deployment configuration permissions are invalid.\n' >&2; exit 2; }
# shellcheck disable=SC1090
source "${CONFIG_FILE}"

for required_name in DEPLOY_USER DELIVERY_OWNER DELIVERY_GROUP ARTIFACT_NAME \
  EXPECTED_ARTIFACT_SHA256 EXPECTED_GIT_COMMIT INCOMING_ROOT PLATFORM_ROOT DELIVERY_ROOT; do
  [[ -n "${!required_name:-}" ]] || { printf 'Missing helper setting: %s\n' "${required_name}" >&2; exit 2; }
done
[[ "${SUDO_USER:-}" == "${DEPLOY_USER}" ]] \
  || { printf 'Deployment helper caller is not authorized.\n' >&2; exit 2; }
[[ "${DEPLOY_USER}" == forge && "${DELIVERY_OWNER}" == forge && "${DELIVERY_GROUP}" == forgeops \
  && "${ARTIFACT_NAME}" == forge-integration-git-ownership-v1.tar.gz \
  && "${EXPECTED_ARTIFACT_SHA256}" =~ ^[a-f0-9]{64}$ \
  && "${EXPECTED_GIT_COMMIT}" =~ ^[a-f0-9]{40}$ \
  && "${INCOMING_ROOT}" == /srv/forge-delivery/platform-releases/incoming \
  && "${PLATFORM_ROOT}" == /opt/forge-delivery-platform \
  && "${DELIVERY_ROOT}" == /srv/forge-delivery ]] \
  || { printf 'Integration Git ownership deployment configuration values are invalid.\n' >&2; exit 2; }

incoming_artifact="${INCOMING_ROOT}/${ARTIFACT_NAME}"
release_root="${DELIVERY_ROOT}/platform-releases/integration-git-ownership-${EXPECTED_ARTIFACT_SHA256:0:12}"
source_root="${release_root}/source"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
receipt_file="${release_root}/deployment.receipt"

die() { printf '[forge-integration-git-ownership-root] ERROR: %s\n' "$*" >&2; exit 1; }
require_commands() {
  local command_name
  for command_name in awk bash chmod cmp curl cut dirname docker find flock git grep head \
      install jq mv paste readlink rsync runuser sha256sum sort stat tar; do
    command -v "${command_name}" >/dev/null 2>&1 || die "Missing remote command: ${command_name}"
  done
}

expected_files() {
  printf '%s\n' \
    docker/harness/Dockerfile.taskspace-broker-ownership \
    docker/harness/taskspace-broker.mjs \
    scripts/acceptance/fault-inject-release-runner.sh \
    scripts/backup-conversation-control-plane.sh \
    scripts/backup-project.sh \
    scripts/clone-project-databases.sh \
    scripts/create-project.sh \
    scripts/forge-delivery-deploy-root.sh \
    scripts/forge-delivery-mobile-runtime-root.sh \
    scripts/lib/common.sh \
    scripts/lib/release-contract.sh \
    scripts/project-gitctl.sh \
    scripts/promote-foundation.sh \
    scripts/recover-legacy-shared-conversations.sh \
    scripts/restore-project.sh \
    scripts/taskspacectl.sh \
    scripts/upgrade-controlled-release.sh \
    scripts/upgrade-conversation-gateway-ui.sh \
    scripts/upgrade-forge-delivery-toolkit.sh \
    scripts/upgrade-harness-vpn-access.sh \
    scripts/upgrade-integration-git-ownership.sh \
    scripts/upgrade-mobile-runtime.sh \
    scripts/upgrade-project-git-remote.sh \
    scripts/upgrade-project-material-isolation.sh \
    scripts/upgrade-prototype-archive-support.sh \
    scripts/upgrade-release-runner-readiness.sh \
    scripts/upgrade-taskspace-isolation.sh \
    scripts/upgrade-unified-conversation-control-plane.sh \
    templates/project/compose.yaml
}

project_slugs() {
  awk -F '\t' 'NR > 1 {print $1}' "${registry_file}"
}

validate_projects() {
  local slug count=0
  while IFS= read -r slug; do
    [[ "${slug}" =~ ^[a-z][a-z0-9-]{2,31}$ ]] || die "Registered project slug is unsafe: ${slug}"
    [[ -d "${DELIVERY_ROOT}/projects/${slug}/workspace/.git" \
      && ! -L "${DELIVERY_ROOT}/projects/${slug}/workspace" \
      && ! -L "${DELIVERY_ROOT}/projects/${slug}/workspace/.git" \
      && -f "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" \
      && -f "${DELIVERY_ROOT}/projects/${slug}/ops/compose.yaml" ]] \
      || die "Registered project is incomplete or unsafe: ${slug}"
    count=$((count + 1))
  done < <(project_slugs)
  ((count > 0)) || die 'No registered projects are available for ownership repair.'
}

credential_check() {
  require_commands
  docker info >/dev/null
  docker compose version >/dev/null
  [[ -d "${PLATFORM_ROOT}" && ! -L "${PLATFORM_ROOT}" \
    && -f "${registry_file}" && ! -L "${registry_file}" ]] \
    || die 'The platform or project registry is incomplete.'
  [[ "$(stat -c '%U:%G:%a' "${PLATFORM_ROOT}")" == "${DELIVERY_OWNER}:${DELIVERY_GROUP}:750" ]] \
    || die 'The platform root ownership or traversal mode is invalid.'
  [[ -d "${INCOMING_ROOT}" \
    && "$(stat -c '%U:%G:%a' "${INCOMING_ROOT}")" == "${DEPLOY_USER}:${DELIVERY_GROUP}:2700" ]] \
    || die 'The deployment inbox is missing or has invalid permissions.'
  validate_projects
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
  if [[ ! -d "${source_root}" ]]; then
    install -d -m 0700 -o root -g root "${source_root}"
    tar --extract --gzip --no-same-owner --file "${root_artifact}" --directory "${source_root}"
  fi
  find "${source_root}" -type l -print -quit | grep -q . && die 'Artifact contains a symbolic link.'
  expected_files | sort >"${release_root}/expected-files"
  find "${source_root}" -type f -printf '%P\n' | sort >"${release_root}/actual-files"
  cmp "${release_root}/expected-files" "${release_root}/actual-files" \
    || die 'Artifact file inventory differs from the fixed deployment allowlist.'
  printf '%s\n' "${EXPECTED_ARTIFACT_SHA256}" >"${release_root}/artifact.sha256"
  printf '%s\n' "${EXPECTED_GIT_COMMIT}" >"${release_root}/git-commit"
  chmod 0600 "${release_root}/artifact.sha256" "${release_root}/git-commit" \
    "${release_root}/expected-files" "${release_root}/actual-files"
}

project_compose() {
  local slug="$1"
  shift
  docker compose \
    --env-file "${DELIVERY_ROOT}/projects/${slug}/ops/project.env" \
    --file "${DELIVERY_ROOT}/projects/${slug}/ops/compose.yaml" "$@"
}

assert_project_idle_and_healthy() {
  local slug="$1" runner_socket broker
  runner_socket="${DELIVERY_ROOT}/projects/${slug}/ops/release-ipc/runner.sock"
  [[ -S "${runner_socket}" ]] || die "Release Runner socket is unavailable: ${slug}"
  curl --fail --silent --show-error --max-time 5 --unix-socket "${runner_socket}" \
    http://localhost/healthz | jq -e '.ok == true and .active == false' >/dev/null \
    || die "Release Runner is active or unhealthy: ${slug}"
  [[ ! -e "${DELIVERY_ROOT}/projects/${slug}/taskspaces/.broker/release.lock" ]] \
    || die "A project release lock is active: ${slug}"
  broker="$(project_compose "${slug}" ps --quiet taskspace-broker)"
  [[ -n "${broker}" && "$(docker inspect --format '{{.State.Status}}' "${broker}")" == running ]] \
    || die "TaskSpace Broker is not running: ${slug}"
}

preflight() {
  local slug
  credential_check
  prepare_release_source
  while IFS= read -r slug; do
    assert_project_idle_and_healthy "${slug}"
  done < <(project_slugs)
  printf 'preflight projects=%s commit=%s artifactSha256=%s\n' \
    "$(project_slugs | paste -sd, -)" "${EXPECTED_GIT_COMMIT}" "${EXPECTED_ARTIFACT_SHA256}"
}

backup_and_publish_platform_source() {
  local timestamp relative_path source_backup target_mode
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  source_backup="${DELIVERY_ROOT}/platform-backups/pre-integration-git-ownership-source-${timestamp}"
  install -d -m 0700 -o root -g root "${source_backup}/platform"
  while IFS= read -r relative_path; do
    [[ -f "${PLATFORM_ROOT}/${relative_path}" && ! -L "${PLATFORM_ROOT}/${relative_path}" ]] \
      || { [[ ! -e "${PLATFORM_ROOT}/${relative_path}" ]] \
        || die "Existing platform path is unsafe: ${relative_path}"; continue; }
    rsync -aR "${PLATFORM_ROOT}/./${relative_path}" "${source_backup}/platform/"
  done < <(expected_files)
  while IFS= read -r relative_path; do
    install -d -m 0750 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "$(dirname -- "${PLATFORM_ROOT}/${relative_path}")"
    target_mode=0644
    [[ "${relative_path}" == *.sh ]] && target_mode=0755
    install -m "${target_mode}" -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" \
      "${source_root}/${relative_path}" "${PLATFORM_ROOT}/${relative_path}"
  done < <(expected_files)
  printf '%s\n' "${source_backup}"
}

deploy() {
  local slug source_backup last_evidence=''
  preflight
  source_backup="$(backup_and_publish_platform_source)"
  while IFS= read -r slug; do
    bash "${PLATFORM_ROOT}/scripts/upgrade-integration-git-ownership.sh" \
      "${slug}" --confirm-maintenance-window integration-git-ownership
    last_evidence="$(find "${DELIVERY_ROOT}/platform-backups" -maxdepth 1 -type d \
      -name "pre-integration-git-ownership-${slug}-*" -printf '%T@ %p\n' \
      | sort -nr | head -n1 | cut -d' ' -f2-)"
    [[ -n "${last_evidence}" ]] || die "Upgrade evidence is unavailable after repairing ${slug}."
  done < <(project_slugs)
  printf 'deployedAt=%s\ncommit=%s\nartifactSha256=%s\nsourceBackup=%s\nlastUpgradeEvidence=%s\n' \
    "$(date --iso-8601=seconds)" "${EXPECTED_GIT_COMMIT}" "${EXPECTED_ARTIFACT_SHA256}" \
    "${source_backup}" "${last_evidence}" >"${receipt_file}"
  chmod 0600 "${receipt_file}"
  printf 'deployed commit=%s artifactSha256=%s sourceBackup=%s\n' \
    "${EXPECTED_GIT_COMMIT}" "${EXPECTED_ARTIFACT_SHA256}" "${source_backup}"
}

assert_owned_tree() {
  local root="$1" drift
  [[ -d "${root}" ]] || return 0
  drift="$(find "${root}" -xdev ! -type s \
    \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) -print -quit)"
  [[ -z "${drift}" ]] || die "Published delivery state has ownership drift: ${drift}"
}

verify() {
  local slug broker task_git health
  credential_check
  [[ -f "${receipt_file}" && ! -L "${receipt_file}" ]] || die 'Deployment receipt is unavailable.'
  grep -Fx "commit=${EXPECTED_GIT_COMMIT}" "${receipt_file}" >/dev/null \
    || die 'Deployment receipt commit does not match the reviewed commit.'
  while IFS= read -r slug; do
    assert_project_idle_and_healthy "${slug}"
    broker="$(project_compose "${slug}" ps --quiet taskspace-broker)"
    health="$(docker exec "${broker}" node -e \
      "fetch('http://127.0.0.1:3100/healthz').then(async r=>{const v=await r.json();console.log(JSON.stringify(v));if(!r.ok||v.ok!==true||v.integration?.ok!==true||v.maintenance?.active!==false)process.exit(1)}).catch(()=>process.exit(1))")"
    jq -e '.ok == true and .integration.ok == true and .maintenance.active == false' <<<"${health}" >/dev/null \
      || die "Broker integration readiness failed: ${slug}"
    [[ -z "$(runuser -u "${DELIVERY_OWNER}" -- env GIT_OPTIONAL_LOCKS=0 \
      git -C "${DELIVERY_ROOT}/projects/${slug}/workspace" status \
      --porcelain=v1 --untracked-files=all)" ]] \
      || die "Delivery owner cannot read integration Git metadata: ${slug}"
    assert_owned_tree "${DELIVERY_ROOT}/projects/${slug}/workspace/.git"
    assert_owned_tree "${DELIVERY_ROOT}/projects/${slug}/ops"
    assert_owned_tree "${DELIVERY_ROOT}/projects/${slug}/taskspaces/.broker"
    while IFS= read -r task_git; do assert_owned_tree "${task_git}"; done \
      < <(find "${DELIVERY_ROOT}/projects/${slug}/taskspaces" -mindepth 3 -maxdepth 3 \
        -type d -path '*/workspace/.git' -print)
  done < <(project_slugs)
  printf 'verified projects=%s commit=%s receipt=%s\n' \
    "$(project_slugs | paste -sd, -)" "${EXPECTED_GIT_COMMIT}" "${receipt_file}"
}

action="${1:-}"
[[ $# -eq 1 ]] \
  || die 'Usage: forge-delivery-integration-git-ownership-deploy <credential-check|preflight|deploy|verify>'
case "${action}" in
  credential-check) credential_check ;;
  preflight) preflight ;;
  deploy) deploy ;;
  verify) verify ;;
  *) die "Unsupported deployment helper command: ${action}" ;;
esac
