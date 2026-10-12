#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
NETWORK_LIB="${REPO_ROOT}/scripts/lib/taskspace-compose-network.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1" text="$2" message="$3"
  grep -Fq -- "${text}" "${file}" || fail "${message}"
}

assert_not_contains() {
  local file="$1" text="$2" message="$3"
  if grep -Fq -- "${text}" "${file}"; then fail "${message}"; fi
}

function_body() {
  local file="$1" name="$2"
  sed -n "/^${name}() {/,/^}/p" "${file}"
}

make_taskspace() {
  local root="$1" port="${2:-20000}"
  mkdir -p -- "${root}"
  printf 'TASKSPACE_HARNESS_PORT=%s\nHARNESS_IMAGE=example.invalid/harness:test\n' "${port}" \
    >"${root}/task.env"
}

expect_compose_rejection() {
  local root="$1" label="$2" error_file
  local -a rejected_args=()
  error_file="${TEST_ROOT}/${label}.stderr"
  if taskspace_network_compose_args "${root}" "${label}" rejected_args \
      >"${TEST_ROOT}/${label}.stdout" 2>"${error_file}"; then
    fail "unsafe TaskSpace network contract was accepted: ${label}"
  fi
  if grep -Fq -- 'do-not-leak-this-secret' "${error_file}"; then
    fail "TaskSpace environment content leaked through validation: ${label}"
  fi
}

for command_name in awk basename chmod chown dd dirname flock grep id ln mkdir mktemp readlink rm sed sha256sum stat; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || fail "required test command is missing: ${command_name}"
done
[[ -f "${NETWORK_LIB}" ]] || fail 'shared TaskSpace network library is missing'
# shellcheck source=../scripts/lib/taskspace-compose-network.sh
source "${NETWORK_LIB}"

TEST_ROOT="$(mktemp -d)"
[[ -n "${TEST_ROOT}" && "${TEST_ROOT}" == /tmp/* ]] \
  || fail "refusing unsafe temporary root: ${TEST_ROOT}"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

# A predecessor with no network override remains a valid no-extra-file Compose
# invocation and is not silently assigned a different subnet by migration.
root="${TEST_ROOT}/no-override"
make_taskspace "${root}" 45000
compose_args=(sentinel)
taskspace_network_compose_args "${root}" no-override compose_args \
  || fail 'no-override predecessor was rejected'
((${#compose_args[@]} == 0)) || fail 'no-override predecessor gained a Compose override'
migrate_taskspace_network_override "${root}" no-override \
  || fail 'no-override predecessor migration gate failed'
[[ ! -e "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'no-override predecessor was silently migrated to a fixed subnet'

# A production legacy filename is loaded directly during read-only inventory,
# then preserved while an exact canonical copy is published idempotently.
root="${TEST_ROOT}/legacy"
make_taskspace "${root}" 20031
taskspace_legacy_network_override_document 20031 \
  >"${root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
legacy_hash="$(sha256sum "${root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')"
taskspace_network_compose_args "${root}" legacy compose_args \
  || fail 'valid legacy network override was rejected'
[[ "${compose_args[*]}" == "--file ${root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'read-only legacy TaskSpace did not load its fixed subnet'
migrate_taskspace_network_override "${root}" legacy \
  || fail 'legacy network override did not migrate'
[[ "$(sha256sum "${root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')" == "${legacy_hash}" ]] \
  || fail 'legacy network override was modified during migration'
canonical_hash="$(sha256sum "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')"
canonical_inode="$(stat -c '%i' "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}")"
taskspace_network_override_document 20031 | sha256sum | awk '{print $1}' \
  | grep -Fx -- "${canonical_hash}" >/dev/null \
  || fail 'migrated canonical network override is not deterministic'
migrate_taskspace_network_override "${root}" legacy \
  || fail 'legacy network override migration is not replay-safe'
[[ "$(stat -c '%i' "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}")" == "${canonical_inode}" ]] \
  || fail 'idempotent migration replaced the canonical file'
taskspace_network_compose_args "${root}" legacy compose_args \
  || fail 'migrated network contract was rejected'
[[ "${compose_args[*]}" == "--file ${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'canonical override was not preferred after migration'

# Explicit ensure is reserved for new/recovery paths and may create canonical
# metadata even when no predecessor override exists, but cannot override task.env.
root="${TEST_ROOT}/new"
make_taskspace "${root}" 28192
ensure_taskspace_network_override "${root}" new 28192 \
  || fail 'new TaskSpace canonical network override was not created'
validate_taskspace_network_override "${root}" new 28192 >/dev/null \
  || fail 'new TaskSpace canonical network override failed validation'
root="${TEST_ROOT}/expected-port-mismatch"
make_taskspace "${root}" 20000
if ensure_taskspace_network_override "${root}" expected-port-mismatch 20001 >/dev/null 2>&1; then
  fail 'caller-supplied port overrode task.env authority'
fi
[[ ! -e "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'port mismatch created canonical network metadata'

# Drift, links, duplicates, and ambiguous dual-file state all fail before any
# caller can construct a Docker Compose command. Error output never includes env
# values beyond the stable validation category.
root="${TEST_ROOT}/drift"
make_taskspace "${root}" 20000
printf '%s\n' '# forge-taskspace-network-v1' 'networks:' '  uploads:' '    ipam:' \
  '      config:' '        - subnet: 10.241.255.248/29' \
  >"${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
printf 'DO_NOT_PRINT=do-not-leak-this-secret\n' >>"${root}/task.env"
expect_compose_rejection "${root}" drift

root="${TEST_ROOT}/canonical-link"
make_taskspace "${root}" 20000
taskspace_network_override_document 20000 >"${TEST_ROOT}/external-canonical.yaml"
ln -s -- "${TEST_ROOT}/external-canonical.yaml" "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
expect_compose_rejection "${root}" canonical-link

root="${TEST_ROOT}/legacy-link"
make_taskspace "${root}" 20000
taskspace_legacy_network_override_document 20000 >"${TEST_ROOT}/external-legacy.yaml"
ln -s -- "${TEST_ROOT}/external-legacy.yaml" "${root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
expect_compose_rejection "${root}" legacy-link

root="${TEST_ROOT}/hard-link"
make_taskspace "${root}" 20000
taskspace_network_override_document 20000 >"${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
ln -- "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" "${TEST_ROOT}/canonical-second-link.yaml"
expect_compose_rejection "${root}" hard-link

root="${TEST_ROOT}/duplicate-port"
make_taskspace "${root}" 20000
printf 'TASKSPACE_HARNESS_PORT=20001\nDO_NOT_PRINT=do-not-leak-this-secret\n' >>"${root}/task.env"
taskspace_network_override_document 20000 >"${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
expect_compose_rejection "${root}" duplicate-port

root="${TEST_ROOT}/arithmetic-port"
make_taskspace "${root}" 20000
printf 'TASKSPACE_HARNESS_PORT=1+do-not-leak-this-secret\n' >"${root}/task.env"
expect_compose_rejection "${root}" arithmetic-port

root="${TEST_ROOT}/dual-file-drift"
make_taskspace "${root}" 20000
taskspace_network_override_document 20000 >"${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
taskspace_legacy_network_override_document 20001 >"${root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
expect_compose_rejection "${root}" dual-file-drift

root="${TEST_ROOT}/env-link"
mkdir -p -- "${root}"
printf 'TASKSPACE_HARNESS_PORT=20000\nDO_NOT_PRINT=do-not-leak-this-secret\n' \
  >"${TEST_ROOT}/external-task.env"
ln -s -- "${TEST_ROOT}/external-task.env" "${root}/task.env"
expect_compose_rejection "${root}" env-link

root="${TEST_ROOT}/invalid-existing-canonical"
make_taskspace "${root}" 20000
printf 'unreviewed: true\n' >"${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
invalid_hash="$(sha256sum "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')"
if ensure_taskspace_network_override "${root}" invalid-existing-canonical >/dev/null 2>&1; then
  fail 'ensure overwrote or accepted a drifted canonical network override'
fi
[[ "$(sha256sum "${root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')" == "${invalid_hash}" ]] \
  || fail 'drifted canonical network override was overwritten'

# Every lifecycle wrapper that renders historical TaskSpace Compose must source
# the shared contract and pass its validated args to Docker. The toolkit upgrade
# deliberately inventories preserved generations from Docker labels without
# rendering their Compose, so it must remain outside this set.
taskspace_upgrade="${REPO_ROOT}/scripts/upgrade-taskspace-isolation.sh"
material_upgrade="${REPO_ROOT}/scripts/upgrade-project-material-isolation.sh"
unified_upgrade="${REPO_ROOT}/scripts/upgrade-unified-conversation-control-plane.sh"
gateway_upgrade="${REPO_ROOT}/scripts/upgrade-conversation-gateway-ui.sh"
toolkit_upgrade="${REPO_ROOT}/scripts/upgrade-forge-delivery-toolkit.sh"
for script in "${taskspace_upgrade}" "${material_upgrade}" "${unified_upgrade}" \
    "${gateway_upgrade}"; do
  assert_contains "${script}" 'lib/taskspace-compose-network.sh' \
    "upgrade script does not source the shared network contract: $(basename -- "${script}")"
done

for wrapper in \
  "${taskspace_upgrade}:task_compose" \
  "${material_upgrade}:task_compose" \
  "${unified_upgrade}:rollback_task_compose" \
  "${gateway_upgrade}:task_compose_readonly"; do
  script="${wrapper%%:*}"
  name="${wrapper##*:}"
  body="${TEST_ROOT}/$(basename -- "${script}").${name}.body"
  function_body "${script}" "${name}" >"${body}"
  assert_contains "${body}" 'taskspace_network_compose_args' \
    "${name} bypasses shared network validation"
  assert_contains "${body}" '"${network_args[@]}"' \
    "${name} does not pass the validated network override to Compose"
  assert_contains "${body}" '--file "' \
    "${name} lost the base TaskSpace Compose definition"
done

assert_contains "${taskspace_upgrade}" 'task_compose "${task_env}" down --remove-orphans' \
  'TaskSpace isolation down path bypasses the guarded wrapper'
assert_contains "${taskspace_upgrade}" 'task_compose "${task_env}" config --quiet' \
  'TaskSpace isolation config path bypasses the guarded wrapper'
assert_contains "${taskspace_upgrade}" 'task_compose "${task_env}" up --detach' \
  'TaskSpace isolation up/rollback path bypasses the guarded wrapper'
assert_contains "${taskspace_upgrade}" 'task_compose "${task_env}" ps --quiet harness' \
  'TaskSpace isolation ps path bypasses the guarded wrapper'
assert_contains "${material_upgrade}" 'task_compose "${slug}" "${task_id}" down --remove-orphans' \
  'material isolation down path bypasses the guarded wrapper'
assert_contains "${material_upgrade}" 'task_compose "${slug}" "${task_id}" up --detach' \
  'material isolation up/rollback path bypasses the guarded wrapper'
assert_contains "${material_upgrade}" 'task_compose "${slug}" "${task_id}" ps --' \
  'material isolation ps paths bypass the guarded wrapper'
assert_contains "${unified_upgrade}" 'rollback_task_compose "${slug}" "${task_env}" up --detach' \
  'unified control-plane rollback up path bypasses the guarded wrapper'
assert_contains "${gateway_upgrade}" 'task_compose_readonly "${slug}" "${task_env}" ps --quiet harness' \
  'Gateway UI inventory ps path bypasses the guarded wrapper'
assert_contains "${toolkit_upgrade}" 'task_compose "${slug}" "${task_id}" ps --' \
  'toolkit preserved-runtime inventory bypasses its bounded label-based wrapper'
assert_not_contains "${toolkit_upgrade}" 'lib/taskspace-compose-network.sh' \
  'preserved-generation toolkit inventory must not render TaskSpace Compose'

assert_contains "${taskspace_upgrade}" 'migrate_taskspace_network_override' \
  'TaskSpace isolation does not migrate validated legacy metadata before restart'
assert_contains "${material_upgrade}" 'migrate_taskspace_network_override' \
  'material isolation does not migrate validated legacy metadata before restart'
assert_not_contains "${unified_upgrade}" 'migrate_taskspace_network_override' \
  'rollback-only unified upgrade must not migrate TaskSpace metadata'
assert_not_contains "${gateway_upgrade}" 'migrate_taskspace_network_override' \
  'read-only Gateway inventory must not migrate TaskSpace metadata'
assert_not_contains "${toolkit_upgrade}" 'migrate_taskspace_network_override' \
  'preserved-generation toolkit inventory must not migrate TaskSpace metadata'

# Both mutating upgrades must claim the shared lifecycle lock after their own
# upgrade/recovery locks and before they enumerate, back up, or change any
# TaskSpace.  That preserves the established lock order and leaves a contested
# lock attempt before all TaskSpace state mutation.
taskspace_source="$(<"${taskspace_upgrade}")"
unified_source="$(<"${unified_upgrade}")"
taskspaces_lock_marker='taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"'
assert_contains "${taskspace_upgrade}" 'exec 7>>"${taskspaces_lock}"' \
  'TaskSpace isolation does not hold taskspaces.lock on a dedicated descriptor'
assert_contains "${taskspace_upgrade}" 'flock --exclusive --nonblock 7' \
  'TaskSpace isolation does not fail closed while acquiring taskspaces.lock'
assert_contains "${unified_upgrade}" 'exec 8>>"${taskspaces_lock}"' \
  'unified upgrade does not hold taskspaces.lock on a dedicated descriptor'
assert_contains "${unified_upgrade}" 'flock --exclusive --nonblock 8' \
  'unified upgrade does not fail closed while acquiring taskspaces.lock'
[[ "$(awk '/taskspace_upgrade_lock=/{print NR; exit}' "${taskspace_upgrade}")" \
    -lt "$(awk -v marker="${taskspaces_lock_marker}" 'index($0, marker) {print NR; exit}' "${taskspace_upgrade}")" ]] \
  || fail 'TaskSpace isolation reverses its upgrade and lifecycle lock order'
[[ "$(awk -v marker="${taskspaces_lock_marker}" 'index($0, marker) {print NR; exit}' "${taskspace_upgrade}")" \
    -lt "$(awk '/find "\$\{taskspaces_root\}" -mindepth 2/{print NR; exit}' "${taskspace_upgrade}")" ]] \
  || fail 'TaskSpace isolation enumerates TaskSpaces before holding taskspaces.lock'
[[ "$(awk '/upgrade_lock=/{print NR; exit}' "${unified_upgrade}")" \
    -lt "$(awk -v marker="${taskspaces_lock_marker}" 'index($0, marker) {print NR; exit}' "${unified_upgrade}")" ]] \
  || fail 'unified upgrade reverses its upgrade and lifecycle lock order'
[[ "$(awk -v marker="${taskspaces_lock_marker}" 'index($0, marker) {print NR; exit}' "${unified_upgrade}")" \
    -lt "$(awk '/backup_root=/{print NR; exit}' "${unified_upgrade}")" ]] \
  || fail 'unified upgrade changes state before holding taskspaces.lock'
assert_contains "${unified_upgrade}" 'export FORGE_TASKSPACES_LOCK_FD' \
  'unified upgrade does not pass its held TaskSpace lock to taskspacectl'

# A child lifecycle command may reuse only the exact inherited lock descriptor.
# The fake Compose endpoint confirms that the parent lock remains held during
# the child call; forged or wrong descriptors fail before status can mutate or
# invoke Compose.
taskspacectl="${REPO_ROOT}/scripts/taskspacectl.sh"
lock_root="${TEST_ROOT}/lock-inheritance"
lock_slug='lock-project'
lock_task='lock-task'
lock_project_root="${lock_root}/projects/${lock_slug}"
lock_task_root="${lock_project_root}/taskspaces/${lock_task}"
lock_fake_bin="${lock_root}/bin"
mkdir -p -- "${lock_root}/registry" "${lock_project_root}/ops" \
  "${lock_project_root}/workspace/.git" "${lock_task_root}" "${lock_fake_bin}"
printf 'TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED=false\n' >"${lock_project_root}/ops/project.env"
printf 'project\ttask\tport\tcreated\n%s\t%s\t20000\tfixture\n' "${lock_slug}" "${lock_task}" \
  >"${lock_root}/registry/taskspace-ports.tsv"
printf '{"schemaVersion":2,"taskId":"%s","status":"active","harnessPort":20000}\n' "${lock_task}" \
  >"${lock_task_root}/metadata.json"
printf 'TASKSPACE_HARNESS_PORT=20000\n' >"${lock_task_root}/task.env"
cat >"${lock_fake_bin}/jq" <<'EOF'
#!/usr/bin/env bash
printf '{}\n'
EOF
cat >"${lock_fake_bin}/openssl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"${lock_fake_bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${LOCK_INHERITANCE_CHECK:-false}" == true ]] \
  && flock --exclusive --nonblock "${LOCK_INHERITANCE_DELIVERY_ROOT}/registry/taskspaces.lock" true; then
  printf 'parent TaskSpace lock was released before child lifecycle work\n' >&2
  exit 97
fi
exit 0
EOF
chmod 0755 "${lock_fake_bin}/jq" "${lock_fake_bin}/openssl" "${lock_fake_bin}/docker"
lock_env=(
  env
  "PATH=${lock_fake_bin}:${PATH}"
  TASKSPACE_CONTROL_CONFIG_MODE=project
  "TASKSPACE_CONTROL_DELIVERY_ROOT=${lock_root}"
  "TASKSPACE_CONTROL_DELIVERY_OWNER=$(id -un)"
  "TASKSPACE_CONTROL_DELIVERY_GROUP=$(id -gn)"
  "TASKSPACE_CONTROL_DELIVERY_UID=$(id -u)"
  "TASKSPACE_CONTROL_DELIVERY_GID=$(id -g)"
  TASKSPACE_SKIP_SOCKET_SCAN=true
)
(
  exec 7>>"${lock_root}/registry/taskspaces.lock"
  flock --exclusive 7
  export FORGE_TASKSPACES_LOCK_FD=7
  export LOCK_INHERITANCE_CHECK=true
  export LOCK_INHERITANCE_DELIVERY_ROOT="${lock_root}"
  "${lock_env[@]}" bash "${taskspacectl}" "${lock_slug}" status "${lock_task}" >/dev/null
) || fail 'taskspacectl did not reuse the parent-held TaskSpace lock'
metadata_before="$(sha256sum "${lock_task_root}/metadata.json")"
if FORGE_TASKSPACES_LOCK_FD=999 "${lock_env[@]}" bash "${taskspacectl}" \
    "${lock_slug}" status "${lock_task}" >"${TEST_ROOT}/forged-lock.stdout" 2>"${TEST_ROOT}/forged-lock.stderr"; then
  fail 'forged TaskSpace lock descriptor was accepted'
fi
assert_contains "${TEST_ROOT}/forged-lock.stderr" 'Inherited TaskSpace registry lock descriptor is unsafe.' \
  'forged TaskSpace lock descriptor did not fail closed'
[[ "$(sha256sum "${lock_task_root}/metadata.json")" == "${metadata_before}" ]] \
  || fail 'forged TaskSpace lock descriptor changed TaskSpace state'
(
  exec 7>>"${lock_root}/registry/not-taskspaces.lock"
  export FORGE_TASKSPACES_LOCK_FD=7
  if "${lock_env[@]}" bash "${taskspacectl}" "${lock_slug}" status "${lock_task}" \
      >"${TEST_ROOT}/wrong-lock.stdout" 2>"${TEST_ROOT}/wrong-lock.stderr"; then
    exit 1
  fi
) || fail 'wrong TaskSpace lock descriptor was accepted'
assert_contains "${TEST_ROOT}/wrong-lock.stderr" 'Inherited TaskSpace registry lock descriptor is unsafe.' \
  'wrong TaskSpace lock descriptor did not fail closed'
[[ "$(sha256sum "${lock_task_root}/metadata.json")" == "${metadata_before}" ]] \
  || fail 'wrong TaskSpace lock descriptor changed TaskSpace state'

printf 'PASS TaskSpace upgrade Compose paths preserve validated canonical/legacy networks and fail closed\n'
