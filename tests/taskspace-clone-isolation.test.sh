#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/taskspace-clone-isolation.XXXXXX")"
TEST_ROOT="$(cd -- "${TEST_ROOT}" && pwd -P)"
[[ "${TEST_ROOT}" == /*/taskspace-clone-isolation.* && ! -L "${TEST_ROOT}" ]] \
  || fail 'unsafe fixture directory'
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

# Keep fixture commits independent of the operator's Git identity and configuration.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Clone fixture' GIT_AUTHOR_EMAIL='clone-fixture@example.invalid'
export GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL}"
unset GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

integration_workspace="${TEST_ROOT}/integration"
stage_root="${TEST_ROOT}/stage"
mkdir -p -- "${stage_root}"
git init --quiet --initial-branch=main "${integration_workspace}"
printf 'root\n' >"${integration_workspace}/tracked.txt"
git -C "${integration_workspace}" add tracked.txt
git -C "${integration_workspace}" commit --quiet -m root
root_commit="$(git -C "${integration_workspace}" rev-parse HEAD)"
git -C "${integration_workspace}" tag -a fixture-v1 -m 'fixture tag'
git -C "${integration_workspace}" switch --quiet --create feature
printf 'feature\n' >"${integration_workspace}/feature.txt"
git -C "${integration_workspace}" add feature.txt
git -C "${integration_workspace}" commit --quiet -m feature
git -C "${integration_workspace}" switch --quiet main
printf 'main\n' >>"${integration_workspace}/tracked.txt"
git -C "${integration_workspace}" commit --quiet -am main
git -C "${integration_workspace}" gc --prune=now --quiet
unreachable="$(printf 'unreachable fixture payload\n' | git -C "${integration_workspace}" hash-object -w --stdin)"
source_refs="$(git -C "${integration_workspace}" show-ref)"
source_head="$(git -C "${integration_workspace}" rev-parse HEAD)"
source_objects="$(find "${integration_workspace}/.git/objects" -type f -exec sha256sum {} + | sort)"

# Execute the production create command, not a separately maintained clone recipe.
clone_command="$(sed -n '/^  create)/,/^    ;;/p' "${REPO_ROOT}/scripts/taskspacectl.sh" \
  | grep -E '^[[:space:]]+git clone .*"\$\{integration_workspace\}" "\$\{stage_root\}/workspace"$')"
[[ -n "${clone_command}" && "${clone_command}" != *$'\n'* ]] || fail 'expected one production create clone command'
eval "${clone_command}"
target="${stage_root}/workspace"

[[ "$(git -C "${target}" rev-parse HEAD)" == "${source_head}" ]] || fail 'base commit changed'
cmp "${integration_workspace}/tracked.txt" "${target}/tracked.txt" || fail 'checked-out source changed'
for branch in main feature; do
  [[ "$(git -C "${integration_workspace}" rev-parse "refs/heads/${branch}")" \
    == "$(git -C "${target}" rev-parse "refs/remotes/origin/${branch}")" ]] || fail "missing branch ${branch}"
done
[[ "$(git -C "${integration_workspace}" rev-parse refs/tags/fixture-v1)" \
  == "$(git -C "${target}" rev-parse refs/tags/fixture-v1)" ]] || fail 'annotated tag changed'
[[ "$(git -C "${integration_workspace}" rev-list --objects --all | cut -d' ' -f1 | sort)" \
  == "$(git -C "${target}" rev-list --objects --all | cut -d' ' -f1 | sort)" ]] || fail 'reachable history is incomplete'
[[ "$(git -C "${target}" rev-parse --is-shallow-repository)" == false \
  && ! -e "${target}/.git/objects/info/alternates" ]] || fail 'clone is shallow or borrows source objects'
if git -C "${target}" cat-file -e "${unreachable}" 2>/dev/null; then
  fail 'unreachable source object was copied into the TaskSpace'
fi

mapfile -t source_packs < <(find "${integration_workspace}/.git/objects/pack" -type f -name '*.pack')
mapfile -t target_packs < <(find "${target}/.git/objects/pack" -type f -name '*.pack')
(( ${#source_packs[@]} > 0 && ${#target_packs[@]} > 0 )) || fail 'packed-object fixture is missing'
for target_pack in "${target_packs[@]}"; do
  for source_pack in "${source_packs[@]}"; do
    [[ "$(stat -c '%d:%i' "${target_pack}")" != "$(stat -c '%d:%i' "${source_pack}")" ]] \
      || fail 'TaskSpace pack shares its inode with the source'
  done
done
printf 'target only\n' >>"${target}/tracked.txt"
git -C "${target}" commit --quiet -am 'target-only commit'
target_commit="$(git -C "${target}" rev-parse HEAD)"
if git -C "${integration_workspace}" cat-file -e "${target_commit}" 2>/dev/null; then
  fail 'target commit leaked into the source object store'
fi
rm -f -- "${target_packs[@]}"
if git -C "${target}" cat-file -e "${root_commit}^{commit}" 2>/dev/null; then
  fail 'target still borrows historical objects after removing its packs'
fi
[[ "$(git -C "${integration_workspace}" show-ref)" == "${source_refs}" \
  && "$(git -C "${integration_workspace}" rev-parse HEAD)" == "${source_head}" \
  && "$(find "${integration_workspace}/.git/objects" -type f -exec sha256sum {} + | sort)" == "${source_objects}" ]] \
  || fail 'target mutation or object deletion changed the source'
git -C "${integration_workspace}" cat-file -e "${root_commit}^{commit}"
git -C "${integration_workspace}" diff --quiet
printf 'PASS: production TaskSpace clone preserves complete reachable history and independent objects without unreachable payload\n'
