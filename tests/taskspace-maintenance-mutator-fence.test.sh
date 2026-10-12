#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
# shellcheck source=../scripts/lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect_rejection() {
  local label="$1"
  shift
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  ((status != 0)) || fail "${label} unexpectedly succeeded"
  grep -Fq -- 'active maintenance recovery' <<<"${output}" \
    || fail "${label} was not rejected by the durable maintenance fence: ${output}"
}

for command_name in bash chmod dd env flock grep id kill ln mkdir mktemp readlink rm sha256sum sleep stat tr; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || fail "required test command is missing: ${command_name}"
done

TEST_ROOT="$(mktemp -d)"
[[ -n "${TEST_ROOT}" && "${TEST_ROOT}" == /tmp/* ]] \
  || fail "refusing unsafe temporary root: ${TEST_ROOT}"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

DELIVERY_ROOT="${TEST_ROOT}/delivery"
DELIVERY_OWNER="$(id -un)"
DELIVERY_GROUP="$(id -gn)"
DELIVERY_OWNER_UID="$(id -u)"
DELIVERY_GROUP_GID="$(id -g)"
export DELIVERY_ROOT DELIVERY_OWNER DELIVERY_GROUP DELIVERY_OWNER_UID DELIVERY_GROUP_GID

fake_bin="${TEST_ROOT}/bin"
docker_log="${TEST_ROOT}/docker.log"
mkdir -p -- "${fake_bin}" "${DELIVERY_ROOT}/registry"
: >"${docker_log}"

if ! command -v jq >/dev/null 2>&1; then
  command -v python3 >/dev/null 2>&1 || fail 'jq or the test-only Python jq substitute is required'
  cat >"${fake_bin}/jq" <<'PY'
#!/usr/bin/env python3
import json
import re
import sys

args = sys.argv[1:]
if any(flag in args for flag in ('-r', '-er')) and '.schemaVersion | select(. == 1 or . == 2)' in args:
    with open(args[-1], encoding='utf-8') as source:
        schema_version = json.load(source).get('schemaVersion')
    if schema_version not in (1, 2):
        raise SystemExit(1)
    print(schema_version)
    raise SystemExit(0)
if '-r' in args and any(query in args for query in ('.status', '.state')):
    query = '.status' if '.status' in args else '.state'
    with open(args[-1], encoding='utf-8') as source:
        print(json.load(source)[query[1:]])
    raise SystemExit(0)

value = json.load(sys.stdin)
valid = (
    isinstance(value, dict)
    and sorted(value) == ['epoch', 'schemaVersion', 'state']
    and value.get('schemaVersion') == 1
    and value.get('state') in ('committed', 'maintenance')
    and isinstance(value.get('epoch'), str)
    and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value['epoch'])
)
if not valid:
    raise SystemExit(1)
print(f"{value['state']}\t{value['epoch']}")
PY
  chmod 0755 "${fake_bin}/jq"
fi
if ! command -v python3 >/dev/null 2>&1; then
  cat >"${fake_bin}/python3" <<'SH'
#!/usr/bin/env bash
printf 'unexpected Python invocation before the maintenance fence\n' >&2
exit 92
SH
  chmod 0755 "${fake_bin}/python3"
fi
cat >"${fake_bin}/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DOCKER_LOG:?}"
case "$*" in
  info) exit 0 ;;
  'compose version') printf 'Docker Compose version test\n'; exit 0 ;;
  *) printf 'unexpected Docker invocation: %s\n' "$*" >&2; exit 91 ;;
esac
SH
cat >"${fake_bin}/openssl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 0755 "${fake_bin}/docker" "${fake_bin}/openssl"
export DOCKER_LOG="${docker_log}"
export PATH="${fake_bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

slug='demo-project'
task_id='task-one'
project_root="${DELIVERY_ROOT}/projects/${slug}"
task_root="${project_root}/taskspaces/${task_id}"
fence="${task_root}/maintenance/proxy-fence.json"
mkdir -p -- \
  "${project_root}/ops" \
  "${project_root}/workspace/.git" \
  "${task_root}/maintenance" \
  "${DELIVERY_ROOT}/file-gateway/data/${slug}" \
  "${DELIVERY_ROOT}/backups/${slug}/input"
printf '{"schemaVersion":2,"projectSlug":"%s","taskId":"%s","status":"active"}\n' \
  "${slug}" "${task_id}" >"${task_root}/metadata.json"
: >"${task_root}/task.env"
: >"${project_root}/ops/compose.yaml"
: >"${project_root}/ops/project.env"
printf 'slug\n%s\n' "${slug}" >"${DELIVERY_ROOT}/registry/projects.tsv"
printf 'project\ttask\tport\tcreated\n' >"${DELIVERY_ROOT}/registry/taskspace-ports.tsv"

platform_config="${TEST_ROOT}/platform.env"
cat >"${platform_config}" <<EOF
DELIVERY_ROOT=${DELIVERY_ROOT}
DELIVERY_OWNER=${DELIVERY_OWNER}
DELIVERY_GROUP=${DELIVERY_GROUP}
DELIVERY_OWNER_UID=${DELIVERY_OWNER_UID}
DELIVERY_GROUP_GID=${DELIVERY_GROUP_GID}
DEEPSEEK_KEY_FILE=${DELIVERY_ROOT}/secrets/deepseek-api-key
KIMI_KEY_FILE=${DELIVERY_ROOT}/secrets/kimi-api-key
SHARED_SERVICES_ENV_FILE=${DELIVERY_ROOT}/secrets/shared-services.env
DEFAULT_BIND_ADDRESS=127.0.0.1
EOF

# Model the critical SIGKILL boundary: the worker owns both process locks, commits
# maintenance, and dies before reconciliation. Kernel locks disappear; the fence does not.
holder_ready="${TEST_ROOT}/holder.ready"
(
  exec 8>>"${DELIVERY_ROOT}/registry/taskspaces.lock"
  flock --exclusive 8
  exec 9>>"${DELIVERY_ROOT}/registry/${slug}.recovery.lock"
  flock --exclusive 9
  printf '{"schemaVersion":1,"state":"maintenance","epoch":"sigkill-recovery-1"}\n' >"${fence}"
  : >"${holder_ready}"
  exec sleep 300
) &
holder_pid=$!
for _ in {1..100}; do
  [[ -f "${holder_ready}" ]] && break
  sleep 0.01
done
[[ -f "${holder_ready}" ]] || fail 'lock holder did not reach the maintenance boundary'
kill -KILL "${holder_pid}"
wait "${holder_pid}" 2>/dev/null || true
[[ "$(jq -r '.state' "${fence}")" == maintenance ]] \
  || fail 'SIGKILL did not preserve the durable maintenance fence'
flock --exclusive --nonblock "${DELIVERY_ROOT}/registry/taskspaces.lock" true \
  || fail 'SIGKILL did not release the TaskSpace process lock'
flock --exclusive --nonblock "${DELIVERY_ROOT}/registry/${slug}.recovery.lock" true \
  || fail 'SIGKILL did not release the project recovery process lock'

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
for action in start stop close; do
  expect_rejection "TaskSpace ${action} after SIGKILL" \
    "${taskspace_env[@]}" bash "${REPO_ROOT}/scripts/taskspacectl.sh" \
      "${slug}" "${action}" "${task_id}"
done
expect_rejection 'project backup after SIGKILL' \
  env "PLATFORM_CONFIG=${platform_config}" bash "${REPO_ROOT}/scripts/backup-project.sh" \
    "${slug}" --confirm-maintenance-window "${slug}"
expect_rejection 'project restore after SIGKILL' \
  env "PLATFORM_CONFIG=${platform_config}" bash "${REPO_ROOT}/scripts/restore-project.sh" \
    "${slug}" "${DELIVERY_ROOT}/backups/${slug}/input" --confirm-destructive-restore "${slug}"

[[ "$(jq -r '.status' "${task_root}/metadata.json")" == active ]] \
  || fail 'a rejected lifecycle operation changed TaskSpace metadata'
if grep -Ev '^(info|compose version)$' "${docker_log}" | grep -q .; then
  fail "a rejected operation reached a mutating Docker call: $(<"${docker_log}")"
fi
[[ ! -e "${task_root}/cache" && ! -e "${DELIVERY_ROOT}/recovery/${slug}" ]] \
  || fail 'a rejected operation mutated TaskSpace cache or restore state'

# The shared reader admits only a bounded, ordinary, single-link, exact committed
# record. These checks cover the non-maintenance fail-closed cases independently.
printf '{"schemaVersion":1,"state":"committed","epoch":"normal-1"}\n' >"${fence}"
assert_taskspace_mutation_fence_committed "${task_root}" "strict/committed"
printf '{"schemaVersion":1,"state":"committed","epoch":"normal-2","extra":true}\n' >"${fence}"
if (assert_taskspace_mutation_fence_committed "${task_root}" strict/extra) >/dev/null 2>&1; then
  fail 'fence with an extra key was admitted'
fi
dd if=/dev/zero bs=4097 count=1 status=none | tr '\0' x >"${fence}"
if (assert_taskspace_mutation_fence_committed "${task_root}" strict/oversize) >/dev/null 2>&1; then
  fail 'oversized fence was admitted'
fi
printf '{"schemaVersion":1,"state":"committed","epoch":"normal-3"}\n' >"${fence}"
hardlink="${TEST_ROOT}/fence-hardlink"
ln "${fence}" "${hardlink}"
if (assert_taskspace_mutation_fence_committed "${task_root}" strict/hardlink) >/dev/null 2>&1; then
  fail 'multiply linked fence was admitted'
fi
rm -f -- "${hardlink}" "${fence}"
outside="${TEST_ROOT}/outside-fence"
printf '{"schemaVersion":1,"state":"committed","epoch":"outside-1"}\n' >"${outside}"
ln -s -- "${outside}" "${fence}"
if (assert_taskspace_mutation_fence_committed "${task_root}" strict/symlink) >/dev/null 2>&1; then
  fail 'symbolic-link fence was admitted'
fi
grep -Fq -- 'outside-1' "${outside}" || fail 'symlink rejection changed the outside target'

printf 'PASS durable TaskSpace maintenance fence blocks lifecycle, backup, and restore after SIGKILL\n'
