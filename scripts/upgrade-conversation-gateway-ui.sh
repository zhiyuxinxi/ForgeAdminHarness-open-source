#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/taskspace-compose-network.sh
source "${SCRIPT_DIR}/lib/taskspace-compose-network.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() { printf 'Usage: %s --confirm-maintenance-window conversation-gateway-ui\n' "$0"; }

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == conversation-gateway-ui ]] \
  || die "This upgrade requires --confirm-maintenance-window conversation-gateway-ui."

for command_name in awk cmp curl docker flock jq sha256sum; do require_command "${command_name}"; done
require_docker_access
acquire_harness_image_upgrade_lock

control_root="${DELIVERY_ROOT}/conversation-control-plane"
control_env="${control_root}/control-plane.env"
compose_file="${REPO_ROOT}/templates/conversation-control-plane/compose.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
[[ -f "${control_env}" && -f "${compose_file}" && -f "${registry_file}" ]] \
  || die "Unified conversation control plane is not prepared."

legacy_project_slug='forge-base'
legacy_project_display_name='示例客户'
legacy_archive_task_id='legacy-history-20260827'
legacy_archive_task_env="${DELIVERY_ROOT}/projects/${legacy_project_slug}/taskspaces/${legacy_archive_task_id}/task.env"
[[ -f "${legacy_archive_task_env}" ]] || die "Legacy archive TaskSpace environment is unavailable."

current_gateway_image="$(awk -F= '$1 == "HARNESS_IMAGE" {sub(/^[^=]*=/, ""); print; exit}' "${control_env}")"
base_image="${CONVERSATION_GATEWAY_FOUNDATION_IMAGE:-forge-delivery/deepseek-harness:0.1.1-rc.2-vpn51}"
target_image="${CONVERSATION_GATEWAY_IMAGE:-forge-delivery/deepseek-harness:0.1.1-rc.2-vpn55}"
target_revision="${CONVERSATION_GATEWAY_IMAGE_REVISION:-vpn-legacy-conversation-surface-55}"
[[ -n "${current_gateway_image}" && -n "${base_image}" && -n "${target_image}" ]] \
  || die "Harness image configuration is incomplete."
for image in "${current_gateway_image}" "${base_image}"; do
  docker image inspect "${image}" >/dev/null 2>&1 || die "Harness image is unavailable: ${image}"
done
current_gateway_image_id="$(docker image inspect --format '{{.Id}}' "${current_gateway_image}")"
base_image_id="$(docker image inspect --format '{{.Id}}' "${base_image}")"
base_skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${base_image}")"
[[ "${current_gateway_image_id}" == sha256:* && "${base_image_id}" == sha256:* && -n "${base_skill_bundle}" ]] \
  || die "Harness image provenance is incomplete."
base_image_build_ref="$(resolve_local_docker_build_ref "${base_image}" "${base_image_id}")"

upgrade_lock="${DELIVERY_ROOT}/registry/conversation-gateway-ui-upgrade.lock"
prepare_delivery_lock "${upgrade_lock}"
exec 9>>"${upgrade_lock}"
flock --exclusive --nonblock 9 || die "Another Conversation Gateway UI upgrade is running."

verify_target_harness_image_legacy_surface() {
  local revision skill_bundle inherited_base target_image_id target_config base_config
  target_image_id="$(docker image inspect --format '{{.Id}}' "${target_image}")"
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image_id}")"
  skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${target_image_id}")"
  inherited_base="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-base-image-id"}}' "${target_image_id}")"
  [[ "${revision}" == "${target_revision}" && "${skill_bundle}" == "${base_skill_bundle}" \
    && "${inherited_base}" == "${base_image_id}" ]] \
    || die "Target Harness image provenance is invalid: ${target_image}"
  printf '%s\n%s\n' \
    "$(docker image inspect --format '{{json .RootFS.Layers}}' "${target_image_id}")" \
    "$(docker image inspect --format '{{json .RootFS.Layers}}' "${base_image_id}")" \
    | docker run --rm --interactive --network none --entrypoint node "${target_image_id}" -e '
      const [targetText, baseText] = require("node:fs").readFileSync(0, "utf8").trim().split("\n");
      const target = JSON.parse(targetText);
      const base = JSON.parse(baseText);
      if (!Array.isArray(target) || !Array.isArray(base) || base.length === 0
          || target.length <= base.length || !base.every((layer, index) => target[index] === layer)) {
        process.exit(1);
      }
    ' || die "Target Harness image is not a strict descendant of the reviewed archive image."
  target_config="$(docker image inspect --format '{{json .Config}}' "${target_image_id}")"
  base_config="$(docker image inspect --format '{{json .Config}}' "${base_image_id}")"
  printf '%s\n%s\n' "${target_config}" "${base_config}" \
    | docker run --rm --interactive --network none --entrypoint node "${target_image_id}" -e '
    const [targetText, baseText] = require("node:fs").readFileSync(0, "utf8").trim().split("\n");
    const target = JSON.parse(targetText);
    const base = JSON.parse(baseText);
    delete target.Labels;
    delete base.Labels;
    if (JSON.stringify(target) !== JSON.stringify(base)) process.exit(1);
  ' \
    || die "Target Harness runtime Config changed outside image labels."
  docker run --rm --network none --entrypoint sh "${target_image_id}" -ec \
    'node --check /usr/local/lib/conversation-gateway.mjs >/dev/null \
      && node --check /usr/local/lib/harness-tcp-proxy.mjs >/dev/null \
      && grep -F "[hidden] { display: none !important; }" /usr/local/share/conversation-gateway/gateway.css >/dev/null \
      && grep -F "switch-project-button" /usr/local/share/conversation-gateway/index.html >/dev/null \
      && grep -F "conversationLoading" /usr/local/share/conversation-gateway/gateway.js >/dev/null \
      && grep -F "迁移前历史对话" /usr/local/share/conversation-gateway/gateway.js >/dev/null \
      && grep -F "INVALID_LEGACY_SESSION_ID" /usr/local/lib/conversation-gateway.mjs >/dev/null \
      && grep -F "hiddenFromList !== true" /usr/local/lib/conversation-gateway.mjs >/dev/null \
      && grep -F "legacy-session-selection" /usr/local/lib/harness-tcp-proxy.mjs >/dev/null \
      && grep -F "dsh.sessions.current" /usr/local/lib/harness-tcp-proxy.mjs >/dev/null \
      && grep -F "UPSTREAM_STARTUP_RETRY_MS = 30_000" /usr/local/lib/harness-tcp-proxy.mjs >/dev/null \
      && grep -F "proxyHarnessRequestWithStartupRetry" /usr/local/lib/harness-tcp-proxy.mjs >/dev/null' \
    || die "Target Harness image is missing the reviewed legacy conversation behavior."
  [[ "$(docker image inspect --format '{{.Id}}' "${target_image}")" == "${target_image_id}" ]] \
    || die "Target Harness tag changed during verification."
}

if docker image inspect "${target_image}" >/dev/null 2>&1; then
  verify_target_harness_image_legacy_surface
  log "Reusing verified Conversation Gateway image ${target_image}."
else
  [[ "${base_image}" != "${target_image}" ]] \
    || die "Target image is referenced by the control plane but is unavailable: ${target_image}"
  log "Building immutable legacy conversation image ${target_image} from ${base_image}."
  docker build \
    --build-arg "HARNESS_BASE_IMAGE=${base_image_build_ref}" \
    --build-arg "HARNESS_BASE_IMAGE_ID=${base_image_id}" \
    --build-arg "HARNESS_IMAGE_REVISION=${target_revision}" \
    --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${base_skill_bundle}" \
    --tag "${target_image}" \
    --file "${REPO_ROOT}/docker/harness/Dockerfile.legacy-conversation-surface" \
    "${REPO_ROOT}"
  verify_target_harness_image_legacy_surface
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="${DELIVERY_ROOT}/platform-backups/pre-conversation-gateway-ui-${timestamp}"
state_file="${DELIVERY_ROOT}/conversation-control-plane/state/state.json"
audit_file="${DELIVERY_ROOT}/conversation-control-plane/state/audit.jsonl"
recovery_script="${REPO_ROOT}/scripts/recover-legacy-shared-conversations.sh"
[[ -f "${state_file}" && -f "${audit_file}" && -f "${recovery_script}" ]] \
  || die "Legacy conversation recovery inputs are incomplete."
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${backup_root}"
cp --preserve=mode,ownership,timestamps -- "${control_env}" "${backup_root}/control-plane.env"
cp --preserve=mode,ownership,timestamps -- "${registry_file}" "${backup_root}/projects.tsv"
cp --preserve=mode,ownership,timestamps -- "${legacy_archive_task_env}" "${backup_root}/legacy-archive-task.env"
cp --preserve=mode,ownership,timestamps -- "${state_file}" "${backup_root}/state.json"
cp --preserve=mode,ownership,timestamps -- "${audit_file}" "${backup_root}/audit.jsonl"

compose() { docker compose --env-file "${control_env}" --file "${compose_file}" "$@"; }

# Inventory is read-only: validate and load either reviewed network filename,
# but do not create canonical metadata from this historical UI upgrade.
task_compose_readonly() {
  local slug="$1" task_env="$2" task_root task_id
  local -a network_args=()
  shift 2
  task_root="$(dirname -- "${task_env}")"
  task_id="$(basename -- "${task_root}")"
  taskspace_network_compose_args "${task_root}" "${slug}/${task_id}" network_args \
    || { printf 'TaskSpace network contract validation failed during inventory: %s/%s\n' \
      "${slug}" "${task_id}" >&2; return 1; }
  docker compose --env-file "${task_env}" \
    --file "${REPO_ROOT}/templates/taskspace/compose.yaml" \
    "${network_args[@]}" "$@"
}

capture_container_ids() {
  local output="$1" slug task_env task_id project_env project_compose
  : >"${output}"
  while IFS=$'\t' read -r slug _; do
    [[ "${slug}" == slug ]] && continue
    project_env="${DELIVERY_ROOT}/projects/${slug}/ops/project.env"
    project_compose="${DELIVERY_ROOT}/projects/${slug}/ops/compose.yaml"
    [[ -f "${project_env}" && -f "${project_compose}" ]] \
      || die "Project runtime definition is incomplete: ${slug}"
    docker compose --env-file "${project_env}" --file "${project_compose}" ps --quiet \
      | xargs -r docker inspect --format "project ${slug} {{index .Config.Labels \"com.docker.compose.service\"}} {{.Id}}" \
      >>"${output}"
    shopt -s nullglob
    for task_env in "${DELIVERY_ROOT}/projects/${slug}"/taskspaces/*/task.env; do
      task_id="$(basename -- "$(dirname -- "${task_env}")")"
      task_compose_readonly "${slug}" "${task_env}" ps --quiet harness \
        | xargs -r docker inspect --format "taskspace ${slug} ${task_id} {{.Id}}" \
        >>"${output}"
    done
    shopt -u nullglob
  done <"${registry_file}"
  sort -o "${output}" "${output}"
}

upsert_env() {
  local file="$1" key="$2" value="$3" temporary
  temporary="${file}.tmp.$$"
  awk -F= -v key="${key}" -v value="${value}" '
    BEGIN {found=0}
    $1 == key {print key "=" value; found=1; next}
    {print}
    END {if (!found) print key "=" value}
  ' "${file}" >"${temporary}"
  chmod --reference="${file}" "${temporary}"
  chown --reference="${file}" "${temporary}"
  mv -- "${temporary}" "${file}"
}

update_project_display_name() {
  local temporary
  temporary="${registry_file}.tmp.$$"
  awk -F $'\t' -v OFS=$'\t' -v slug="${legacy_project_slug}" -v name="${legacy_project_display_name}" '
    BEGIN {found=0}
    $1 == slug {$2=name; found=1}
    {print}
    END {if (!found) exit 2}
  ' "${registry_file}" >"${temporary}" \
    || { rm -f -- "${temporary}"; die "Legacy project is absent from the registry."; }
  chmod --reference="${registry_file}" "${temporary}"
  chown --reference="${registry_file}" "${temporary}"
  mv -- "${temporary}" "${registry_file}"
}

capture_container_ids "${backup_root}/protected-container-ids.before"
gateway_before="$(compose ps --quiet conversation-gateway)"
printf '%s\n' "${gateway_before}" >"${backup_root}/gateway-container-id.before"

switched=false
rollback() {
  local exit_code=$?
  trap - ERR EXIT
  ((exit_code != 0)) || return 0
  if [[ "${switched}" == true ]]; then
    warn "Legacy conversation upgrade failed; restoring control-plane, registry, archive and state files."
    cp --preserve=mode,ownership,timestamps -- "${backup_root}/control-plane.env" "${control_env}" || true
    cp --preserve=mode,ownership,timestamps -- "${backup_root}/projects.tsv" "${registry_file}" || true
    cp --preserve=mode,ownership,timestamps -- "${backup_root}/legacy-archive-task.env" "${legacy_archive_task_env}" || true
    cp --preserve=mode,ownership,timestamps -- "${backup_root}/state.json" "${state_file}" || true
    cp --preserve=mode,ownership,timestamps -- "${backup_root}/audit.jsonl" "${audit_file}" || true
    compose up --detach --force-recreate --no-deps conversation-gateway || true
  fi
  warn "Rollback evidence is retained at ${backup_root}."
  exit "${exit_code}"
}
trap rollback ERR EXIT

switched=true
compose stop conversation-gateway
update_project_display_name
upsert_env "${legacy_archive_task_env}" HARNESS_IMAGE "${target_image}"
bash "${recovery_script}" \
  --project "${legacy_project_slug}" \
  --owner admin \
  --confirm-maintenance-window legacy-shared-conversations
upsert_env "${control_env}" HARNESS_IMAGE "${target_image}"
compose config --quiet
compose up --detach --force-recreate --no-deps conversation-gateway

deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  if curl --fail --silent --show-error --max-time 3 \
    "http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/healthz" \
    | jq -e '.ok == true' >/dev/null; then
    break
  fi
  sleep 2
done
((SECONDS < deadline)) || die "Conversation Gateway did not become healthy after the UI upgrade."

[[ "$(awk -F $'\t' -v slug="${legacy_project_slug}" '$1==slug {print $2}' "${registry_file}")" == "${legacy_project_display_name}" ]] \
  || die "The reviewed 示例客户 display name was not persisted."
[[ "$(awk -F= '$1=="HARNESS_IMAGE" {print $2}' "${legacy_archive_task_env}")" == "${target_image}" ]] \
  || die "Legacy archive TaskSpace did not adopt the target image."
jq -e --arg project "${legacy_project_slug}" '
  . as $state
  | ($state.users[] | select(.username=="admin" and .role=="admin" and .status=="active").id) as $admin
  | ([.conversations[] | select(
    .projectSlug==$project
    and .conversationKind=="legacy-session"
    and .legacyArchiveConversationId=="legacy-shared-history-20260827"
    and .ownerUserId==$admin
  )] | length)==38
  and ([.conversations[] | select(.id=="legacy-shared-history-20260827" and .hiddenFromList==true)] | length)==1
  and ([.conversations[] | select(.title=="周长庆-测试-危废功能开发")] | length)==1
  and ([.conversations[] | select(.title=="周长庆-测试-APP功能")] | length)==1
' "${state_file}" >/dev/null || die "Recovered legacy conversation state is incomplete."

capture_container_ids "${backup_root}/protected-container-ids.after"
cmp "${backup_root}/protected-container-ids.before" "${backup_root}/protected-container-ids.after" \
  || die "A Forge application or active TaskSpace container changed unexpectedly."

gateway_after="$(compose ps --quiet conversation-gateway)"
[[ -n "${gateway_after}" && "${gateway_after}" != "${gateway_before}" ]] \
  || die "Conversation Gateway was not recreated with the target image."
printf '%s\n' "${gateway_after}" >"${backup_root}/gateway-container-id.after"
docker image inspect --format '{{.Id}}' "${target_image}" >"${backup_root}/target-image-id"
jq --null-input \
  --arg deployedAt "$(date --iso-8601=seconds)" \
  --arg image "${target_image}" \
  --arg imageId "$(cat "${backup_root}/target-image-id")" \
  --arg project "${legacy_project_slug}" \
  --arg displayName "${legacy_project_display_name}" \
  '{schemaVersion:1,deployedAt:$deployedAt,image:$image,imageId:$imageId,projectSlug:$project,projectDisplayName:$displayName,legacyConversations:38}' \
  >"${backup_root}/deployment-result.json"
sha256sum \
  "${backup_root}/control-plane.env" \
  "${backup_root}/projects.tsv" \
  "${backup_root}/legacy-archive-task.env" \
  "${backup_root}/state.json" \
  "${backup_root}/audit.jsonl" \
  "${backup_root}/gateway-container-id.before" \
  "${backup_root}/gateway-container-id.after" \
  "${backup_root}/protected-container-ids.before" \
  "${backup_root}/protected-container-ids.after" \
  "${backup_root}/target-image-id" \
  "${backup_root}/deployment-result.json" \
  >"${backup_root}/SHA256SUMS"

trap - ERR EXIT
switched=false
log "Legacy conversation surface ${target_revision} is active at http://${CONVERSATION_GATEWAY_BIND_ADDRESS}:${CONVERSATION_GATEWAY_PORT}/forge-gateway/."
log "Recovered 38 peer legacy conversations for 示例客户, including both 周长庆 records."
log "Forge application and active TaskSpace container identities are unchanged."
log "Backup and rollback evidence: ${backup_root}"
