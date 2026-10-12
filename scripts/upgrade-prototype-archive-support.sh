#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() {
  printf 'Usage: %s --confirm-maintenance-window prototype-archive-support\n' "$0"
}

confirmation=''
while (($# > 0)); do
  case "$1" in
    --confirm-maintenance-window) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ "${confirmation}" == prototype-archive-support ]] \
  || die "This upgrade requires --confirm-maintenance-window prototype-archive-support."

for command_name in awk docker flock jq readlink; do require_command "${command_name}"; done
require_docker_access
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
[[ -f "${registry_file}" ]] || die "Project registry is missing: ${registry_file}"
projects_lock="${DELIVERY_ROOT}/registry/projects.lock"
prepare_delivery_lock "${projects_lock}"
inherited_projects_lock_fd="${FORGE_PROJECTS_LOCK_FD:-}"
if [[ "${inherited_projects_lock_fd}" =~ ^[0-9]+$ \
  && -e "/proc/$$/fd/${inherited_projects_lock_fd}" \
  && "$(readlink -f "/proc/$$/fd/${inherited_projects_lock_fd}")" == "$(readlink -f "${projects_lock}")" ]]; then
  flock --exclusive --nonblock "${inherited_projects_lock_fd}" \
    || die "Inherited project registry lock is not held."
else
  exec 5>>"${projects_lock}"
  flock --exclusive --nonblock 5 \
    || die "A project create, clone, or registry action is active; retry after it finishes."
  inherited_projects_lock_fd=5
fi
export FORGE_PROJECTS_LOCK_FD="${inherited_projects_lock_fd}"
acquire_harness_image_upgrade_lock
mapfile -t project_slugs < <(awk -F '\t' 'NR > 1 {print $1}' "${registry_file}")
((${#project_slugs[@]} > 0)) || die "No registered projects exist."

declare -A current_images=()
for slug in "${project_slugs[@]}"; do
  project_env="${DELIVERY_ROOT}/projects/${slug}/ops/project.env"
  [[ -f "${project_env}" ]] || die "Project environment is missing for ${slug}."
  image="$(awk -F= '$1 == "HARNESS_IMAGE" {sub(/^[^=]*=/, ""); print; exit}' "${project_env}")"
  [[ -n "${image}" ]] || die "HARNESS_IMAGE is missing for ${slug}."
  current_images["${image}"]=1
done
target_image="${HARNESS_IMAGE}"
declare -a predecessor_images=()
for image in "${!current_images[@]}"; do
  [[ "${image}" == "${target_image}" ]] || predecessor_images+=("${image}")
done
((${#predecessor_images[@]} <= 1)) \
  || die "Registered projects contain more than one predecessor Harness image; use a reviewed recovery before platform cutover."
current_image="${predecessor_images[0]:-${target_image}}"
if docker image inspect "${target_image}" >/dev/null 2>&1; then
  expected_base_image_id="$(resolve_configured_harness_foundation_image_id)"
  verify_target_harness_image "${target_image}" "${expected_base_image_id}"
  log "Reusing verified prototype-capable Harness image ${target_image}."
else
  [[ "${current_image}" != "${target_image}" ]] \
    || die "Target image is referenced by projects but is unavailable: ${target_image}"
  docker image inspect "${current_image}" >/dev/null 2>&1 \
    || die "Current Harness image is unavailable: ${current_image}"
  expected_base_image_id="$(resolve_configured_harness_foundation_image_id)"
  foundation_image_build_ref="$(resolve_local_docker_build_ref "${HARNESS_FOUNDATION_IMAGE}" "${expected_base_image_id}")"
  log "Building immutable prototype-capable Harness image ${target_image} from verified foundation ${expected_base_image_id}."
  docker build \
    --build-arg "HARNESS_BASE_IMAGE=${foundation_image_build_ref}" \
    --build-arg "HARNESS_BASE_IMAGE_ID=${expected_base_image_id}" \
    --build-arg "DSH_VERSION=${DSH_VERSION}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "HARNESS_IMAGE_REVISION=${HARNESS_IMAGE_REVISION}" \
    --build-arg "HARNESS_SKILL_BUNDLE_VERSION=${HARNESS_SKILL_BUNDLE_VERSION}" \
    --build-arg "HARNESS_RUNTIME_PROFILE=${HARNESS_RUNTIME_PROFILE}" \
    --build-arg "PDFJS_DIST_VERSION=${PDFJS_DIST_VERSION}" \
    --build-arg "MAMMOTH_VERSION=${MAMMOTH_VERSION}" \
    --build-arg "READ_EXCEL_FILE_VERSION=${READ_EXCEL_FILE_VERSION}" \
    --build-arg "YAUZL_VERSION=${YAUZL_VERSION}" \
    --build-arg INSTALL_DOCUMENT_DEPENDENCIES=false \
    --tag "${target_image}" \
    --file "${REPO_ROOT}/docker/harness/Dockerfile.overlay" \
    "${REPO_ROOT}"
  verify_target_harness_image "${target_image}" "${expected_base_image_id}"
fi

# Reuse the reviewed all-project, rollback-capable cutover. It refuses active
# release/broker jobs, preserves application containers and updates existing
# TaskSpaces, Manager, Gateway and reusable templates to the same image.
exec bash "${SCRIPT_DIR}/upgrade-project-material-isolation.sh" \
  --confirm-maintenance-window project-material-isolation
