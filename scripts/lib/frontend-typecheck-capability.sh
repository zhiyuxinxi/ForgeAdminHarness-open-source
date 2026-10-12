#!/usr/bin/env bash

set -Eeuo pipefail

FRONTEND_TYPECHECK_HELPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FRONTEND_TYPECHECK_REPO_ROOT="$(cd -- "${FRONTEND_TYPECHECK_HELPER_DIR}/../.." && pwd -P)"
FRONTEND_TYPECHECK_MANIFEST="${FRONTEND_TYPECHECK_REPO_ROOT}/templates/project/frontend-typecheck-capability.json"
FRONTEND_TYPECHECK_PATCH="${FRONTEND_TYPECHECK_REPO_ROOT}/templates/project/frontend-typecheck-capability.patch"

frontend_typecheck_die() {
  printf '[forge-delivery] ERROR: %s\n' "$*" >&2
  exit 1
}

frontend_typecheck_require_command() {
  command -v "$1" >/dev/null 2>&1 \
    || frontend_typecheck_die "Required command is missing: $1"
}

frontend_typecheck_text_sha256() {
  # The reviewed hashes describe LF text so checkouts remain portable across Git EOL settings.
  sed 's/\r$//' -- "$1" | sha256sum | awk '{print $1}'
}

frontend_typecheck_assert_regular_file() {
  local file="$1" label="$2"
  [[ -f "${file}" && ! -L "${file}" && "$(stat -c '%h' -- "${file}")" == 1 ]] \
    || frontend_typecheck_die "${label} must be a single-link regular file: ${file}"
}

frontend_typecheck_validate_candidate() {
  local workspace="$1" metadata="$2" task_root task_id workspace_real metadata_real
  [[ -n "${metadata}" ]] \
    || frontend_typecheck_die "candidate TaskSpace metadata is required for apply"
  frontend_typecheck_assert_regular_file "${metadata}" 'candidate TaskSpace metadata'
  task_root="$(dirname -- "${workspace}")"
  task_id="$(basename -- "${task_root}")"
  [[ "${task_id}" =~ ^c-[a-f0-9]{24}$ ]] \
    || frontend_typecheck_die "candidate TaskSpace metadata has an invalid task identity"
  workspace_real="$(readlink -f -- "${workspace}")" \
    || frontend_typecheck_die "candidate TaskSpace workspace cannot be resolved"
  metadata_real="$(readlink -f -- "${metadata}")" \
    || frontend_typecheck_die "candidate TaskSpace metadata cannot be resolved"
  [[ "${workspace_real}" == "$(readlink -f -- "${task_root}")/workspace" \
    && "${metadata_real}" == "$(readlink -f -- "${task_root}")/metadata.json" ]] \
    || frontend_typecheck_die "candidate TaskSpace metadata is not adjacent to its workspace"
  jq -e --arg task_id "${task_id}" '
    type == "object"
    and .taskId == $task_id
    and (.projectSlug | type == "string" and test("^[a-z][a-z0-9-]{2,31}$"))
    and .status == "active"
    and .accessMode == "conversation"
  ' "${metadata}" >/dev/null \
    || frontend_typecheck_die "candidate TaskSpace metadata is invalid or inactive"
}

frontend_typecheck_validate_manifest() {
  local manifest="$1" patch="$2" patch_hash expected_patch_hash
  frontend_typecheck_assert_regular_file "${manifest}" 'frontend typecheck manifest'
  frontend_typecheck_assert_regular_file "${patch}" 'frontend typecheck patch'
  jq -e '
    .schemaVersion == 1
    and .capability == "frontend-admin-typecheck"
    and .frontendDirectory == "forge-admin-ui"
    and .command == "vue-tsc --noEmit --project jsconfig.json"
    and .packageManager.name == "pnpm"
    and .packageManager.sourceVersion == "11.7.0"
    and .packageManager.runnerVersion == "11.24.0"
    and .dependencies.typescript.version == "5.9.3"
    and .dependencies["vue-tsc"].version == "3.3.11"
    and .dependencies["vue-tsc"].typescriptPeerRange == ">=5.0.0"
    and .files.packageJson.path == "forge-admin-ui/package.json"
    and .files.lockfile.path == "forge-admin-ui/pnpm-lock.yaml"
    and .files.jsconfig.path == "forge-admin-ui/jsconfig.json"
    and .patch.path == "templates/project/frontend-typecheck-capability.patch"
    and ([.files.packageJson.beforeSha256, .files.packageJson.targetSha256,
          .files.lockfile.beforeSha256, .files.lockfile.targetSha256,
          .files.jsconfig.beforeSha256, .files.jsconfig.upgradeFromSha256,
          .files.jsconfig.targetSha256, .patch.sha256]
         | all(type == "string" and test("^[a-f0-9]{64}$")))
  ' "${manifest}" >/dev/null \
    || frontend_typecheck_die "frontend typecheck manifest is invalid"
  patch_hash="$(frontend_typecheck_text_sha256 "${patch}")"
  expected_patch_hash="$(jq -r '.patch.sha256' "${manifest}")"
  [[ "${patch_hash}" == "${expected_patch_hash}" ]] \
    || frontend_typecheck_die "frontend typecheck patch hash does not match its manifest"
}

frontend_typecheck_verify_target() {
  local package_json="$1" jsconfig="$2" manifest="$3" command typescript_version vue_tsc_version
  command="$(jq -r '.command' "${manifest}")"
  typescript_version="$(jq -r '.dependencies.typescript.version' "${manifest}")"
  vue_tsc_version="$(jq -r '.dependencies["vue-tsc"].version' "${manifest}")"
  jq -e --arg command "${command}" --arg typescript "${typescript_version}" --arg vue_tsc "${vue_tsc_version}" '
    .scripts.typecheck == $command
    and .devDependencies.typescript == $typescript
    and .devDependencies["vue-tsc"] == $vue_tsc
  ' "${package_json}" >/dev/null \
    || frontend_typecheck_die "frontend typecheck target does not contain the reviewed command and exact dependencies"
  jq -e '
    .compilerOptions.target == "ESNext"
    and .compilerOptions.module == "ESNext"
    and .compilerOptions.esModuleInterop == true
    and .exclude == ["node_modules", "dist"]
  ' "${jsconfig}" >/dev/null \
    || frontend_typecheck_die "frontend typecheck target does not contain the reviewed compiler options and exclude list"
}

frontend_typecheck_capability_run() {
  local action="$1" workspace="$2" manifest="$3" patch="$4" metadata="${5:-}"
  local frontend package_json lockfile jsconfig package_hash lock_hash jsconfig_hash
  local before_package target_package before_lock target_lock before_jsconfig upgrade_from_jsconfig target_jsconfig
  local pending_path jsconfig_upgrade_tmp=''
  local foundation_before_package foundation_target_package foundation_before_lock foundation_target_lock
  local -a patch_paths pending_paths

  [[ "${action}" == check || "${action}" == provision || "${action}" == apply ]] \
    || frontend_typecheck_die "frontend typecheck action must be check, provision, or apply"
  for command_name in awk git jq mktemp mv readlink rm sed sha256sum sort stat; do
    frontend_typecheck_require_command "${command_name}"
  done
  [[ -d "${workspace}" && ! -L "${workspace}" \
    && -d "${workspace}/.git" && ! -L "${workspace}/.git" ]] \
    || frontend_typecheck_die "frontend typecheck workspace must be an independent Git worktree"
  frontend_typecheck_validate_manifest "${manifest}" "${patch}"
  [[ "${action}" != apply ]] || frontend_typecheck_validate_candidate "${workspace}" "${metadata}"

  frontend="${workspace}/forge-admin-ui"
  package_json="${frontend}/package.json"
  lockfile="${frontend}/pnpm-lock.yaml"
  jsconfig="${frontend}/jsconfig.json"
  [[ -d "${frontend}" && ! -L "${frontend}" ]] \
    || frontend_typecheck_die "forge-admin-ui is missing or unsafe"
  frontend_typecheck_assert_regular_file "${package_json}" 'frontend package.json'
  frontend_typecheck_assert_regular_file "${lockfile}" 'frontend pnpm lockfile'
  frontend_typecheck_assert_regular_file "${jsconfig}" 'frontend jsconfig.json'

  package_hash="$(frontend_typecheck_text_sha256 "${package_json}")"
  lock_hash="$(frontend_typecheck_text_sha256 "${lockfile}")"
  jsconfig_hash="$(frontend_typecheck_text_sha256 "${jsconfig}")"
  before_package="$(jq -r '.files.packageJson.beforeSha256' "${manifest}")"
  target_package="$(jq -r '.files.packageJson.targetSha256' "${manifest}")"
  before_lock="$(jq -r '.files.lockfile.beforeSha256' "${manifest}")"
  target_lock="$(jq -r '.files.lockfile.targetSha256' "${manifest}")"
  before_jsconfig="$(jq -r '.files.jsconfig.beforeSha256' "${manifest}")"
  upgrade_from_jsconfig="$(jq -r '.files.jsconfig.upgradeFromSha256' "${manifest}")"
  target_jsconfig="$(jq -r '.files.jsconfig.targetSha256' "${manifest}")"

  # The promoted foundation preserves its pinned i18n dependency. Select only
  # the complete reviewed package/lock pair; never mix it with legacy inputs.
  if jq -e '.foundationPreimage != null' "${manifest}" >/dev/null; then
    jq -e '
      (.foundationPreimage.sourceCommit | type == "string" and test("^[a-f0-9]{40}$"))
      and ([.foundationPreimage.files.packageJson.beforeSha256,
            .foundationPreimage.files.packageJson.targetSha256,
            .foundationPreimage.files.lockfile.beforeSha256,
            .foundationPreimage.files.lockfile.targetSha256]
           | all(type == "string" and test("^[a-f0-9]{64}$")))
    ' "${manifest}" >/dev/null || frontend_typecheck_die "foundation typecheck binding is invalid"
    foundation_before_package="$(jq -r '.foundationPreimage.files.packageJson.beforeSha256' "${manifest}")"
    foundation_target_package="$(jq -r '.foundationPreimage.files.packageJson.targetSha256' "${manifest}")"
    foundation_before_lock="$(jq -r '.foundationPreimage.files.lockfile.beforeSha256' "${manifest}")"
    foundation_target_lock="$(jq -r '.foundationPreimage.files.lockfile.targetSha256' "${manifest}")"
    if [[ "${package_hash}" == "${foundation_before_package}" && "${lock_hash}" == "${foundation_before_lock}" \
       || "${package_hash}" == "${foundation_target_package}" && "${lock_hash}" == "${foundation_target_lock}" ]]; then
      before_package="${foundation_before_package}"; target_package="${foundation_target_package}"
      before_lock="${foundation_before_lock}"; target_lock="${foundation_target_lock}"
    fi
  fi

  if [[ "${package_hash}" == "${target_package}" \
    && "${lock_hash}" == "${target_lock}" \
    && "${jsconfig_hash}" == "${target_jsconfig}" ]]; then
    frontend_typecheck_verify_target "${package_json}" "${jsconfig}" "${manifest}"
    if [[ "${action}" != check ]]; then
      printf 'Frontend typecheck capability is already active; no files changed.\n'
    else
      printf 'Frontend typecheck capability is active.\n'
    fi
    return 0
  fi
  [[ "${package_hash}" == "${before_package}" || "${package_hash}" == "${target_package}" ]] \
    || frontend_typecheck_die "unknown frontend typecheck preimage; package.json, pnpm-lock.yaml, and jsconfig.json were not changed"
  [[ "${lock_hash}" == "${before_lock}" || "${lock_hash}" == "${target_lock}" ]] \
    || frontend_typecheck_die "unknown frontend typecheck preimage; package.json, pnpm-lock.yaml, and jsconfig.json were not changed"
  [[ "${jsconfig_hash}" == "${before_jsconfig}" \
    || "${jsconfig_hash}" == "${upgrade_from_jsconfig}" \
    || "${jsconfig_hash}" == "${target_jsconfig}" ]] \
    || frontend_typecheck_die "unknown frontend typecheck preimage; package.json, pnpm-lock.yaml, and jsconfig.json were not changed"
  [[ "${action}" != check ]] \
    || frontend_typecheck_die "frontend typecheck requires reviewed new-project provision or candidate apply"

  mapfile -t patch_paths < <(git apply --numstat -- "${patch}" | awk -F '\t' '{print $3}' | sort)
  [[ "${#patch_paths[@]}" == 3 \
    && "${patch_paths[0]}" == 'forge-admin-ui/jsconfig.json' \
    && "${patch_paths[1]}" == 'forge-admin-ui/package.json' \
    && "${patch_paths[2]}" == 'forge-admin-ui/pnpm-lock.yaml' ]] \
    || frontend_typecheck_die "frontend typecheck patch must change only package.json, pnpm-lock.yaml, and jsconfig.json"

  [[ "${package_hash}" == "${target_package}" ]] || pending_paths+=('forge-admin-ui/package.json')
  [[ "${lock_hash}" == "${target_lock}" ]] || pending_paths+=('forge-admin-ui/pnpm-lock.yaml')
  if [[ "${jsconfig_hash}" == "${upgrade_from_jsconfig}" ]]; then
    jsconfig_upgrade_tmp="$(mktemp "${frontend}/.jsconfig-upgrade.XXXXXX")"
    sed '/^    "module": "ESNext",$/d; /^    "baseUrl": "\.\/",$/a\    "module": "ESNext",' \
      "${jsconfig}" >"${jsconfig_upgrade_tmp}"
    [[ "$(frontend_typecheck_text_sha256 "${jsconfig_upgrade_tmp}")" == "${target_jsconfig}" ]] \
      || { rm -f -- "${jsconfig_upgrade_tmp}"; frontend_typecheck_die "known frontend jsconfig upgrade did not reach the reviewed target"; }
  elif [[ "${jsconfig_hash}" != "${target_jsconfig}" ]]; then
    pending_paths+=('forge-admin-ui/jsconfig.json')
  fi
  for pending_path in "${pending_paths[@]}"; do
    git -C "${workspace}" apply --check --whitespace=nowarn --include="${pending_path}" -- "${patch}" \
      || { [[ -z "${jsconfig_upgrade_tmp}" ]] || rm -f -- "${jsconfig_upgrade_tmp}"; frontend_typecheck_die "frontend typecheck patch does not apply to the reviewed preimage"; }
  done
  for pending_path in "${pending_paths[@]}"; do
    git -C "${workspace}" apply --whitespace=nowarn --include="${pending_path}" -- "${patch}"
  done
  if [[ -n "${jsconfig_upgrade_tmp}" ]]; then
    chmod --reference="${jsconfig}" "${jsconfig_upgrade_tmp}"
    mv -- "${jsconfig_upgrade_tmp}" "${jsconfig}"
  fi

  package_hash="$(frontend_typecheck_text_sha256 "${package_json}")"
  lock_hash="$(frontend_typecheck_text_sha256 "${lockfile}")"
  jsconfig_hash="$(frontend_typecheck_text_sha256 "${jsconfig}")"
  [[ "${package_hash}" == "${target_package}" \
    && "${lock_hash}" == "${target_lock}" \
    && "${jsconfig_hash}" == "${target_jsconfig}" ]] \
    || frontend_typecheck_die "frontend typecheck apply did not reach the reviewed target"
  frontend_typecheck_verify_target "${package_json}" "${jsconfig}" "${manifest}"
  if [[ "${action}" == apply ]]; then
    printf 'Applied the reviewed frontend typecheck capability to the candidate TaskSpace.\n'
  else
    printf 'Provisioned the reviewed frontend typecheck capability in the new project.\n'
  fi
}

frontend_typecheck_capability() {
  local action="${1:-}" workspace='' metadata=''
  [[ -n "${action}" ]] || frontend_typecheck_die "frontend typecheck action is required"
  shift || true
  while (($# > 0)); do
    case "$1" in
      --workspace) workspace="${2:-}"; shift 2 ;;
      --candidate-metadata) metadata="${2:-}"; shift 2 ;;
      *) frontend_typecheck_die "unknown frontend typecheck argument: $1" ;;
    esac
  done
  [[ -n "${workspace}" ]] || frontend_typecheck_die "--workspace is required"
  frontend_typecheck_capability_run \
    "${action}" "${workspace}" "${FRONTEND_TYPECHECK_MANIFEST}" "${FRONTEND_TYPECHECK_PATCH}" "${metadata}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  frontend_typecheck_capability "$@"
fi
