#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
fixture_root="$(mktemp -d /tmp/forge-project-git-owner.XXXXXX)"

cleanup() {
  [[ -n "${fixture_root}" && -d "${fixture_root}" ]] && rm -rf -- "${fixture_root}"
}
trap cleanup EXIT

if [[ "${EUID}" -eq 0 ]]; then
  DELIVERY_OWNER='nobody'
  DELIVERY_GROUP="$(id -gn nobody)"
else
  DELIVERY_OWNER="$(id -un)"
  DELIVERY_GROUP="$(id -gn)"
fi
export DELIVERY_OWNER DELIVERY_GROUP

# shellcheck source=../scripts/lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

# Lock validation must not depend on locale-specific GNU stat file-kind prose.
! grep -q '%F' "${REPO_ROOT}/scripts/lib/common.sh"
# Host and container user/group names may differ for the same numeric identity.
! grep -q "stat -c '%U:%G" "${REPO_ROOT}/scripts/lib/common.sh"

workspace="${fixture_root}/workspace"
mkdir -p -- "${workspace}"
if [[ "${EUID}" -eq 0 ]]; then
  chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${fixture_root}"
fi
run_as_delivery_owner git -C "${workspace}" init --initial-branch=integration >/dev/null
run_as_delivery_owner git -C "${workspace}" config user.name 'Ownership Test'
run_as_delivery_owner git -C "${workspace}" config user.email 'ownership@example.invalid'
run_as_delivery_owner sh -c 'printf "fixture\n" >"$1/tracked.txt"' sh "${workspace}"
project_git "${workspace}" add -- tracked.txt
project_git "${workspace}" commit -m fixture >/dev/null

expected_uid="$(id -u "${DELIVERY_OWNER}")"
expected_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
[[ "$(stat -c '%u' "${workspace}/.git/index")" == "${expected_uid}" ]]
[[ "$(stat -c '%g' "${workspace}/.git/index")" == "${expected_gid}" ]]

# Force a stat-cache difference, then execute the same read gate from root.
# GIT_OPTIONAL_LOCKS=0 plus run-as-owner must not replace the index as root.
index_identity="$(stat -c '%d:%i:%Y:%s' "${workspace}/.git/index")"
run_as_delivery_owner touch "${workspace}/tracked.txt"
export GIT_INDEX_FILE=/dev/null
project_git_readonly "${workspace}" status --porcelain=v1 --untracked-files=all >/dev/null
unset GIT_INDEX_FILE
[[ "$(stat -c '%u' "${workspace}/.git/index")" == "${expected_uid}" ]]
[[ "$(stat -c '%g' "${workspace}/.git/index")" == "${expected_gid}" ]]
[[ "$(stat -c '%d:%i:%Y:%s' "${workspace}/.git/index")" == "${index_identity}" ]]

lock_path="${fixture_root}/ownership-upgrade.lock"
if [[ "${EUID}" -eq 0 ]]; then
  (umask 0077; : >"${lock_path}")
else
  (umask 0007; : >"${lock_path}")
fi
prepare_delivery_lock "${lock_path}"
[[ "$(stat -c '%u:%g:%a:%h' "${lock_path}")" \
  == "${expected_uid}:${expected_gid}:660:1" ]]

# Re-run with deliberately unresolvable namespace-local names and explicit numeric
# identities. This is the Manager container case: host forge:forgeops may appear as
# ubuntu:UNKNOWN inside the image, but UID/GID remain authoritative.
namespace_lock_path="${fixture_root}/namespace-identity.lock"
(
  export DELIVERY_OWNER='host-name-not-in-container'
  export DELIVERY_GROUP='host-group-not-in-container'
  export DELIVERY_OWNER_UID="${expected_uid}"
  export DELIVERY_GROUP_GID="${expected_gid}"
  prepare_delivery_lock "${namespace_lock_path}"
)
[[ "$(stat -c '%u:%g:%a:%h' "${namespace_lock_path}")" \
  == "${expected_uid}:${expected_gid}:660:1" ]]

if [[ "${EUID}" -ne 0 ]]; then
  namespace_command_marker="${fixture_root}/namespace-command.marker"
  (
    export DELIVERY_OWNER='host-name-not-in-container'
    export DELIVERY_GROUP='host-group-not-in-container'
    export DELIVERY_OWNER_UID="$(id -u)"
    export DELIVERY_GROUP_GID="$(id -g)"
    run_as_delivery_owner sh -c 'printf "explicit-numeric\n" >"$1"' sh "${namespace_command_marker}"
  )
  [[ "$(<"${namespace_command_marker}")" == explicit-numeric ]]

  namespace_fallback_marker="${fixture_root}/namespace-command-fallback.marker"
  (
    export DELIVERY_OWNER='host-name-not-in-container'
    export DELIVERY_GROUP='host-group-not-in-container'
    unset DELIVERY_OWNER_UID DELIVERY_GROUP_GID
    run_as_delivery_owner sh -c 'printf "current-process\n" >"$1"' sh "${namespace_fallback_marker}"
  )
  [[ "$(<"${namespace_fallback_marker}")" == current-process ]]

  if (
    export DELIVERY_OWNER='host-name-not-in-container'
    export DELIVERY_OWNER_UID="$(( $(id -u) + 1 ))"
    run_as_delivery_owner true
  ); then
    printf 'run_as_delivery_owner accepted a mismatched explicit UID.\n' >&2
    exit 1
  fi

  fallback_lock_path="${fixture_root}/namespace-fallback.lock"
  (
    export DELIVERY_OWNER='host-name-not-in-container'
    export DELIVERY_GROUP='host-group-not-in-container'
    unset DELIVERY_OWNER_UID DELIVERY_GROUP_GID
    prepare_delivery_lock "${fallback_lock_path}"
  )
  [[ "$(stat -c '%u:%g:%a:%h' "${fallback_lock_path}")" \
    == "$(id -u):$(id -g):660:1" ]]
fi

managed_tree="${fixture_root}/historical-taskspace-git"
mkdir -p -- "${managed_tree}/objects/aa"
: >"${managed_tree}/objects/aa/object"
repair_delivery_owned_regular_tree "${managed_tree}"
[[ -z "$(find "${managed_tree}" -xdev \
  \( ! -user "${DELIVERY_OWNER}" -o ! -group "${DELIVERY_GROUP}" \) -print -quit)" ]]

printf 'PASS project Git read gates and lifecycle locks preserve delivery ownership\n'
