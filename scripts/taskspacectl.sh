#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/taskspace-compose-network.sh
source "${SCRIPT_DIR}/lib/taskspace-compose-network.sh"

# Conversation Manager runs as the non-root delivery identity and must not need
# read access to the host-wide platform.env.  Compose injects the three
# non-secret location/ownership values from the project's mode-0600 project.env.
# Direct host-side operator calls keep using the reviewed platform config.
if [[ "${TASKSPACE_CONTROL_CONFIG_MODE:-platform}" == project ]]; then
  : "${TASKSPACE_CONTROL_DELIVERY_ROOT:?TASKSPACE_CONTROL_DELIVERY_ROOT is required}"
  : "${TASKSPACE_CONTROL_DELIVERY_OWNER:?TASKSPACE_CONTROL_DELIVERY_OWNER is required}"
  : "${TASKSPACE_CONTROL_DELIVERY_GROUP:?TASKSPACE_CONTROL_DELIVERY_GROUP is required}"
  DELIVERY_ROOT="${TASKSPACE_CONTROL_DELIVERY_ROOT}"
  DELIVERY_OWNER="${TASKSPACE_CONTROL_DELIVERY_OWNER}"
  DELIVERY_GROUP="${TASKSPACE_CONTROL_DELIVERY_GROUP}"
  # New Manager templates inject the host numeric identity explicitly. During a
  # rolling upgrade an older Manager may omit these values; common.sh then accepts
  # only the current non-root process identity as the compatibility fallback.
  DELIVERY_OWNER_UID="${TASKSPACE_CONTROL_DELIVERY_UID:-}"
  DELIVERY_GROUP_GID="${TASKSPACE_CONTROL_DELIVERY_GID:-}"
else
  load_platform_config
fi

usage() {
  printf '%s\n' \
    "Usage: $0 <project-slug> <command> [options]" \
    "" \
    "Commands:" \
    "  preflight" \
    "  create --task <id> --actor <username> --actor-user-id <uuid> --conversation <id> [--access-mode token|conversation] [--port <port>] [--runtime-channel stable|enhanced] [--runtime-version-id <sha256>]" \
    "  recover <task-id>" \
    "  list" \
    "  status <task-id>" \
    "  start <task-id>" \
    "  enable-tool-worker <task-id>  (stopped TaskSpace only; preserves credentials/history)" \
    "  stop <task-id>" \
    "  access <task-id>" \
    "  close <task-id>" \
    "" \
    "TaskSpaces are preserved on stop/close. This command has no destructive delete operation."
}

slug="${1:-}"
action="${2:-}"
[[ -n "${slug}" && -n "${action}" ]] || { usage >&2; exit 2; }
shift 2
validate_slug "${slug}"

project_root="${DELIVERY_ROOT}/projects/${slug}"
project_env="${project_root}/ops/project.env"
integration_workspace="${project_root}/workspace"
taskspaces_root="${project_root}/taskspaces"
taskspace_compose="${REPO_ROOT}/templates/taskspace/compose.yaml"
taskspace_legacy_compose="${REPO_ROOT}/templates/taskspace/compose.legacy-v1.yaml"
registry_file="${DELIVERY_ROOT}/registry/projects.tsv"
taskspace_registry_file="${DELIVERY_ROOT}/registry/taskspace-ports.tsv"
[[ -d "${project_root}" && -f "${project_env}" && -d "${integration_workspace}/.git" ]] \
  || die "Project is missing or incomplete: ${project_root}"
[[ -f "${taskspace_compose}" ]] || die "TaskSpace Compose template is unavailable."
[[ -f "${taskspace_legacy_compose}" ]] || die "Legacy TaskSpace Compose template is unavailable."
[[ -f "${taskspace_registry_file}" ]] \
  || die "TaskSpace port registry is unavailable; run the reviewed platform upgrade first."

for command_name in dd docker flock git jq ln openssl readlink sha256sum stat; do
  require_command "${command_name}"
done
if [[ "${TASKSPACE_SKIP_SOCKET_SCAN:-false}" != true ]]; then
  require_command ss
fi

# This is the exact non-mutating dependency path used by Manager health checks.
# It intentionally returns before lock acquisition or any lifecycle change.
if [[ "${action}" == preflight ]]; then
  (($# == 0)) || { usage >&2; exit 2; }
  [[ -r "${project_env}" && -r "${taskspace_compose}" && -r "${taskspace_legacy_compose}" && -r "${registry_file}" \
    && -r "${taskspace_registry_file}" ]] \
    || die "TaskSpace control dependencies are not readable by the current operator."
  printf 'TaskSpace control ready: %s\n' "${slug}"
  exit 0
fi

env_value() {
  local key="$1"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${project_env}"
}

taskspace_governance_context_required() {
  local mode
  mode="$(env_value TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED)"
  case "${mode:-false}" in
    true) return 0 ;;
    false) return 1 ;;
    *) die "TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED must be true or false." ;;
  esac
}

project_ftp_input_root() {
  local mode direct_root reviewed_root
  mode="$(env_value PROJECT_MATERIAL_ACCESS_MODE)"
  direct_root="$(env_value PROJECT_UPLOAD_ROOT)"
  reviewed_root="$(env_value PROJECT_SHARED_INPUT_ROOT)"
  case "${mode:-reviewed}" in
    direct)
      [[ -n "${direct_root}" ]] || die "PROJECT_UPLOAD_ROOT is required in direct material mode."
      printf '%s' "${direct_root}"
      ;;
    reviewed)
      [[ -n "${reviewed_root}" ]] || die "PROJECT_SHARED_INPUT_ROOT is required in reviewed material mode."
      printf '%s' "${reviewed_root}"
      ;;
    *) die "Unsupported PROJECT_MATERIAL_ACCESS_MODE: ${mode}" ;;
  esac
}

validate_task_id() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,47}$ ]] || die "Task id is invalid: $1"
}

validate_actor_id() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{1,63}$ ]] || die "Actor id is invalid: $1"
}

validate_actor_user_id() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || die "Actor user id is invalid."
}

validate_conversation_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$ ]] || die "Conversation id is invalid."
}

task_root_of() {
  printf '%s/%s' "${taskspaces_root}" "$1"
}

task_env_of() {
  printf '%s/task.env' "$(task_root_of "$1")"
}

# The root CLI synchronizer publishes a project-owned short-access-token seed.
# Manager never reads the host CLI login, refresh token or root-only config.
prepare_taskspace_codex_credentials() {
  local task_id="$1" config="${project_root}/ops/codex-cli.env"
  [[ -e "${config}" || -L "${config}" ]] || return 0
  require_command node
  node - "${project_root}" "$(task_root_of "${task_id}")" \
    "$(env_value HOST_UID)" "$(env_value HOST_GID)" <<'NODE_CODEX_SEED'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const [project, task, uidText, gidText] = process.argv.slice(2);
  const uid = Number(uidText), gid = Number(gidText);
  const check = (value) => { if (!value) throw new Error('invalid'); };
  check(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0);
  check(fs.realpathSync(project) === project && fs.realpathSync(task) === task
    && path.dirname(task) === path.join(project, 'taskspaces'));
  const readPrivate = (name) => {
    const info = fs.lstatSync(name);
    check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1
      && info.uid === uid && info.gid === gid && (info.mode & 0o777) === 0o600
      && info.size > 0 && info.size <= 1024 * 1024);
    return fs.readFileSync(name, 'utf8');
  };
  const configuration = readPrivate(path.join(project, 'ops/codex-cli.env'));
  const entries = configuration.trim().split('\n').map((line) => {
    const split = line.indexOf('='); check(split > 0 && !/[\r\0]/u.test(line));
    return [line.slice(0, split), line.slice(split + 1)];
  });
  check([2, 3].includes(entries.length) && new Set(entries.map(([key]) => key)).size === entries.length
    && entries.every(([key]) => ['TASKSPACE_CODEX_CLI_ENABLED', 'TASKSPACE_DEFAULT_HTTPS_PROXY', 'TASKSPACE_CODEX_NEW_ONLY'].includes(key)));
  const config = Object.fromEntries(entries);
  check(['true', 'false'].includes(config.TASKSPACE_CODEX_CLI_ENABLED)
    && typeof config.TASKSPACE_DEFAULT_HTTPS_PROXY === 'string'
    && (config.TASKSPACE_CODEX_NEW_ONLY === undefined || ['true', 'false'].includes(config.TASKSPACE_CODEX_NEW_ONLY)));
  const eligible = config.TASKSPACE_CODEX_NEW_ONLY !== 'true'
    || /^TASKSPACE_CODEX_CLI_MANAGED=true$/mu.test(readPrivate(path.join(task, 'task.env')));
  if (config.TASKSPACE_CODEX_CLI_ENABLED === 'true' && eligible) {
    const proxy = config.TASKSPACE_DEFAULT_HTTPS_PROXY;
    const parsed = new URL(proxy);
    check(parsed.protocol === 'http:' && parsed.hostname && parsed.port
      && parsed.username && parsed.password && !parsed.search && !parsed.hash
      && parsed.pathname === '/' && !/[\s$\0]/u.test(proxy));
    const seedDirectory = path.join(project, 'ops/codex-cli');
    let seed = '';
    try {
      const seedInfo = fs.lstatSync(seedDirectory);
      check(seedInfo.isDirectory() && !seedInfo.isSymbolicLink()
        && seedInfo.uid === uid && seedInfo.gid === gid && (seedInfo.mode & 0o777) === 0o700);
      seed = readPrivate(path.join(seedDirectory, 'credentials.yaml'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const jwtPattern = '[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+';
    const blockSeedPattern = new RegExp('^version: 1\\nrefs:\\n  FORGE_CODEX_CLI_ACCESS_TOKEN: (' + jwtPattern + ')\\n?$');
    const nativeFlowSeedPattern = new RegExp('^version: 1\\nrefs:\\n  \\{\\n    FORGE_CODEX_CLI_ACCESS_TOKEN: (' + jwtPattern + ')\\n  \\}\\n?$');
    const seedMatch = blockSeedPattern.exec(seed) ?? nativeFlowSeedPattern.exec(seed);
    check(seed === '' || seedMatch || /^version: 1\n(?:refs: \{\}\n?)?$/u.test(seed));
    const currentAccount = (token) => {
      try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        return Number.isFinite(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) + 60
          && typeof account === 'string' && account.length > 0 ? account : null;
      } catch { return null; }
    };
    const seedAccount = seedMatch ? currentAccount(seedMatch[1]) : null;
    const home = path.join(task, 'dsh-home');
    const homeInfo = fs.lstatSync(home);
    check(homeInfo.isDirectory() && !homeInfo.isSymbolicLink() && fs.realpathSync(home) === home
      && homeInfo.uid === uid && homeInfo.gid === gid && (homeInfo.mode & 0o777) === 0o700);
    const credentials = path.join(home, '.credentials.yaml');
    let createCredentials = false, authorizationReady = false;
    try {
      const existing = readPrivate(credentials);
      // Existing files may contain other providers. Validate only the required
      // native ref and leave the entire file to the native synchronizer.
      const refs = /^refs:\n((?:[ \t]+[^\n]*\n?)*)/mu.exec(existing)?.[1] ?? '';
      const singleRefMatch = blockSeedPattern.exec(existing) ?? nativeFlowSeedPattern.exec(existing);
      const matches = singleRefMatch ? [singleRefMatch]
        : [...refs.matchAll(new RegExp('^  FORGE_CODEX_CLI_ACCESS_TOKEN: (' + jwtPattern + ')$', 'gm'))];
      authorizationReady = Boolean(seedAccount && matches.length === 1
        && currentAccount(matches[0][1]) === seedAccount);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      createCredentials = Boolean(seedAccount);
      authorizationReady = createCredentials;
    }
    if (!authorizationReady) process.stderr.write('Codex CLI authorization is currently unavailable; other configured models remain available.\n');
    const envPath = path.join(task, 'task.env');
    const before = readPrivate(envPath);
    check(!/[\r\0]/u.test(before));
    let after = before;
    for (const [key, value] of [['TASKSPACE_HTTPS_PROXY', proxy], ['TASKSPACE_NO_PROXY', '']]) {
      const pattern = new RegExp('^' + key + '=(.*)$', 'gm');
      const matches = [...after.matchAll(pattern)];
      check(matches.length <= 1 && (!matches.length || matches[0][1] === '' || matches[0][1] === value));
      after = matches.length ? after.replace(pattern, () => key + '=' + value)
        : after.replace(/\n?$/u, '\n') + key + '=' + value + '\n';
    }
    if (createCredentials) {
      const descriptor = fs.openSync(credentials, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, seed); fs.fsyncSync(descriptor);
        if (process.getuid() === 0) fs.fchownSync(descriptor, uid, gid);
      } finally { fs.closeSync(descriptor); }
    }
    if (after !== before) {
      const temporary = path.join(task, '.codex-task-env-' + crypto.randomBytes(8).toString('hex'));
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, after); fs.fsyncSync(descriptor);
        if (process.getuid() === 0) fs.fchownSync(descriptor, uid, gid);
      } finally { fs.closeSync(descriptor); }
      try {
        check(readPrivate(envPath) === before);
        fs.renameSync(temporary, envPath);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
  }
} catch {
  process.stderr.write('Codex CLI project seed or TaskSpace configuration has an unsafe structure or ownership.\n');
  process.exitCode = 1;
}
NODE_CODEX_SEED
}

task_metadata_of() {
  printf '%s/metadata.json' "$(task_root_of "$1")"
}

taskspace_control_file_path() {
  local task_root="$1" name="$2" label="$3" path task_real path_real links size
  taskspace_root_is_contained "${task_root}" "${label}" || return 1
  path="${task_root}/${name}"
  [[ -f "${path}" && ! -L "${path}" ]] \
    || { printf 'TaskSpace control file is missing or unsafe (%s/%s).\n' "${label}" "${name}" >&2; return 1; }
  task_real="$(readlink -f -- "${task_root}")" || return 1
  path_real="$(readlink -f -- "${path}")" || return 1
  links="$(stat -c '%h' -- "${path}")" || return 1
  size="$(stat -c '%s' -- "${path}")" || return 1
  [[ "${path_real}" == "${task_real}/${name}" \
    && "${links}" == 1 \
    && "${size}" =~ ^[0-9]+$ && "${size}" -gt 0 && "${size}" -le 65536 ]] \
    || { printf 'TaskSpace control file is not bounded to its TaskSpace (%s/%s).\n' \
      "${label}" "${name}" >&2; return 1; }
  printf '%s\n' "${path}"
}

task_env_exact_value() {
  local task_env="$1" key="$2"
  awk -F= -v name="${key}" '
    $1 == name { sub(/^[^=]*=/, ""); value=$0; count++ }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "${task_env}"
}

# Runtime selection is resolved only from the operator-owned project catalog.
# The resulting snapshot belongs to this TaskSpace, not to the moving default.
runtime_environment_value() {
  local key="$1" selected
  if [[ "${runtime_version_json:-null}" != null ]]; then
    selected="$(jq -r --arg key "${key}" '.environment[$key] // empty' <<<"${runtime_version_json}")" || return 1
    if [[ -n "${selected}" ]]; then printf '%s' "${selected}"; return 0; fi
  fi
  env_value "${key}"
}

taskspace_skill_bundle_root() {
  local task_id="$1"
  if jq -e '.runtimeVersion != null' "$(task_metadata_of "${task_id}")" >/dev/null; then
    task_env_exact_value "$(task_env_of "${task_id}")" FORGE_SKILL_BUNDLE_ROOT
  else
    env_value FORGE_SKILL_BUNDLE_ROOT
  fi
}

validate_taskspace_skill_bundle_root() {
  local task_id="$1" snapshot expected
  snapshot="$(jq -c '.runtimeVersion // null' "$(task_metadata_of "${task_id}")")" || return 1
  if [[ "${snapshot}" == null ]]; then
    validate_external_skill_bundle_root "$(taskspace_skill_bundle_root "${task_id}")"
  else
    expected="$(jq -er '.skillBundleSha256 | strings' <<<"${snapshot}")" \
      || die "TaskSpace runtime Skill bundle digest is missing."
    validate_external_skill_bundle_root "$(taskspace_skill_bundle_root "${task_id}")" "${expected}"
  fi
}

taskspace_runtime_compose_environment() {
  local task_id="$1" snapshot assignments key expected actual broker_host
  snapshot="$(jq -c '.runtimeVersion // null' "$(task_metadata_of "${task_id}")")" || return 1
  if [[ "${snapshot}" == null ]]; then
    printf 'FORGE_SKILL_BUNDLE_ROOT=%s\n' "$(env_value FORGE_SKILL_BUNDLE_ROOT)"
    return 0
  fi
  validate_taskspace_skill_bundle_root "${task_id}" || return 1
  assignments="$(jq -r '
    {HARNESS_IMAGE: .harnessImage, FORGE_SKILL_BUNDLE_ROOT: .skillBundleRoot,
      FORGE_TASKSPACE_BROKER_URL: .brokerUrl} + .environment
    | to_entries[] | "\(.key)=\(.value)"' <<<"${snapshot}")" || return 1
  while IFS='=' read -r key expected; do
    case "${key}" in
      HARNESS_IMAGE|FORGE_SKILL_BUNDLE_ROOT|FORGE_TASKSPACE_BROKER_URL|FORGE_DEVELOPMENT_MODE|FORGE_SEMANTIC_INTENT_ENABLED|FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED|FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED|FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED|FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED|FORGE_CHANGED_VERIFICATION_SUPPORTED|FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED|FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED) ;;
      *) printf 'TaskSpace runtime environment key is unsupported: %s\n' "${key}" >&2; return 1 ;;
    esac
    actual="$(task_env_exact_value "$(task_env_of "${task_id}")" "${key}")" || return 1
    [[ "${actual}" == "${expected}" ]] \
      || { printf 'TaskSpace runtime binding differs at %s.\n' "${key}" >&2; return 1; }
    printf '%s=%s\n' "${key}" "${actual}"
  done <<<"${assignments}"
  # Even an optional catalog field keeps the value captured at creation. An
  # inherited Manager environment must not replace that per-TaskSpace setting.
  for key in FORGE_DEVELOPMENT_MODE FORGE_SEMANTIC_INTENT_ENABLED \
    FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED \
    FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED \
    FORGE_CHANGED_VERIFICATION_SUPPORTED FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED \
    FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED; do
    actual="$(task_env_exact_value "$(task_env_of "${task_id}")" "${key}")" || return 1
    printf '%s=%s\n' "${key}" "${actual}"
  done
  broker_host="$(jq -r '.brokerUrl' <<<"${snapshot}")"
  broker_host="${broker_host#http://}"
  printf 'TASKSPACE_RUNTIME_BROKER_HOST=%s\n' "${broker_host%:3100}"
}

assert_taskspace_broker_healthy() {
  local broker_url="${1:-http://taskspace-broker:3100}" service container
  case "${broker_url}" in
    http://taskspace-broker:3100|http://taskspace-broker-stable:3100|http://taskspace-broker-enhanced:3100) ;;
    *) [[ "${broker_url}" =~ ^http://taskspace-broker-(stable|enhanced)-r[1-9][0-9]{0,5}:3100$ ]] \
      || die "TaskSpace runtime Broker URL is invalid." ;;
  esac
  service="${broker_url#http://}"
  service="${service%:3100}"
  if [[ "${service}" == taskspace-broker ]]; then
    container="$(docker compose --env-file "${project_env}" --file "${project_root}/ops/compose.yaml" ps --quiet taskspace-broker)"
  else
    container="$(docker ps --quiet --filter "label=com.docker.compose.project=forge-${slug}" \
      --filter "label=com.docker.compose.service=${service}")"
  fi
  [[ -n "${container}" && "${container}" != *$'\n'* \
    && "$(docker inspect --format '{{.State.Health.Status}}' "${container}" 2>/dev/null)" == healthy ]] \
    || die "Selected TaskSpace Broker is not healthy: ${service}"
}

assert_taskspace_control_identity() {
  local task_id="$1" task_root label metadata task_env key expected actual
  task_root="$(task_root_of "${task_id}")"
  label="${slug}/${task_id}"
  metadata="$(taskspace_control_file_path "${task_root}" metadata.json "${label}")" \
    || return 1
  task_env="$(taskspace_control_file_path "${task_root}" task.env "${label}")" \
    || return 1
  jq -e --arg project_slug "${slug}" --arg task_id "${task_id}" \
    '.projectSlug == $project_slug and .taskId == $task_id' "${metadata}" >/dev/null \
    || { printf 'TaskSpace metadata identity does not match the recovery target.\n' >&2; return 1; }

  while IFS=$'\t' read -r key expected; do
    actual="$(task_env_exact_value "${task_env}" "${key}")" \
      || { printf 'TaskSpace recovery environment must contain exactly one %s.\n' "${key}" >&2; return 1; }
    [[ "${actual}" == "${expected}" ]] \
      || { printf 'TaskSpace recovery environment identity differs at %s.\n' "${key}" >&2; return 1; }
  done <<EOF
TASKSPACE_COMPOSE_PROJECT_NAME	forge-${slug}-task-${task_id}
PROJECT_COMPOSE_NAME	forge-${slug}
TASKSPACE_ROOT	${task_root}
PROJECT_SLUG	${slug}
TASKSPACE_ID	${task_id}
EOF
}

ipv4_cidr_range() {
  local cidr="$1"
  awk -v cidr="${cidr}" '
    BEGIN {
      if (split(cidr, parts, "/") != 2 || parts[2] !~ /^[0-9]+$/) exit 1
      prefix = parts[2] + 0
      if (prefix < 0 || prefix > 32 || split(parts[1], octets, ".") != 4) exit 1
      value = 0
      for (octet_index = 1; octet_index <= 4; octet_index++) {
        if (octets[octet_index] !~ /^(0|[1-9][0-9]?[0-9]?)$/ \
            || octets[octet_index] + 0 > 255) exit 1
        value = value * 256 + octets[octet_index]
      }
      block = 2 ^ (32 - prefix)
      first = int(value / block) * block
      last = first + block - 1
      printf "%.0f\t%.0f\n", first, last
    }
  '
}

taskspace_upload_network_name() {
  local task_id="$1" task_env compose_project
  task_env="$(taskspace_control_file_path "$(task_root_of "${task_id}")" task.env \
    "${slug}/${task_id}")" || return 1
  compose_project="$(task_env_exact_value "${task_env}" TASKSPACE_COMPOSE_PROJECT_NAME)" \
    || return 1
  printf '%s_uploads\n' "${compose_project}"
}

assert_taskspace_subnet_available() {
  local port="$1" allowed_network_name="${2:-}" candidate_subnet candidate_range
  local candidate_first candidate_last network_ids network_id record network_name cidr_text cidr range first last
  local -a cidrs
  candidate_subnet="$(taskspace_network_subnet_for_port "${port}")" || return 1
  candidate_range="$(ipv4_cidr_range "${candidate_subnet}")" || return 1
  IFS=$'\t' read -r candidate_first candidate_last <<<"${candidate_range}"
  network_ids="$(docker network ls --quiet --no-trunc 2>&1)" \
    || { printf 'Docker network inventory failed closed during TaskSpace subnet admission.\n' >&2; return 1; }
  while IFS= read -r network_id; do
    [[ -n "${network_id}" ]] || continue
    [[ "${network_id}" =~ ^[0-9a-f]{12,64}$ ]] \
      || { printf 'Docker network inventory returned an invalid identity.\n' >&2; return 1; }
    record="$(docker network inspect --format \
      '{{.Name}}|{{range .IPAM.Config}}{{.Subnet}},{{end}}' "${network_id}" 2>&1)" \
      || { printf 'Docker network changed during TaskSpace subnet admission.\n' >&2; return 1; }
    [[ "${record}" == *'|'* ]] \
      || { printf 'Docker network IPAM inventory is malformed.\n' >&2; return 1; }
    network_name="${record%%|*}"
    cidr_text="${record#*|}"
    [[ "${network_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
      || { printf 'Docker network inventory returned an invalid name.\n' >&2; return 1; }
    IFS=',' read -r -a cidrs <<<"${cidr_text}"
    for cidr in "${cidrs[@]}"; do
      [[ -n "${cidr}" ]] || continue
      [[ "${cidr}" != *:* ]] || continue
      range="$(ipv4_cidr_range "${cidr}")" \
        || { printf 'Docker network inventory contains an invalid IPv4 CIDR.\n' >&2; return 1; }
      IFS=$'\t' read -r first last <<<"${range}"
      if ((candidate_first <= last && first <= candidate_last)); then
        if [[ -n "${allowed_network_name}" \
            && "${network_name}" == "${allowed_network_name}" \
            && "${cidr}" == "${candidate_subnet}" ]]; then
          continue
        fi
        printf 'TaskSpace subnet %s overlaps existing Docker network %s (%s).\n' \
          "${candidate_subnet}" "${network_name}" "${cidr}" >&2
        return 1
      fi
    done
  done <<<"${network_ids}"
}

assert_taskspace_upload_network_contract() {
  local task_id="$1" port="$2" allow_absent="$3" task_env compose_project network_name
  local expected_subnet expected_contract actual_contract
  task_env="$(taskspace_control_file_path "$(task_root_of "${task_id}")" task.env \
    "${slug}/${task_id}")" || return 1
  compose_project="$(task_env_exact_value "${task_env}" TASKSPACE_COMPOSE_PROJECT_NAME)" \
    || return 1
  network_name="${compose_project}_uploads"
  expected_subnet="$(taskspace_network_subnet_for_port "${port}")" || return 1
  expected_contract="${compose_project}|uploads|bridge|true|${expected_subnet},"

  if actual_contract="$(docker network inspect --format \
      '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}|{{.Driver}}|{{.Internal}}|{{range .IPAM.Config}}{{.Subnet}},{{end}}' \
      "${network_name}" 2>&1)"; then
    [[ "${actual_contract}" == "${expected_contract}" ]] \
      || { printf 'Existing TaskSpace uploads network differs from its deterministic contract (%s).\n' \
        "${network_name}" >&2; return 1; }
    return 0
  fi
  # Docker CLI releases may prefix the canonical not-found diagnostic with a
  # blank line. Accept surrounding whitespace only; every other inspect error
  # still fails closed.
  if [[ "${actual_contract}" =~ ^[[:space:]]*Error[[:space:]]+response[[:space:]]+from[[:space:]]+daemon:[[:space:]]+network[[:space:]]+${network_name}[[:space:]]+not[[:space:]]+found[[:space:]]*$ ]]; then
    [[ "${allow_absent}" == true ]] \
      || { printf 'TaskSpace uploads network was not realized after provisioning (%s).\n' \
        "${network_name}" >&2; return 1; }
    return 0
  fi
  printf 'TaskSpace uploads network state inspection failed closed: %s\n' "${network_name}" >&2
  return 1
}

assert_taskspace_recovery_network_compatible() {
  assert_taskspace_upload_network_contract "$1" "$2" true
}

assert_taskspace_upload_network_realized() {
  assert_taskspace_upload_network_contract "$1" "$2" false
}

task_env_value() {
  local task_id="$1" key="$2"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "$(task_env_of "${task_id}")"
}

taskspace_schema_version_of() {
  local task_id="$1" schema_version
  schema_version="$(jq -er '.schemaVersion | select(. == 1 or . == 2)' \
    "$(task_metadata_of "${task_id}")")" \
    || die "TaskSpace metadata has no supported lifecycle schema: ${task_id}"
  printf '%s\n' "${schema_version}"
}

taskspace_uses_current_compose() {
  [[ "$(taskspace_schema_version_of "$1")" == 2 ]]
}

taskspace_compose_of() {
  local task_id="$1" schema_version
  schema_version="$(taskspace_schema_version_of "${task_id}")"
  case "${schema_version}" in
    1) printf '%s\n' "${taskspace_legacy_compose}" ;;
    2) printf '%s\n' "${taskspace_compose}" ;;
  esac
}

task_compose() {
  local task_id="$1" task_root compose_file runtime_assignments
  local -a network_compose_args runtime_compose_env
  shift
  task_root="$(task_root_of "${task_id}")"
  compose_file="$(taskspace_compose_of "${task_id}")"
  taskspace_network_compose_args "${task_root}" "${slug}/${task_id}" network_compose_args \
    || die "TaskSpace network Compose contract validation failed: ${task_id}"
  runtime_assignments="$(taskspace_runtime_compose_environment "${task_id}")" \
    || die "TaskSpace runtime binding is inconsistent: ${task_id}"
  mapfile -t runtime_compose_env <<<"${runtime_assignments}"
  local -x "${runtime_compose_env[@]}"
  docker compose --env-file "$(task_env_of "${task_id}")" \
      --file "${compose_file}" "${network_compose_args[@]}" "$@"
}

active_legacy_taskspace_runtime_is_healthy() {
  local task_id="$1" harness_container upload_container
  harness_container="$(task_compose "${task_id}" ps --quiet harness 2>/dev/null)" || return 1
  upload_container="$(task_compose "${task_id}" ps --quiet harness-upload 2>/dev/null)" || return 1
  [[ "${harness_container}" =~ ^[0-9a-f]{12,64}$ \
    && "${upload_container}" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "${harness_container}" 2>/dev/null)" == true \
    && "$(docker inspect --format '{{.State.Running}}' "${upload_container}" 2>/dev/null)" == true \
    && "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "${upload_container}" 2>/dev/null)" == healthy ]]
}

validate_external_skill_bundle_root() {
  local root current_real versions_real skills_real expected
  root="${1:-$(env_value FORGE_SKILL_BUNDLE_ROOT)}"
  [[ "${root}" == /* && -d "${root}" && ! -L "${root}" ]] \
    || die "External Skill bundle root is missing or unsafe: ${root:-unset}"
  [[ -d "${root}/versions" && ! -L "${root}/versions" && -L "${root}/current" ]] \
    || die "External Skill bundle versions/current layout is incomplete."
  current_real="$(readlink -f -- "${root}/current")" || die "External Skill current pointer is invalid."
  versions_real="$(readlink -f -- "${root}/versions")" || die "External Skill versions root is invalid."
  case "${current_real}" in
    "${versions_real}"/*) ;;
    *) die "External Skill current pointer escaped the immutable versions root." ;;
  esac
  [[ -r "${current_real}/bundle.manifest.json" && -d "${current_real}/skills" ]] \
    || die "Active external Skill bundle is unreadable or incomplete."
  skills_real="$(readlink -f -- "${current_real}/skills")" || die "Active external Skill directory is invalid."
  [[ "${skills_real}" == "${current_real}/skills" ]] \
    || die "Active external Skill directory contains an indirect link."
  if [[ "$#" -ge 2 ]]; then
    expected="$2"
    [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || die "TaskSpace runtime Skill bundle digest is invalid."
    require_command node
    # Runtime bindings pin the validated payload tree, not the manifest bytes.
    if ! node --input-type=module - "${REPO_ROOT}/scripts/forge-skill-bundle.mjs" "${current_real}" "${expected}" <<'SKILL_DIGEST_NODE'
  import { pathToFileURL } from 'node:url';
  try {
    const { validateExternalSkillBundle } = await import(pathToFileURL(process.argv[2]).href);
    const bundle = await validateExternalSkillBundle(process.argv[3]);
    if (bundle.treeSha256 !== process.argv[4]) throw new Error('TaskSpace runtime Skill bundle digest differs from its binding.');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
SKILL_DIGEST_NODE
    then
      die "TaskSpace runtime Skill bundle validation failed."
    fi
  fi
}

taskspace_git_exclude_path() {
  local task_root="$1" label="${2:-TaskSpace}"
  local workspace="${task_root}/workspace" git_dir info_dir exclude_file
  local task_root_real workspace_real git_real info_real exclude_real
  git_dir="${workspace}/.git"
  info_dir="${git_dir}/info"
  exclude_file="${info_dir}/exclude"

  [[ -d "${task_root}" && ! -L "${task_root}" ]] \
    || { printf 'Unsafe TaskSpace root for Git exclude (%s): %s\n' "${label}" "${task_root}" >&2; return 1; }
  [[ -d "${workspace}" && ! -L "${workspace}" ]] \
    || { printf 'TaskSpace workspace must be a real directory, not a symbolic link (%s).\n' "${label}" >&2; return 1; }
  [[ -d "${git_dir}" && ! -L "${git_dir}" ]] \
    || { printf 'TaskSpace .git must be a real directory; gitfile worktrees are unsupported (%s).\n' "${label}" >&2; return 1; }
  [[ -d "${info_dir}" && ! -L "${info_dir}" ]] \
    || { printf 'TaskSpace .git/info must be a real directory, not a symbolic link (%s).\n' "${label}" >&2; return 1; }
  [[ ! -L "${exclude_file}" && ( ! -e "${exclude_file}" || -f "${exclude_file}" ) ]] \
    || { printf 'TaskSpace Git exclude must be absent or a regular non-symbolic-link file (%s).\n' "${label}" >&2; return 1; }

  task_root_real="$(readlink -f -- "${task_root}")" || return 1
  workspace_real="$(readlink -f -- "${workspace}")" || return 1
  git_real="$(readlink -f -- "${git_dir}")" || return 1
  info_real="$(readlink -f -- "${info_dir}")" || return 1
  if [[ -e "${exclude_file}" ]]; then
    exclude_real="$(readlink -f -- "${exclude_file}")" || return 1
  else
    exclude_real="${info_real}/exclude"
  fi
  [[ "${workspace_real}" == "${task_root_real}/workspace" \
    && "${git_real}" == "${workspace_real}/.git" \
    && "${info_real}" == "${workspace_real}/.git/info" \
    && "${exclude_real}" == "${workspace_real}/.git/info/exclude" ]] \
    || { printf 'TaskSpace Git exclude resolved outside its workspace boundary (%s).\n' "${label}" >&2; return 1; }

  printf '%s\n' "${exclude_file}"
}

ensure_taskspace_git_exclude_contract() {
  local task_root="$1" label="${2:-TaskSpace}" exclude_file line
  exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
  if [[ ! -e "${exclude_file}" ]]; then
    exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
    if ! (umask 0077; dd if=/dev/null of="${exclude_file}" \
        conv=excl oflag=nofollow status=none) 2>/dev/null; then
      exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
      [[ -f "${exclude_file}" ]] || return 1
    fi
  fi
  exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
  [[ -f "${exclude_file}" ]] || return 1
  # PROJECT_CONTEXT.md is only an inert nested-bind mountpoint in the clone;
  # the admitted content lives under the platform-owned governance root.
  for line in '/.forge-cache/' '/.forge-delivery/' '/PROJECT_CONTEXT.md'; do
    exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
    if ! dd if="${exclude_file}" iflag=nofollow status=none \
        | grep -Fx -- "${line}" >/dev/null; then
      exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
      printf '%s\n' "${line}" \
        | dd of="${exclude_file}" oflag=append,nofollow conv=notrunc,nocreat status=none \
        || return 1
      exclude_file="$(taskspace_git_exclude_path "${task_root}" "${label}")" || return 1
      dd if="${exclude_file}" iflag=nofollow status=none \
        | grep -Fx -- "${line}" >/dev/null \
        || return 1
    fi
  done
  printf '%s\n' "${exclude_file}"
}

taskspace_root_is_contained() {
  local task_root="$1" label="${2:-TaskSpace}"
  local taskspaces_root_real task_root_real

  [[ -d "${taskspaces_root}" && ! -L "${taskspaces_root}" ]] \
    || { printf 'TaskSpace root directory is unsafe (%s): %s\n' "${label}" "${taskspaces_root}" >&2; return 1; }
  [[ -d "${task_root}" && ! -L "${task_root}" ]] \
    || { printf 'TaskSpace directory is unsafe (%s): %s\n' "${label}" "${task_root}" >&2; return 1; }
  taskspaces_root_real="$(readlink -f -- "${taskspaces_root}")" || return 1
  task_root_real="$(readlink -f -- "${task_root}")" || return 1
  case "${task_root_real}" in
    "${taskspaces_root_real}"/*) ;;
    *)
      printf 'TaskSpace resolved outside the registered task root (%s): %s\n' \
        "${label}" "${task_root_real}" >&2
      return 1
      ;;
  esac
}

governance_file_sha256() {
  local path="$1"
  dd if="${path}" iflag=nofollow status=none | sha256sum | awk '{print $1}'
}

migrate_legacy_project_governance_context() {
  local label="${1:-project}" governance_root source hash_file legacy temporary exclude_file
  local project_real integration_real governance_real exclude_real source_hash copied_hash
  local host_uid legacy_metadata legacy_tracked=false
  governance_root="${project_root}/governance"
  source="${governance_root}/PROJECT_CONTEXT.md"
  hash_file="${governance_root}/PROJECT_CONTEXT.sha256"
  legacy="${integration_workspace}/PROJECT_CONTEXT.md"

  [[ -d "${project_root}" && ! -L "${project_root}" \
    && -d "${integration_workspace}" && ! -L "${integration_workspace}" \
    && ! -L "${governance_root}" \
    && ! -e "${source}" && ! -L "${source}" \
    && ! -e "${hash_file}" && ! -L "${hash_file}" ]] \
    || return 1
  [[ -f "${legacy}" && ! -L "${legacy}" ]] \
    || { printf 'Legacy project governance context is unavailable (%s).\n' "${label}" >&2; return 1; }
  host_uid="$(env_value HOST_UID)"
  legacy_metadata="$(stat -Lc '%u:%a:%h' -- "${legacy}" 2>/dev/null || true)"
  [[ "${host_uid}" =~ ^[1-9][0-9]*$ \
    && ( "${legacy_metadata}" == "${host_uid}:644:1" \
      || "${legacy_metadata}" == "${host_uid}:600:1" ) ]] \
    || { printf 'Legacy project governance context metadata is unsafe (%s).\n' \
      "${label}" >&2; return 1; }
  if project_git_readonly "${integration_workspace}" ls-files --error-unmatch -- PROJECT_CONTEXT.md >/dev/null 2>&1; then
    legacy_tracked=true
    project_git_readonly "${integration_workspace}" diff --quiet HEAD -- PROJECT_CONTEXT.md \
      || { printf 'Tracked legacy PROJECT_CONTEXT.md is not clean at HEAD (%s).\n' \
        "${label}" >&2; return 1; }
  fi
  project_real="$(readlink -f -- "${project_root}")" || return 1
  integration_real="$(readlink -f -- "${integration_workspace}")" || return 1
  [[ "${integration_real}" == "${project_real}/workspace" ]] || return 1
  exclude_file="${integration_workspace}/.git/info/exclude"
  [[ -d "${integration_workspace}/.git" && ! -L "${integration_workspace}/.git" \
    && -d "${integration_workspace}/.git/info" && ! -L "${integration_workspace}/.git/info" \
    && -f "${exclude_file}" && ! -L "${exclude_file}" ]] || return 1
  exclude_real="$(readlink -f -- "${exclude_file}")" || return 1
  [[ "${exclude_real}" == "${integration_real}/.git/info/exclude" ]] || return 1
  if [[ "${legacy_tracked}" != true ]]; then
    dd if="${exclude_file}" iflag=nofollow status=none \
      | grep -Fx -- '/PROJECT_CONTEXT.md' >/dev/null \
      || { printf 'Untracked legacy project governance context lacks its private exclude identity (%s).\n' \
        "${label}" >&2; return 1; }
  fi
  [[ ! -e "${governance_root}" || -d "${governance_root}" ]] || return 1
  if [[ ! -e "${governance_root}" ]]; then
    mkdir -m 0750 -- "${governance_root}" || return 1
  fi
  governance_real="$(readlink -f -- "${governance_root}")" || return 1
  [[ "${governance_real}" == "${project_real}/governance" ]] || return 1
  chmod 0750 "${governance_root}" || return 1
  if [[ "${EUID}" -eq 0 ]]; then
    chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${governance_root}" || return 1
  fi

  source_hash="$(governance_file_sha256 "${legacy}")" || return 1
  temporary="$(mktemp "${governance_root}/.PROJECT_CONTEXT.XXXXXX")" || return 1
  [[ -f "${temporary}" && ! -L "${temporary}" ]] \
    || { rm -f -- "${temporary}" 2>/dev/null || true; return 1; }
  if ! dd if="${legacy}" iflag=nofollow of="${temporary}" oflag=nofollow \
      conv=fsync status=none \
    || ! chmod 0444 "${temporary}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  if [[ "${EUID}" -eq 0 ]] \
      && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
  copied_hash="$(governance_file_sha256 "${temporary}")" \
    || { rm -f -- "${temporary}" 2>/dev/null || true; return 1; }
  [[ "${copied_hash}" == "${source_hash}" \
    && "$(governance_file_sha256 "${legacy}")" == "${source_hash}" ]] \
    || { rm -f -- "${temporary}" 2>/dev/null || true; return 1; }
  mv -- "${temporary}" "${source}" \
    || { rm -f -- "${temporary}" 2>/dev/null || true; return 1; }

  temporary="$(mktemp "${governance_root}/.PROJECT_CONTEXT.sha256.XXXXXX")" || {
    rm -f -- "${source}" 2>/dev/null || true
    return 1
  }
  [[ -f "${temporary}" && ! -L "${temporary}" ]] \
    || { rm -f -- "${temporary}" "${source}" 2>/dev/null || true; return 1; }
  if ! printf '%s\n' "${source_hash}" \
      | dd of="${temporary}" oflag=nofollow conv=fsync status=none \
    || ! chmod 0444 "${temporary}"; then
    rm -f -- "${temporary}" "${source}" 2>/dev/null || true
    return 1
  fi
  if [[ "${EUID}" -eq 0 ]] \
      && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
    rm -f -- "${temporary}" "${source}" 2>/dev/null || true
    return 1
  fi
  if ! mv -- "${temporary}" "${hash_file}"; then
    rm -f -- "${temporary}" "${source}" 2>/dev/null || true
    return 1
  fi
}

project_governance_context_path() {
  local label="${1:-project}" governance_root source hash_file
  local project_real governance_real source_real hash_real expected_hash actual_hash

  governance_root="${project_root}/governance"
  source="${governance_root}/PROJECT_CONTEXT.md"
  hash_file="${governance_root}/PROJECT_CONTEXT.sha256"
  if [[ ! -e "${source}" && ! -L "${source}" \
      && ! -e "${hash_file}" && ! -L "${hash_file}" ]]; then
    migrate_legacy_project_governance_context "${label}" || return 1
  fi
  [[ -d "${project_root}" && ! -L "${project_root}" \
    && -d "${governance_root}" && ! -L "${governance_root}" ]] \
    || { printf 'Project governance root is missing or unsafe (%s).\n' "${label}" >&2; return 1; }
  [[ -f "${source}" && ! -L "${source}" \
    && -f "${hash_file}" && ! -L "${hash_file}" ]] \
    || { printf 'Project governance context and hash must be regular non-symbolic-link files (%s).\n' \
      "${label}" >&2; return 1; }

  project_real="$(readlink -f -- "${project_root}")" || return 1
  governance_real="$(readlink -f -- "${governance_root}")" || return 1
  source_real="$(readlink -f -- "${source}")" || return 1
  hash_real="$(readlink -f -- "${hash_file}")" || return 1
  [[ "${governance_real}" == "${project_real}/governance" \
    && "${source_real}" == "${governance_real}/PROJECT_CONTEXT.md" \
    && "${hash_real}" == "${governance_real}/PROJECT_CONTEXT.sha256" ]] \
    || { printf 'Project governance context escaped its platform-controlled root (%s).\n' \
      "${label}" >&2; return 1; }

  expected_hash="$(dd if="${hash_file}" iflag=nofollow status=none)" || return 1
  [[ "${expected_hash}" =~ ^[0-9a-f]{64}$ ]] \
    || { printf 'Project governance hash is invalid (%s).\n' "${label}" >&2; return 1; }
  actual_hash="$(governance_file_sha256 "${source}")" || return 1
  [[ "${actual_hash}" == "${expected_hash}" ]] \
    || { printf 'Project governance context failed hash admission (%s).\n' "${label}" >&2; return 1; }
  if ! dd if="${source}" iflag=nofollow status=none \
      | grep -Fx -- '<!-- forge-delivery-project-context-v1 -->' >/dev/null; then
    [[ -s "${source}" ]] \
      || { printf 'Legacy project governance context is empty (%s).\n' "${label}" >&2; return 1; }
  fi
  printf '%s\n' "${source}"
}

validate_workspace_instruction_path() {
  local workspace="$1" name="$2" label="$3" expected_hash="${4:-}"
  local allow_empty_mountpoint="${5:-false}" target tracked=false
  target="${workspace}/${name}"
  if project_git_readonly "${workspace}" ls-files --error-unmatch -- "${name}" >/dev/null 2>&1; then
    tracked=true
  fi
  if [[ "${tracked}" == true ]]; then
    [[ -f "${target}" && ! -L "${target}" ]] \
      || { printf 'Tracked %s must be a regular non-symbolic-link file (%s).\n' \
        "${name}" "${label}" >&2; return 1; }
  elif [[ -e "${target}" || -L "${target}" ]]; then
    [[ "${name}" == PROJECT_CONTEXT.md && "${expected_hash}" =~ ^[0-9a-f]{64}$ \
      && -f "${target}" && ! -L "${target}" \
      && ( "${allow_empty_mountpoint}" == true && ! -s "${target}" \
        || "$(governance_file_sha256 "${target}")" == "${expected_hash}" ) ]] \
      || { printf 'Untracked %s is ambiguous or drifted and cannot participate in TaskSpace instruction discovery (%s).\n' \
        "${name}" "${label}" >&2; return 1; }
  fi
}

ensure_taskspace_context_mountpoint() {
  local task_workspace="$1" label="$2" expected_hash="$3" target
  target="${task_workspace}/PROJECT_CONTEXT.md"
  if [[ ! -e "${target}" && ! -L "${target}" ]]; then
    if ! (umask 0077; dd if=/dev/null of="${target}" \
        oflag=nofollow conv=excl status=none) 2>/dev/null; then
      [[ -e "${target}" || -L "${target}" ]] || return 1
    fi
    [[ -f "${target}" && ! -L "${target}" ]] || return 1
    chmod 0644 "${target}" || return 1
    if [[ "${EUID}" -eq 0 ]]; then
      chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${target}" || return 1
    fi
  fi
  validate_workspace_instruction_path "${task_workspace}" PROJECT_CONTEXT.md \
    "${label}" "${expected_hash}" true
}

taskspace_maintenance_root_path() {
  local task_root="$1" label="${2:-TaskSpace}" root task_real root_real
  taskspace_root_is_contained "${task_root}" "${label}" || return 1
  root="${task_root}/maintenance"
  [[ -d "${root}" && ! -L "${root}" ]] \
    || { printf 'TaskSpace maintenance root is missing or unsafe (%s).\n' "${label}" >&2; return 1; }
  task_real="$(readlink -f -- "${task_root}")" || return 1
  root_real="$(readlink -f -- "${root}")" || return 1
  [[ "${root_real}" == "${task_real}/maintenance" ]] \
    || { printf 'TaskSpace maintenance root escaped its TaskSpace (%s).\n' "${label}" >&2; return 1; }
  printf '%s\n' "${root}"
}

ensure_taskspace_maintenance_fence() {
  local task_root="$1" label="${2:-TaskSpace}" root fence temporary state
  [[ ! -L "${task_root}/maintenance" \
    && ( ! -e "${task_root}/maintenance" || -d "${task_root}/maintenance" ) ]] \
    || return 1
  if [[ ! -e "${task_root}/maintenance" ]]; then
    mkdir -m 0750 -- "${task_root}/maintenance" || return 1
  fi
  root="$(taskspace_maintenance_root_path "${task_root}" "${label}")" || return 1
  chmod 0750 "${root}" || return 1
  if [[ "${EUID}" -eq 0 ]]; then
    chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${root}" || return 1
  fi
  fence="${root}/proxy-fence.json"
  [[ ! -L "${fence}" && ( ! -e "${fence}" || -f "${fence}" ) ]] \
    || { printf 'TaskSpace maintenance fence is unsafe (%s).\n' "${label}" >&2; return 1; }
  if [[ ! -e "${fence}" ]]; then
    temporary="$(mktemp "${root}/.proxy-fence.XXXXXX")" || return 1
    if ! jq --null-input \
        --arg epoch "lifecycle-$(date -u +%Y%m%dT%H%M%SZ)-$$" \
        '{schemaVersion: 1, state: "committed", epoch: $epoch}' >"${temporary}" \
      || ! chmod 0644 "${temporary}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      return 1
    fi
    if [[ "${EUID}" -eq 0 ]] \
        && ! chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      return 1
    fi
    if ! mv -- "${temporary}" "${fence}"; then
      rm -f -- "${temporary}" 2>/dev/null || true
      return 1
    fi
  fi
  root="$(taskspace_maintenance_root_path "${task_root}" "${label}")" || return 1
  fence="${root}/proxy-fence.json"
  [[ -f "${fence}" && ! -L "${fence}" \
    && "$(readlink -f -- "${fence}")" == "${root}/proxy-fence.json" ]] \
    || return 1
  state="$(dd if="${fence}" iflag=nofollow status=none \
    | jq -er 'if (type == "object"
      and (keys | sort) == ["epoch", "schemaVersion", "state"]
      and .schemaVersion == 1
      and (.epoch | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))
      and .state == "committed") then .state else error("invalid fence") end')" \
    || { printf 'TaskSpace maintenance fence is not safely committed (%s).\n' "${label}" >&2; return 1; }
  [[ "${state}" == committed ]] || return 1
}

ensure_legacy_taskspace_maintenance_baseline() {
  local task_id="$1" task_root schema_version
  task_root="$(task_root_of "${task_id}")"
  schema_version="$(taskspace_schema_version_of "${task_id}")"
  if [[ "${schema_version}" == 1
    && ! -e "${task_root}/maintenance" && ! -L "${task_root}/maintenance" ]]; then
    ensure_taskspace_maintenance_fence "${task_root}" "${slug}/${task_id}" \
      || die "Legacy TaskSpace maintenance fence could not be established before lifecycle mutation."
  fi
}

ensure_taskspace_governance_context() {
  local task_root="$1" label="${2:-TaskSpace}" task_workspace source source_hash

  taskspace_root_is_contained "${task_root}" "${label}" || return 1
  taskspace_git_exclude_path "${task_root}" "${label}" >/dev/null || return 1
  ensure_taskspace_git_exclude_contract "${task_root}" "${label}" >/dev/null || return 1
  source="$(project_governance_context_path "${label}")" || return 1
  [[ "${source}" == "${project_root}/governance/PROJECT_CONTEXT.md" ]] || return 1
  source_hash="$(governance_file_sha256 "${source}")" || return 1
  task_workspace="${task_root}/workspace"
  validate_workspace_instruction_path "${integration_workspace}" PROJECT_CONTEXT.md "${label}/integration" "${source_hash}" \
    || return 1
  ensure_taskspace_context_mountpoint "${task_workspace}" "${label}/workspace" "${source_hash}" \
    || return 1
  validate_workspace_instruction_path "${integration_workspace}" AGENTS.md "${label}/integration" \
    || return 1
  validate_workspace_instruction_path "${task_workspace}" AGENTS.md "${label}/workspace" \
    || return 1
  ensure_taskspace_maintenance_fence "${task_root}" "${label}" || return 1
}

ensure_taskspace_cache_contract() {
  local task_root="$1" workspace exclude_file
  workspace="${task_root}/workspace"
  taskspace_git_exclude_path "${task_root}" "$(basename -- "${task_root}")" >/dev/null \
    || die "TaskSpace Git exclude path is unsafe; cache preparation was blocked."
  install -d -m 0700 -- \
    "${task_root}/cache" \
    "${task_root}/cache/m2" \
    "${task_root}/cache/npm" \
    "${task_root}/cache/pnpm" \
    "${task_root}/cache/pnpm/data" \
    "${task_root}/cache/pnpm/home" \
    "${task_root}/cache/general" \
    "${task_root}/cache/general/jansi" \
    "${task_root}/cache/general/state" \
    "${workspace}/.forge-cache" \
    "${workspace}/.forge-cache/m2" \
    "${workspace}/.forge-cache/npm" \
    "${workspace}/.forge-cache/pnpm" \
    "${workspace}/.forge-cache/general"
  exclude_file="$(ensure_taskspace_git_exclude_contract \
    "${task_root}" "$(basename -- "${task_root}")")" \
    || die "TaskSpace Git exclude contract could not be established."
  if [[ "${EUID}" -eq 0 ]]; then
    chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" \
      "${task_root}/cache" "${workspace}/.forge-cache"
    exclude_file="$(taskspace_git_exclude_path \
      "${task_root}" "$(basename -- "${task_root}")")" \
      || die "TaskSpace Git exclude path changed before ownership repair."
    chown --no-dereference "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${exclude_file}"
    taskspace_git_exclude_path "${task_root}" "$(basename -- "${task_root}")" >/dev/null \
      || die "TaskSpace Git exclude path changed during ownership repair."
  fi
}

atomic_metadata_status() {
  local task_id="$1" status="$2" metadata temporary
  metadata="$(task_metadata_of "${task_id}")"
  temporary="${metadata}.tmp.$$"
  jq --arg status "${status}" --arg updated_at "$(date --iso-8601=seconds)" \
    '.status = $status | .updatedAt = $updated_at' "${metadata}" >"${temporary}"
  chmod 0600 "${temporary}"
  # Backup/restore maintenance invokes this lifecycle as root.  Without an
  # explicit owner, the atomic replacement becomes root:root/0600 and the
  # non-root Conversation Manager can no longer reopen the TaskSpace.
  if [[ "${EUID}" -eq 0 ]]; then
    chown "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${temporary}"
  fi
  mv -- "${temporary}" "${metadata}"
}

port_reserved() {
  local port="$1"
  if awk -F '\t' -v value="${port}" 'NR > 1 && ($3 == value || $4 == value) {found=1} END {exit !found}' "${registry_file}"; then
    return 0
  fi
  if awk -F '\t' -v value="${port}" 'NR > 1 && $3 == value {found=1} END {exit !found}' "${taskspace_registry_file}"; then
    return 0
  fi
  if [[ "${TASKSPACE_SKIP_SOCKET_SCAN:-false}" == true ]]; then
    return 1
  fi
  port_is_listening "${port}"
}

assert_taskspace_port_registration() {
  local task_id="$1" port="$2"
  awk -F '\t' -v project="${slug}" -v task="${task_id}" -v port="${port}" '
    NR == 1 { next }
    $1 == project && $2 == task {
      task_rows++
      if ($3 == port) exact++
    }
    $3 == port && !($1 == project && $2 == task) { conflicting++ }
    END { exit !(task_rows == 1 && exact == 1 && conflicting == 0) }
  ' "${taskspace_registry_file}" \
    || die "TaskSpace lifecycle requires one exact, conflict-free port registration."
}

allocate_taskspace_port() {
  local minimum maximum candidate
  minimum="$(env_value TASKSPACE_PORT_MIN)"
  maximum="$(env_value TASKSPACE_PORT_MAX)"
  [[ "${minimum}" =~ ^[0-9]+$ ]] || minimum=20000
  [[ "${maximum}" =~ ^[0-9]+$ ]] || maximum=29999
  taskspace_network_subnet_for_port "${minimum}" >/dev/null \
    || { printf 'TASKSPACE_PORT_MIN is outside the deterministic TaskSpace network pool.\n' >&2; return 1; }
  taskspace_network_subnet_for_port "${maximum}" >/dev/null \
    || { printf 'TASKSPACE_PORT_MAX is outside the deterministic TaskSpace network pool.\n' >&2; return 1; }
  ((10#${minimum} <= 10#${maximum})) \
    || { printf 'TASKSPACE_PORT_MIN must not exceed TASKSPACE_PORT_MAX.\n' >&2; return 1; }
  for ((candidate = 10#${minimum}; candidate <= 10#${maximum}; candidate++)); do
    if ! port_reserved "${candidate}"; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

mkdir -p -m 0700 -- "${taskspaces_root}"
taskspaces_lock="${DELIVERY_ROOT}/registry/taskspaces.lock"
prepare_delivery_lock "${taskspaces_lock}"
[[ -w "${taskspaces_lock}" ]] \
  || die "TaskSpace registry lock is not writable by the current operator: ${taskspaces_lock}"
inherited_taskspaces_lock_fd="${FORGE_TASKSPACES_LOCK_FD:-}"
if [[ -n "${inherited_taskspaces_lock_fd}" ]]; then
  [[ "${inherited_taskspaces_lock_fd}" =~ ^[0-9]+$ \
    && -e "/proc/$$/fd/${inherited_taskspaces_lock_fd}" \
    && "$(readlink -f "/proc/$$/fd/${inherited_taskspaces_lock_fd}")" == "$(readlink -f "${taskspaces_lock}")" ]] \
    || die "Inherited TaskSpace registry lock descriptor is unsafe."
  flock --exclusive --nonblock "${inherited_taskspaces_lock_fd}" \
    || die "Inherited TaskSpace registry lock is not held."
else
  exec 9>>"${taskspaces_lock}"
  flock --exclusive 9
fi

case "${action}" in
  create)
    task_id=''
    actor_id=''
    actor_user_id=''
    conversation_id=''
    harness_port=''
    access_mode='token'
    runtime_channel=''
    runtime_version_id=''
    runtime_version_json=null
    while (($# > 0)); do
      case "$1" in
        --task) task_id="${2:-}"; shift 2 ;;
        --actor) actor_id="${2:-}"; shift 2 ;;
        --actor-user-id) actor_user_id="${2:-}"; shift 2 ;;
        --conversation) conversation_id="${2:-}"; shift 2 ;;
        --access-mode) access_mode="${2:-}"; shift 2 ;;
        --port) harness_port="${2:-}"; shift 2 ;;
        --runtime-channel) runtime_channel="${2:-}"; shift 2 ;;
        --runtime-version-id) runtime_version_id="${2:-}"; shift 2 ;;
        *) usage >&2; die "Unknown create option: $1" ;;
      esac
    done
    validate_task_id "${task_id}"
    validate_actor_id "${actor_id}"
    validate_actor_user_id "${actor_user_id}"
    validate_conversation_id "${conversation_id}"
    [[ "${access_mode}" == token || "${access_mode}" == conversation ]] \
      || die "TaskSpace access mode must be token or conversation."
    [[ -z "${runtime_version_id}" || -n "${runtime_channel}" ]] \
      || die "A runtime version id requires a runtime channel."
    runtime_image="$(env_value HARNESS_IMAGE)"
    runtime_skill_root="$(env_value FORGE_SKILL_BUNDLE_ROOT)"
    runtime_skill_digest=''
    runtime_broker_url=http://taskspace-broker:3100
    runtime_broker_host=''
    if [[ -n "${runtime_channel}" ]]; then
      require_command node
      runtime_resolve_args=(resolve --catalog "${project_root}/ops/harness-runtime-versions.json" --channel "${runtime_channel}")
      if [[ -n "${runtime_version_id}" ]]; then runtime_resolve_args+=(--version-id "${runtime_version_id}"); fi
      runtime_version_json="$(node "${REPO_ROOT}/docker/harness/harness-runtime-versions.mjs" "${runtime_resolve_args[@]}")" \
        || die "Selected Harness runtime version is unavailable."
      runtime_image="$(jq -er '.harnessImage' <<<"${runtime_version_json}")"
      runtime_skill_root="$(jq -er '.skillBundleRoot' <<<"${runtime_version_json}")"
      runtime_skill_digest="$(jq -er '.skillBundleSha256' <<<"${runtime_version_json}")"
      runtime_broker_url="$(jq -er '.brokerUrl' <<<"${runtime_version_json}")"
      runtime_broker_host="${runtime_broker_url#http://}"
      runtime_broker_host="${runtime_broker_host%:3100}"
    fi
    # New TaskSpaces are always created with the current schema-v2 contract.
    if [[ "${runtime_version_json}" == null ]]; then
      validate_external_skill_bundle_root "${runtime_skill_root}"
    else
      validate_external_skill_bundle_root "${runtime_skill_root}" "${runtime_skill_digest}"
    fi
    [[ -z "$(project_git_readonly "${integration_workspace}" status --porcelain=v1 --untracked-files=all)" ]] \
      || die "Canonical integration workspace is dirty; TaskSpace creation is blocked."
    docker network inspect "forge-${slug}_taskspaces" >/dev/null 2>&1 \
      || die "Project TaskSpace network is unavailable; start the upgraded project before creating a worker."
    assert_taskspace_broker_healthy "${runtime_broker_url}"
    base_commit="$(project_git_readonly "${integration_workspace}" rev-parse 'HEAD^{commit}')"
    task_root="$(task_root_of "${task_id}")"
    [[ ! -e "${task_root}" ]] || die "TaskSpace already exists: ${task_id}"
    if [[ -z "${harness_port}" ]]; then
      harness_port="$(allocate_taskspace_port)" || die "No free TaskSpace port remains."
    fi
    validate_port "${harness_port}"
    taskspace_network_subnet_for_port "${harness_port}" >/dev/null \
      || die "TaskSpace port cannot be mapped into the deterministic network pool: ${harness_port}"
    ! port_reserved "${harness_port}" || die "TaskSpace port is already allocated or listening: ${harness_port}"
    assert_taskspace_subnet_available "${harness_port}" \
      || die "TaskSpace subnet is unavailable for the selected port: ${harness_port}"

    stage_root="${taskspaces_root}/.${task_id}.creating.$$"
    [[ ! -e "${stage_root}" ]] || die "TaskSpace staging directory already exists."
    mkdir -m 0700 -- "${stage_root}"
    mkdir -m 0700 -- \
      "${stage_root}/dsh-home" \
      "${stage_root}/uploads" \
      "${stage_root}/tokens" \
      "${stage_root}/cache"
    ensure_taskspace_maintenance_fence "${stage_root}" "${slug}/${task_id}" \
      || die "TaskSpace maintenance fence could not be established."
    # Transfer reachable history as a pack instead of copying every local object file.
    git clone --no-hardlinks --no-local "${integration_workspace}" "${stage_root}/workspace"
    git -C "${stage_root}/workspace" remote rename origin integration
    git -C "${stage_root}/workspace" remote set-url integration /integration
    git -C "${stage_root}/workspace" config --local user.name "Forge TaskSpace ${actor_id}"
    git -C "${stage_root}/workspace" config --local user.email "${actor_id}@taskspace.invalid"
    git -C "${stage_root}/workspace" switch --create "task/${actor_id}/${task_id}" "${base_commit}"
    git -C "${stage_root}/workspace" config --local forge-delivery.managed true
    git -C "${stage_root}/workspace" config --local forge-delivery.project-slug "${slug}"
    git -C "${stage_root}/workspace" config --local forge-delivery.taskspace-id "${task_id}"
    git -C "${stage_root}/workspace" config --local forge-delivery.actor-id "${actor_id}"
    git -C "${stage_root}/workspace" config --local forge-delivery.actor-user-id "${actor_user_id}"
    git -C "${stage_root}/workspace" config --local forge-delivery.conversation-id "${conversation_id}"
    # Governance reads Git as the delivery owner, including during root-led
    # creation. Transfer the private clone before that identity reads it.
    if [[ "${EUID}" -eq 0 ]]; then
      chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${stage_root}"
    fi
    ensure_taskspace_cache_contract "${stage_root}"
    if taskspace_governance_context_required; then
      ensure_taskspace_governance_context "${stage_root}" "${slug}/${task_id}" \
        || die "TaskSpace governance context could not be established."
    fi
    install -m 0600 "${REPO_ROOT}/templates/project/harness-settings.yaml" "${stage_root}/dsh-home/settings.yaml"

    broker_token="$(openssl rand -hex 32)"
    browser_token="$(openssl rand -hex 32)"
    upload_token="$(openssl rand -hex 32)"
    printf '%s\n' "${broker_token}" >"${stage_root}/tokens/broker"
    printf '%s\n' "${browser_token}" >"${stage_root}/tokens/browser"
    chmod 0600 "${stage_root}/tokens/broker" "${stage_root}/tokens/browser"
    created_at="$(date --iso-8601=seconds)"
    jq --null-input \
      --arg project_slug "${slug}" \
      --arg task_id "${task_id}" \
      --arg actor_id "${actor_id}" \
      --arg actor_user_id "${actor_user_id}" \
      --arg conversation_id "${conversation_id}" \
      --arg branch "task/${actor_id}/${task_id}" \
      --arg base_commit "${base_commit}" \
      --arg created_at "${created_at}" \
      --arg access_mode "${access_mode}" \
      --arg access_token_hash "$(printf '%s' "${broker_token}" | sha256sum | awk '{print $1}')" \
      --argjson harness_port "${harness_port}" \
      --argjson runtime_version "${runtime_version_json}" \
      '{schemaVersion: 2, projectSlug: $project_slug, taskId: $task_id, actorId: $actor_id,
        actorUserId: $actor_user_id,
        conversationId: $conversation_id, branch: $branch, baseCommit: $base_commit, status: "provisioning-failed",
        createdAt: $created_at, updatedAt: $created_at, accessTokenHash: $access_token_hash,
        harnessPort: $harness_port, accessMode: $access_mode, lastCandidate: null, lastRelease: null}
        + (if $runtime_version == null then {} else {runtimeVersion: $runtime_version} end)' \
      >"${stage_root}/metadata.json"
    chmod 0600 "${stage_root}/metadata.json"

    cat >"${stage_root}/task.env" <<EOF
TASKSPACE_COMPOSE_PROJECT_NAME=forge-${slug}-task-${task_id}
PROJECT_COMPOSE_NAME=forge-${slug}
PROJECT_ROOT=${project_root}
FORGE_SKILL_BUNDLE_ROOT=${runtime_skill_root}
PROJECT_FTP_INPUT_ROOT=$(project_ftp_input_root)
PROJECT_SHARED_INPUT_ROOT=$(env_value PROJECT_SHARED_INPUT_ROOT)
TASKSPACE_ROOT=${task_root}
PROJECT_SLUG=${slug}
TASKSPACE_ID=${task_id}
TASKSPACE_ACTOR_ID=${actor_id}
TASKSPACE_ACTOR_USER_ID=${actor_user_id}
TASKSPACE_CONVERSATION_ID=${conversation_id}
TASKSPACE_ACCESS_MODE=${access_mode}
TASKSPACE_CODEX_CLI_MANAGED=true
TASKSPACE_HTTPS_PROXY=
TASKSPACE_NO_PROXY=
TASKSPACE_RUNTIME_BROKER_HOST=${runtime_broker_host}
PLATFORM_CONVERSATION_AUTH_ROOT=$(env_value PLATFORM_CONVERSATION_AUTH_ROOT)
FORGE_BIND_ADDRESS=$(env_value FORGE_BIND_ADDRESS)
TASKSPACE_HARNESS_PORT=${harness_port}
CONVERSATION_GATEWAY_AUTHZ_URL=$(env_value CONVERSATION_GATEWAY_AUTHZ_URL)
CONVERSATION_GATEWAY_LOGIN_URL=$(env_value CONVERSATION_GATEWAY_LOGIN_URL)
HARNESS_PRIVILEGED_API_MODE=$(env_value HARNESS_PRIVILEGED_API_MODE)
HARNESS_HISTORY_PAGE_MESSAGES=$(env_value HARNESS_HISTORY_PAGE_MESSAGES)
HARNESS_UPLOAD_TOKEN=${upload_token}
HARNESS_UPLOAD_MAX_FILE_BYTES=$(env_value HARNESS_UPLOAD_MAX_FILE_BYTES)
HARNESS_UPLOAD_MAX_BATCH_FILES=$(env_value HARNESS_UPLOAD_MAX_BATCH_FILES)
HARNESS_UPLOAD_MAX_BATCH_BYTES=$(env_value HARNESS_UPLOAD_MAX_BATCH_BYTES)
HARNESS_UPLOAD_MAX_PROJECT_BYTES=$(env_value HARNESS_UPLOAD_MAX_PROJECT_BYTES)
HARNESS_DOCUMENT_MAX_SOURCE_BYTES=$(env_value HARNESS_DOCUMENT_MAX_SOURCE_BYTES)
HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=$(env_value HARNESS_DOCUMENT_MAX_OUTPUT_BYTES)
HARNESS_DOCUMENT_MAX_PDF_PAGES=$(env_value HARNESS_DOCUMENT_MAX_PDF_PAGES)
HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=$(env_value HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS)
HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=$(env_value HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS)
HOST_UID=$(env_value HOST_UID)
HOST_GID=$(env_value HOST_GID)
DEEPSEEK_KEY_FILE=$(env_value DEEPSEEK_KEY_FILE)
KIMI_KEY_FILE=$(env_value KIMI_KEY_FILE)
GLM_KEY_FILE=$(env_value GLM_KEY_FILE)
HARNESS_IMAGE=${runtime_image}
FORGE_TASKSPACE_BROKER_URL=${runtime_broker_url}
FORGE_DEVELOPMENT_MODE=$(runtime_environment_value FORGE_DEVELOPMENT_MODE)
FORGE_SEMANTIC_INTENT_ENABLED=$(runtime_environment_value FORGE_SEMANTIC_INTENT_ENABLED)
FORGE_TOOL_WORKER_ENABLED=$(if [[ "$(docker image inspect --format '{{index .Config.Labels "io.forge.tool-worker"}}' "${runtime_image}")" == v1 ]]; then printf true; else printf false; fi)
FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
FORGE_CHANGED_VERIFICATION_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_CHANGED_VERIFICATION_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED=$(if [[ "$(runtime_environment_value FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED)" == true ]]; then printf true; else printf false; fi)
TZ=$(env_value TZ)
EOF
    chmod 0600 "${stage_root}/task.env"
    ensure_taskspace_tool_worker_directory "${stage_root}" "${slug}/${task_id}" \
      || die "TaskSpace tool-worker socket directory could not be established."
    ensure_taskspace_network_override "${stage_root}" "${slug}/${task_id}" "${harness_port}" \
      || die "TaskSpace network override could not be established."
    if [[ "${EUID}" -eq 0 ]]; then
      chown -R "${DELIVERY_OWNER}:${DELIVERY_GROUP}" "${stage_root}"
    fi
    mv -- "${stage_root}" "${task_root}"
    printf '%s\t%s\t%s\t%s\n' \
      "${slug}" "${task_id}" "${harness_port}" "${created_at}" >>"${taskspace_registry_file}"
    if ! prepare_taskspace_codex_credentials "${task_id}" \
        || ! task_compose "${task_id}" config --quiet \
        || ! task_compose "${task_id}" up --detach \
        || ! assert_taskspace_upload_network_realized "${task_id}" "${harness_port}"; then
      atomic_metadata_status "${task_id}" provisioning-failed
      die "TaskSpace provisioning failed; evidence is preserved at ${task_root}."
    fi
    atomic_metadata_status "${task_id}" active
    log "Created TaskSpace ${task_id} for ${actor_id}; base commit ${base_commit}."
    if [[ "${access_mode}" == conversation ]]; then
      log "Open the conversation through $(env_value CONVERSATION_GATEWAY_LOGIN_URL) after signing in."
    else
      log "Run '$0 ${slug} access ${task_id}' to obtain its private access URL."
    fi
    ;;
  recover)
    task_id="${1:-}"
    [[ -n "${task_id}" && $# -eq 1 ]] || { usage >&2; exit 2; }
    validate_task_id "${task_id}"
    [[ -f "$(task_metadata_of "${task_id}")" && -f "$(task_env_of "${task_id}")" ]] \
      || die "TaskSpace is missing or incomplete: ${task_id}"
    assert_taskspace_control_identity "${task_id}" \
      || die "TaskSpace recovery identity validation failed."
    current_status="$(jq -r '.status' "$(task_metadata_of "${task_id}")")"
    metadata_port="$(jq -er \
      '.harnessPort | select(type == "number" and . == floor and . >= 1 and . <= 65535) | tostring' \
      "$(task_metadata_of "${task_id}")")" \
      || die "TaskSpace recovery metadata has an invalid Harness port."
    harness_port="$(task_env_exact_value "$(task_env_of "${task_id}")" TASKSPACE_HARNESS_PORT)" \
      || die "TaskSpace recovery environment must contain exactly one Harness port."
    [[ "${metadata_port}" == "${harness_port}" ]] \
      || die "TaskSpace recovery port differs between metadata and task.env."
    assert_taskspace_port_registration "${task_id}" "${harness_port}"

    if [[ "${current_status}" == active ]]; then
      active_network_compose_args=()
      taskspace_network_compose_args "$(task_root_of "${task_id}")" \
        "${slug}/${task_id}" active_network_compose_args \
        || die "Active TaskSpace network metadata is invalid."
      ((${#active_network_compose_args[@]} > 0)) \
        || die "Active TaskSpace does not carry a deterministic network contract."
      ensure_taskspace_maintenance_fence "$(task_root_of "${task_id}")" "${slug}/${task_id}" \
        || die "TaskSpace maintenance fence could not be established for idempotent recovery."
      assert_taskspace_mutation_fence_committed \
        "$(task_root_of "${task_id}")" "${slug}/${task_id}"
      assert_taskspace_upload_network_realized "${task_id}" "${harness_port}" \
        || die "Active TaskSpace does not have its realized recovery network."
      assert_taskspace_subnet_available "${harness_port}" \
        "$(taskspace_upload_network_name "${task_id}")" \
        || die "Active TaskSpace recovery network overlaps another Docker network."
      # Production incident recovery used the reviewed legacy filename. Preserve
      # that evidence while publishing the canonical equivalent without touching
      # the already-running Compose project.
      ensure_taskspace_network_override "$(task_root_of "${task_id}")" \
        "${slug}/${task_id}" "${harness_port}" \
        || die "Active TaskSpace network override could not be migrated safely."
      validate_taskspace_network_override "$(task_root_of "${task_id}")" \
        "${slug}/${task_id}" "${harness_port}" >/dev/null \
        || die "Active TaskSpace does not carry the completed recovery network contract."
      log "TaskSpace ${task_id} provisioning recovery is already complete."
      exit 0
    fi
    [[ "${current_status}" == provisioning-failed ]] \
      || die "Only provisioning-failed TaskSpaces can recover; current status is ${current_status}."
    assert_taskspace_recovery_network_compatible "${task_id}" "${harness_port}" \
      || die "TaskSpace uploads network is incompatible with safe provisioning recovery."
    assert_taskspace_subnet_available "${harness_port}" \
      "$(taskspace_upload_network_name "${task_id}")" \
      || die "TaskSpace recovery subnet overlaps another Docker network."
    ensure_taskspace_maintenance_fence "$(task_root_of "${task_id}")" "${slug}/${task_id}" \
      || die "TaskSpace maintenance fence could not be established for recovery."
    assert_taskspace_mutation_fence_committed \
      "$(task_root_of "${task_id}")" "${slug}/${task_id}"
    if taskspace_uses_current_compose "${task_id}"; then
      validate_taskspace_skill_bundle_root "${task_id}"
    fi
    docker network inspect "forge-${slug}_taskspaces" >/dev/null 2>&1 \
      || die "Project TaskSpace network is unavailable; start the upgraded project before recovery."
    assert_taskspace_broker_healthy "$(task_env_exact_value "$(task_env_of "${task_id}")" FORGE_TASKSPACE_BROKER_URL || true)"
    ensure_taskspace_cache_contract "$(task_root_of "${task_id}")"
    if taskspace_uses_current_compose "${task_id}" && taskspace_governance_context_required; then
      ensure_taskspace_governance_context "$(task_root_of "${task_id}")" "${slug}/${task_id}" \
        || die "TaskSpace governance context could not be re-established during recovery."
    fi
    ensure_taskspace_network_override "$(task_root_of "${task_id}")" \
      "${slug}/${task_id}" "${harness_port}" \
      || die "TaskSpace network override could not be established for recovery."
    if ! prepare_taskspace_codex_credentials "${task_id}" \
        || ! task_compose "${task_id}" config --quiet \
        || ! task_compose "${task_id}" up --detach \
        || ! assert_taskspace_upload_network_realized "${task_id}" "${harness_port}"; then
      atomic_metadata_status "${task_id}" provisioning-failed
      die "TaskSpace provisioning recovery failed; evidence remains preserved at $(task_root_of "${task_id}")."
    fi
    atomic_metadata_status "${task_id}" active
    log "Recovered TaskSpace ${task_id} from provisioning-failed without deleting preserved evidence."
    ;;
  list)
    printf 'TASK\tACTOR\tCONVERSATION\tACCESS\tSTATUS\tPORT\tBASE\n'
    shopt -s nullglob
    for metadata in "${taskspaces_root}"/*/metadata.json; do
      jq -r '[.taskId,.actorId,.conversationId,(.accessMode // "token"),.status,(.harnessPort|tostring),.baseCommit] | @tsv' "${metadata}"
    done
    ;;
  enable-tool-worker)
    task_id="${1:-}"
    [[ -n "${task_id}" && $# -eq 1 ]] || { usage >&2; exit 2; }
    validate_task_id "${task_id}"
    [[ -f "$(task_metadata_of "${task_id}")" && -f "$(task_env_of "${task_id}")" ]] \
      || die "TaskSpace is missing or incomplete: ${task_id}"
    taskspace_uses_current_compose "${task_id}" || die "Tool worker requires the current TaskSpace schema."
    task_root="$(task_root_of "${task_id}")"
    if taskspace_tool_worker_enabled "${task_root}" "${slug}/${task_id}"; then
      ensure_taskspace_tool_worker_directory "${task_root}" "${slug}/${task_id}" \
        || die "TaskSpace tool-worker directory is unsafe."
      log "TaskSpace ${task_id} tool-worker contract is already enabled; no runtime was changed."
      exit 0
    else
      worker_setting_status=$?
      [[ "${worker_setting_status}" == 1 ]] || die "TaskSpace tool-worker setting is invalid."
    fi
    [[ "$(jq -r '.status' "$(task_metadata_of "${task_id}")")" == stopped ]] \
      || die "Stop the drained TaskSpace before enabling its tool worker."
    [[ -z "$(task_compose "${task_id}" ps --quiet --status running harness)" ]] \
      || die "TaskSpace Harness is still running."
    assert_taskspace_mutation_fence_committed "${task_root}" "${slug}/${task_id}"
    image="$(task_env_exact_value "$(task_env_of "${task_id}")" HARNESS_IMAGE)"
    [[ "$(docker image inspect --format '{{index .Config.Labels "io.forge.tool-worker"}}' "${image}")" == v1 ]] \
      || die "TaskSpace image does not contain the verified tool-worker integration."
    ensure_taskspace_tool_worker_directory "${task_root}" "${slug}/${task_id}" \
      || die "TaskSpace tool-worker socket directory could not be established."
    task_env="$(task_env_of "${task_id}")"
    temporary="$(mktemp "${task_root}/.tool-worker-env.XXXXXX")"
    python3 - "${task_env}" "${temporary}" <<'PY'
import pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
original = source.read_bytes()
lines = original.splitlines(keepends=True)
matches = [i for i, line in enumerate(lines) if line.partition(b'=')[0] == b'FORGE_TOOL_WORKER_ENABLED']
assert len(matches) <= 1, 'Duplicate tool-worker setting'
if matches:
    index = matches[0]
    suffix = b'\r\n' if lines[index].endswith(b'\r\n') else b'\n' if lines[index].endswith(b'\n') else b''
    lines[index] = b'FORGE_TOOL_WORKER_ENABLED=true' + suffix
    result = b''.join(lines)
else:
    result = original + (b'' if not original or original.endswith(b'\n') else b'\n') + b'FORGE_TOOL_WORKER_ENABLED=true\n'
assert source.read_bytes() == original, 'TaskSpace environment changed'
target.write_bytes(result)
PY
    chmod 0600 "${temporary}"
    if [[ "${EUID}" == 0 ]]; then chown --reference="${task_env}" "${temporary}"; fi
    mv -- "${temporary}" "${task_env}"
    task_compose "${task_id}" config --quiet
    log "TaskSpace ${task_id} tool-worker contract enabled; start uses the existing preserved workspace and history."
    ;;
  status|start|stop|access|close)
    task_id="${1:-}"
    [[ -n "${task_id}" && $# -eq 1 ]] || { usage >&2; exit 2; }
    validate_task_id "${task_id}"
    [[ -f "$(task_metadata_of "${task_id}")" && -f "$(task_env_of "${task_id}")" ]] \
      || die "TaskSpace is missing or incomplete: ${task_id}"
    if [[ "${action}" == stop || "${action}" == close ]]; then
      # The shared lifecycle lock above is intentionally necessary but not sufficient:
      # it disappears with a killed recovery worker while this durable fence remains.
      # Only the fixed recovery/reconciliation entrypoint may operate in maintenance.
      ensure_legacy_taskspace_maintenance_baseline "${task_id}"
      assert_taskspace_mutation_fence_committed \
        "$(task_root_of "${task_id}")" "${slug}/${task_id}"
    fi
    case "${action}" in
      status)
        jq '{schemaVersion, taskId, actorId, actorUserId: (.actorUserId // null), conversationId, accessMode: (.accessMode // "token"), status, harnessPort, baseCommit, lastCandidate, lastRelease}' \
          "$(task_metadata_of "${task_id}")"
        task_compose "${task_id}" ps --all
        ;;
      start)
        current_status="$(jq -r '.status' "$(task_metadata_of "${task_id}")")"
        [[ "${current_status}" == stopped || "${current_status}" == active ]] \
          || die "Only active or stopped TaskSpaces can start; current status is ${current_status}."
        prepare_taskspace_codex_credentials "${task_id}" \
          || die 'Codex CLI project configuration safety check failed.'
        if [[ "${current_status}" == active ]] \
            && ! taskspace_uses_current_compose "${task_id}" \
            && active_legacy_taskspace_runtime_is_healthy "${task_id}"; then
          log "Legacy TaskSpace ${task_id} is already active and healthy; its preserved containers were not reconciled."
          exit 0
        fi
        ensure_taskspace_maintenance_fence "$(task_root_of "${task_id}")" "${slug}/${task_id}" \
          || die "TaskSpace maintenance fence could not be established before start; an active maintenance recovery or unsafe fence blocks lifecycle mutation."
        assert_taskspace_mutation_fence_committed \
          "$(task_root_of "${task_id}")" "${slug}/${task_id}"
        if taskspace_uses_current_compose "${task_id}"; then
          validate_taskspace_skill_bundle_root "${task_id}"
        fi
        ensure_taskspace_cache_contract "$(task_root_of "${task_id}")"
        if taskspace_uses_current_compose "${task_id}" && taskspace_governance_context_required; then
          ensure_taskspace_governance_context "$(task_root_of "${task_id}")" "${slug}/${task_id}" \
            || die "TaskSpace governance context could not be re-established."
        fi
        override="$(task_root_of "${task_id}")/${TASKSPACE_NETWORK_OVERRIDE_NAME}"
        legacy_override="$(task_root_of "${task_id}")/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}"
        if [[ -e "${override}" || -L "${override}" \
            || -e "${legacy_override}" || -L "${legacy_override}" \
            || "${current_status}" == stopped ]]; then
          assert_taskspace_control_identity "${task_id}" \
            || die "TaskSpace network lifecycle identity validation failed before start."
          metadata_port="$(jq -er \
            '.harnessPort | select(type == "number" and . == floor and . >= 1 and . <= 65535) | tostring' \
            "$(task_metadata_of "${task_id}")")" \
            || die "TaskSpace start metadata has an invalid Harness port."
          harness_port="$(task_env_exact_value "$(task_env_of "${task_id}")" TASKSPACE_HARNESS_PORT)" \
            || die "TaskSpace start environment must contain exactly one Harness port."
          [[ "${metadata_port}" == "${harness_port}" ]] \
            || die "TaskSpace start port differs between metadata and task.env."
          assert_taskspace_port_registration "${task_id}" "${harness_port}"
          assert_taskspace_recovery_network_compatible "${task_id}" "${harness_port}" \
            || die "TaskSpace uploads network is incompatible with safe start."
          assert_taskspace_subnet_available "${harness_port}" \
            "$(taskspace_upload_network_name "${task_id}")" \
            || die "TaskSpace start subnet overlaps another Docker network."
          ensure_taskspace_network_override "$(task_root_of "${task_id}")" \
            "${slug}/${task_id}" "${harness_port}" \
            || die "TaskSpace network override could not be migrated before start."
        else
          die "An unhealthy active TaskSpace without a deterministic network contract requires reviewed recovery."
        fi
        # Opening a conversation starts missing/stopped services; configuration
        # reconciliation belongs to the explicit, drained upgrade workflow.
        task_compose "${task_id}" up --detach --no-recreate
        assert_taskspace_upload_network_realized "${task_id}" "${harness_port}" \
          || die "TaskSpace uploads network was not realized after start."
        atomic_metadata_status "${task_id}" active
        ;;
      stop)
        if [[ "$(jq -r '.status' "$(task_metadata_of "${task_id}")")" == closed ]]; then
          log "TaskSpace ${task_id} is closed; its terminal status and preserved data were left unchanged."
        else
          task_root="$(task_root_of "${task_id}")"
          if [[ -e "${task_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
              || -L "${task_root}/${TASKSPACE_NETWORK_OVERRIDE_NAME}" \
              || -e "${task_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" \
              || -L "${task_root}/${TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME}" ]]; then
            # task_compose validates the preserved network contract before stopping.
            task_compose "${task_id}" stop --timeout 30
          else
            # Unmigrated legacy networks must still be rebuilt by the next start.
            task_compose "${task_id}" down --remove-orphans
          fi
          atomic_metadata_status "${task_id}" stopped
          log "TaskSpace ${task_id} stopped; workspace, conversation state, uploads and volumes were preserved."
        fi
        ;;
      close)
        task_compose "${task_id}" down --remove-orphans
        atomic_metadata_status "${task_id}" closed
        log "TaskSpace ${task_id} closed; its files, tool caches and residual named volumes were preserved."
        ;;
      access)
        bind_address="$(task_env_value "${task_id}" FORGE_BIND_ADDRESS)"
        harness_port="$(task_env_value "${task_id}" TASKSPACE_HARNESS_PORT)"
        access_mode="$(jq -r '.accessMode // "token"' "$(task_metadata_of "${task_id}")")"
        if [[ "${access_mode}" == conversation ]]; then
          printf 'Conversation Gateway: %s\n' "$(task_env_value "${task_id}" CONVERSATION_GATEWAY_LOGIN_URL)"
          exit 0
        fi
        browser_token="$(<"$(task_root_of "${task_id}")/tokens/browser")"
        printf 'TaskSpace Harness: http://%s:%s/forge-access?token=%s\n' \
          "${bind_address}" "${harness_port}" "${browser_token}"
        ;;
    esac
    ;;
  *)
    usage >&2
    die "Unknown command: ${action}"
    ;;
esac
