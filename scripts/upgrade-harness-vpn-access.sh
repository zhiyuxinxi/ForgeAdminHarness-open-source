#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() {
  printf '%s\n' "Usage: $0 <project-slug>"
}

slug="${1:-}"
[[ -n "${slug}" && $# -eq 1 ]] || { usage >&2; exit 2; }
validate_slug "${slug}"

for command_name in awk curl docker find git grep jq mktemp openssl sha256sum; do
  require_command "${command_name}"
done
require_docker_access
acquire_harness_image_upgrade_lock

project_path="${DELIVERY_ROOT}/projects/${slug}"
ops_path="${project_path}/ops"
env_file="${ops_path}/project.env"
compose_file="${ops_path}/compose.yaml"
template_compose_file="${REPO_ROOT}/templates/project/compose.yaml"
[[ -d "${project_path}" && -f "${env_file}" && -f "${compose_file}" ]] \
  || die "Project is missing or incomplete: ${project_path}"
assert_managed_path "${project_path}"
if find "${project_path}/taskspaces" -mindepth 2 -maxdepth 2 -type f \
    -name metadata.json -print -quit 2>/dev/null | grep -q .; then
  die "TaskSpace-managed projects must use upgrade-forge-delivery-toolkit.sh so every active worker and rollback record is upgraded together."
fi

env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

compose() {
  docker compose --env-file "${env_file}" --file "${compose_file}" "$@"
}

current_image="$(env_value HARNESS_IMAGE)"
current_runner_image="$(env_value RELEASE_RUNNER_IMAGE)"
if [[ -z "${current_runner_image}" ]]; then current_runner_image="${current_image}"; fi
target_image="${HARNESS_IMAGE}"
bind_address="$(env_value FORGE_BIND_ADDRESS)"
harness_port="$(env_value HARNESS_PORT)"
skill_bundle_root="$(env_value FORGE_SKILL_BUNDLE_ROOT)"
[[ -n "${current_image}" ]] || die "HARNESS_IMAGE is absent from ${env_file}"
[[ -n "${bind_address}" && -n "${harness_port}" ]] \
  || die "FORGE_BIND_ADDRESS or HARNESS_PORT is absent from ${env_file}"
[[ -n "${skill_bundle_root}" ]] \
  || die "FORGE_SKILL_BUNDLE_ROOT is absent from ${env_file}"
validate_port "${harness_port}"

legacy_compose_hash='bc7a3085ef30b6364af1871d2ff67ad5bb762bcb88077b3524b55017b3f5caff'
vpn9_compose_hash='b834e55b0be15537e50301a297b33181dbd344a36af461f5f170f207297b14ef'
# Canonical vpn20 template before the Harness-side runtime-contract snapshot
# was removed. Accept only this exact reviewed predecessor, never arbitrary
# project-local Compose drift.
vpn20_compose_hash='ef96f87a0b25c2a0b9792284f194350537e302761127937b4cae4951f7899234'
# Canonical vpn21 template before Harness/Runner image references were split.
vpn21_compose_hash='cfd253a5b8d2348e8db45119fdddeca55ba1c1c2497ee5f960d4b70527f25802'
current_compose_hash="$(sha256sum "${compose_file}" | awk '{print $1}')"
target_compose_hash="$(sha256sum "${template_compose_file}" | awk '{print $1}')"
if [[ "${current_compose_hash}" != "${legacy_compose_hash}" \
  && "${current_compose_hash}" != "${vpn9_compose_hash}" \
  && "${current_compose_hash}" != "${vpn20_compose_hash}" \
  && "${current_compose_hash}" != "${vpn21_compose_hash}" \
  && "${current_compose_hash}" != "${target_compose_hash}" ]]; then
  die "Project Compose has local changes; review and migrate it manually instead of overwriting: ${compose_file}"
fi

docker image inspect "${current_image}" >/dev/null 2>&1 \
  || die "Current Harness image is unavailable: ${current_image}"
current_image_id="$(docker image inspect --format '{{.Id}}' "${current_image}")"
[[ "${current_image_id}" == sha256:* ]] || die "Current Harness image has no immutable image ID."
current_image_build_ref="$(resolve_local_docker_build_ref "${current_image}" "${current_image_id}")"

# Harness capability upgrades have a deliberately narrower lifecycle scope
# than Runner upgrades. Require the existing Runner to be healthy and then
# recreate only Harness plus its upload sidecar without traversing depends_on.
runner_container_id="$(compose ps --quiet release-runner)"
[[ -n "${runner_container_id}" ]] \
  || die "Release Runner is absent; restore it through the reviewed Runner upgrade path first."
runner_running="$(docker inspect --format '{{.State.Running}}' "${runner_container_id}")"
runner_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${runner_container_id}")"
[[ "${runner_running}" == 'true' && "${runner_health}" == 'healthy' ]] \
  || die "Release Runner is not healthy; Harness upgrade will not recreate or repair it implicitly."

if docker image inspect "${target_image}" >/dev/null 2>&1; then
  target_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image}")"
  target_mode="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${target_image}" \
    | awk -F= '$1 == "HARNESS_PRIVILEGED_API_MODE" {print $2; exit}')"
  target_skill_root="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${target_image}" \
    | awk -F= '$1 == "DSH_BUNDLED_SKILL_DIR" {sub(/^[^=]*=/, ""); print; exit}')"
  target_skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${target_image}")"
  [[ "${target_revision}" == "${HARNESS_IMAGE_REVISION}" \
    && "${target_skill_bundle}" == "${HARNESS_SKILL_BUNDLE_VERSION}" \
    && ( "${target_mode}" == 'loopback-only' || "${target_mode}" == 'trusted-host' ) \
    && "${target_skill_root}" == '/opt/forge-skill-bundles/current/skills' ]] \
    || die "Target image tag already exists with unexpected provenance or mode: ${target_image}"
  log "Reusing verified Harness image ${target_image}."
elif [[ "${current_image}" == "${target_image}" ]]; then
  die "Target Harness tag is referenced but the image is unavailable: ${target_image}"
else
  log "Building immutable Harness VPN access image ${target_image} from ${current_image}."
  docker build \
    --build-arg "HARNESS_BASE_IMAGE=${current_image_build_ref}" \
    --build-arg "HARNESS_BASE_IMAGE_ID=${current_image_id}" \
    --build-arg "DSH_VERSION=${DSH_VERSION}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
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

external_skill_receipt="$(node "${REPO_ROOT}/scripts/forge-skill-bundle.mjs" doctor \
  --install-root "${skill_bundle_root}" \
  --dsh-version "${DSH_VERSION}")" \
  || die "Active external Skill bundle failed validation: ${skill_bundle_root}"
[[ "$(harness_json_required_field ok <<<"${external_skill_receipt}")" == true \
  && "$(harness_json_required_field version <<<"${external_skill_receipt}")" == "${FORGE_EXTERNAL_SKILL_BUNDLE_VERSION}" \
  && "$(harness_json_required_field treeSha256 <<<"${external_skill_receipt}")" =~ ^[0-9a-f]{64}$ ]] \
  || die "Active external Skill bundle version or tree identity is invalid: ${skill_bundle_root}"

if ! docker run --rm --entrypoint node "${target_image}" \
    /usr/local/lib/document-extractor.mjs --check-dependencies; then
  die "Target Harness image does not provide the pinned PDF/DOCX/XLSX parser dependencies."
fi
if ! docker run --rm --read-only --network none --entrypoint sh "${target_image}" -ec \
    'test "${DSH_BUNDLED_SKILL_DIR:-}" = /opt/forge-skill-bundles/current/skills && test ! -e /usr/local/share/dsh-skills && test ! -e /usr/local/share/dsh-skills.catalog.json && ! command -v java && ! command -v mvn && ! command -v pnpm && command -v forge-delivery >/dev/null && forge-delivery --help >/dev/null && command -v harness-document-extract >/dev/null'; then
  die "Target Harness image does not provide the reviewed core-only delivery and document capabilities."
fi

# Building the immutable image is safe during active use. Everything below
# changes project-local state or containers, so refuse while any conversation
# may still be writing its session history.
if find "${project_path}/dsh-home/sessions" -type f -name 'session.jsonl.zstd' -mmin -2 -print -quit 2>/dev/null | grep -q .; then
  die "Harness session state changed in the last two minutes; no project runtime files, Git configuration or containers were changed."
fi
[[ "$(project_git_readonly "${project_path}/workspace" rev-parse --is-inside-work-tree)" == true ]] \
  || die "Project workspace is not a Git worktree: ${project_path}/workspace"
project_git "${project_path}/workspace" config --local forge-delivery.managed true
project_git "${project_path}/workspace" config --local forge-delivery.project-slug "${slug}"

timestamp="$(date '+%Y%m%d%H%M%S')"
backup_env="${env_file}.pre-harness-vpn-access-${timestamp}-$$"
backup_compose="${compose_file}.pre-harness-vpn-access-${timestamp}-$$"
install -m 0600 -- "${env_file}" "${backup_env}"
chown --reference="${env_file}" -- "${backup_env}"
install --preserve-timestamps -- "${compose_file}" "${backup_compose}"
chown --reference="${compose_file}" -- "${backup_compose}"

upload_token="$(env_value HARNESS_UPLOAD_TOKEN)"
if [[ -z "${upload_token}" ]]; then
  upload_token="$(openssl rand -hex 32)"
fi

temp_env="$(mktemp "${ops_path}/.project.env.harness-vpn.XXXXXX")"
probe_body="$(mktemp "${ops_path}/.harness-vpn-probe.XXXXXX")"
rollback_armed=false
rollback_attempted=false
cleanup_temp() {
  rm -f -- "${temp_env}" "${probe_body}"
}

rollback() {
  if [[ "${rollback_armed}" != true || "${rollback_attempted}" == true ]]; then
    return
  fi
  rollback_attempted=true
  set +e
  warn "Harness VPN access verification failed; restoring ${backup_env}."
  install -m 0600 -- "${backup_env}" "${env_file}"
  chown --reference="${backup_env}" -- "${env_file}"
  install --preserve-timestamps -- "${backup_compose}" "${compose_file}"
  chown --reference="${backup_compose}" -- "${compose_file}"
  if ! compose up --detach --force-recreate --no-deps --remove-orphans harness-upload harness; then
    warn "Automatic Harness rollback also failed; preserve both env files and inspect Compose logs."
  fi
}

on_exit() {
  local status=$?
  if ((status != 0)); then
    rollback
  fi
  cleanup_temp
  return "${status}"
}
trap on_exit EXIT

awk -v image="${target_image}" -v runner_image="${current_runner_image}" -v upload_token="${upload_token}" '
  BEGIN {
    found_image = 0
    found_runner_image = 0
    found_mode = 0
    found_history_page = 0
    found_upload_token = 0
    found_document_source = 0
    found_document_output = 0
    found_document_pages = 0
    found_document_rows = 0
    found_document_columns = 0
  }
  /^HARNESS_IMAGE=/ {
    print "HARNESS_IMAGE=" image
    found_image = 1
    next
  }
  /^RELEASE_RUNNER_IMAGE=/ {
    print "RELEASE_RUNNER_IMAGE=" runner_image
    found_runner_image = 1
    next
  }
  /^HARNESS_PRIVILEGED_API_MODE=/ {
    print "HARNESS_PRIVILEGED_API_MODE=trusted-host"
    found_mode = 1
    next
  }
  /^HARNESS_HISTORY_PAGE_MESSAGES=/ {
    print "HARNESS_HISTORY_PAGE_MESSAGES=5"
    found_history_page = 1
    next
  }
  /^HARNESS_UPLOAD_TOKEN=/ {
    print "HARNESS_UPLOAD_TOKEN=" upload_token
    found_upload_token = 1
    next
  }
  /^HARNESS_DOCUMENT_MAX_SOURCE_BYTES=/ {
    print "HARNESS_DOCUMENT_MAX_SOURCE_BYTES=26214400"
    found_document_source = 1
    next
  }
  /^HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=/ {
    print "HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=1048576"
    found_document_output = 1
    next
  }
  /^HARNESS_DOCUMENT_MAX_PDF_PAGES=/ {
    print "HARNESS_DOCUMENT_MAX_PDF_PAGES=200"
    found_document_pages = 1
    next
  }
  /^HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=/ {
    print "HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=2000"
    found_document_rows = 1
    next
  }
  /^HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=/ {
    print "HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=100"
    found_document_columns = 1
    next
  }
  { print }
  END {
    if (!found_image) print "HARNESS_IMAGE=" image
    if (!found_runner_image) print "RELEASE_RUNNER_IMAGE=" runner_image
    if (!found_mode) print "HARNESS_PRIVILEGED_API_MODE=trusted-host"
    if (!found_history_page) print "HARNESS_HISTORY_PAGE_MESSAGES=5"
    if (!found_upload_token) print "HARNESS_UPLOAD_TOKEN=" upload_token
    if (!found_document_source) print "HARNESS_DOCUMENT_MAX_SOURCE_BYTES=26214400"
    if (!found_document_output) print "HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=1048576"
    if (!found_document_pages) print "HARNESS_DOCUMENT_MAX_PDF_PAGES=200"
    if (!found_document_rows) print "HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=2000"
    if (!found_document_columns) print "HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=100"
  }
' "${env_file}" >"${temp_env}"
chmod 0600 "${temp_env}"
chown --reference="${env_file}" -- "${temp_env}"
mv -- "${temp_env}" "${env_file}"
install --preserve-timestamps -- "${template_compose_file}" "${compose_file}"
chown --reference="${backup_compose}" -- "${compose_file}"
rollback_armed=true

if ! compose config --quiet; then
  die "Compose validation failed after updating Harness configuration."
fi
if ! compose up --detach --force-recreate --no-deps harness-upload harness; then
  die "Harness and its isolated upload sidecar could not be recreated."
fi

base_url="http://${bind_address}:${harness_port}"
ready=false
for _attempt in {1..30}; do
  if curl --noproxy '*' --silent --show-error --fail --max-time 2 "${base_url}/" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  die "Harness did not become ready at ${base_url}."
fi
if ! curl --noproxy '*' --silent --show-error --fail --max-time 5 \
  --output "${probe_body}" "${base_url}/"; then
  die "Harness compatibility HTML probe could not reach Harness."
fi
if ! grep -Fq 'data-forge-harness-compat="history-auto-load"' "${probe_body}"; then
  die "Harness HTML does not contain the automatic history loading adapter."
fi
if ! grep -Fq 'data-forge-harness-compat="project-file-upload"' "${probe_body}"; then
  die "Harness HTML does not contain the project-file upload adapter."
fi
if ! curl --noproxy '*' --silent --show-error --fail --max-time 5 \
  --header "Origin: ${base_url}" \
  --header 'Sec-Fetch-Site: same-origin' \
  --output "${probe_body}" "${base_url}/forge-upload/config"; then
  die "Harness project-file upload configuration probe failed."
fi
if [[ "$(jq -r '.maxFileBytes // 0' "${probe_body}")" != '52428800' ]] \
    || [[ "$(jq -r '.projectPath // empty' "${probe_body}")" != '/project-inputs' ]] \
    || [[ "$(jq -r '.documentMaxSourceBytes // 0' "${probe_body}")" != '26214400' ]] \
    || ! jq -e '.readableFormats | index("pdf") and index("docx") and index("xlsx")' "${probe_body}" >/dev/null; then
  die "Harness project-file upload limits or model path are unexpected."
fi

rpc_id='00000000-0000-4000-8000-000000000006'
request_body="{\"type\":\"client-request\",\"rpcId\":\"${rpc_id}\",\"method\":\"credentials.describe\",\"payload\":{\"refs\":[]}}"
if ! privileged_status="$(curl --noproxy '*' --silent --show-error --max-time 5 \
  --output "${probe_body}" --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Origin: ${base_url}" \
  --header "Referer: ${base_url}/" \
  --header 'Sec-Fetch-Site: same-origin' \
  --data-raw "${request_body}" \
  "${base_url}/api/credentials.describe")"; then
  die "Trusted-host credentials.describe probe could not reach Harness."
fi
if [[ "${privileged_status}" != '200' ]] || ! grep -Fq '"ok":true' "${probe_body}"; then
  die "Trusted-host credentials.describe probe failed with HTTP ${privileged_status}."
fi

if ! forged_status="$(curl --noproxy '*' --silent --show-error --max-time 5 \
  --output "${probe_body}" --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Host: 127.0.0.1:${harness_port}" \
  --header "Origin: http://127.0.0.1:${harness_port}" \
  --data-raw "${request_body}" \
  "${base_url}/api/credentials.describe")"; then
  die "Forged loopback Host negative probe could not reach Harness."
fi
if [[ "${forged_status}" != '403' ]]; then
  die "Forged loopback Host negative probe returned HTTP ${forged_status}, expected 403."
fi

rollback_armed=false
trap - EXIT
cleanup_temp
log "Harness VPN access and Skill bundle ${HARNESS_SKILL_BUNDLE_VERSION} are active for ${slug} at ${base_url}."
log "Verified credentials.describe HTTP 200, forged loopback Host HTTP 403, five-message history pages, automatic upward loading, isolated uploads, and PDF/DOCX/XLSX document extraction."
log "Rollback environment retained at ${backup_env}; Compose backup retained at ${backup_compose}."
