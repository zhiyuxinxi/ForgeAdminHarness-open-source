#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
TASKSPACECTL="${REPO_ROOT}/scripts/taskspacectl.sh"
UPGRADE="${REPO_ROOT}/scripts/upgrade-project-material-isolation.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

extract_contract() {
  local source="$1"
  sed -n \
    -e '/^taskspace_git_exclude_path() {/,/^}/p' \
    -e '/^ensure_taskspace_git_exclude_contract() {/,/^}/p' \
    "${source}"
}

assert_contains() {
  local source="$1" pattern="$2" message="$3"
  grep -Fq -- "${pattern}" "${source}" || fail "${message}"
}

expect_contract_rejection() {
  local task_root="$1" label="$2"
  if ensure_taskspace_git_exclude_contract "${task_root}" "${label}" >/dev/null 2>&1; then
    fail "unsafe path was accepted: ${label}"
  fi
}

make_normal_taskspace() {
  local task_root="$1"
  mkdir -p -- "${task_root}/workspace"
  git -C "${task_root}/workspace" init --quiet
}

run_executable_contract_tests() {
  local source="$1" suite="$2" root external exclude_file sentinel_before
  unset -f taskspace_git_exclude_path ensure_taskspace_git_exclude_contract 2>/dev/null || true
  eval "$(extract_contract "${source}")"
  declare -F taskspace_git_exclude_path >/dev/null || fail "path resolver was not loaded from ${suite}"
  declare -F ensure_taskspace_git_exclude_contract >/dev/null || fail "contract writer was not loaded from ${suite}"

  root="${TEST_ROOT}/${suite}-normal"
  make_normal_taskspace "${root}"
  rm -f -- "${root}/workspace/.git/info/exclude"
  exclude_file="$(ensure_taskspace_git_exclude_contract "${root}" "${suite}-normal")" \
    || fail "normal clone was rejected by ${suite}"
  [[ -f "${exclude_file}" && ! -L "${exclude_file}" ]] || fail "normal exclude was not created by ${suite}"
  [[ "$(readlink -f -- "${exclude_file}")" == "$(readlink -f -- "${root}/workspace")/.git/info/exclude" ]] \
    || fail "normal exclude escaped its workspace in ${suite}"
  [[ "$(grep -Fxc -- '/.forge-cache/' "${exclude_file}")" == 1 \
    && "$(grep -Fxc -- '/.forge-delivery/' "${exclude_file}")" == 1 \
    && "$(grep -Fxc -- '/PROJECT_CONTEXT.md' "${exclude_file}")" == 1 ]] \
    || fail "required excludes were not written exactly once by ${suite}"
  ensure_taskspace_git_exclude_contract "${root}" "${suite}-normal" >/dev/null \
    || fail "idempotent replay failed in ${suite}"
  [[ "$(grep -Fxc -- '/.forge-cache/' "${exclude_file}")" == 1 \
    && "$(grep -Fxc -- '/.forge-delivery/' "${exclude_file}")" == 1 \
    && "$(grep -Fxc -- '/PROJECT_CONTEXT.md' "${exclude_file}")" == 1 ]] \
    || fail "idempotent replay duplicated excludes in ${suite}"

  root="${TEST_ROOT}/${suite}-workspace-link"
  external="${TEST_ROOT}/${suite}-workspace-link-outside"
  mkdir -p -- "${root}"
  make_normal_taskspace "${external}"
  sentinel_before="$(sha256sum "${external}/workspace/.git/info/exclude" | awk '{print $1}')"
  ln -s -- "${external}/workspace" "${root}/workspace"
  expect_contract_rejection "${root}" "${suite}-workspace-link"
  [[ "$(sha256sum "${external}/workspace/.git/info/exclude" | awk '{print $1}')" == "${sentinel_before}" ]] \
    || fail "workspace symlink target was modified by ${suite}"

  root="${TEST_ROOT}/${suite}-git-link"
  external="${TEST_ROOT}/${suite}-git-link-outside"
  mkdir -p -- "${root}/workspace"
  make_normal_taskspace "${external}"
  sentinel_before="$(sha256sum "${external}/workspace/.git/info/exclude" | awk '{print $1}')"
  ln -s -- "${external}/workspace/.git" "${root}/workspace/.git"
  expect_contract_rejection "${root}" "${suite}-git-link"
  [[ "$(sha256sum "${external}/workspace/.git/info/exclude" | awk '{print $1}')" == "${sentinel_before}" ]] \
    || fail ".git symlink target was modified by ${suite}"

  root="${TEST_ROOT}/${suite}-info-link"
  external="${TEST_ROOT}/${suite}-info-link-outside"
  make_normal_taskspace "${root}"
  mkdir -p -- "${external}"
  printf 'outside-info\n' >"${external}/exclude"
  rm -rf -- "${root}/workspace/.git/info"
  ln -s -- "${external}" "${root}/workspace/.git/info"
  expect_contract_rejection "${root}" "${suite}-info-link"
  [[ "$(<"${external}/exclude")" == outside-info ]] || fail ".git/info symlink target was modified by ${suite}"

  root="${TEST_ROOT}/${suite}-exclude-link"
  external="${TEST_ROOT}/${suite}-exclude-link-outside"
  make_normal_taskspace "${root}"
  printf 'do-not-change\n' >"${external}"
  rm -f -- "${root}/workspace/.git/info/exclude"
  ln -s -- "${external}" "${root}/workspace/.git/info/exclude"
  expect_contract_rejection "${root}" "${suite}-exclude-link"
  [[ "$(<"${external}")" == do-not-change ]] || fail "exclude symlink target was modified by ${suite}"

  root="${TEST_ROOT}/${suite}-gitfile"
  mkdir -p -- "${root}/workspace"
  printf 'gitdir: /unsupported/external/worktree\n' >"${root}/workspace/.git"
  expect_contract_rejection "${root}" "${suite}-gitfile"
}

run_nofollow_primitive_tests() {
  local root="${TEST_ROOT}/nofollow-primitives" outside link source
  mkdir -p -- "${root}"
  outside="${root}/outside"
  printf 'outside-must-survive\n' >"${outside}"
  link="${root}/exclude"
  ln -s -- "${outside}" "${link}"

  if printf '%s\n' '/.forge-delivery/' \
      | dd of="${link}" oflag=append,nofollow conv=notrunc,nocreat status=none 2>/dev/null; then
    fail 'dd append unexpectedly followed a swapped exclude symlink'
  fi
  if dd if=/dev/null of="${link}" conv=excl oflag=nofollow status=none 2>/dev/null; then
    fail 'dd creation unexpectedly followed or replaced an existing exclude symlink'
  fi
  [[ "$(<"${outside}")" == outside-must-survive ]] \
    || fail 'atomic no-follow primitives modified an external symlink target'

  rm -f -- "${link}"
  if printf '%s\n' '/.forge-delivery/' \
      | dd of="${link}" oflag=append,nofollow conv=notrunc,nocreat status=none 2>/dev/null; then
    fail 'dd append recreated an exclude file removed after validation'
  fi
  [[ ! -e "${link}" ]] || fail 'append-only primitive recreated a missing exclude file'
  ln -s -- "${outside}" "${link}"

  source="${root}/backup.exclude"
  printf 'restored-exclude\n' >"${source}"
  cp --no-dereference --remove-destination --preserve=mode,ownership,timestamps -- \
    "${source}" "${link}"
  [[ -f "${link}" && ! -L "${link}" && "$(<"${link}")" == restored-exclude ]] \
    || fail 'rollback copy did not replace the link itself with a regular file'
  [[ "$(<"${outside}")" == outside-must-survive ]] \
    || fail 'rollback copy followed the previous destination symlink'

  rm -f -- "${link}"
  [[ ! -e "${link}" && "$(<"${outside}")" == outside-must-survive ]] \
    || fail 'rollback removal affected the external symlink target'
}

for command_name in awk cmp cp dd git grep ln mkdir mktemp readlink rm sed sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required test command is missing: ${command_name}"
done

TEST_ROOT="$(mktemp -d)"
[[ -n "${TEST_ROOT}" && "${TEST_ROOT}" == /tmp/* ]] || fail "refusing unsafe temporary root: ${TEST_ROOT}"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

taskspace_contract="${TEST_ROOT}/taskspacectl.contract.sh"
upgrade_contract="${TEST_ROOT}/upgrade.contract.sh"
upgrade_backup="${TEST_ROOT}/upgrade.backup.sh"
upgrade_restore="${TEST_ROOT}/upgrade.restore.sh"
extract_contract "${TASKSPACECTL}" >"${taskspace_contract}"
extract_contract "${UPGRADE}" >"${upgrade_contract}"
sed -n '/^backup_project() {/,/^}/p' "${UPGRADE}" >"${upgrade_backup}"
sed -n '/^restore_project_files() {/,/^}/p' "${UPGRADE}" >"${upgrade_restore}"
cmp --silent "${taskspace_contract}" "${upgrade_contract}" \
  || fail "taskspacectl and upgrade no-follow contracts drifted"

run_executable_contract_tests "${TASKSPACECTL}" taskspacectl
run_executable_contract_tests "${UPGRADE}" upgrade
run_nofollow_primitive_tests

assert_contains "${TASKSPACECTL}" 'ensure_taskspace_cache_contract "$(task_root_of "${task_id}")"' \
  'TaskSpace start does not re-establish the guarded exclude contract'
assert_contains "${TASKSPACECTL}" 'chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${exclude_file}"' \
  'TaskSpace ownership repair can dereference a swapped exclude link'
assert_contains "${TASKSPACECTL}" 'conv=excl oflag=nofollow' \
  'TaskSpace exclude creation lacks an atomic no-follow open'
assert_contains "${TASKSPACECTL}" 'iflag=nofollow' \
  'TaskSpace exclude inspection can follow a swapped link'
assert_contains "${TASKSPACECTL}" 'oflag=append,nofollow conv=notrunc,nocreat' \
  'TaskSpace exclude append lacks an atomic no-follow open'
assert_contains "${upgrade_backup}" 'exclude_source="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")"' \
  'upgrade backup does not validate the exclude source path'
assert_contains "${upgrade_backup}" 'cp --no-dereference --preserve=mode,ownership,timestamps --' \
  'upgrade backup can dereference a swapped exclude source'
assert_contains "${upgrade_restore}" 'cp --no-dereference --remove-destination --preserve=mode,ownership,timestamps --' \
  'upgrade rollback can follow a swapped exclude destination'
assert_contains "${upgrade_restore}" 'exclude_target="$(taskspace_git_exclude_path "${task_root}" "${slug}/${task_id}")"' \
  'upgrade rollback does not validate the exclude path before copy/removal'
assert_contains "${upgrade_restore}" 'rm -f -- "${exclude_target}"' \
  'upgrade rollback does not preserve the recorded missing-exclude state'
assert_contains "${UPGRADE}" 'exclude_file="$(ensure_taskspace_git_exclude_contract' \
  'upgrade mutation bypasses the guarded exclude writer'
assert_contains "${UPGRADE}" 'chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${exclude_file}"' \
  'upgrade ownership repair can dereference a swapped exclude link'

if grep -Eq 'touch -- .*\.git/info/exclude|>>.*workspace/\.git/info/exclude' "${TASKSPACECTL}" "${UPGRADE}"; then
  fail 'unguarded direct TaskSpace Git exclude mutation remains'
fi

printf 'PASS TaskSpace Git exclude paths are no-follow, workspace-bounded, and rollback-safe\n'
