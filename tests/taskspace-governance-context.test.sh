#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
TASKSPACECTL="${REPO_ROOT}/scripts/taskspacectl.sh"
CREATE_PROJECT="${REPO_ROOT}/scripts/create-project.sh"
TASKSPACE_COMPOSE="${REPO_ROOT}/templates/taskspace/compose.yaml"
PROJECT_CONTEXT_TEMPLATE="${REPO_ROOT}/templates/project/PROJECT_CONTEXT.md.tpl"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

die() {
  fail "$@"
}

assert_contains() {
  local file="$1" pattern="$2" message="$3"
  grep -Fq -- "${pattern}" "${file}" || fail "${message}"
}

assert_rejected() {
  local task_root="$1" label="$2"
  if ensure_taskspace_governance_context "${task_root}" "${label}" >/dev/null 2>&1; then
    fail "${label} was not rejected"
  fi
}

# The production script requires jq. Keep this focused dynamic unit test
# portable to minimal WSL environments by emulating only the two strict fence
# operations exercised by the extracted lifecycle functions.
jq() {
  local epoch='' argument file=''
  if [[ "${1:-}" == --null-input ]]; then
    shift
    while (($# > 0)); do
      case "$1" in
        --arg)
          [[ "${2:-}" == epoch ]] && epoch="${3:-}"
          shift 3
          ;;
        *) shift ;;
      esac
    done
    JQ_TEST_EPOCH="${epoch}" python3 -c \
      'import json, os; print(json.dumps({"schemaVersion":1,"state":"committed","epoch":os.environ["JQ_TEST_EPOCH"]}))'
    return
  fi
  for argument in "$@"; do
    [[ -f "${argument}" ]] && file="${argument}"
  done
  python3 -c '
import json, re, sys
raw = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sys.stdin.read()
value = json.loads(raw)
valid = (isinstance(value, dict)
  and sorted(value) == ["epoch", "schemaVersion", "state"]
  and value.get("schemaVersion") == 1
  and value.get("state") == "committed"
  and isinstance(value.get("epoch"), str)
  and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value["epoch"]))
if not valid: raise SystemExit(1)
print(value["state"])
' ${file:+"${file}"}
}

function_source="$(
  sed -n \
    -e '/^taskspace_git_exclude_path() {/,/^}/p' \
    -e '/^ensure_taskspace_git_exclude_contract() {/,/^}/p' \
    -e '/^taskspace_root_is_contained() {/,/^}/p' \
    -e '/^governance_file_sha256() {/,/^}/p' \
    -e '/^migrate_legacy_project_governance_context() {/,/^}/p' \
    -e '/^project_governance_context_path() {/,/^}/p' \
    -e '/^validate_workspace_instruction_path() {/,/^}/p' \
    -e '/^ensure_taskspace_context_mountpoint() {/,/^}/p' \
    -e '/^taskspace_maintenance_root_path() {/,/^}/p' \
    -e '/^ensure_taskspace_maintenance_fence() {/,/^}/p' \
    -e '/^ensure_taskspace_governance_context() {/,/^}/p' \
    "${TASKSPACECTL}"
)"
for function_name in \
  taskspace_git_exclude_path ensure_taskspace_git_exclude_contract \
  taskspace_root_is_contained governance_file_sha256 \
  migrate_legacy_project_governance_context \
  project_governance_context_path validate_workspace_instruction_path \
  ensure_taskspace_context_mountpoint \
  taskspace_maintenance_root_path ensure_taskspace_maintenance_fence \
  ensure_taskspace_governance_context; do
  grep -Fq "${function_name}()" <<<"${function_source}" \
    || fail "could not extract ${function_name} from taskspacectl.sh"
done
project_git_readonly() {
  local workspace="$1"
  shift
  env GIT_OPTIONAL_LOCKS=0 git -C "${workspace}" "$@"
}
env_value() {
  [[ "$1" == HOST_UID ]] || return 1
  id -u
}
eval "${function_source}"

create_context_function_source="$(
  sed -n -e '/^write_project_governance_context() {/,/^}/p' "${CREATE_PROJECT}"
)"
grep -Fq 'write_project_governance_context()' <<<"${create_context_function_source}" \
  || fail 'could not extract write_project_governance_context from create-project.sh'
eval "${create_context_function_source}"

assert_create_context_rejected() {
  local workspace="$1" source_kind="$2" output="$3" label="$4"
  if (write_project_governance_context "${workspace}" "${source_kind}" 'rendered platform context' "${output}") \
      >/dev/null 2>&1; then
    fail "${label} was not rejected"
  fi
}

test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT
DELIVERY_ROOT="${test_root}/delivery"
DELIVERY_OWNER="$(id -un)"
DELIVERY_GROUP="$(id -gn)"
project_root="${DELIVERY_ROOT}/projects/demo-project"
integration_workspace="${project_root}/workspace"
taskspaces_root="${project_root}/taskspaces"
mkdir -p -- "${integration_workspace}" "${taskspaces_root}" "${project_root}/governance"

git -C "${integration_workspace}" init -q
git -C "${integration_workspace}" config user.email 'taskspace-governance@test.invalid'
git -C "${integration_workspace}" config user.name 'TaskSpace Governance Test'
printf 'tracked customer agents\n' >"${integration_workspace}/AGENTS.md"
printf 'tracked source\n' >"${integration_workspace}/README.md"
git -C "${integration_workspace}" add AGENTS.md README.md
git -C "${integration_workspace}" commit -qm baseline

create_context_root="${test_root}/create-context"
mkdir -p "${create_context_root}"

tracked_workspace="${create_context_root}/tracked-workspace"
mkdir -p "${tracked_workspace}"
git -C "${tracked_workspace}" init -q
git -C "${tracked_workspace}" config user.email 'tracked-context@test.invalid'
git -C "${tracked_workspace}" config user.name 'Tracked Context Test'
printf 'tracked business contract\nwith exact source bytes\n' >"${tracked_workspace}/PROJECT_CONTEXT.md"
git -C "${tracked_workspace}" add PROJECT_CONTEXT.md
git -C "${tracked_workspace}" commit -qm baseline
tracked_head_context="${create_context_root}/tracked-head-context"
git -C "${tracked_workspace}" show HEAD:PROJECT_CONTEXT.md >"${tracked_head_context}"
tracked_governance="${create_context_root}/tracked-governance"
# create-project's staging clone is owned by the invoking identity. The
# delivery-owner Git reader is intentionally unsuitable there and must not be
# consulted by this helper.
(
  project_git_readonly() { return 97; }
  write_project_governance_context \
    "${tracked_workspace}" registered-project 'must not replace tracked business context' "${tracked_governance}"
)
cmp --silent "${tracked_workspace}/PROJECT_CONTEXT.md" "${tracked_governance}" \
  && cmp --silent "${tracked_head_context}" "${tracked_governance}" \
  && [[ -z "$(git -C "${tracked_workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
  || fail 'tracked business context inheritance changed bytes or dirtied the workspace'

template_workspace="${create_context_root}/template-workspace"
mkdir -p "${template_workspace}"
git -C "${template_workspace}" init -q
template_governance="${create_context_root}/template-governance"
write_project_governance_context \
  "${template_workspace}" foundation 'rendered platform context' "${template_governance}"
[[ "$(<"${template_governance}")" == 'rendered platform context' ]] \
  || fail 'source without PROJECT_CONTEXT.md did not retain the rendered-template behavior'

untracked_workspace="${create_context_root}/untracked-workspace"
mkdir -p "${untracked_workspace}"
git -C "${untracked_workspace}" init -q
printf 'untracked context\n' >"${untracked_workspace}/PROJECT_CONTEXT.md"
assert_create_context_rejected \
  "${untracked_workspace}" registered-project "${create_context_root}/untracked-output" 'untracked context'

dirty_workspace="${create_context_root}/dirty-workspace"
git clone -q "${tracked_workspace}" "${dirty_workspace}"
printf 'dirty change\n' >>"${dirty_workspace}/PROJECT_CONTEXT.md"
assert_create_context_rejected \
  "${dirty_workspace}" registered-project "${create_context_root}/dirty-output" 'dirty tracked context'

symlink_workspace="${create_context_root}/symlink-workspace"
mkdir -p "${symlink_workspace}"
git -C "${symlink_workspace}" init -q
git -C "${symlink_workspace}" config user.email 'symlink-context@test.invalid'
git -C "${symlink_workspace}" config user.name 'Symlink Context Test'
printf 'outside context\n' >"${create_context_root}/outside-context"
ln -s "${create_context_root}/outside-context" "${symlink_workspace}/PROJECT_CONTEXT.md"
git -C "${symlink_workspace}" add PROJECT_CONTEXT.md
git -C "${symlink_workspace}" commit -qm baseline
assert_create_context_rejected \
  "${symlink_workspace}" registered-project "${create_context_root}/symlink-output" 'tracked context symlink'

unsupported_workspace="${create_context_root}/unsupported-workspace"
git clone -q "${tracked_workspace}" "${unsupported_workspace}"
assert_create_context_rejected \
  "${unsupported_workspace}" foundation "${create_context_root}/unsupported-output" 'unsupported source kind'

printf '%s\n%s\n' \
  '<!-- forge-delivery-project-context-v1 -->' \
  'platform context v1' >"${project_root}/governance/PROJECT_CONTEXT.md"
printf '%s\n' "$(sha256sum "${project_root}/governance/PROJECT_CONTEXT.md" | awk '{print $1}')" \
  >"${project_root}/governance/PROJECT_CONTEXT.sha256"
chmod 0444 \
  "${project_root}/governance/PROJECT_CONTEXT.md" \
  "${project_root}/governance/PROJECT_CONTEXT.sha256"
authority_hash="$(sha256sum "${project_root}/governance/PROJECT_CONTEXT.md" | awk '{print $1}')"
agents_hash="$(sha256sum "${integration_workspace}/AGENTS.md" | awk '{print $1}')"

make_taskspace() {
  local task_id="$1" task_root
  task_root="${taskspaces_root}/${task_id}"
  mkdir -m 0700 -- "${task_root}"
  git clone -q --no-hardlinks "${integration_workspace}" "${task_root}/workspace"
  printf '%s\n' "${task_root}"
}

task_one="$(make_taskspace task-one)"
ensure_taskspace_governance_context "${task_one}" task-one >/dev/null \
  || fail 'new TaskSpace governance admission failed'
[[ -f "${task_one}/workspace/PROJECT_CONTEXT.md" \
  && ! -L "${task_one}/workspace/PROJECT_CONTEXT.md" \
  && ! -s "${task_one}/workspace/PROJECT_CONTEXT.md" ]] \
  || fail 'TaskSpace did not create a safe empty nested-bind mountpoint'
grep -Fxq -- '/PROJECT_CONTEXT.md' "${task_one}/workspace/.git/info/exclude" \
  || fail 'the inert mountpoint is not privately excluded from candidate changes'
[[ "$(sha256sum "${task_one}/workspace/AGENTS.md" | awk '{print $1}')" == "${agents_hash}" ]] \
  || fail 'tracked AGENTS.md was changed during TaskSpace preparation'
[[ "$(sha256sum "${integration_workspace}/AGENTS.md" | awk '{print $1}')" == "${agents_hash}" ]] \
  || fail 'integration tracked AGENTS.md was changed'
jq -e '.schemaVersion == 1 and .state == "committed"
  and (.epoch | type == "string" and length > 0)' \
  "${task_one}/maintenance/proxy-fence.json" >/dev/null \
  || fail 'TaskSpace maintenance fence was not initialized committed'

context_stat="$(stat -c '%i:%Y:%s' "${project_root}/governance/PROJECT_CONTEXT.md")"
fence_stat="$(stat -c '%i:%Y:%s' "${task_one}/maintenance/proxy-fence.json")"
ensure_taskspace_governance_context "${task_one}" task-one >/dev/null \
  || fail 'idempotent TaskSpace governance admission failed'
[[ "$(stat -c '%i:%Y:%s' "${project_root}/governance/PROJECT_CONTEXT.md")" == "${context_stat}" \
  && "$(stat -c '%i:%Y:%s' "${task_one}/maintenance/proxy-fence.json")" == "${fence_stat}" ]] \
  || fail 'idempotent admission rewrote platform state'

# A legacy ignored copy may remain under the bind target only if it is an exact
# regular-file shadow of the platform authority. It is never the effective file
# once Compose overlays the read-only source.
task_legacy="$(make_taskspace task-legacy)"
cp -- "${project_root}/governance/PROJECT_CONTEXT.md" \
  "${task_legacy}/workspace/PROJECT_CONTEXT.md"
chmod 0644 "${task_legacy}/workspace/PROJECT_CONTEXT.md"
ensure_taskspace_governance_context "${task_legacy}" task-legacy >/dev/null \
  || fail 'exact legacy PROJECT_CONTEXT shadow was rejected'

printf 'model tamper\n' >"${task_legacy}/workspace/PROJECT_CONTEXT.md"
assert_rejected "${task_legacy}" 'drifted legacy PROJECT_CONTEXT'
[[ "$(sha256sum "${project_root}/governance/PROJECT_CONTEXT.md" | awk '{print $1}')" == "${authority_hash}" ]] \
  || fail 'workspace tamper changed the platform authority'
rm -f -- "${task_legacy}/workspace/PROJECT_CONTEXT.md"
outside_context="${test_root}/outside-context"
printf 'outside\n' >"${outside_context}"
ln -s -- "${outside_context}" "${task_legacy}/workspace/PROJECT_CONTEXT.md"
assert_rejected "${task_legacy}" 'TaskSpace PROJECT_CONTEXT symlink'
[[ "$(<"${outside_context}")" == outside ]] \
  || fail 'symlink rejection modified the outside target'

task_agents="$(make_taskspace task-agents)"
git -C "${task_agents}/workspace" rm -q --cached AGENTS.md
assert_rejected "${task_agents}" 'untracked TaskSpace AGENTS.md'
[[ "$(<"${task_agents}/workspace/AGENTS.md")" == 'tracked customer agents' ]] \
  || fail 'untracked AGENTS.md was overwritten while failing closed'

# Old project-state archives contain the managed private context only in the
# integration clone. A restored TaskSpace start migrates it once into the
# platform root without touching the repository-owned AGENTS.md.
primary_project_root="${project_root}"
primary_integration_workspace="${integration_workspace}"
primary_taskspaces_root="${taskspaces_root}"
project_root="${DELIVERY_ROOT}/projects/restored-project"
integration_workspace="${project_root}/workspace"
taskspaces_root="${project_root}/taskspaces"
mkdir -p -- "${integration_workspace}" "${taskspaces_root}"
git -C "${integration_workspace}" init -q
git -C "${integration_workspace}" config user.email 'restored-governance@test.invalid'
git -C "${integration_workspace}" config user.name 'Restored Governance Test'
printf 'restored tracked agents\n' >"${integration_workspace}/AGENTS.md"
printf 'restored source\n' >"${integration_workspace}/README.md"
git -C "${integration_workspace}" add AGENTS.md README.md
git -C "${integration_workspace}" commit -qm baseline
printf '%s\n' 'restored legacy platform context' >"${integration_workspace}/PROJECT_CONTEXT.md"
printf '%s\n' '/PROJECT_CONTEXT.md' >>"${integration_workspace}/.git/info/exclude"
restored_task="$(make_taskspace task-restored)"
restored_agents_hash="$(sha256sum "${restored_task}/workspace/AGENTS.md" | awk '{print $1}')"
ensure_taskspace_governance_context "${restored_task}" task-restored >/dev/null \
  || fail 'legacy restore governance migration failed'
[[ -f "${project_root}/governance/PROJECT_CONTEXT.md" \
  && -f "${project_root}/governance/PROJECT_CONTEXT.sha256" \
  && "$(sha256sum "${restored_task}/workspace/AGENTS.md" | awk '{print $1}')" == "${restored_agents_hash}" ]] \
  || fail 'legacy restore migration did not create platform authority while preserving AGENTS.md'
ensure_taskspace_governance_context "${restored_task}" task-restored >/dev/null \
  || fail 'legacy restore governance migration was not idempotent'

# Some long-lived projects committed their former PROJECT_CONTEXT.md before the
# platform moved the authority outside Git. A clean tracked copy is admitted as
# the one-time legacy source without dirtying or rewriting the repository.
project_root="${DELIVERY_ROOT}/projects/restored-tracked-project"
integration_workspace="${project_root}/workspace"
taskspaces_root="${project_root}/taskspaces"
mkdir -p -- "${integration_workspace}" "${taskspaces_root}"
git -C "${integration_workspace}" init -q
git -C "${integration_workspace}" config user.email 'restored-tracked-governance@test.invalid'
git -C "${integration_workspace}" config user.name 'Restored Tracked Governance Test'
printf 'restored tracked agents\n' >"${integration_workspace}/AGENTS.md"
printf 'restored tracked source\n' >"${integration_workspace}/README.md"
printf 'restored tracked legacy project context\n' >"${integration_workspace}/PROJECT_CONTEXT.md"
git -C "${integration_workspace}" add AGENTS.md README.md PROJECT_CONTEXT.md
git -C "${integration_workspace}" commit -qm baseline
restored_tracked_task="$(make_taskspace task-restored-tracked)"
ensure_taskspace_governance_context "${restored_tracked_task}" task-restored-tracked >/dev/null \
  || fail 'clean tracked legacy governance migration failed'
[[ -f "${project_root}/governance/PROJECT_CONTEXT.md" \
  && "$(<"${project_root}/governance/PROJECT_CONTEXT.md")" == 'restored tracked legacy project context' \
  && -z "$(git -C "${integration_workspace}" status --porcelain=v1 -- PROJECT_CONTEXT.md)" ]] \
  || fail 'tracked legacy migration changed or failed to preserve its source'
project_root="${primary_project_root}"
integration_workspace="${primary_integration_workspace}"
taskspaces_root="${primary_taskspaces_root}"

task_context_link="$(make_taskspace task-context-link)"
rm -f -- "${project_root}/governance/PROJECT_CONTEXT.md"
ln -s -- "${outside_context}" "${project_root}/governance/PROJECT_CONTEXT.md"
assert_rejected "${task_context_link}" 'project governance source symlink'
rm -f -- "${project_root}/governance/PROJECT_CONTEXT.md"
printf '%s\n%s\n' \
  '<!-- forge-delivery-project-context-v1 -->' \
  'platform context v1' >"${project_root}/governance/PROJECT_CONTEXT.md"
chmod 0444 "${project_root}/governance/PROJECT_CONTEXT.md"

chmod 0644 "${project_root}/governance/PROJECT_CONTEXT.md"
printf 'hash drift\n' >>"${project_root}/governance/PROJECT_CONTEXT.md"
chmod 0444 "${project_root}/governance/PROJECT_CONTEXT.md"
assert_rejected "${task_context_link}" 'project governance hash drift'

assert_contains "${CREATE_PROJECT}" 'governance/PROJECT_CONTEXT.md' \
  'create-project does not write the platform context outside Git'
assert_contains "${CREATE_PROJECT}" 'Tracked AGENTS.md must be a regular non-symbolic-link file.' \
  'create-project does not explicitly protect tracked AGENTS.md'
if grep -Fq 'agents_file=' "${CREATE_PROJECT}" \
    || grep -Fq '>>"${agents_file}"' "${CREATE_PROJECT}"; then
  fail 'create-project still appends platform instructions to AGENTS.md'
fi
assert_contains "${TASKSPACE_COMPOSE}" 'source: ${PROJECT_ROOT:?PROJECT_ROOT is required}/governance/PROJECT_CONTEXT.md' \
  'TaskSpace Compose lacks the platform governance source bind'
assert_contains "${TASKSPACE_COMPOSE}" 'target: /workspace/PROJECT_CONTEXT.md' \
  'TaskSpace Compose lacks the root instruction discovery target'
assert_contains "${TASKSPACE_COMPOSE}" 'read_only: true' \
  'TaskSpace governance bind is not read-only'
assert_contains "${TASKSPACE_COMPOSE}" 'create_host_path: false' \
  'TaskSpace governance bind can silently create a missing host path'
assert_contains "${TASKSPACECTL}" 'ensure_taskspace_governance_context "${stage_root}" "${slug}/${task_id}"' \
  'new TaskSpaces do not run governance admission'
assert_contains "${TASKSPACECTL}" 'ensure_taskspace_governance_context "$(task_root_of "${task_id}")" "${slug}/${task_id}"' \
  'existing TaskSpaces do not rerun governance admission on start/restore'
assert_contains "${PROJECT_CONTEXT_TEMPLATE}" '<!-- forge-delivery-project-context-v1 -->' \
  'PROJECT_CONTEXT template lacks its managed identity marker'
assert_contains "${PROJECT_CONTEXT_TEMPLATE}" '平台不得覆盖、追加或隐式改写' \
  'PROJECT_CONTEXT template does not protect tracked AGENTS.md'

printf 'PASS TaskSpace governance is platform-controlled, hash-admitted, read-only-mounted, nofollow, and tracked-AGENTS-safe\n'

# Keep the executable create/recovery network contract in the standard shell
# validation path without duplicating its security-sensitive fixtures here.
bash "${SCRIPT_DIR}/taskspace-network-pool.test.sh"
