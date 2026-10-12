#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/frontend-typecheck-capability.sh
source "${SCRIPT_DIR}/lib/frontend-typecheck-capability.sh"
# shellcheck source=lib/release-contract.sh
source "${SCRIPT_DIR}/lib/release-contract.sh"
load_platform_config
: "${GLM_KEY_FILE:?GLM_KEY_FILE is required to create a project with the versioned GLM provider}"
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() {
  printf '%s\n' \
    "Usage: $0 --slug <slug> --name <display-name> [options]" \
    "" \
    "Options:" \
    "  --ui-port <port>          Allocate automatically when omitted" \
    "  --harness-port <port>     Deprecated; must equal platform entry ${CONVERSATION_GATEWAY_PORT}" \
    "  --bind-address <address>  Default: ${DEFAULT_BIND_ADDRESS}" \
    "  --git-url <ssh-url>       Required private project origin; ssh://git@host[:port]/namespace/project.git" \
    "  --source-project <slug>   Clone the exact clean commit from a registered project" \
    "  --source-commit <sha>     Required 40-character HEAD when --source-project is used" \
    "  --application-runtime <pc-only|pc-mobile>  Default: pc-mobile; pc-only uses the three-service PC baseline" \
    "  --redis-database <1-15>   Required shared Redis logical database" \
    "  --redis-test-database <0-15> Required, distinct Redis logical database for _test migration" \
    "  --foundation              Create the single forge-base maintainer workspace" \
    "  --help"
}

write_project_governance_context() {
  local workspace="$1" source_kind="$2" rendered_context="$3" output="$4"
  local tracked_context="${workspace}/PROJECT_CONTEXT.md" source_hash copied_hash

  [[ ! -e "${output}" && ! -L "${output}" ]] \
    || die "Project governance context output already exists or is unsafe."
  if [[ -e "${tracked_context}" || -L "${tracked_context}" ]]; then
    [[ "${source_kind}" == registered-project ]] \
      || die "The source repository reserves PROJECT_CONTEXT.md; only a registered project may inherit a clean tracked context."
    env GIT_OPTIONAL_LOCKS=0 git -C "${workspace}" \
      ls-files --error-unmatch -- PROJECT_CONTEXT.md >/dev/null 2>&1 \
      || die "An untracked PROJECT_CONTEXT.md is ambiguous; project creation failed closed."
    [[ -f "${tracked_context}" && ! -L "${tracked_context}" ]] \
      || die "Tracked PROJECT_CONTEXT.md must be a regular non-symbolic-link file."
    env GIT_OPTIONAL_LOCKS=0 git -C "${workspace}" \
      diff --quiet HEAD -- PROJECT_CONTEXT.md \
      || die "Tracked PROJECT_CONTEXT.md must be clean at HEAD before inheritance."
    source_hash="$(dd if="${tracked_context}" iflag=nofollow status=none | sha256sum | awk '{print $1}')"
    dd if="${tracked_context}" iflag=nofollow of="${output}" \
      oflag=nofollow conv=excl,fsync status=none \
      || die "Tracked PROJECT_CONTEXT.md could not be copied into the project governance root."
    copied_hash="$(sha256sum "${output}" | awk '{print $1}')"
    [[ "${copied_hash}" == "${source_hash}" \
      && "$(dd if="${tracked_context}" iflag=nofollow status=none | sha256sum | awk '{print $1}')" == "${source_hash}" ]] \
      || die "Tracked PROJECT_CONTEXT.md changed during inheritance."
    env GIT_OPTIONAL_LOCKS=0 git -C "${workspace}" \
      diff --quiet HEAD -- PROJECT_CONTEXT.md \
      || die "Tracked PROJECT_CONTEXT.md changed during inheritance."
    return 0
  fi

  printf '%s\n' "${rendered_context}" \
    | dd of="${output}" oflag=nofollow conv=excl,fsync status=none \
    || die "Rendered project governance context could not be written safely."
}

slug=''
display_name=''
ui_port=''
harness_port="${CONVERSATION_GATEWAY_PORT}"
bind_address="${DEFAULT_BIND_ADDRESS}"
project_git_url=''
source_project=''
requested_source_commit=''
foundation_mode=false
redis_database=''
redis_test_database=''
application_runtime='pc-mobile'

while (($# > 0)); do
  case "$1" in
    --slug) slug="${2:-}"; shift 2 ;;
    --name) display_name="${2:-}"; shift 2 ;;
    --ui-port) ui_port="${2:-}"; shift 2 ;;
    --harness-port) harness_port="${2:-}"; shift 2 ;;
    --bind-address) bind_address="${2:-}"; shift 2 ;;
    --git-url) project_git_url="${2:-}"; shift 2 ;;
    --source-project) source_project="${2:-}"; shift 2 ;;
    --source-commit) requested_source_commit="${2:-}"; shift 2 ;;
    --application-runtime) application_runtime="${2:-}"; shift 2 ;;
    --redis-database) redis_database="${2:-}"; shift 2 ;;
    --redis-test-database) redis_test_database="${2:-}"; shift 2 ;;
    --foundation) foundation_mode=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

[[ -n "${slug}" ]] || die "--slug is required"
[[ -n "${display_name}" ]] || die "--name is required"
[[ -n "${project_git_url}" ]] || die "--git-url is required; every delivery project must have an independent private remote."
[[ "${project_git_url}" =~ ^ssh://git@([A-Za-z0-9.-]+)(:([0-9]{1,5}))?/[A-Za-z0-9._/-]+\.git$ ]] \
  || die "--git-url must be ssh://git@host[:port]/namespace/project.git without embedded credentials."
[[ "${project_git_url}" != *$'\n'* && "${project_git_url}" != *$'\r'* && "${project_git_url}" != *$'\t'* ]] \
  || die "--git-url contains forbidden whitespace."
[[ "${display_name}" != *$'\n'* && "${display_name}" != *$'\r'* && "${display_name}" != *$'\t'* ]] \
  || die "Display name cannot contain tabs or newlines."
[[ "${redis_database}" =~ ^([1-9]|1[0-5])$ ]] \
  || die "--redis-database is required and must be between 1 and 15."
[[ "${redis_test_database}" =~ ^([0-9]|1[0-5])$ ]] \
  || die "--redis-test-database is required and must be between 0 and 15."
[[ "${redis_database}" != "${redis_test_database}" ]] \
  || die "Runtime and test Redis databases must differ."
validate_slug "${slug}"
if [[ "${foundation_mode}" == true && "${slug}" != 'forge-base' ]]; then
  die "--foundation is reserved for the canonical forge-base project slug."
fi
if [[ -n "${source_project}" ]]; then
  validate_slug "${source_project}"
  [[ "${source_project}" != "${slug}" ]] || die "Source and target project slugs must differ."
  [[ "${foundation_mode}" == false ]] || die "--source-project cannot be combined with --foundation."
  [[ "${requested_source_commit}" =~ ^[a-f0-9]{40}$ ]] \
    || die "--source-commit must be the exact 40-character source HEAD when --source-project is used."
elif [[ -n "${requested_source_commit}" ]]; then
  die "--source-commit requires --source-project."
fi
[[ "${bind_address}" =~ ^[0-9a-fA-F:.]+$ ]] \
  || die "--bind-address must be an IPv4/IPv6 literal, not a hostname."

for command_name in flock git jq openssl sha256sum ssh-keygen ss; do
  require_command "${command_name}"
done
allowed_release_services_json="$(release_contract_application_runtime_services_json "${application_runtime}")" \
  || die "--application-runtime must be pc-only or pc-mobile."

projects_root="${DELIVERY_ROOT}/projects"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
mirror_path="${DELIVERY_ROOT}/baselines/forge-admin.git"
foundation_path="${DELIVERY_ROOT}/baselines/forge-admin-foundation.git"
baseline_lock="${DELIVERY_ROOT}/baselines/baseline.lock"

[[ -d "${projects_root}" && -f "${registry_file}" ]] \
  || die "Host is not bootstrapped."
[[ -d "${mirror_path}" && -d "${foundation_path}" && -f "${baseline_lock}" ]] \
  || die "Baseline is absent. Run sync-baseline.sh first."
require_docker_access
harness_image_id="$(resolve_configured_harness_image_id)"
[[ "${harness_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "Configured Harness image must resolve to an immutable image ID."
harness_cache_image_id="${harness_image_id#sha256:}"
format_maintenance_supported=false
if harness_image_supports_format_maintenance "${harness_image_id}"; then format_maintenance_supported=true; fi
contract_continuation_supported=false
review_suspension_supported=false
changed_verification_supported=false
focused_backend_verification_supported=false
ordinary_final_verification_supported=false
if harness_image_supports_contract_continuation "${harness_image_id}"; then contract_continuation_supported=true; fi
if harness_image_supports_review_suspension "${harness_image_id}"; then review_suspension_supported=true; fi
if harness_image_supports_changed_verification "${harness_image_id}"; then changed_verification_supported=true; fi
if harness_image_supports_focused_backend_verification "${harness_image_id}"; then focused_backend_verification_supported=true; fi
if harness_image_supports_ordinary_final_verification "${harness_image_id}"; then ordinary_final_verification_supported=true; fi
expected_harness_foundation_image_id="$(resolve_configured_harness_foundation_image_id)"
verify_target_harness_image "${CONVERSATION_MANAGER_IMAGE}" "${expected_harness_foundation_image_id}"
conversation_manager_image_id="${FORGE_VERIFIED_HARNESS_IMAGE_ID}"
[[ "${conversation_manager_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "Configured Conversation Manager image must pass the complete Harness image verifier."

source_kind='foundation'
source_slug=''
source_repository="${foundation_path}"
source_commit="$(git --git-dir="${foundation_path}" rev-parse 'refs/heads/main^{commit}')"
source_ref="foundation-${source_commit:0:12}"
source_remote='foundation'
if [[ -n "${source_project}" ]]; then
  source_workspace="${projects_root}/${source_project}/workspace"
  awk -F '\t' -v value="${source_project}" 'NR > 1 && $1 == value {found=1} END {exit !found}' "${registry_file}" \
    || die "Source project is not registered: ${source_project}"
  [[ -d "${source_workspace}/.git" ]] || die "Source project workspace is missing: ${source_project}"
  [[ "$(project_git_readonly "${source_workspace}" config --local --get forge-delivery.managed || true)" == true ]] \
    || die "Source project workspace is not platform-managed: ${source_project}"
  [[ -z "$(project_git_readonly "${source_workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Source project workspace must be clean before replication: ${source_project}"
  actual_source_head="$(project_git_readonly "${source_workspace}" rev-parse 'HEAD^{commit}')"
  [[ "${actual_source_head}" == "${requested_source_commit}" ]] \
    || die "Source project HEAD changed; expected ${requested_source_commit}, got ${actual_source_head}."
  source_kind='registered-project'
  source_slug="${source_project}"
  source_repository="${source_workspace}"
  source_commit="${actual_source_head}"
  source_ref="project-${source_project}-${source_commit:0:12}"
  source_remote='source'
fi
database_slug="${slug//-/_}"
mysql_database="forge_${database_slug}"
mysql_test_database="${mysql_database}_test"
if [[ "${foundation_mode}" == true ]]; then
  project_kind='foundation'
  work_branch='main'
elif [[ "${source_kind}" == 'registered-project' ]]; then
  project_kind='replica'
  work_branch="delivery/${slug}"
else
  project_kind='delivery'
  work_branch="delivery/${slug}"
fi

registry_has_port() {
  local port="$1"
  awk -F '\t' -v value="${port}" 'NR > 1 && ($3 == value || $4 == value) {found=1} END {exit !found}' "${registry_file}"
}

registry_has_redis_database() {
  local database="$1"
  awk -F '\t' -v value="${database}" \
    'NR > 1 && ($11 == value || $12 == value) {found=1} END {exit !found}' \
    "${registry_file}"
}

allocate_port() {
  local start="$1"
  local end="$2"
  local candidate
  for ((candidate = start; candidate <= end; candidate++)); do
    if ! registry_has_port "${candidate}" && ! port_is_listening "${candidate}"; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

projects_lock="${DELIVERY_ROOT}/registry/projects.lock"
prepare_delivery_lock "${projects_lock}"
exec 9>>"${projects_lock}"
flock --exclusive 9

if awk -F '\t' -v value="${slug}" 'NR > 1 && $1 == value {found=1} END {exit !found}' "${registry_file}"; then
  die "Project slug already exists: ${slug}"
fi
if registry_has_redis_database "${redis_database}"; then
  die "Redis runtime database is already allocated: ${redis_database}"
fi
if registry_has_redis_database "${redis_test_database}"; then
  die "Redis test database is already allocated: ${redis_test_database}"
fi

if [[ -z "${ui_port}" ]]; then
  ui_port="$(allocate_port "${UI_PORT_MIN}" "${UI_PORT_MAX}")" \
    || die "No free UI port remains in ${UI_PORT_MIN}-${UI_PORT_MAX}."
fi
validate_port "${ui_port}"
validate_port "${harness_port}"
[[ "${harness_port}" == "${CONVERSATION_GATEWAY_PORT}" ]] \
  || die "Projects share the platform Conversation Gateway port ${CONVERSATION_GATEWAY_PORT}; per-project Harness ports are retired."
[[ "${ui_port}" != "${harness_port}" ]] || die "UI and Harness ports must differ."
if registry_has_port "${ui_port}" || port_is_listening "${ui_port}"; then
  die "UI port is already allocated or listening: ${ui_port}"
fi

project_path="${projects_root}/${slug}"
git_remotes_root="${DELIVERY_ROOT}/git-remotes"
project_git_root="${git_remotes_root}/${slug}"
[[ ! -e "${project_path}" ]] || die "Project directory already exists: ${project_path}"
[[ ! -e "${project_git_root}" ]] || die "Project Git credential directory already exists: ${project_git_root}"
stage_path="${projects_root}/.${slug}.creating.$$"
git_stage_path="${git_remotes_root}/.${slug}.creating.$$"
assert_managed_path "${stage_path}"
mkdir -m 0750 -- "${stage_path}"
install -d -m 0700 -- "${git_remotes_root}"
mkdir -m 0700 -- "${git_stage_path}"
if [[ "${EUID}" -eq 0 ]]; then
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${git_remotes_root}"
fi
git_credentials_moved=false

cleanup_stage() {
  if [[ -d "${stage_path}" ]]; then
    assert_managed_path "${stage_path}"
    rm -rf -- "${stage_path}"
  fi
  if [[ -d "${git_stage_path}" ]]; then
    [[ "${git_stage_path}" == "${git_remotes_root}/.${slug}.creating."* ]] \
      || die "Refusing to clean an unexpected Git credential staging path: ${git_stage_path}"
    rm -rf -- "${git_stage_path}"
  fi
  if [[ "${git_credentials_moved}" == true && -d "${project_git_root}" ]]; then
    [[ "${project_git_root}" == "${git_remotes_root}/${slug}" ]] \
      || die "Refusing to clean an unexpected Git credential path: ${project_git_root}"
    rm -rf -- "${project_git_root}"
  fi
}
trap cleanup_stage EXIT

  mkdir -m 0750 -- \
    "${stage_path}/ops" \
    "${stage_path}/workspace" \
    "${stage_path}/shared-inputs" \
    "${stage_path}/governance"
mkdir -m 0700 -- "${stage_path}/ops/release-ipc" "${stage_path}/ops/conversation-ipc"
  mkdir -m 0750 -- "${stage_path}/shared-inputs/accepted"
  mkdir -m 0700 -- "${stage_path}/shared-inputs/governance"
  mkdir -m 0700 -- \
    "${stage_path}/dsh-home" \
    "${stage_path}/backups" \
    "${stage_path}/taskspaces" \
    "${stage_path}/conversation-gateway"
  mkdir -m 2700 -- \
    "${stage_path}/verification" \
    "${stage_path}/verification/ipc" \
    "${stage_path}/verification/source-ipc" \
    "${stage_path}/verification/empty-manager-mask" \
    "${stage_path}/verification/state" \
    "${stage_path}/verification/cache-packs" \
    "${stage_path}/verification/cache-packs/images" \
    "${stage_path}/verification/cache-packs/images/${harness_cache_image_id}" \
    "${stage_path}/acceptance" \
    "${stage_path}/acceptance/state" \
    "${stage_path}/acceptance/secrets" \
    "${stage_path}/acceptance/empty-secret-mask" \
    "${stage_path}/acceptance/ipc-control" \
    "${stage_path}/acceptance/ipc-issuer" \
    "${stage_path}/acceptance/ipc-resolver" \
    "${stage_path}/acceptance/ipc-scope"
rmdir -- "${stage_path}/workspace"

git clone --no-hardlinks "${source_repository}" "${stage_path}/workspace"
git -C "${stage_path}/workspace" remote rename origin "${source_remote}"
git -C "${stage_path}/workspace" remote add upstream "${FORGE_ADMIN_REPOSITORY}"
git -C "${stage_path}/workspace" config --local forge-delivery.managed true
git -C "${stage_path}/workspace" config --local forge-delivery.project-slug "${slug}"
git -C "${stage_path}/workspace" config --local forge-delivery.foundation-commit "${source_commit}"
git -C "${stage_path}/workspace" config --local forge-delivery.source-kind "${source_kind}"
git -C "${stage_path}/workspace" config --local forge-delivery.source-project "${source_slug}"
git -C "${stage_path}/workspace" config --local forge-delivery.source-commit "${source_commit}"
git -C "${stage_path}/workspace" remote add origin "${project_git_url}"
if [[ "${foundation_mode}" == true ]]; then
  git -C "${stage_path}/workspace" switch main
  git -C "${stage_path}/workspace" branch --set-upstream-to=foundation/main main
else
  git -C "${stage_path}/workspace" checkout --detach "${source_commit}"
  git -C "${stage_path}/workspace" switch --create "${work_branch}"
fi
[[ "$(git -C "${stage_path}/workspace" rev-parse --is-inside-work-tree)" == true ]] \
  || die "Project workspace is not an independent Git worktree."
[[ "$(git -C "${stage_path}/workspace" rev-parse HEAD)" == "${source_commit}" ]] \
  || die "Project Git source does not match the reviewed source commit."

forge_ref="${source_ref}"
forge_commit="${source_commit}"
frontend_typecheck_capability provision --workspace "${stage_path}/workspace"
typecheck_status="$(git -C "${stage_path}/workspace" status --porcelain=v1 --untracked-files=all)"
expected_typecheck_status=$' M forge-admin-ui/jsconfig.json\n M forge-admin-ui/package.json\n M forge-admin-ui/pnpm-lock.yaml'
if [[ "${typecheck_status}" == "${expected_typecheck_status}" ]]; then
  git -C "${stage_path}/workspace" add -- \
    forge-admin-ui/package.json forge-admin-ui/pnpm-lock.yaml forge-admin-ui/jsconfig.json
  git -C "${stage_path}/workspace" \
    -c user.name='Forge Delivery Bootstrap' \
    -c user.email='forge-delivery@localhost.invalid' \
    commit --no-gpg-sign --message 'chore: enable frontend typecheck'
  forge_ref="${source_ref}-frontend-typecheck"
  forge_commit="$(git -C "${stage_path}/workspace" rev-parse 'HEAD^{commit}')"
elif [[ -n "${typecheck_status}" ]]; then
  die "Frontend typecheck provisioning changed files outside package.json, pnpm-lock.yaml, and jsconfig.json."
fi
frontend_typecheck_capability check --workspace "${stage_path}/workspace"
ssh-keygen -q -t ed25519 -N '' -C "forge-delivery:${slug}" \
  -f "${git_stage_path}/id_ed25519"
chmod 0600 "${git_stage_path}/id_ed25519"
chmod 0644 "${git_stage_path}/id_ed25519.pub"
[[ "$(git -C "${stage_path}/workspace" rev-parse HEAD)" == "${forge_commit}" \
  && -z "$(git -C "${stage_path}/workspace" status --porcelain=v1 --untracked-files=all)" ]] \
  || die "Project Git initial commit is not the reviewed frontend typecheck target."

release_contract_render_project_compose \
  "${REPO_ROOT}/templates/project/compose.yaml" "${allowed_release_services_json}" \
  >"${stage_path}/ops/compose.yaml"

host_uid="$(id -u "${DELIVERY_OWNER}")"
host_gid="$(getent group "${DELIVERY_GROUP}" | cut -d: -f3)"
docker_gid="$(getent group docker | cut -d: -f3)"
[[ -n "${docker_gid}" ]] || die "Docker group is required for Harness release execution."
harness_upload_token="$(openssl rand -hex 32)"
conversation_manager_token="$(openssl rand -hex 32)"
rendered_env="$(<"${REPO_ROOT}/templates/project/project.env.tpl")"
rendered_env="${rendered_env//__PROJECT_SLUG__/${slug}}"
rendered_env="${rendered_env//__PLATFORM_ROOT__/${REPO_ROOT}}"
rendered_env="${rendered_env//__FORGE_ADMIN_REF__/${forge_ref}}"
rendered_env="${rendered_env//__FORGE_ADMIN_COMMIT__/${forge_commit}}"
rendered_env="${rendered_env//__PROJECT_SOURCE_KIND__/${source_kind}}"
rendered_env="${rendered_env//__PROJECT_SOURCE_SLUG__/${source_slug}}"
rendered_env="${rendered_env//__PROJECT_SOURCE_COMMIT__/${source_commit}}"
rendered_env="${rendered_env//__PROJECT_GIT_REMOTE_URL__/${project_git_url}}"
rendered_env="${rendered_env//__PROJECT_GIT_REMOTE_BRANCH__/${work_branch}}"
rendered_env="${rendered_env//__FORGE_BIND_ADDRESS__/${bind_address}}"
rendered_env="${rendered_env//__FORGE_UI_PORT__/${ui_port}}"
rendered_env="${rendered_env//__HARNESS_PORT__/${harness_port}}"
rendered_env="${rendered_env//__HARNESS_PRIVILEGED_API_MODE__/${HARNESS_PRIVILEGED_API_MODE:-loopback-only}}"
rendered_env="${rendered_env//__HARNESS_UPLOAD_TOKEN__/${harness_upload_token}}"
rendered_env="${rendered_env//__HOST_UID__/${host_uid}}"
rendered_env="${rendered_env//__HOST_GID__/${host_gid}}"
rendered_env="${rendered_env//__DOCKER_GID__/${docker_gid}}"
rendered_env="${rendered_env//__DELIVERY_ROOT__/${DELIVERY_ROOT}}"
rendered_env="${rendered_env//__DELIVERY_OWNER__/${DELIVERY_OWNER}}"
rendered_env="${rendered_env//__DELIVERY_GROUP__/${DELIVERY_GROUP}}"
rendered_env="${rendered_env//__DEEPSEEK_KEY_FILE__/${DEEPSEEK_KEY_FILE}}"
rendered_env="${rendered_env//__KIMI_KEY_FILE__/${KIMI_KEY_FILE}}"
rendered_env="${rendered_env//__GLM_KEY_FILE__/${GLM_KEY_FILE}}"
rendered_env="${rendered_env//__SHARED_SERVICES_ENV_FILE__/${SHARED_SERVICES_ENV_FILE}}"
rendered_env="${rendered_env//__MYSQL_DATABASE__/${mysql_database}}"
rendered_env="${rendered_env//__MYSQL_TEST_DATABASE__/${mysql_test_database}}"
rendered_env="${rendered_env//__REDIS_DATABASE__/${redis_database}}"
rendered_env="${rendered_env//__REDIS_TEST_DATABASE__/${redis_test_database}}"
rendered_env="${rendered_env//__HARNESS_IMAGE__/${harness_image_id}}"
rendered_env="${rendered_env//__RELEASE_RUNNER_IMAGE__/${RELEASE_RUNNER_IMAGE:-${harness_image_id}}}"
rendered_env="${rendered_env//__TASKSPACE_BROKER_IMAGE__/${TASKSPACE_BROKER_IMAGE:-${RELEASE_RUNNER_IMAGE:-${harness_image_id}}}}"
rendered_env="${rendered_env//__PROTECTED_ACCEPTANCE_IMAGE__/${PROTECTED_ACCEPTANCE_IMAGE:-${harness_image_id}}}"
rendered_env="${rendered_env//__HARNESS_IMAGE_SOURCE__/${HARNESS_IMAGE}}"
rendered_env="${rendered_env//__FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED__/${format_maintenance_supported}}"
rendered_env="${rendered_env//__FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED__/${contract_continuation_supported}}"
rendered_env="${rendered_env//__FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED__/${review_suspension_supported}}"
rendered_env="${rendered_env//__FORGE_CHANGED_VERIFICATION_SUPPORTED__/${changed_verification_supported}}"
rendered_env="${rendered_env//__FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED__/${focused_backend_verification_supported}}"
rendered_env="${rendered_env//__FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED__/${ordinary_final_verification_supported}}"
rendered_env="${rendered_env//__CONVERSATION_MANAGER_IMAGE__/${conversation_manager_image_id}}"
  rendered_env="${rendered_env//__RELEASE_DB_OPERATOR_IMAGE__/${RELEASE_DB_OPERATOR_IMAGE}}"
previous_umask="$(umask)"
umask 077
printf '%s\n' "${rendered_env}" >"${stage_path}/ops/project.env"
chmod 0600 "${stage_path}/ops/project.env"
printf '%s\n' "${conversation_manager_token}" >"${stage_path}/ops/conversation-manager-token"
chmod 0600 "${stage_path}/ops/conversation-manager-token"
umask "${previous_umask}"

render_release_contract \
  "${slug}" \
  "${project_path}" \
  "${stage_path}/workspace" \
  "${stage_path}/ops/project.env" \
  "${stage_path}/ops/runtime-contract.json" \
  "${stage_path}/workspace" \
  "${allowed_release_services_json}" \
  "${allowed_release_services_json}"

verification_contract="$(<"${REPO_ROOT}/templates/project/verification-contract.json.tpl")"
verification_contract="${verification_contract//__DELIVERY_ROOT__/${DELIVERY_ROOT}}"
verification_contract="${verification_contract//__PROJECT_SLUG__/${slug}}"
verification_contract="${verification_contract//__HARNESS_IMAGE_REVISION__/${HARNESS_IMAGE_REVISION}}"
verification_contract="${verification_contract//__HARNESS_IMAGE__/${harness_image_id}}"
verification_contract="${verification_contract//__HARNESS_IMAGE_ID__/${harness_cache_image_id}}"
printf '%s\n' "${verification_contract}" >"${stage_path}/verification/contract.json"
chmod 0600 "${stage_path}/verification/contract.json"

acceptance_issued_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
acceptance_expires_at="$(date -u -d '+365 days' +%Y-%m-%dT%H:%M:%S.000Z)"
acceptance_config="$(<"${REPO_ROOT}/templates/project/acceptance-service.json.tpl")"
acceptance_config="${acceptance_config//__PROJECT_SLUG__/${slug}}"
acceptance_config="${acceptance_config//__TRUST_ISSUED_AT__/${acceptance_issued_at}}"
acceptance_config="${acceptance_config//__TRUST_EXPIRES_AT__/${acceptance_expires_at}}"
printf '%s\n' "${acceptance_config}" >"${stage_path}/acceptance/service.json"
chmod 0600 "${stage_path}/acceptance/service.json"
for acceptance_role in platform governance verification semantic verdict; do
  openssl genpkey -algorithm ED25519 -out "${stage_path}/acceptance/secrets/${acceptance_role}.pem"
  chmod 0600 "${stage_path}/acceptance/secrets/${acceptance_role}.pem"
done

install -m 0600 "${REPO_ROOT}/templates/project/harness-settings.yaml" \
  "${stage_path}/dsh-home/settings.yaml"

project_context="$(<"${REPO_ROOT}/templates/project/PROJECT_CONTEXT.md.tpl")"
project_context="${project_context//__PROJECT_SLUG__/${slug}}"
project_context="${project_context//__PROJECT_DISPLAY_NAME__/${display_name}}"
project_context="${project_context//__FORGE_ADMIN_REF__/${forge_ref}}"
project_context="${project_context//__FORGE_ADMIN_COMMIT__/${forge_commit}}"
project_context="${project_context//__PROJECT_SOURCE_KIND__/${source_kind}}"
project_context="${project_context//__PROJECT_SOURCE_SLUG__/${source_slug}}"
project_context="${project_context//__PROJECT_SOURCE_COMMIT__/${source_commit}}"
project_context="${project_context//__WORK_BRANCH__/${work_branch}}"
project_context="${project_context//__HARNESS_SKILL_BUNDLE_VERSION__/${HARNESS_SKILL_BUNDLE_VERSION}}"
project_context="${project_context//__MYSQL_DATABASE__/${mysql_database}}"
project_context="${project_context//__MYSQL_TEST_DATABASE__/${mysql_test_database}}"
project_context="${project_context//__REDIS_DATABASE__/${redis_database}}"
project_context="${project_context//__REDIS_TEST_DATABASE__/${redis_test_database}}"
governance_context="${stage_path}/governance/PROJECT_CONTEXT.md"
governance_context_hash="${stage_path}/governance/PROJECT_CONTEXT.sha256"
write_project_governance_context \
  "${stage_path}/workspace" "${source_kind}" "${project_context}" "${governance_context}"
printf '%s\n' "$(sha256sum "${governance_context}" | awk '{print $1}')" \
  >"${governance_context_hash}"
chmod 0444 "${governance_context}" "${governance_context_hash}"

# AGENTS.md belongs exclusively to the source repository. Platform context is
# normally rendered outside Git. A registered project may instead carry a
# clean tracked legacy context; the helper above preserves those exact bytes so
# the read-only TaskSpace overlay remains identical to the Git HEAD content.
if [[ -e "${stage_path}/workspace/AGENTS.md" \
    || -L "${stage_path}/workspace/AGENTS.md" ]]; then
  git -C "${stage_path}/workspace" ls-files --error-unmatch -- AGENTS.md >/dev/null 2>&1 \
    || die "An untracked AGENTS.md is ambiguous; project creation failed closed."
  [[ -f "${stage_path}/workspace/AGENTS.md" \
    && ! -L "${stage_path}/workspace/AGENTS.md" ]] \
    || die "Tracked AGENTS.md must be a regular non-symbolic-link file."
fi

if [[ "${EUID}" -eq 0 ]]; then
  chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${stage_path}"
  chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${git_stage_path}"
fi
chmod 2700 \
  "${stage_path}/verification" \
  "${stage_path}/verification/ipc" \
  "${stage_path}/verification/source-ipc" \
  "${stage_path}/verification/empty-manager-mask" \
  "${stage_path}/verification/state" \
  "${stage_path}/verification/cache-packs" \
  "${stage_path}/verification/cache-packs/images" \
  "${stage_path}/verification/cache-packs/images/${harness_cache_image_id}" \
  "${stage_path}/acceptance" \
  "${stage_path}/acceptance/state" \
  "${stage_path}/acceptance/secrets" \
  "${stage_path}/acceptance/empty-secret-mask" \
  "${stage_path}/acceptance/ipc-control" \
  "${stage_path}/acceptance/ipc-issuer" \
  "${stage_path}/acceptance/ipc-resolver" \
  "${stage_path}/acceptance/ipc-scope"
chmod 0500 "${stage_path}/acceptance/empty-secret-mask"

stage_status="$(project_git_readonly "${stage_path}/workspace" status --porcelain=v1 --untracked-files=all)" \
  || die "Unable to read the new project Git worktree as its delivery owner."
if [[ -n "${stage_status}" ]]; then
  die "New project Git worktree is unexpectedly dirty; refusing to register it."
fi
if [[ "${source_kind}" == 'registered-project' ]]; then
  [[ -z "$(project_git_readonly "${source_workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Source project changed during replication; refusing to register the target."
  [[ "$(project_git_readonly "${source_workspace}" rev-parse 'HEAD^{commit}')" == "${source_commit}" ]] \
    || die "Source project HEAD changed during replication; refusing to register the target."
fi

mv -- "${git_stage_path}" "${project_git_root}"
git_credentials_moved=true
mv -- "${stage_path}" "${project_path}"
trap - EXIT

control_project_root="${DELIVERY_ROOT}/conversation-control-plane/projects/${slug}"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${control_project_root}"
install -d -m 0700 -o "${DELIVERY_OWNER}" -g "${DELIVERY_GROUP}" "${control_project_root}/ipc"
mv -- "${project_path}/ops/conversation-manager-token" "${control_project_root}/manager-token"
chmod 0600 "${control_project_root}/manager-token"
if [[ "${EUID}" -eq 0 ]]; then
  chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${control_project_root}/manager-token"
fi

created_at="$(date --iso-8601=seconds)"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "${slug}" "${display_name}" "${ui_port}" "${harness_port}" \
  "${forge_ref}" "${forge_commit}" "${created_at}" "${project_kind}" \
  "${mysql_database}" "${mysql_test_database}" "${redis_database}" "${redis_test_database}" >>"${registry_file}"

# Seed the registered project before Manager can create its first conversation.
# The host synchronizer owns CLI refresh; no login is copied into the project.
if [[ -e /etc/forge-delivery/codex-cli.json || -L /etc/forge-delivery/codex-cli.json ]]; then
  if [[ "${EUID}" -eq 0 ]] && command -v python3 >/dev/null 2>&1; then
    python3 "${REPO_ROOT}/scripts/sync-codex-cli-authorization.py" --project-root "${project_path}" >/dev/null \
      || warn 'Codex CLI authorization is not ready for this project yet; other configured models remain available.'
  else
    warn 'Codex CLI authorization awaits the host synchronizer; other configured models remain available.'
  fi
fi

log "Created project ${display_name} (${slug}) at ${project_path}."
log "Git: source ${source_kind}${source_slug:+ ${source_slug}} remains ${source_commit}; initial project HEAD is ${forge_commit} on ${work_branch}."
log "Private Git remote: ${project_git_url} (pending deploy-key registration and host-key pinning)."
log "Deploy public key: ${project_git_root}/id_ed25519.pub"
warn "Run project-gitctl.sh ${slug} attach after adding that deploy key to the exact GitLab project with write access."
log "Forge UI: http://${bind_address}:${ui_port}/forge/login"
log "Unified Harness project directory: http://${bind_address}:${harness_port}/forge-gateway/"
log "Database isolation: ${mysql_database} and ${mysql_test_database}; Redis runtime/test logical DBs ${redis_database}/${redis_test_database}."
log "Application runtime: ${application_runtime}; release services ${allowed_release_services_json}."
warn "The shared MySQL databases and grants must exist before the first start; project creation does not mutate shared services."
log "Validate next: bash ${REPO_ROOT}/scripts/projectctl.sh ${slug} validate"
log "Start only after reviewing project.env: bash ${REPO_ROOT}/scripts/projectctl.sh ${slug} up"
if [[ -f "${DELIVERY_ROOT}/file-gateway/file-gateway.env" ]]; then
  warn "Run 'bash ${REPO_ROOT}/scripts/file-gatewayctl.sh sync-projects' to create the upload directory and grant the shared upload group access."
fi
