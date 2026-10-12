#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly REQUIRED_SOURCE_COMMIT="6eb2881e6f6af85a5348acf3da63cef53a873b0e"
readonly PROJECT_SLUG="forge-harness-eval"
readonly CACHE_WARM_MIN_FREE_BYTES=6442450944
SOURCE_PATH=""
IMAGE_REFERENCE=""
CACHE_ROOT=""
SEED_WARM_PATH=""
CONFIRMED=0
stage=""
stage_token=""
stage_marker=""
contract_file=""
contract_created=0
warm=""
warm_marker_name='.forge-warm-owner.json'
cache_lock_dir=""
cache_lock_token=""
cache_lock_acquired=0

usage() {
  cat <<'EOF'
Usage:
  scripts/prepare-local-forge-harness-eval-cache.sh \
    --source /absolute/local/forge-admin-v1.1.2 \
    --image LOCAL_CANDIDATE_IMAGE \
    --cache-root /absolute/local/cache-packs \
    [--seed-warm /absolute/local/cache-packs/.warm-OLD_COMPAT-FINGERPRINT] \
    --confirm-local-cache-warm

This is the only network-enabled dependency preparation path for the local
Forge Harness behavior evaluation. It never calls a model, accepts no remote
or server destination, uses fixed Maven/pnpm commands, and publishes one
content-addressed cache pack only after networkless verification.
EOF
}

die() {
  printf 'forge-harness-eval-cache: %s\n' "$1" >&2
  exit 2
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required local tool is missing: $1"
}

reject_remote_syntax() {
  local label="$1" value="$2"
  [[ -n "${value}" ]] || die "${label} is required"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "${label} contains a line break"
  [[ "${value}" != //* && "${value}" != \\\\* ]] || die "${label} must not use a network-share path"
  [[ ! "${value}" =~ ^[A-Za-z][A-Za-z0-9+.-]*:// ]] || die "${label} must be a local path, not a URI"
  [[ ! "${value}" =~ ^[^/@[:space:]]+@[^:[:space:]]+: ]] || die "${label} must not use a remote-shell target"
  [[ "${value}" != *','* ]] || die "${label} must not contain a comma because Docker --mount is CSV encoded"
}

canonical_directory() {
  local label="$1" value="$2" canonical
  reject_remote_syntax "${label}" "${value}"
  [[ ! -L "${value}" ]] || die "${label} must not be a symbolic link"
  canonical="$(realpath -e -- "${value}" 2>/dev/null)" || die "${label} does not resolve to an existing local path"
  [[ -d "${canonical}" ]] || die "${label} must be a directory"
  printf '%s\n' "${canonical}"
}

paths_overlap() {
  local left="$1" right="$2"
  [[ "${left}" == "${right}" || "${left}" == "${right}/"* || "${right}" == "${left}/"* ]]
}

docker_host_path() {
  if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
    cygpath -am -- "$1"
  else
    printf '%s\n' "$1"
  fi
}

docker_safe() {
  if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
    MSYS2_ARG_CONV_EXCL='*' command docker "$@"
  else
    command docker "$@"
  fi
}

cleanup_cache_stage() {
  if [[ -n "${stage_token}" && ( -e "${stage}" || -e "${stage_marker}" ) ]]; then
    node - "${CACHE_ROOT}" "${stage}" "${stage_marker}" "${stage_token}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, stageInput, markerInput, token] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const stage = path.resolve(stageInput);
if (path.dirname(stage) !== root || path.basename(stage) !== `.incoming-${token}`) {
  throw new Error('refusing to remove a cache staging path outside the exact generated root');
}
const marker = path.resolve(markerInput);
if (path.dirname(marker) !== root || path.basename(marker) !== `.${token}.owner.json`) {
  throw new Error('cache staging marker escaped the exact generated root');
}
const info = fs.lstatSync(marker);
if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('invalid cache staging owner marker');
const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
if (owner.schemaVersion !== 1 || owner.token !== token) throw new Error('cache staging owner token mismatch');
if (fs.existsSync(stage)) {
  const stageInfo = fs.lstatSync(stage);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw new Error('invalid cache staging directory');
  fs.rmSync(stage, { recursive: true, force: false });
}
fs.unlinkSync(marker);
NODE
  fi
}

cleanup_stage() {
  cleanup_cache_stage
  if [[ "${contract_created}" -eq 1 && -n "${contract_file}" && -e "${contract_file}" ]]; then
    node - "${CACHE_ROOT}" "${contract_file}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, fileInput] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const file = path.resolve(fileInput);
if (path.dirname(file) !== root || !/^\.contract-[0-9a-f]{16}\.json$/u.test(path.basename(file))) {
  throw new Error('refusing to remove an unowned local cache contract');
}
const info = fs.lstatSync(file);
if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('invalid local cache contract');
fs.unlinkSync(file);
NODE
  fi
  if [[ "${cache_lock_acquired}" -eq 1 && -n "${cache_lock_dir}" && -n "${cache_lock_token}" && -e "${cache_lock_dir}" ]]; then
    node - "${CACHE_ROOT}" "${cache_lock_dir}" "${cache_lock_token}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, lockInput, token] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const lock = path.resolve(lockInput);
if (path.dirname(lock) !== root || path.basename(lock) !== '.cache-warm.lock') {
  throw new Error('refusing to release a cache lock outside the exact cache root');
}
const marker = path.join(lock, 'owner.json');
const lockInfo = fs.lstatSync(lock);
const markerInfo = fs.lstatSync(marker);
const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()
    || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1
    || owner.schemaVersion !== 1 || owner.token !== token) {
  throw new Error('local cache lock ownership changed during execution');
}
fs.unlinkSync(marker);
fs.rmdirSync(lock);
NODE
  fi
}

trap cleanup_stage EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) [[ $# -ge 2 ]] || die '--source requires a value'; SOURCE_PATH="$2"; shift 2 ;;
    --image) [[ $# -ge 2 ]] || die '--image requires a value'; IMAGE_REFERENCE="$2"; shift 2 ;;
    --cache-root) [[ $# -ge 2 ]] || die '--cache-root requires a value'; CACHE_ROOT="$2"; shift 2 ;;
    --seed-warm) [[ $# -ge 2 ]] || die '--seed-warm requires a value'; SEED_WARM_PATH="$2"; shift 2 ;;
    --confirm-local-cache-warm) CONFIRMED=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "${CONFIRMED}" -eq 1 ]] || die 'network-enabled dependency preparation requires --confirm-local-cache-warm'
for tool in awk docker git node realpath sha256sum; do require_tool "${tool}"; done
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then require_tool cygpath; fi

SOURCE_PATH="$(canonical_directory '--source' "${SOURCE_PATH}")"
reject_remote_syntax '--cache-root' "${CACHE_ROOT}"
[[ ! -L "${CACHE_ROOT}" ]] || die '--cache-root must not be a symbolic link'
mkdir -p -- "${CACHE_ROOT}"
CACHE_ROOT="$(canonical_directory '--cache-root' "${CACHE_ROOT}")"
paths_overlap "${SOURCE_PATH}" "${CACHE_ROOT}" && die '--source and --cache-root must not overlap'
if [[ -n "${SEED_WARM_PATH}" ]]; then
  SEED_WARM_PATH="$(canonical_directory '--seed-warm' "${SEED_WARM_PATH}")"
fi
cache_lock_dir="${CACHE_ROOT}/.cache-warm.lock"
cache_lock_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
node - "${CACHE_ROOT}" "${cache_lock_dir}" "${cache_lock_token}" <<'NODE' \
  || die 'another local verification cache preparation is active, or its reviewed lock needs operator recovery'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, lockInput, token] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const lock = path.resolve(lockInput);
if (path.dirname(lock) !== root || path.basename(lock) !== '.cache-warm.lock'
    || !/^[0-9a-f]{32}$/u.test(token)) {
  throw new Error('local cache lock path or token is invalid');
}
fs.mkdirSync(lock, { recursive: false, mode: 0o700 });
fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
  schemaVersion: 1,
  token,
  pid: process.ppid,
  acquiredAt: new Date().toISOString(),
})}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
cache_lock_acquired=1
[[ -d "${SOURCE_PATH}/.git" && ! -L "${SOURCE_PATH}/.git" ]] || die '--source must be a normal Git checkout'
source_head="$(git -C "${SOURCE_PATH}" rev-parse --verify 'HEAD^{commit}')"
[[ "${source_head}" == "${REQUIRED_SOURCE_COMMIT}" ]] || die "--source HEAD must equal ${REQUIRED_SOURCE_COMMIT}"
[[ -z "$(git -C "${SOURCE_PATH}" status --porcelain=v1 --untracked-files=all)" ]] \
  || die '--source must be clean, including untracked files'

reject_remote_syntax '--image' "${IMAGE_REFERENCE}"
[[ "${IMAGE_REFERENCE}" != -* ]] || die '--image must not begin with a dash'
image_prefix="${IMAGE_REFERENCE%%/*}"
if [[ "${IMAGE_REFERENCE}" == */* && ( "${image_prefix}" == localhost || "${image_prefix}" == *.* || "${image_prefix}" == *:* ) ]]; then
  die '--image must be a local image name or immutable id, not a registry/server-qualified reference'
fi
image_id="$(docker_safe image inspect --format '{{.Id}}' "${IMAGE_REFERENCE}" 2>/dev/null)" \
  || die '--image must already exist in the local Docker engine'
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Docker returned a non-immutable image identifier'
runner_revision="$(docker_safe image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_id}")"
[[ "${runner_revision}" =~ ^vpn-forge-delivery-toolkit-[0-9]+$ ]] \
  || die 'candidate image has no reviewed Forge delivery toolkit revision label'
node_base_image="$(docker_safe image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-node-base-manifest"}}' "${image_id}")"
maven_base_image="$(docker_safe image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-maven-base-manifest"}}' "${image_id}")"
[[ "${node_base_image}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] \
  || die 'candidate image has no immutable Node executor-toolchain manifest label'
[[ "${maven_base_image}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] \
  || die 'candidate image has no immutable Maven executor-toolchain manifest label'

source_docker="$(docker_host_path "${SOURCE_PATH}")"
cache_docker="$(docker_host_path "${CACHE_ROOT}")"
contract_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
contract_file="${CACHE_ROOT}/.contract-${contract_token}.json"
node - "${contract_file}" "${image_id}" "${runner_revision}" <<'NODE'
const fs = require('node:fs');
const [file, image, runnerRevision] = process.argv.slice(2);
const value = {
  schemaVersion: 1,
  projectSlug: 'forge-harness-eval',
  runnerRevision,
  toolchainImage: image,
  cacheRoot: '/cache-packs',
  stateRoot: '/verification-state',
  profiles: [
    'governance', 'backend-red-test', 'frontend-red-test',
    'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build',
    'changed-safe', 'full-regression',
  ],
  limits: { maxFiles: 250000, maxBytes: 4294967296, maxLogBytes: 8388608, defaultTimeoutSeconds: 900 },
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
NODE
contract_created=1
contract_docker="$(docker_host_path "${contract_file}")"

fingerprint_json="$(docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
  --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
  "${image_id}" node /usr/local/lib/verification-cache-tool.mjs fingerprint \
    --workspace /workspace --contract /contract.json)" \
  || die 'could not fingerprint the fixed Forge Admin source'
fingerprint="$(node -e 'const x=JSON.parse(process.argv[1]);if(!/^[0-9a-f]{64}$/.test(x.dependencyManifestFingerprint)||!(/^[0-9a-f]{40}$/).test(x.sourceHead))process.exit(2);process.stdout.write(x.dependencyManifestFingerprint)' "${fingerprint_json}")" \
  || die 'dependency fingerprint receipt is invalid'
acquisition_policy_digest="$(node -e 'const x=JSON.parse(process.argv[1]);if(!/^[0-9a-f]{64}$/.test(x.mavenAcquisitionPolicyDigest)||x.mavenAcquisitionPolicy?.strictChecksums!==true)process.exit(2);process.stdout.write(x.mavenAcquisitionPolicyDigest)' "${fingerprint_json}")" \
  || die 'Maven acquisition-policy fingerprint receipt is invalid'
compatibility_json="$(docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
  --user 1000:1000 --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
  "${image_id}" node /usr/local/lib/verification-cache-tool.mjs compatibility \
    --workspace /workspace --contract /contract.json \
    --node-base-image "${node_base_image}" --maven-base-image "${maven_base_image}")" \
  || die 'could not establish the candidate cache-compatibility closure'
compatibility_digest="$(node -e 'const x=JSON.parse(process.argv[1]);if(!/^[0-9a-f]{64}$/.test(x.cacheCompatibilityDigest))process.exit(2);process.stdout.write(x.cacheCompatibilityDigest)' "${compatibility_json}")" \
  || die 'candidate cache-compatibility receipt is invalid'
node - "${compatibility_json}" "${acquisition_policy_digest}" <<'NODE' \
  || die 'candidate cache producer topology does not match this local warmer implementation'
const value = JSON.parse(process.argv[2]);
const expectedCommands = [
  ['env', 'MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi', '/usr/local/bin/maven-verification-exec', 'mvn', '--strict-checksums', '--settings', '/usr/local/lib/maven-verification-settings.xml', '--no-transfer-progress', '-f', '/workspace/forge-server/pom.xml', '-Dmaven.repo.local=/warm/m2/repository', '-Penable-tests', '-DskipTests', 'dependency:go-offline'],
  ['pnpm', '--dir', '/workspace/forge-admin-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-admin-virtual-store', '--modules-dir', '/warm/scratch/forge-admin-node_modules'],
  ['pnpm', '--dir', '/workspace/forge-h5-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-h5-virtual-store', '--modules-dir', '/warm/scratch/forge-h5-node_modules'],
];
const expectedTopology = {
  schemaVersion: 'forge-verification-cache-producer-topology/v8',
  executorUser: '1000:1000',
  rootFilesystem: 'read-only',
  networkPolicy: 'enabled-only-for-fixed-warm-commands',
  pnpmLifecyclePolicy: { argv: '--ignore-scripts', logGate: 'no-lifecycle-execution-lines' },
  sourceMount: { destination: '/workspace', access: 'read-only' },
  warmWorkspaceMount: {
    destination: '/warm', access: 'read-write',
    publishAllowlist: ['m2/repository/', 'pnpm/store/'],
    disposablePaths: ['scratch/'],
    resumableBinding: 'compatibility-digest+dependency-fingerprint+acquisition-policy+source-head+base-images',
    scratchRemovedBeforePublish: true,
    scratchLifecycle: 'fresh-per-warm-attempt',
  },
  pnpmStoreSanitization: {
    removedPaths: ['pnpm/store/v11/projects/'],
    afterRemovalNodePolicy: 'ordinary-files-and-directories-only',
  },
  stageMaterialization: {
    include: ['m2/', 'pnpm/'],
    symlinkDereference: false,
    hardLinkPreservation: false,
    warmRetainedUntilFinalVerify: true,
  },
  ephemeralTmpfs: [
    { destination: '/tmp', options: 'rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700' },
  ],
  ephemeralEnvironment: {
    XDG_CACHE_HOME: '/warm/scratch/xdg-cache',
    MAVEN_OPTS: '-Djansi.tmpdir=/tmp/forge-maven-jansi',
  },
  mavenEphemeralState: {
    path: '/tmp/forge-maven-jansi', mode: '0700',
    lifecycle: 'fresh-per-command-and-container-ephemeral',
    sourceAndHomeWrites: 'forbidden',
  },
  hardening: { capDrop: 'ALL', noNewPrivileges: true },
};
if (value?.cacheCompatibility?.schemaVersion !== 'forge-verification-cache-compatibility/v2'
    || value?.cacheCompatibility?.cacheManifestSchemaVersion !== 3
    || value?.cacheCompatibility?.mavenAcquisitionPolicyDigest !== process.argv[3]
    || value?.cacheCompatibility?.mavenAcquisitionPolicy?.strictChecksums !== true
    || JSON.stringify(value?.cacheCompatibility?.warmCommands) !== JSON.stringify(expectedCommands)
    || JSON.stringify(value?.cacheCompatibility?.producerTopology) !== JSON.stringify(expectedTopology)) {
  process.exit(2);
}
NODE

# Keep exact-image packs immutable and coexisting. A governance-only image can
# receive a copied, newly bound pack only after the compatibility closure is
# equal; the executor still runs as the newly selected immutable image ID.
image_pack_parent="${CACHE_ROOT}/images/${image_id#sha256:}"
mkdir -p -- "${CACHE_ROOT}/images"
[[ -d "${CACHE_ROOT}/images" && ! -L "${CACHE_ROOT}/images" ]] || die 'cache image namespace is unsafe'
mkdir -p -- "${image_pack_parent}"
[[ -d "${image_pack_parent}" && ! -L "${image_pack_parent}" ]] || die 'cache image pack namespace is unsafe'
final_pack="${image_pack_parent}/${fingerprint}"
image_pack_parent_docker="$(docker_host_path "${image_pack_parent}")"
if [[ -d "${final_pack}" && ! -L "${final_pack}" ]]; then
  docker_safe run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
    --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
    --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
    --mount "type=bind,src=${image_pack_parent_docker},dst=/cache-packs,readonly" \
    "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
      --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null \
    || die 'existing local verification cache pack failed closed'
  manifest_sha256="$(sha256sum -- "${final_pack}/manifest.json" | awk '{print $1}')"
  rm -f -- "${contract_file}"
  contract_created=0
  printf '{"outcome":"ready","dependencyManifestFingerprint":"%s","manifestSha256":"%s","pack":"%s"}\n' \
    "${fingerprint}" "${manifest_sha256}" "${final_pack}"
  exit 0
fi
[[ ! -e "${final_pack}" && ! -L "${final_pack}" ]] || die 'final cache-pack path is not an ordinary absent path'

cache_available_bytes="$(node - "${CACHE_ROOT}" <<'NODE'
const fs = require('node:fs');
const stats = fs.statfsSync(process.argv[2], { bigint: true });
process.stdout.write(String(stats.bavail * stats.bsize));
NODE
)" || die 'could not determine local cache filesystem capacity'
[[ "${cache_available_bytes}" =~ ^[0-9]+$ ]] || die 'local cache filesystem returned an invalid capacity'
node -e '
  const available = BigInt(process.argv[1]);
  const required = BigInt(process.argv[2]);
  if (available < required) process.exit(2);
' "${cache_available_bytes}" "${CACHE_WARM_MIN_FREE_BYTES}" \
  || die 'local cache filesystem needs at least 6 GiB free before dependency warm'

# Promotion sources are limited to the legacy direct pack and exact image-ID
# namespaces created by this script. The target tool re-hashes every ordinary,
# read-only file and copies it into fresh staging; no source hard link survives.
promotion_candidates=()
if [[ -d "${CACHE_ROOT}/${fingerprint}" && ! -L "${CACHE_ROOT}/${fingerprint}" ]]; then
  promotion_candidates+=("${CACHE_ROOT}/${fingerprint}")
fi
while IFS= read -r candidate; do
  [[ -n "${candidate}" && "${candidate}" != "${final_pack}" ]] && promotion_candidates+=("${candidate}")
done < <(node - "${CACHE_ROOT}/images" "${fingerprint}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, fingerprint] = process.argv.slice(2);
for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!/^[0-9a-f]{64}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
  const candidate = path.join(root, entry.name, fingerprint);
  try {
    const info = fs.lstatSync(candidate);
    if (info.isDirectory() && !info.isSymbolicLink()) process.stdout.write(`${candidate}\n`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
NODE
)

for promotion_source in "${promotion_candidates[@]}"; do
  source_manifest_image="$(node - "${promotion_source}/manifest.json" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.schemaVersion !== 3 || value?.complete !== true
  || !/^sha256:[0-9a-f]{64}$/u.test(value?.toolchainImage ?? '')
  || !/^[0-9a-f]{64}$/u.test(value?.cacheCompatibilityDigest ?? '')) process.exit(2);
process.stdout.write(value.toolchainImage);
NODE
)"
  [[ -n "${source_manifest_image}" ]] || continue
  docker_safe image inspect --format '{{.Id}}' "${source_manifest_image}" 2>/dev/null \
    | grep -Fx -- "${source_manifest_image}" >/dev/null || continue

  stage_token="${fingerprint}-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
  stage="${CACHE_ROOT}/.incoming-${stage_token}"
  stage_marker="${CACHE_ROOT}/.${stage_token}.owner.json"
  node - "${stage_marker}" "${stage_token}" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], `${JSON.stringify({ schemaVersion: 1, token: process.argv[3] })}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
});
NODE
  mkdir -- "${stage}"
  stage_docker="$(docker_host_path "${stage}")"
  promotion_source_docker="$(docker_host_path "${promotion_source}")"
  if docker_safe run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 128 --memory 1g --cpus 1 --user 1000:1000 \
    --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
    --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
    --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
    --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
    --mount "type=bind,src=${promotion_source_docker},dst=/source-pack,readonly" \
    --mount "type=bind,src=${stage_docker},dst=/staging" \
    "${image_id}" node /usr/local/lib/verification-cache-tool.mjs promote \
      --workspace /workspace --contract /contract.json --source-pack /source-pack \
      --staging /staging --fingerprint "${fingerprint}" \
      --node-base-image "${node_base_image}" --maven-base-image "${maven_base_image}" >/dev/null; then
    docker_safe run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --pids-limit 64 --memory 256m --cpus 1 --user 0:0 \
      --mount "type=bind,src=${stage_docker},dst=/staging" \
      "${image_id}" bash -Eeuo pipefail -c \
        'find -P /staging -xdev -depth -exec chmod a-w -- {} +'

    docker_safe run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
      --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
      --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
      --mount "type=bind,src=${stage_docker},dst=/cache-packs/${fingerprint},readonly" \
      "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
        --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null \
      || die 'promoted staging pack failed pre-publish networkless verification'

    mv -T --no-clobber -- "${stage}" "${final_pack}"
    if ! docker_safe run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
      --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
      --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
      --mount "type=bind,src=${image_pack_parent_docker},dst=/cache-packs,readonly" \
      "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
        --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null; then
      mv -T --no-clobber -- "${final_pack}" "${stage}" \
        || die 'invalid promoted cache could not be returned to its owned staging path'
      die 'promoted verification cache pack failed final networkless verification'
    fi
    cleanup_cache_stage
    stage=""
    stage_marker=""
    stage_token=""
    manifest_sha256="$(sha256sum -- "${final_pack}/manifest.json" | awk '{print $1}')"
    rm -f -- "${contract_file}"
    contract_created=0
    printf '{"outcome":"promoted","dependencyManifestFingerprint":"%s","cacheCompatibilityDigest":"%s","manifestSha256":"%s","pack":"%s"}\n' \
      "${fingerprint}" "${compatibility_digest}" "${manifest_sha256}" "${final_pack}"
    exit 0
  fi
  cleanup_cache_stage
  stage=""
  stage_marker=""
  stage_token=""
done

# Network preparation is resumable but never directly publishable. The warm
# workspace is bound to the complete compatibility closure and source
# fingerprint, remains outside every exact-image pack namespace, and contains
# an internal owner marker. A failed network run leaves it available for the
# next identical invocation. A successful run preserves the bound download
# workspace as a local reusable seed and copies only the reviewed payload into
# an ordinary incoming stage before publication.
warm_key="${compatibility_digest}-${fingerprint}"
warm="${CACHE_ROOT}/.warm-${warm_key}"
node - "${CACHE_ROOT}" "${warm}" "${warm_marker_name}" \
  "${compatibility_digest}" "${fingerprint}" "${acquisition_policy_digest}" "${source_head}" \
  "${node_base_image}" "${maven_base_image}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, warmInput, markerName, compatibilityDigest, fingerprint,
  acquisitionPolicyDigest, sourceHead, nodeBaseImage, mavenBaseImage] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const warm = path.resolve(warmInput);
const expectedName = `.warm-${compatibilityDigest}-${fingerprint}`;
if (path.dirname(warm) !== root || path.basename(warm) !== expectedName) {
  throw new Error('warm workspace escaped the exact cache root');
}
const expected = {
  schemaVersion: 1,
  compatibilityDigest,
  fingerprint,
  acquisitionPolicyDigest,
  sourceHead,
  nodeBaseImage,
  mavenBaseImage,
};
try {
  fs.mkdirSync(warm, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(warm, 'm2', 'repository'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(warm, 'pnpm', 'store'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(warm, 'scratch'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(warm, markerName), `${JSON.stringify(expected)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
} catch (error) {
  if (error.code !== 'EEXIST') {
    throw error;
  }
  const warmInfo = fs.lstatSync(warm);
  if (!warmInfo.isDirectory() || warmInfo.isSymbolicLink()) {
    throw new Error('warm workspace is not an ordinary directory');
  }
  const marker = path.join(warm, markerName);
  const markerInfo = fs.lstatSync(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1) {
    throw new Error('warm workspace owner marker is invalid');
  }
  const actual = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('warm workspace binding does not match this execution');
  }
  for (const relative of ['m2/repository', 'pnpm/store']) {
    const target = path.join(warm, relative);
    const info = fs.lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`warm workspace path is invalid: ${relative}`);
    }
  }
}
const scratch = path.join(warm, 'scratch');
try {
  const scratchInfo = fs.lstatSync(scratch);
  if (!scratchInfo.isDirectory() || scratchInfo.isSymbolicLink()) {
    throw new Error('warm scratch path is invalid');
  }
  fs.rmSync(scratch, { recursive: true, force: false });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.mkdirSync(scratch, { recursive: false, mode: 0o700 });
NODE
warm_docker="$(docker_host_path "${warm}")"

# An explicitly selected historical warm may seed a new compatibility-bound
# workspace. The source remains read-only and is never accepted as a pack:
# fixed package-manager commands still reconcile it, lifecycle gates still run,
# and publish/networkless verification still re-inventory every output byte.
if [[ -n "${SEED_WARM_PATH}" ]]; then
  seed_warm="$(node - "${CACHE_ROOT}" "${SEED_WARM_PATH}" "${warm}" "${warm_marker_name}" \
    "${fingerprint}" "${acquisition_policy_digest}" "${source_head}" \
    "${node_base_image}" "${maven_base_image}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, seedInput, warmInput, markerName, fingerprint,
  acquisitionPolicyDigest, sourceHead, nodeBaseImage, mavenBaseImage] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const seed = fs.realpathSync(seedInput);
const warm = fs.realpathSync(warmInput);
if (path.dirname(seed) !== root || !/^\.warm-[0-9a-f]{64}-[0-9a-f]{64}$/u.test(path.basename(seed))
    || seed === warm) throw new Error('seed warm must be another direct compatibility workspace under the exact cache root');
const marker = path.join(seed, markerName);
const markerInfo = fs.lstatSync(marker);
if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1) {
  throw new Error('seed warm owner marker is invalid');
}
const actual = JSON.parse(fs.readFileSync(marker, 'utf8'));
if (actual.schemaVersion !== 1 || !/^[0-9a-f]{64}$/u.test(actual.compatibilityDigest ?? '')
    || actual.fingerprint !== fingerprint
    || actual.acquisitionPolicyDigest !== acquisitionPolicyDigest
    || actual.sourceHead !== sourceHead
    || actual.nodeBaseImage !== nodeBaseImage
    || actual.mavenBaseImage !== mavenBaseImage) {
  throw new Error('seed warm is not bound to the same dependencies, source, acquisition policy, and executor bases');
}
for (const relative of ['m2/repository', 'pnpm/store']) {
  const info = fs.lstatSync(path.join(seed, relative));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`seed warm path is invalid: ${relative}`);
}
process.stdout.write(seed);
NODE
  )" || die 'explicit local download seed failed its compatibility and ownership checks'
  seed_warm_docker="$(docker_host_path "${seed_warm}")"
  docker_safe run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 --user 1000:1000 \
    --mount "type=bind,src=${seed_warm_docker},dst=/seed,readonly" \
    --mount "type=bind,src=${warm_docker},dst=/warm" \
    "${image_id}" bash -Eeuo pipefail -c '
      if [[ -e /seed/pnpm/store/v11/projects \
          && ( ! -d /seed/pnpm/store/v11/projects || -L /seed/pnpm/store/v11/projects ) ]]; then
        printf "%s\n" "local download seed pnpm project index is not an ordinary directory" >&2
        exit 3
      fi
      if find -P /seed/m2 /seed/pnpm -xdev \
          -path /seed/pnpm/store/v11/projects -prune -o \
          ! -type f ! -type d -print -quit | grep -q .; then
        printf "%s\n" "local download seed contains a symbolic link or special node outside the exact disposable pnpm project index" >&2
        exit 3
      fi
      if [[ -e /warm/pnpm/store/v11/projects ]]; then
        find -P /warm/pnpm/store/v11/projects -depth -delete
      fi
      if find -P /warm/m2 /warm/pnpm -xdev ! -type f ! -type d -print -quit | grep -q .; then
        printf "%s\n" "resumable destination warm contains a symbolic link or special node" >&2
        exit 3
      fi
      tar -C /seed/m2/repository --hard-dereference -cf - . \
        | tar -C /warm/m2/repository --no-overwrite-dir --touch \
            --no-same-owner --no-same-permissions -xf -
      tar -C /seed/pnpm/store --hard-dereference \
          --exclude=./v11/projects --exclude=./v11/projects/\* -cf - . \
        | tar -C /warm/pnpm/store --no-overwrite-dir --touch \
            --no-same-owner --no-same-permissions -xf -
      if find -P /warm/m2 /warm/pnpm -xdev ! -type f ! -type d -print -quit | grep -q .; then
        printf "%s\n" "copied local download seed contains a symbolic link or special node" >&2
        exit 3
      fi
    '
fi

# Sole network-enabled step: fixed image, fixed package-manager commands, no
# model/API credential, no Docker socket, and a read-only source checkout. pnpm
# control, virtual-store and modules writes are redirected to the resumable
# workspace's disposable scratch tree. That tree is removed before the warm
# workspace can become a candidate pack, so no node_modules or control state is
# published and the read-only source checkout is never mutated.
docker_safe run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 4g --cpus 2 --user 1000:1000 \
  --env XDG_CACHE_HOME=/warm/scratch/xdg-cache \
  --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
  --mount "type=bind,src=${warm_docker},dst=/warm" \
  "${image_id}" bash -Eeuo pipefail -c '
    tmp_mount_options="$(LC_ALL=C awk '\''$5 == "/tmp" { print $6; exit }'\'' /proc/self/mountinfo)"
    [[ -n "${tmp_mount_options}" && ",${tmp_mount_options}," != *,noexec,* ]]
    exec_probe_source="$(type -P true)"
    [[ "${exec_probe_source}" == /* && -x "${exec_probe_source}" ]]
    cp -- "${exec_probe_source}" /tmp/forge-exec-probe
    chmod 0700 /tmp/forge-exec-probe
    /tmp/forge-exec-probe
    rm -f -- /tmp/forge-exec-probe
    maven_warm_log=/warm/scratch/maven-warm.log
    env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
      /usr/local/bin/maven-verification-exec \
      mvn --strict-checksums --settings /usr/local/lib/maven-verification-settings.xml \
      --no-transfer-progress -f /workspace/forge-server/pom.xml \
      -Dmaven.repo.local=/warm/m2/repository -Penable-tests -DskipTests dependency:go-offline \
      2>&1 | tee "${maven_warm_log}"
    ! grep -Eiq "Failed to load native library|failed to map segment" "${maven_warm_log}"
    pnpm_admin_warm_log=/warm/scratch/pnpm-admin-warm.log
    pnpm --dir /workspace/forge-admin-ui fetch \
      --frozen-lockfile --ignore-scripts --store-dir /warm/pnpm/store \
      --virtual-store-dir /warm/scratch/forge-admin-virtual-store \
      --modules-dir /warm/scratch/forge-admin-node_modules \
      2>&1 | tee "${pnpm_admin_warm_log}"
    ! grep -Eq " (preinstall|install|postinstall)\\\$" "${pnpm_admin_warm_log}"
    pnpm_h5_warm_log=/warm/scratch/pnpm-h5-warm.log
    pnpm --dir /workspace/forge-h5-ui fetch \
      --frozen-lockfile --ignore-scripts --store-dir /warm/pnpm/store \
      --virtual-store-dir /warm/scratch/forge-h5-virtual-store \
      --modules-dir /warm/scratch/forge-h5-node_modules \
      2>&1 | tee "${pnpm_h5_warm_log}"
    ! grep -Eq " (preinstall|install|postinstall)\\\$" "${pnpm_h5_warm_log}"
  '

stage_token="${fingerprint}-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
stage="${CACHE_ROOT}/.incoming-${stage_token}"
stage_marker="${CACHE_ROOT}/.${stage_token}.owner.json"
node - "${CACHE_ROOT}" "${warm}" "${warm_marker_name}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [rootInput, warmInput, markerName] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const warm = fs.realpathSync(warmInput);
if (path.dirname(warm) !== root || !/^\.warm-[0-9a-f]{64}-[0-9a-f]{64}$/u.test(path.basename(warm))) {
  throw new Error('refusing to finalize a warm workspace outside the exact cache root');
}
const scratch = path.join(warm, 'scratch');
const scratchInfo = fs.lstatSync(scratch);
if (!scratchInfo.isDirectory() || scratchInfo.isSymbolicLink()) {
  throw new Error('warm scratch path is invalid');
}
fs.rmSync(scratch, { recursive: true, force: false });
const pnpmProjects = path.join(warm, 'pnpm', 'store', 'v11', 'projects');
try {
  const projectsInfo = fs.lstatSync(pnpmProjects);
  if (!projectsInfo.isDirectory() || projectsInfo.isSymbolicLink()) {
    throw new Error('pnpm project index is not an ordinary directory');
  }
  fs.rmSync(pnpmProjects, { recursive: true, force: false });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const marker = path.join(warm, markerName);
const markerInfo = fs.lstatSync(marker);
if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1) {
  throw new Error('warm owner marker is invalid during finalization');
}
NODE
node - "${stage_marker}" "${stage_token}" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], `${JSON.stringify({ schemaVersion: 1, token: process.argv[3] })}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
});
NODE
mkdir -- "${stage}"
stage_docker="$(docker_host_path "${stage}")"

docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 --user 1000:1000 \
  --mount "type=bind,src=${warm_docker},dst=/warm,readonly" \
  --mount "type=bind,src=${stage_docker},dst=/staging" \
  "${image_id}" bash -Eeuo pipefail -c '
    if find -P /warm/m2 /warm/pnpm -xdev ! -type f ! -type d -print -quit | grep -q .; then
      printf "%s\n" "verification warm contains a symbolic link or special node after pnpm metadata normalization" >&2
      exit 3
    fi
    cp -R --no-preserve=links,ownership,mode,timestamps -- /warm/m2 /warm/pnpm /staging/
  '

docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 1g --cpus 1 --user 1000:1000 \
  --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
  --mount "type=bind,src=${stage_docker},dst=/staging" \
  "${image_id}" node /usr/local/lib/verification-cache-tool.mjs publish \
    --workspace /workspace --contract /contract.json --staging /staging \
    --fingerprint "${fingerprint}" --node-base-image "${node_base_image}" \
    --maven-base-image "${maven_base_image}" >/dev/null

docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 256m --cpus 1 --user 0:0 \
  --mount "type=bind,src=${stage_docker},dst=/staging" \
  "${image_id}" bash -Eeuo pipefail -c \
    'find -P /staging -xdev -depth -exec chmod a-w -- {} +'

# Verify the complete immutable layout before it enters the final namespace.
# The same contract still resolves /cache-packs/<fingerprint>; only the bind
# source differs. This makes every ordinary publish failure recoverable without
# touching the retained download workspace.
docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
  --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
  --mount "type=bind,src=${stage_docker},dst=/cache-packs/${fingerprint},readonly" \
  "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
    --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null \
  || die 'staged cache pack failed pre-publish networkless verification'

mv -T --no-clobber -- "${stage}" "${final_pack}"
if ! docker_safe run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
  --mount "type=bind,src=${source_docker},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract_docker},dst=/contract.json,readonly" \
  --mount "type=bind,src=${image_pack_parent_docker},dst=/cache-packs,readonly" \
  "${image_id}" node /usr/local/lib/verification-cache-tool.mjs verify \
    --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null; then
  mv -T --no-clobber -- "${final_pack}" "${stage}" \
    || die 'published cache pack failed verification and could not be returned to its owned staging path'
  die 'published cache pack failed networkless verification'
fi
cleanup_cache_stage
stage=""
stage_marker=""
stage_token=""
manifest_sha256="$(sha256sum -- "${final_pack}/manifest.json" | awk '{print $1}')"
rm -f -- "${contract_file}"
contract_created=0
printf '{"outcome":"published","dependencyManifestFingerprint":"%s","cacheCompatibilityDigest":"%s","manifestSha256":"%s","pack":"%s"}\n' \
  "${fingerprint}" "${compatibility_digest}" "${manifest_sha256}" "${final_pack}"
