#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
TASKSPACECTL="${REPO_ROOT}/scripts/taskspacectl.sh"
NETWORK_HELPER="${REPO_ROOT}/scripts/lib/taskspace-compose-network.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_subnet() {
  local port="$1" expected="$2" actual
  actual="$(taskspace_network_subnet_for_port "${port}")" \
    || fail "valid port was rejected: ${port}"
  [[ "${actual}" == "${expected}" ]] \
    || fail "port ${port} mapped to ${actual}, expected ${expected}"
}

expect_rejection() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "${label} unexpectedly succeeded"
  fi
}

set_metadata_status() {
  python3 -c '
import json, sys
path, status = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    value = json.load(source)
value["status"] = status
with open(path, "w", encoding="utf-8") as target:
    json.dump(value, target)
    target.write("\n")
' "$1" "$2"
}

extract_function() {
  local name="$1"
  sed -n "/^${name}() {/,/^}/p" "${TASKSPACECTL}"
}

for command_name in awk bash chmod cp cut dd git grep id ln mkdir mktemp mv readlink rm sed seq sha256sum sort stat tail wc; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || fail "required test command is missing: ${command_name}"
done
command -v python3 >/dev/null 2>&1 || fail 'python3 is required by the test-only jq substitute'

TEST_ROOT="$(mktemp -d)"
[[ -n "${TEST_ROOT}" && "${TEST_ROOT}" == /tmp/* ]] \
  || fail "refusing unsafe temporary root: ${TEST_ROOT}"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

eval "$(extract_function taskspace_root_is_contained)"
declare -F taskspace_root_is_contained >/dev/null \
  || fail 'could not extract taskspace_root_is_contained'
# shellcheck source=../scripts/lib/taskspace-compose-network.sh
source "${NETWORK_HELPER}"
for function_name in \
  taskspace_network_subnet_for_port \
  taskspace_network_override_document \
  taskspace_legacy_network_override_document \
  taskspace_network_override_path \
  validate_taskspace_network_override \
  ensure_taskspace_network_override; do
  declare -F "${function_name}" >/dev/null \
    || fail "could not extract ${function_name}"
done

DELIVERY_OWNER="$(id -un)"
DELIVERY_GROUP="$(id -gn)"
export DELIVERY_OWNER DELIVERY_GROUP
taskspaces_root="${TEST_ROOT}/unit-taskspaces"
mkdir -p -- "${taskspaces_root}"

write_unit_task_env() {
  printf 'TASKSPACE_HARNESS_PORT=%s\n' "$2" >"$1/task.env"
}

assert_subnet 20000 '10.240.0.0/29'
assert_subnet 20001 '10.240.0.8/29'
assert_subnet 20031 '10.240.0.248/29'
assert_subnet 20032 '10.240.1.0/29'
assert_subnet 28191 '10.240.255.248/29'
assert_subnet 28192 '10.241.0.0/29'
assert_subnet 36383 '10.241.255.248/29'
for invalid_port in 19999 36384 020000 abc ''; do
  expect_rejection "invalid deterministic network port ${invalid_port:-empty}" \
    taskspace_network_subnet_for_port "${invalid_port}"
done

all_subnets="${TEST_ROOT}/all-subnets.txt"
for ((port = TASKSPACE_NETWORK_POOL_PORT_MIN; port <= TASKSPACE_NETWORK_POOL_PORT_MAX; port++)); do
  taskspace_network_subnet_for_port "${port}"
done >"${all_subnets}"
[[ "$(wc -l <"${all_subnets}")" -eq "${TASKSPACE_NETWORK_POOL_SLOT_COUNT}" ]] \
  || fail 'the deterministic network pool did not emit one subnet per slot'
[[ "$(sort -u "${all_subnets}" | wc -l)" -eq "${TASKSPACE_NETWORK_POOL_SLOT_COUNT}" ]] \
  || fail 'the deterministic network pool contains duplicate /29 subnets'
awk -F '[./]' '
  NF != 5 || $1 != 10 || ($2 != 240 && $2 != 241) ||
    $3 < 0 || $3 > 255 || $4 < 0 || $4 > 255 || ($4 % 8) != 0 || $5 != 29 { invalid=1 }
  END { exit invalid }
' "${all_subnets}" || fail 'the deterministic network pool emitted an invalid /29'

normal_root="${taskspaces_root}/normal-task"
mkdir -p -- "${normal_root}"
write_unit_task_env "${normal_root}" 20000
ensure_taskspace_network_override "${normal_root}" unit/normal-task 20000 \
  || fail 'normal network override creation failed'
normal_override="${normal_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
validate_taskspace_network_override "${normal_root}" unit/normal-task 20000 >/dev/null \
  || fail 'normal network override validation failed'
grep -Fxq -- '        - subnet: 10.240.0.0/29' "${normal_override}" \
  || fail 'normal network override does not carry the expected subnet'
normal_hash="$(sha256sum "${normal_override}" | awk '{print $1}')"
normal_inode="$(stat -c '%i' -- "${normal_override}")"
ensure_taskspace_network_override "${normal_root}" unit/normal-task 20000 \
  || fail 'idempotent network override replay failed'
[[ "$(sha256sum "${normal_override}" | awk '{print $1}')" == "${normal_hash}" \
  && "$(stat -c '%i' -- "${normal_override}")" == "${normal_inode}" ]] \
  || fail 'idempotent network override replay replaced or changed the contract'

legacy_contract_root="${taskspaces_root}/legacy-contract-task"
mkdir -p -- "${legacy_contract_root}"
write_unit_task_env "${legacy_contract_root}" 20002
legacy_contract="${legacy_contract_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
taskspace_legacy_network_override_document 20002 >"${legacy_contract}"
legacy_hash="$(sha256sum "${legacy_contract}" | awk '{print $1}')"
ensure_taskspace_network_override "${legacy_contract_root}" unit/legacy-contract-task 20002 \
  || fail 'validated legacy network contract did not migrate'
[[ -f "${legacy_contract_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && "$(sha256sum "${legacy_contract}" | awk '{print $1}')" == "${legacy_hash}" ]] \
  || fail 'legacy network migration did not create canonical while preserving legacy'
validate_taskspace_network_override "${legacy_contract_root}" unit/legacy-contract-task 20002 >/dev/null \
  || fail 'canonical network contract created from legacy is invalid'
validate_taskspace_network_override "${legacy_contract_root}" unit/legacy-contract-task 20002 \
  "${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" >/dev/null \
  || fail 'strict legacy network contract became invalid after migration'

wrong_legacy_root="${taskspaces_root}/wrong-legacy-task"
mkdir -p -- "${wrong_legacy_root}"
write_unit_task_env "${wrong_legacy_root}" 20003
wrong_legacy="${wrong_legacy_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
taskspace_legacy_network_override_document 20004 >"${wrong_legacy}"
wrong_legacy_hash="$(sha256sum "${wrong_legacy}" | awk '{print $1}')"
expect_rejection 'legacy network contract for another reserved port' \
  ensure_taskspace_network_override "${wrong_legacy_root}" unit/wrong-legacy-task 20003
[[ ! -e "${wrong_legacy_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && "$(sha256sum "${wrong_legacy}" | awk '{print $1}')" == "${wrong_legacy_hash}" ]] \
  || fail 'wrong legacy subnet was changed or canonicalized'

marked_legacy_root="${taskspaces_root}/marked-legacy-task"
mkdir -p -- "${marked_legacy_root}"
write_unit_task_env "${marked_legacy_root}" 20005
marked_legacy="${marked_legacy_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
{
  printf '# unexpected-marker\n'
  taskspace_legacy_network_override_document 20005
} >"${marked_legacy}"
expect_rejection 'legacy network contract with an extra marker' \
  ensure_taskspace_network_override "${marked_legacy_root}" unit/marked-legacy-task 20005
[[ ! -e "${marked_legacy_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'non-production legacy shape was canonicalized'

newline_legacy_root="${taskspaces_root}/newline-legacy-task"
mkdir -p -- "${newline_legacy_root}"
write_unit_task_env "${newline_legacy_root}" 20006
newline_legacy="${newline_legacy_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
taskspace_legacy_network_override_document 20006 >"${newline_legacy}"
printf '\n' >>"${newline_legacy}"
expect_rejection 'legacy network contract with more than one trailing newline' \
  ensure_taskspace_network_override "${newline_legacy_root}" unit/newline-legacy-task 20006
[[ ! -e "${newline_legacy_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'legacy contract with extra trailing bytes was canonicalized'

mismatch_root="${taskspaces_root}/mismatch-task"
mkdir -p -- "${mismatch_root}"
write_unit_task_env "${mismatch_root}" 20000
taskspace_network_override_document 20001 >"${mismatch_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
mismatch_hash="$(sha256sum "${mismatch_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')"
expect_rejection 'mismatched port/subnet override' \
  ensure_taskspace_network_override "${mismatch_root}" unit/mismatch-task 20000
[[ "$(sha256sum "${mismatch_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')" == "${mismatch_hash}" ]] \
  || fail 'mismatched override was overwritten'

outside="${TEST_ROOT}/outside-override"
printf 'outside-must-survive\n' >"${outside}"
symlink_root="${taskspaces_root}/symlink-task"
mkdir -p -- "${symlink_root}"
write_unit_task_env "${symlink_root}" 20000
ln -s -- "${outside}" "${symlink_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
expect_rejection 'symbolic-link network override' \
  ensure_taskspace_network_override "${symlink_root}" unit/symlink-task 20000
[[ "$(<"${outside}")" == outside-must-survive ]] \
  || fail 'symbolic-link rejection changed its external target'

hardlink="${TEST_ROOT}/normal-override-hardlink"
ln -- "${normal_override}" "${hardlink}"
expect_rejection 'multiply-linked network override' \
  validate_taskspace_network_override "${normal_root}" unit/normal-task 20000
rm -f -- "${hardlink}"
validate_taskspace_network_override "${normal_root}" unit/normal-task 20000 >/dev/null \
  || fail 'network override did not recover after the test hardlink was removed'

maintenance_line="$(grep -nF \
  'ensure_taskspace_maintenance_fence "${stage_root}" "${slug}/${task_id}"' \
  "${TASKSPACECTL}" | cut -d: -f1)"
network_line="$(grep -nF \
  'ensure_taskspace_network_override "${stage_root}" "${slug}/${task_id}" "${harness_port}"' \
  "${TASKSPACECTL}" | cut -d: -f1)"
clone_line="$(grep -nF 'git clone --no-hardlinks --no-local "${integration_workspace}" "${stage_root}/workspace"' \
  "${TASKSPACECTL}" | cut -d: -f1)"
task_env_line="$(grep -nF 'chmod 0600 "${stage_root}/task.env"' \
  "${TASKSPACECTL}" | cut -d: -f1)"
publish_line="$(grep -nF 'mv -- "${stage_root}" "${task_root}"' \
  "${TASKSPACECTL}" | cut -d: -f1)"
governance_line="$(awk \
  '/ensure_taskspace_cache_contract "\$\{stage_root\}"/ { in_create=1 }
   in_create && /if taskspace_governance_context_required; then/ { print NR; exit }' \
  "${TASKSPACECTL}")"
[[ -n "${maintenance_line}" && -n "${network_line}" && -n "${clone_line}" \
  && -n "${task_env_line}" && -n "${publish_line}" && -n "${governance_line}" \
  && "${maintenance_line}" -lt "${clone_line}" \
  && "${maintenance_line}" -lt "${governance_line}" \
  && "${task_env_line}" -lt "${network_line}" \
  && "${network_line}" -lt "${publish_line}" ]] \
  || fail 'create does not establish its fence and validated network contract before publication'

recover_block="${TEST_ROOT}/recover.block"
sed -n '/^  recover)/,/^    ;;/p' "${TASKSPACECTL}" >"${recover_block}"
grep -Fq -- 'current_status}" == provisioning-failed' "${recover_block}" \
  || fail 'explicit recovery is not restricted to provisioning-failed state'
grep -Fq -- 'ensure_taskspace_network_override "$(task_root_of "${task_id}")"' "${recover_block}" \
  || fail 'explicit recovery does not establish the deterministic network override'
grep -Fq -- 'atomic_metadata_status "${task_id}" provisioning-failed' "${recover_block}" \
  || fail 'failed recovery does not preserve the provisioning-failed state'
if grep -Eq -- 'rm -rf|docker (network|volume) rm|down --volumes' "${recover_block}"; then
  fail 'explicit provisioning recovery contains a destructive cleanup path'
fi

fake_bin="${TEST_ROOT}/bin"
docker_log="${TEST_ROOT}/docker.log"
task_network_state_root="${TEST_ROOT}/task-networks"
mkdir -p -- "${fake_bin}" "${task_network_state_root}"
: >"${docker_log}"
cat >"${fake_bin}/jq" <<'PY'
#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
values = {}
index = 0
while index < len(args):
    if args[index] in ('--arg', '--argjson'):
        raw = args[index + 2]
        values[args[index + 1]] = int(raw) if args[index] == '--argjson' else raw
        index += 3
    else:
        index += 1

if '--null-input' in args:
    if 'epoch' in values:
        value = {'schemaVersion': 1, 'state': 'committed', 'epoch': values['epoch']}
    else:
        value = {
            'schemaVersion': 2,
            'projectSlug': values['project_slug'],
            'taskId': values['task_id'],
            'actorId': values['actor_id'],
            'actorUserId': values['actor_user_id'],
            'conversationId': values['conversation_id'],
            'branch': values['branch'],
            'baseCommit': values['base_commit'],
            'status': 'provisioning-failed',
            'createdAt': values['created_at'],
            'updatedAt': values['created_at'],
            'accessTokenHash': values['access_token_hash'],
            'harnessPort': values['harness_port'],
            'accessMode': values['access_mode'],
            'lastCandidate': None,
            'lastRelease': None,
        }
    print(json.dumps(value))
    raise SystemExit(0)

query = next((item for item in args
              if item.startswith('.') or item.startswith('if ') or item.startswith('{')), '')
source_path = args[-1] if args and os.path.isfile(args[-1]) else None
if source_path:
    with open(source_path, encoding='utf-8') as source:
        value = json.load(source)
else:
    value = json.load(sys.stdin)

if '@tsv' in query:
    if (isinstance(value, dict) and sorted(value) == ['epoch', 'schemaVersion', 'state']
            and value.get('schemaVersion') == 1
            and value.get('state') in ('committed', 'maintenance')):
        print(f"{value['state']}\t{value['epoch']}")
        raise SystemExit(0)
    raise SystemExit(1)
if query == '.status':
    print(value['status'])
    raise SystemExit(0)
if query == '.schemaVersion | select(. == 1 or . == 2)':
    schema_version = value.get('schemaVersion')
    if schema_version in (1, 2):
        print(schema_version)
        raise SystemExit(0)
    raise SystemExit(1)
if '.harnessPort | select' in query:
    port = value.get('harnessPort')
    if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
        print(port)
        raise SystemExit(0)
    raise SystemExit(1)
if '.projectSlug == $project_slug' in query:
    raise SystemExit(0 if value.get('projectSlug') == values.get('project_slug')
                     and value.get('taskId') == values.get('task_id') else 1)
if '.status = $status' in query:
    value['status'] = values['status']
    value['updatedAt'] = values['updated_at']
    print(json.dumps(value))
    raise SystemExit(0)
if '.state == "committed"' in query:
    if value.get('schemaVersion') == 1 and value.get('state') == 'committed':
        print('committed')
        raise SystemExit(0)
    raise SystemExit(1)
if query.startswith('{schemaVersion'):
    print(json.dumps(value))
    raise SystemExit(0)
raise SystemExit(f'unexpected test jq query: {query}')
PY
cat >"${fake_bin}/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DOCKER_LOG:?}"
last_arg="${!#}"
if [[ "$*" == 'network ls --quiet --no-trunc' ]]; then
  if [[ -n "${FAKE_DOCKER_COLLISION_CIDR:-}" ]]; then
    printf 'aaaaaaaaaaaa\n'
  fi
  exit 0
fi
if [[ "$1" == network && "$2" == inspect && "${last_arg}" == aaaaaaaaaaaa ]]; then
  printf 'unrelated-network|%s,\n' "${FAKE_DOCKER_COLLISION_CIDR:?}"
  exit 0
fi
if [[ "$1" == network && "$2" == inspect \
    && "${last_arg}" == forge-demo-project-task-*_uploads ]]; then
  state_file="${FAKE_TASK_NETWORK_STATE_ROOT:?}/${last_arg}"
  if [[ -f "${state_file}" ]]; then
    if [[ -n "${FAKE_TASK_NETWORK_CONTRACT_OVERRIDE:-}" ]]; then
      printf '%s\n' "${FAKE_TASK_NETWORK_CONTRACT_OVERRIDE}"
    else
      dd if="${state_file}" status=none
    fi
    exit 0
  fi
  [[ "${FAKE_DOCKER_NETWORK_NOT_FOUND_LEADING_BLANK:-false}" == true ]] && printf '\n' >&2
  printf 'Error response from daemon: network %s not found\n' "${last_arg}" >&2
  exit 1
fi
case "$*" in
  'network inspect forge-demo-project_taskspaces') exit 0 ;;
  *'/ops/project.env --file '*'/ops/compose.yaml ps --quiet taskspace-broker')
    printf 'broker-container\n'
    exit 0
    ;;
  "inspect --format {{.State.Health.Status}} broker-container")
    printf 'healthy\n'
    exit 0
    ;;
  *' ps --quiet harness')
    if [[ "${FAKE_HEALTHY_LEGACY:-false}" == true ]]; then
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
      exit 0
    fi
    ;;
  *' ps --quiet harness-upload')
    if [[ "${FAKE_HEALTHY_LEGACY:-false}" == true ]]; then
      printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
      exit 0
    fi
    ;;
  "inspect --format {{.State.Running}} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" | \
  "inspect --format {{.State.Running}} bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    printf 'true\n'
    exit 0
    ;;
  "inspect --format {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}} bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    printf 'healthy\n'
    exit 0
    ;;
  compose*)
    if [[ "${FAKE_TASK_UP_FAIL:-false}" == true && "$*" == *' up --detach'* ]]; then
      exit 73
    fi
    if [[ "$*" == *' up --detach'* ]]; then
      args=("$@")
      env_file=''
      for ((index = 0; index < ${#args[@]} - 1; index++)); do
        if [[ "${args[index]}" == --env-file ]]; then
          env_file="${args[index + 1]}"
          break
        fi
      done
      [[ -n "${env_file}" && -f "${env_file}" ]] || exit 94
      compose_project="$(awk -F= '$1 == "TASKSPACE_COMPOSE_PROJECT_NAME" {print $2; exit}' "${env_file}")"
      override="$(dirname -- "${env_file}")/compose.network.override.yaml"
      if [[ -e "${override}" ]]; then
        subnet="$(awk '$1 == "-" && $2 == "subnet:" {print $3; exit}' "${override}")"
        [[ -n "${compose_project}" && -n "${subnet}" ]] || exit 95
        printf '%s|uploads|bridge|true|%s,\n' "${compose_project}" "${subnet}" \
          >"${FAKE_TASK_NETWORK_STATE_ROOT:?}/${compose_project}_uploads"
      fi
    fi
    exit 0
    ;;
  *)
    printf 'unexpected Docker invocation: %s\n' "$*" >&2
    exit 91
    ;;
esac
SH
cat >"${fake_bin}/openssl" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == 'rand -hex 32' ]]; then
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  exit 0
fi
printf 'unexpected openssl invocation: %s\n' "$*" >&2
exit 92
SH
chmod 0755 "${fake_bin}/jq" "${fake_bin}/docker" "${fake_bin}/openssl"
export DOCKER_LOG="${docker_log}"
export FAKE_TASK_NETWORK_STATE_ROOT="${task_network_state_root}"
export PATH="${fake_bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

DELIVERY_ROOT="${TEST_ROOT}/delivery"
DELIVERY_OWNER_UID="$(id -u)"
DELIVERY_GROUP_GID="$(id -g)"
slug='demo-project'
task_id='failed-task'
project_root="${DELIVERY_ROOT}/projects/${slug}"
task_root="${project_root}/taskspaces/${task_id}"
skill_root="${TEST_ROOT}/skills"
mkdir -p -- \
  "${DELIVERY_ROOT}/registry" \
  "${project_root}/ops" \
  "${project_root}/workspace/.git" \
  "${task_root}/workspace/.git/info" \
  "${task_root}/dsh-home" \
  "${task_root}/uploads" \
  "${task_root}/tokens" \
  "${skill_root}/versions/v1/skills"
printf '{}\n' >"${skill_root}/versions/v1/bundle.manifest.json"
ln -s -- "${skill_root}/versions/v1" "${skill_root}/current"
cat >"${project_root}/ops/project.env" <<EOF
FORGE_SKILL_BUNDLE_ROOT=${skill_root}
TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED=false
TASKSPACE_PORT_MIN=20050
TASKSPACE_PORT_MAX=20060
PROJECT_MATERIAL_ACCESS_MODE=reviewed
PROJECT_SHARED_INPUT_ROOT=${project_root}/shared-inputs/accepted
PROJECT_UPLOAD_ROOT=${DELIVERY_ROOT}/file-gateway/data/${slug}
PLATFORM_CONVERSATION_AUTH_ROOT=${DELIVERY_ROOT}/conversation-control-plane/authz
FORGE_BIND_ADDRESS=127.0.0.1
CONVERSATION_GATEWAY_AUTHZ_URL=http://gateway.invalid/internal/taskspace-authorize
CONVERSATION_GATEWAY_LOGIN_URL=http://gateway.invalid/
HARNESS_PRIVILEGED_API_MODE=false
HARNESS_HISTORY_PAGE_MESSAGES=50
HARNESS_UPLOAD_MAX_FILE_BYTES=1048576
HARNESS_UPLOAD_MAX_BATCH_FILES=10
HARNESS_UPLOAD_MAX_BATCH_BYTES=10485760
HARNESS_UPLOAD_MAX_PROJECT_BYTES=104857600
HARNESS_DOCUMENT_MAX_SOURCE_BYTES=1048576
HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=1048576
HARNESS_DOCUMENT_MAX_PDF_PAGES=10
HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=1000
HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=100
HOST_UID=${DELIVERY_OWNER_UID}
HOST_GID=${DELIVERY_GROUP_GID}
DEEPSEEK_KEY_FILE=${DELIVERY_ROOT}/secrets/deepseek
KIMI_KEY_FILE=${DELIVERY_ROOT}/secrets/kimi
GLM_KEY_FILE=${DELIVERY_ROOT}/secrets/glm
HARNESS_IMAGE=example.invalid/harness:test
TZ=Asia/Shanghai
EOF
: >"${project_root}/ops/compose.yaml"
printf 'fixture\n' >"${project_root}/workspace/README.md"
git -C "${project_root}/workspace" init --quiet
git -C "${project_root}/workspace" config user.name fixture
git -C "${project_root}/workspace" config user.email fixture@example.invalid
git -C "${project_root}/workspace" add -- README.md
git -C "${project_root}/workspace" commit --quiet -m fixture
printf 'slug\n%s\n' "${slug}" >"${DELIVERY_ROOT}/registry/projects.tsv"
printf 'project\ttask\tport\tcreated\n%s\t%s\t20042\t2026-09-07T07:17:00Z\n' \
  "${slug}" "${task_id}" >"${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
cat >"${task_root}/metadata.json" <<EOF
{"schemaVersion":2,"projectSlug":"${slug}","taskId":"${task_id}","status":"provisioning-failed","harnessPort":20042,"updatedAt":"2026-09-07T07:17:00Z"}
EOF
cat >"${task_root}/task.env" <<EOF
TASKSPACE_COMPOSE_PROJECT_NAME=forge-${slug}-task-${task_id}
PROJECT_COMPOSE_NAME=forge-${slug}
TASKSPACE_ROOT=${task_root}
PROJECT_SLUG=${slug}
TASKSPACE_ID=${task_id}
TASKSPACE_HARNESS_PORT=20042
EOF
printf 'preserved-evidence\n' >"${task_root}/failure-evidence.txt"

taskspace_env=(
  env
  TASKSPACE_CONTROL_CONFIG_MODE=project
  "TASKSPACE_CONTROL_DELIVERY_ROOT=${DELIVERY_ROOT}"
  "TASKSPACE_CONTROL_DELIVERY_OWNER=${DELIVERY_OWNER}"
  "TASKSPACE_CONTROL_DELIVERY_GROUP=${DELIVERY_GROUP}"
  "TASKSPACE_CONTROL_DELIVERY_UID=${DELIVERY_OWNER_UID}"
  "TASKSPACE_CONTROL_DELIVERY_GID=${DELIVERY_GROUP_GID}"
  TASKSPACE_SKIP_SOCKET_SCAN=true
)

set +e
failed_output="$(FAKE_TASK_UP_FAIL=true "${taskspace_env[@]}" \
  bash "${TASKSPACECTL}" "${slug}" recover "${task_id}" 2>&1)"
failed_status=$?
set -e
((failed_status != 0)) || fail 'injected Compose failure unexpectedly recovered'
grep -Fq -- 'evidence remains preserved' <<<"${failed_output}" \
  || fail "failed recovery did not report its evidence boundary: ${failed_output}"
[[ -d "${task_root}" && "$(<"${task_root}/failure-evidence.txt")" == preserved-evidence ]] \
  || fail 'failed recovery deleted or changed preserved TaskSpace evidence'
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
  "${task_root}/metadata.json")" == provisioning-failed ]] \
  || fail 'failed recovery did not retain provisioning-failed metadata'
[[ -f "${task_root}/maintenance/proxy-fence.json" \
  && -f "${task_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'failed recovery did not retain its maintenance and network contracts'
[[ "$(wc -l <"${DELIVERY_ROOT}/registry/taskspace-ports.tsv")" -eq 2 ]] \
  || fail 'failed recovery changed the preserved port registration'

"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}" >/dev/null \
  || fail 'provisioning-failed TaskSpace did not recover after the injected fault cleared'
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
  "${task_root}/metadata.json")" == active ]] \
  || fail 'successful recovery did not atomically mark the TaskSpace active'
up_count_before="$(grep -Fc -- ' up --detach' "${docker_log}")"
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}" >/dev/null \
  || fail 'completed provisioning recovery is not idempotent'
[[ "$(grep -Fc -- ' up --detach' "${docker_log}")" == "${up_count_before}" ]] \
  || fail 'idempotent recovery replay mutated the active Compose project'

# The bounded production bridge used the legacy filename. An active replay must
# validate that exact file, preserve it, and add only the canonical equivalent.
rm -f -- "${task_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
taskspace_legacy_network_override_document 20042 \
  >"${task_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
legacy_override_hash_before="$(sha256sum \
  "${task_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')"
up_count_before="$(grep -Fc -- ' up --detach' "${docker_log}")"
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}" >/dev/null \
  || fail 'active legacy-only production recovery did not migrate idempotently'
[[ -f "${task_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && -f "${task_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" \
  && "$(sha256sum "${task_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')" \
    == "${legacy_override_hash_before}" ]] \
  || fail 'active legacy-only recovery did not preserve legacy evidence while adding canonical metadata'
[[ "$(grep -Fc -- ' up --detach' "${docker_log}")" == "${up_count_before}" ]] \
  || fail 'active legacy-only recovery restarted or recreated the Compose project'
recovered_up_call="$(grep -F -- "${task_root}/task.env" "${docker_log}" \
  | grep -F -- ' up --detach' | tail -n 1)"
[[ "${recovered_up_call}" == *"--file ${REPO_ROOT}/templates/taskspace/compose.yaml"* \
  && "${recovered_up_call}" == *"--file ${task_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"* ]] \
  || fail 'recovered TaskSpace did not apply its per-task Compose override'

# Every identity and allocation rejection below must occur before a mutating
# Compose up. Read-only network inspection is allowed only for the network-drift
# case that specifically exercises that admission check.
set_metadata_status "${task_root}/metadata.json" provisioning-failed
cp -- "${task_root}/task.env" "${TEST_ROOT}/task.env.good"
printf 'TASKSPACE_HARNESS_PORT=20043\n' >>"${task_root}/task.env"
docker_lines_before="$(wc -l <"${docker_log}")"
expect_rejection 'duplicate TASKSPACE_HARNESS_PORT during recovery' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}"
[[ "$(wc -l <"${docker_log}")" == "${docker_lines_before}" ]] \
  || fail 'duplicate recovery port reached Docker'
cp -- "${TEST_ROOT}/task.env.good" "${task_root}/task.env"

sed -i "s/^PROJECT_SLUG=.*/PROJECT_SLUG=wrong-project/" "${task_root}/task.env"
docker_lines_before="$(wc -l <"${docker_log}")"
expect_rejection 'drifted recovery project identity' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}"
[[ "$(wc -l <"${docker_log}")" == "${docker_lines_before}" ]] \
  || fail 'drifted recovery identity reached Docker'
cp -- "${TEST_ROOT}/task.env.good" "${task_root}/task.env"

mv -- "${task_root}/metadata.json" "${TEST_ROOT}/metadata.good"
ln -s -- "${TEST_ROOT}/metadata.good" "${task_root}/metadata.json"
docker_lines_before="$(wc -l <"${docker_log}")"
expect_rejection 'symbolic-link recovery metadata' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}"
[[ "$(wc -l <"${docker_log}")" == "${docker_lines_before}" ]] \
  || fail 'symbolic-link recovery metadata reached Docker'
rm -f -- "${task_root}/metadata.json"
mv -- "${TEST_ROOT}/metadata.good" "${task_root}/metadata.json"

cp -- "${DELIVERY_ROOT}/registry/taskspace-ports.tsv" "${TEST_ROOT}/registry.good"
awk 'NR == 1' "${TEST_ROOT}/registry.good" >"${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
docker_lines_before="$(wc -l <"${docker_log}")"
expect_rejection 'missing recovery port registration' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}"
[[ "$(wc -l <"${docker_log}")" == "${docker_lines_before}" ]] \
  || fail 'missing recovery port registration reached Docker'
cp -- "${TEST_ROOT}/registry.good" "${DELIVERY_ROOT}/registry/taskspace-ports.tsv"

printf '%s\t%s\t20044\t2026-09-07T07:18:00Z\n' "${slug}" "${task_id}" \
  >>"${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
docker_lines_before="$(wc -l <"${docker_log}")"
expect_rejection 'second port registration for the same recovery target' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}"
[[ "$(wc -l <"${docker_log}")" == "${docker_lines_before}" ]] \
  || fail 'ambiguous recovery port registration reached Docker'
cp -- "${TEST_ROOT}/registry.good" "${DELIVERY_ROOT}/registry/taskspace-ports.tsv"

up_count_before="$(grep -Fc -- ' up --detach' "${docker_log}")"
expect_rejection 'wrong existing uploads network contract' \
  env FAKE_TASK_NETWORK_CONTRACT_OVERRIDE='forge-demo-project-task-failed-task|uploads|bridge|false|10.240.1.80/29,' \
    "${taskspace_env[@]:1}" bash "${TASKSPACECTL}" "${slug}" recover "${task_id}"
[[ "$(grep -Fc -- ' up --detach' "${docker_log}")" == "${up_count_before}" ]] \
  || fail 'wrong existing uploads network contract reached Compose up'
[[ "$(<"${task_root}/failure-evidence.txt")" == preserved-evidence ]] \
  || fail 'negative recovery admissions changed preserved evidence'
set_metadata_status "${task_root}/metadata.json" active

collision_id='collision-task'
collision_root="${project_root}/taskspaces/${collision_id}"
registry_lines_before="$(wc -l <"${DELIVERY_ROOT}/registry/taskspace-ports.tsv")"
up_count_before="$(grep -Fc -- ' up --detach' "${docker_log}")"
expect_rejection 'candidate subnet overlapping an existing Docker IPv4 network' \
  env FAKE_DOCKER_COLLISION_CIDR='10.240.1.160/28' \
    "${taskspace_env[@]:1}" bash "${TASKSPACECTL}" "${slug}" create \
      --task "${collision_id}" \
      --actor collision \
      --actor-user-id 33333333-3333-4333-8333-333333333333 \
      --conversation conversation-collision \
      --access-mode conversation \
      --port 20052
[[ ! -e "${collision_root}" \
  && "$(wc -l <"${DELIVERY_ROOT}/registry/taskspace-ports.tsv")" == "${registry_lines_before}" \
  && "$(grep -Fc -- ' up --detach' "${docker_log}")" == "${up_count_before}" ]] \
  || fail 'overlapping subnet admission persisted or started a TaskSpace'

created_id='created-task'
created_root="${project_root}/taskspaces/${created_id}"
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" create \
  --task "${created_id}" \
  --actor alice \
  --actor-user-id 11111111-1111-4111-8111-111111111111 \
  --conversation conversation-created \
  --access-mode conversation \
  --port 20050 >/dev/null \
  || fail 'governance-disabled TaskSpace creation failed'
[[ -f "${created_root}/maintenance/proxy-fence.json" \
  && -f "${created_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && -f "${created_root}/tokens/browser" \
  && -f "${created_root}/tokens/broker" ]] \
  || fail 'new TaskSpace did not persist its fence, network contract, and tokens'
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
  "${created_root}/metadata.json")" == active ]] \
  || fail 'new TaskSpace was not marked active after realized-network verification'
[[ "$(awk -F '\t' -v task="${created_id}" '$2 == task && $3 == 20050 {count++} END {print count+0}' \
  "${DELIVERY_ROOT}/registry/taskspace-ports.tsv")" -eq 1 ]] \
  || fail 'new TaskSpace does not have one exact port registration'
created_up_call="$(grep -F -- "${created_root}/task.env" "${docker_log}" \
  | grep -F -- ' up --detach' | tail -n 1)"
[[ "${created_up_call}" == *"--file ${created_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"* ]] \
  || fail 'new TaskSpace did not pass its override to Compose up'
[[ "$(<"${task_network_state_root}/forge-demo-project-task-created-task_uploads")" \
  == 'forge-demo-project-task-created-task|uploads|bridge|true|10.240.1.144/29,' ]] \
  || fail 'new TaskSpace realized a network other than its port-derived /29'
[[ ! -e "${project_root}/governance/PROJECT_CONTEXT.md" ]] \
  || fail 'governance-disabled creation unexpectedly required governance state'

# A stopped current TaskSpace must tolerate the blank line emitted before the
# Docker CLI's canonical network-not-found diagnostic and recreate only its
# deterministic network.
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" stop "${created_id}" >/dev/null \
  || fail 'current TaskSpace stop failed before network-not-found replay'
rm -f -- "${task_network_state_root}/forge-demo-project-task-created-task_uploads"
FAKE_DOCKER_NETWORK_NOT_FOUND_LEADING_BLANK=true "${taskspace_env[@]}" \
  bash "${TASKSPACECTL}" "${slug}" start "${created_id}" >/dev/null \
  || fail 'current TaskSpace did not accept the whitespace-prefixed canonical network-not-found diagnostic'
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
    "${created_root}/metadata.json")" == active \
  && "$(<"${task_network_state_root}/forge-demo-project-task-created-task_uploads")" \
    == 'forge-demo-project-task-created-task|uploads|bridge|true|10.240.1.144/29,' ]] \
  || fail 'current TaskSpace did not safely realize its deterministic network after reopen'

failed_create_id='create-fail-task'
failed_create_root="${project_root}/taskspaces/${failed_create_id}"
set +e
failed_create_output="$(FAKE_TASK_UP_FAIL=true "${taskspace_env[@]}" \
  bash "${TASKSPACECTL}" "${slug}" create \
    --task "${failed_create_id}" \
    --actor bob \
    --actor-user-id 22222222-2222-4222-8222-222222222222 \
    --conversation conversation-create-fail \
    --access-mode conversation \
    --port 20051 2>&1)"
failed_create_status=$?
set -e
((failed_create_status != 0)) || fail 'injected new-TaskSpace Compose failure unexpectedly succeeded'
grep -Fq -- 'evidence is preserved' <<<"${failed_create_output}" \
  || fail "failed create did not report preserved evidence: ${failed_create_output}"
[[ -d "${failed_create_root}" \
  && -f "${failed_create_root}/metadata.json" \
  && -f "${failed_create_root}/maintenance/proxy-fence.json" \
  && -f "${failed_create_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && -f "${failed_create_root}/tokens/browser" ]] \
  || fail 'failed create deleted or omitted its durable evidence'
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
  "${failed_create_root}/metadata.json")" == provisioning-failed ]] \
  || fail 'failed create did not remain fail-safe provisioning-failed'
[[ "$(awk -F '\t' -v task="${failed_create_id}" '$2 == task && $3 == 20051 {count++} END {print count+0}' \
  "${DELIVERY_ROOT}/registry/taskspace-ports.tsv")" -eq 1 ]] \
  || fail 'failed create did not preserve its exact port registration'

legacy_network_id='legacy-network-task'
legacy_network_root="${project_root}/taskspaces/${legacy_network_id}"
mkdir -p -- "${legacy_network_root}/workspace/.git/info"
cp -- "${created_root}/task.env" "${legacy_network_root}/task.env"
sed -i \
  -e "s/created-task/${legacy_network_id}/g" \
  -e 's/TASKSPACE_HARNESS_PORT=20050/TASKSPACE_HARNESS_PORT=20053/' \
  "${legacy_network_root}/task.env"
printf '{"schemaVersion":2,"projectSlug":"%s","taskId":"%s","status":"stopped","harnessPort":20053,"updatedAt":"2026-09-07T07:17:00Z"}\n' \
  "${slug}" "${legacy_network_id}" >"${legacy_network_root}/metadata.json"
taskspace_legacy_network_override_document 20053 \
  >"${legacy_network_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
legacy_network_hash="$(sha256sum "${legacy_network_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')"
printf '%s\t%s\t20053\t2026-09-07T07:17:00Z\n' "${slug}" "${legacy_network_id}" \
  >>"${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
[[ ! -e "${legacy_network_root}/maintenance" \
  && ! -e "${legacy_network_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" ]] \
  || fail 'legacy network fixture unexpectedly started migrated'
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" start "${legacy_network_id}" >/dev/null \
  || fail 'legacy production network contract did not survive start migration'
[[ -f "${legacy_network_root}/maintenance/proxy-fence.json" \
  && -f "${legacy_network_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && "$(sha256sum "${legacy_network_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" | awk '{print $1}')" == "${legacy_network_hash}" ]] \
  || fail 'legacy start did not add fence/canonical while preserving the legacy contract'
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
  "${legacy_network_root}/metadata.json")" == active ]] \
  || fail 'legacy network TaskSpace was not marked active after verified start'
[[ "$(<"${task_network_state_root}/forge-demo-project-task-legacy-network-task_uploads")" \
  == 'forge-demo-project-task-legacy-network-task|uploads|bridge|true|10.240.1.168/29,' ]] \
  || fail 'legacy network TaskSpace did not realize its port-derived /29'

legacy_id='legacy-task'
legacy_root="${project_root}/taskspaces/${legacy_id}"
mkdir -p -- "${legacy_root}/workspace/.git/info"
printf '{"schemaVersion":1,"projectSlug":"%s","taskId":"%s","status":"active","harnessPort":45000}\n' \
  "${slug}" "${legacy_id}" >"${legacy_root}/metadata.json"
printf 'TASKSPACE_HARNESS_PORT=45000\n' >"${legacy_root}/task.env"
legacy_up_count_before="$(grep -Fc -- ' up --detach' "${docker_log}")"
FAKE_HEALTHY_LEGACY=true "${taskspace_env[@]}" \
  bash "${TASKSPACECTL}" "${slug}" start "${legacy_id}" >/dev/null \
  || fail 'healthy active legacy TaskSpace did not take the preservation no-op path'
[[ "$(grep -Fc -- ' up --detach' "${docker_log}")" == "${legacy_up_count_before}" \
  && ! -e "${legacy_root}/maintenance" ]] \
  || fail 'healthy active legacy TaskSpace was reconciled or mutated during open'
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" status "${legacy_id}" >/dev/null \
  || fail 'legacy TaskSpace without an override no longer composes'
legacy_compose_call="$(grep -F -- "${legacy_root}/task.env" "${docker_log}" | tail -n 1)"
[[ "${legacy_compose_call}" == *"--file ${REPO_ROOT}/templates/taskspace/compose.legacy-v1.yaml ps --all"* \
  && "${legacy_compose_call}" != *"${TASKSPACE_NETWORK_OVERRIDE_NAME}"* ]] \
  || fail 'legacy TaskSpace unexpectedly received the new network override'
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" stop "${legacy_id}" >/dev/null \
  || fail 'schema-v1 TaskSpace without a maintenance node could not stop safely'
[[ -f "${legacy_root}/maintenance/proxy-fence.json" \
  && "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' \
    "${legacy_root}/maintenance/proxy-fence.json")" == committed \
  && "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
    "${legacy_root}/metadata.json")" == stopped ]] \
  || fail 'schema-v1 stop did not establish a committed fence before changing status'
legacy_stop_call="$(grep -F -- "${legacy_root}/task.env" "${docker_log}" \
  | grep -F -- ' down --remove-orphans' | tail -n 1)"
[[ "${legacy_stop_call}" == *"--file ${REPO_ROOT}/templates/taskspace/compose.legacy-v1.yaml"* ]] \
  || fail 'schema-v1 stop did not use the frozen legacy Compose template'

schema2_missing_fence_id='schema2-missing-fence'
schema2_missing_fence_root="${project_root}/taskspaces/${schema2_missing_fence_id}"
mkdir -p -- "${schema2_missing_fence_root}/workspace/.git/info"
printf '{"schemaVersion":2,"projectSlug":"%s","taskId":"%s","status":"active","harnessPort":45001}\n' \
  "${slug}" "${schema2_missing_fence_id}" >"${schema2_missing_fence_root}/metadata.json"
printf 'TASKSPACE_HARNESS_PORT=45001\n' >"${schema2_missing_fence_root}/task.env"
docker_calls_before="$(wc -l <"${docker_log}")"
expect_rejection 'schema-v2 TaskSpace without a maintenance fence' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" stop "${schema2_missing_fence_id}"
[[ ! -e "${schema2_missing_fence_root}/maintenance" \
  && "$(wc -l <"${docker_log}")" == "${docker_calls_before}" ]] \
  || fail 'schema-v2 missing-fence rejection mutated state or reached Docker'

legacy_partial_fence_id='legacy-partial-fence'
legacy_partial_fence_root="${project_root}/taskspaces/${legacy_partial_fence_id}"
mkdir -p -- "${legacy_partial_fence_root}/workspace/.git/info" "${legacy_partial_fence_root}/maintenance"
printf '{"schemaVersion":1,"projectSlug":"%s","taskId":"%s","status":"active","harnessPort":45002}\n' \
  "${slug}" "${legacy_partial_fence_id}" >"${legacy_partial_fence_root}/metadata.json"
printf 'TASKSPACE_HARNESS_PORT=45002\n' >"${legacy_partial_fence_root}/task.env"
docker_calls_before="$(wc -l <"${docker_log}")"
expect_rejection 'schema-v1 TaskSpace with a partial maintenance node' \
  "${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" close "${legacy_partial_fence_id}"
[[ ! -e "${legacy_partial_fence_root}/maintenance/proxy-fence.json" \
  && "$(wc -l <"${docker_log}")" == "${docker_calls_before}" ]] \
  || fail 'partial schema-v1 fence rejection filled state or reached Docker'

# A stopped schema-v1 TaskSpace has no live uploads network to preserve. Its
# first reopen must establish the deterministic network contract before Compose
# up, while still selecting the frozen legacy template.
legacy_stopped_id='legacy-stopped-task'
legacy_stopped_root="${project_root}/taskspaces/${legacy_stopped_id}"
mkdir -p -- "${legacy_stopped_root}/workspace/.git/info"
cp -- "${created_root}/task.env" "${legacy_stopped_root}/task.env"
sed -i \
  -e "s/created-task/${legacy_stopped_id}/g" \
  -e 's/TASKSPACE_HARNESS_PORT=20050/TASKSPACE_HARNESS_PORT=20054/' \
  -e '/^FORGE_SKILL_BUNDLE_ROOT=/d' \
  -e '/^TASKSPACE_ACTOR_USER_ID=/d' \
  -e '/^GLM_KEY_FILE=/d' \
  "${legacy_stopped_root}/task.env"
printf '{"schemaVersion":1,"projectSlug":"%s","taskId":"%s","status":"stopped","harnessPort":20054}\n' \
  "${slug}" "${legacy_stopped_id}" >"${legacy_stopped_root}/metadata.json"
printf '%s\t%s\t20054\t2026-09-07T07:19:00Z\n' "${slug}" "${legacy_stopped_id}" \
  >>"${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
"${taskspace_env[@]}" bash "${TASKSPACECTL}" "${slug}" start "${legacy_stopped_id}" >/dev/null \
  || fail 'stopped schema-v1 TaskSpace without a network contract did not reopen safely'
[[ -f "${legacy_stopped_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
  && "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
    "${legacy_stopped_root}/metadata.json")" == active ]] \
  || fail 'stopped schema-v1 TaskSpace did not publish its deterministic network before activation'
legacy_stopped_up_call="$(grep -F -- "${legacy_stopped_root}/task.env" "${docker_log}" \
  | grep -F -- ' up --detach' | tail -n 1)"
[[ "${legacy_stopped_up_call}" == *"--file ${REPO_ROOT}/templates/taskspace/compose.legacy-v1.yaml"* \
  && "${legacy_stopped_up_call}" == *"--file ${legacy_stopped_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}"* ]] \
  || fail 'stopped schema-v1 TaskSpace did not combine its frozen template and deterministic network'

[[ "${legacy_stopped_up_call}" == *' up --detach --no-recreate' ]] \
  || fail 'opening a stopped TaskSpace allowed replacement of preserved containers'
current_start_call="$(grep -F -- "${legacy_network_root}/task.env" "${docker_log}" \
  | grep -F -- ' up --detach' | tail -n 1)"
[[ "${current_start_call}" == *' up --detach --no-recreate' ]] \
  || fail 'opening a schema-v2 TaskSpace allowed replacement during an active conversation'

printf 'PASS TaskSpace ports map uniquely to /29 networks, legacy Compose remains compatible, and failed provisioning recovers non-destructively\n'
