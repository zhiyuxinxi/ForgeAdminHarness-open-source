#!/usr/bin/env bash

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
load_platform_config
# shellcheck source=lib/harness-image-verifier.sh
source "${SCRIPT_DIR}/lib/harness-image-verifier.sh"

usage() {
  printf 'Usage: %s --project <slug> [--task <task-id>] --confirm-cache-warm <slug>\n' "$0"
}

project_slug=''
task_id=''
confirmation=''
while (($# > 0)); do
  case "$1" in
    --project) project_slug="${2:-}"; shift 2 ;;
    --task) task_id="${2:-}"; shift 2 ;;
    --confirm-cache-warm) confirmation="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ "${project_slug}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ && "${confirmation}" == "${project_slug}" ]] \
  || die 'A valid project slug and matching --confirm-cache-warm value are required.'
[[ -z "${task_id}" || "${task_id}" =~ ^[a-z0-9][a-z0-9-]{1,47}$ ]] \
  || die 'TaskSpace id is invalid.'
for command_name in awk chmod chown df dirname docker flock grep install jq mkdir mv openssl readlink rm sha256sum stat tee; do require_command "${command_name}"; done
require_docker_access

project_root="${DELIVERY_ROOT}/projects/${project_slug}"
project_env="${project_root}/ops/project.env"
workspace="${project_root}/workspace"
if [[ -n "${task_id}" ]]; then
  task_root="${project_root}/taskspaces/${task_id}"
  metadata="${task_root}/metadata.json"
  [[ -f "${metadata}" && ! -L "${metadata}" \
    && "$(jq -er '.taskId | strings' "${metadata}")" == "${task_id}" \
    && "$(jq -er '.status | strings' "${metadata}")" == active ]] \
    || die "TaskSpace ${task_id} is not an active member of ${project_slug}."
  workspace="${task_root}/workspace"
fi
contract="${project_root}/verification/contract.json"
cache_root="${project_root}/verification/cache-packs"
[[ -f "${project_env}" && -d "${workspace}/.git" && -f "${contract}" && -d "${cache_root}" ]] \
  || die "Project ${project_slug} has not completed the verification baseline."

env_value() {
  local file="$1" key="$2"
  awk -F= -v name="${key}" '$1 == name {sub(/^[^=]*=/, ""); print; exit}' "${file}"
}
toolchain_image="$(jq -er '.toolchainImage | strings' "${contract}")" \
  || die 'Verification contract has no immutable toolchain image.'
[[ "${toolchain_image}" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die 'Verification toolchain image is not immutable.'
toolchain_image_id="${toolchain_image#sha256:}"
contract_cache_root="$(jq -er '.cacheRoot | strings' "${contract}")" \
  || die 'Verification contract has no cache root.'
image_cache_root="${cache_root}/images/${toolchain_image_id}"
[[ "${contract_cache_root}" == "${image_cache_root}" ]] \
  || die 'Verification contract cache root is not bound to its immutable toolchain image.'
[[ -d "${cache_root}" && ! -L "${cache_root}" \
  && -d "${cache_root}/images" && ! -L "${cache_root}/images" \
  && -d "${image_cache_root}" && ! -L "${image_cache_root}" \
  && "$(readlink -f -- "${image_cache_root}")" == "$(readlink -f -- "${cache_root}")/images/${toolchain_image_id}" ]] \
  || die 'Verification cache image namespace is absent or unsafe.'
expected_project="$(jq -er '.projectSlug | strings' "${contract}")"
[[ "${expected_project}" == "${project_slug}" ]] || die 'Verification contract project mismatch.'
expected_image="$(env_value "${project_env}" VERIFICATION_TOOLCHAIN_IMAGE)"
[[ "${expected_image}" == "${toolchain_image}" ]] || die 'Project environment and verification contract image differ.'
docker image inspect "${toolchain_image}" >/dev/null 2>&1 \
  || die "Verification toolchain image ${toolchain_image} is not present locally."
toolchain_user="$(docker image inspect --format '{{.Config.User}}' "${toolchain_image}")"
node_base_image="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-node-base-manifest"}}' "${toolchain_image}")"
maven_base_image="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-maven-base-manifest"}}' "${toolchain_image}")"
[[ "${toolchain_user}" == 1000:1000 ]] \
  || die 'Verification cache producer requires the reviewed 1000:1000 toolchain identity.'
[[ "${node_base_image}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ \
  && "${maven_base_image}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] \
  || die 'Verification toolchain image has no immutable executor base-image manifests.'

lock_file="${project_root}/verification/cache.lock"
exec 8>>"${lock_file}"
flock --exclusive --nonblock 8 || die "A verification cache preparation is already active for ${project_slug}."

fingerprint_json="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --cpus 1 \
  --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract},dst=/contract.json,readonly" \
  "${toolchain_image}" node /usr/local/lib/verification-cache-tool.mjs fingerprint \
    --workspace /workspace --contract /contract.json)" \
  || die 'Could not fingerprint the reviewed project dependency manifests.'
fingerprint="$(jq -er '.dependencyManifestFingerprint | strings' <<<"${fingerprint_json}")"
[[ "${fingerprint}" =~ ^[0-9a-f]{64}$ ]] || die 'Dependency manifest fingerprint is invalid.'
source_head="$(jq -er '.sourceHead | strings' <<<"${fingerprint_json}")"
acquisition_policy_digest="$(jq -er 'select(.mavenAcquisitionPolicy.strictChecksums == true) | .mavenAcquisitionPolicyDigest | strings' <<<"${fingerprint_json}")"
[[ "${source_head}" =~ ^[0-9a-f]{40}$ && "${acquisition_policy_digest}" =~ ^[0-9a-f]{64}$ ]] \
  || die 'Verification cache source or acquisition-policy receipt is invalid.'
compatibility_json="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --cpus 1 \
  --user 1000:1000 \
  --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract},dst=/contract.json,readonly" \
  "${toolchain_image}" node /usr/local/lib/verification-cache-tool.mjs compatibility \
    --workspace /workspace --contract /contract.json \
    --node-base-image "${node_base_image}" --maven-base-image "${maven_base_image}")" \
  || die 'Could not establish the current verification cache compatibility closure.'
compatibility_digest="$(jq -er '.cacheCompatibilityDigest | strings' <<<"${compatibility_json}")"
[[ "${compatibility_digest}" =~ ^[0-9a-f]{64}$ ]] \
  || die 'Verification cache compatibility digest is invalid.'
expected_commands="$(jq -cn '[
  ["env","MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi","/usr/local/bin/maven-verification-exec","mvn","--strict-checksums","--settings","/usr/local/lib/maven-verification-settings.xml","--no-transfer-progress","-f","/workspace/forge-server/pom.xml","-Dmaven.repo.local=/warm/m2/repository","-Penable-tests","-DskipTests","dependency:go-offline"],
  ["pnpm","--dir","/workspace/forge-admin-ui","fetch","--frozen-lockfile","--ignore-scripts","--store-dir","/warm/pnpm/store","--virtual-store-dir","/warm/scratch/forge-admin-virtual-store","--modules-dir","/warm/scratch/forge-admin-node_modules"],
  ["pnpm","--dir","/workspace/forge-h5-ui","fetch","--frozen-lockfile","--ignore-scripts","--store-dir","/warm/pnpm/store","--virtual-store-dir","/warm/scratch/forge-h5-virtual-store","--modules-dir","/warm/scratch/forge-h5-node_modules"]
]')"
expected_topology="$(jq -cn '{
  schemaVersion:"forge-verification-cache-producer-topology/v8",
  executorUser:"1000:1000",
  rootFilesystem:"read-only",
  networkPolicy:"enabled-only-for-fixed-warm-commands",
  pnpmLifecyclePolicy:{argv:"--ignore-scripts",logGate:"no-lifecycle-execution-lines"},
  sourceMount:{destination:"/workspace",access:"read-only"},
  warmWorkspaceMount:{destination:"/warm",access:"read-write",publishAllowlist:["m2/repository/","pnpm/store/"],disposablePaths:["scratch/"],resumableBinding:"compatibility-digest+dependency-fingerprint+acquisition-policy+source-head+base-images",scratchRemovedBeforePublish:true,scratchLifecycle:"fresh-per-warm-attempt"},
  pnpmStoreSanitization:{removedPaths:["pnpm/store/v11/projects/"],afterRemovalNodePolicy:"ordinary-files-and-directories-only"},
  stageMaterialization:{include:["m2/","pnpm/"],symlinkDereference:false,hardLinkPreservation:false,warmRetainedUntilFinalVerify:true},
  ephemeralTmpfs:[{destination:"/tmp",options:"rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700"}],
  ephemeralEnvironment:{XDG_CACHE_HOME:"/warm/scratch/xdg-cache",MAVEN_OPTS:"-Djansi.tmpdir=/tmp/forge-maven-jansi"},
  mavenEphemeralState:{path:"/tmp/forge-maven-jansi",mode:"0700",lifecycle:"fresh-per-command-and-container-ephemeral",sourceAndHomeWrites:"forbidden"},
  hardening:{capDrop:"ALL",noNewPrivileges:true}
}')"
jq -e --arg acquisitionPolicyDigest "${acquisition_policy_digest}" \
  --argjson expectedCommands "${expected_commands}" --argjson expectedTopology "${expected_topology}" \
  '.cacheCompatibility.schemaVersion == "forge-verification-cache-compatibility/v2"
   and .cacheCompatibility.cacheManifestSchemaVersion == 3
   and .cacheCompatibility.mavenAcquisitionPolicyDigest == $acquisitionPolicyDigest
   and .cacheCompatibility.mavenAcquisitionPolicy.strictChecksums == true
   and .cacheCompatibility.warmCommands == $expectedCommands
   and .cacheCompatibility.producerTopology == $expectedTopology' \
  <<<"${compatibility_json}" >/dev/null \
  || die 'Verification cache producer topology does not match this server warmer implementation.'
final_pack="${image_cache_root}/${fingerprint}"
if [[ -e "${final_pack}" || -L "${final_pack}" ]]; then
  [[ -d "${final_pack}" && ! -L "${final_pack}" ]] \
    || die 'An existing verification cache pack is not an ordinary directory.'
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --cpus 1 \
    --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
    --mount "type=bind,src=${contract},dst=/contract.json,readonly" \
    --mount "type=bind,src=${image_cache_root},dst=${contract_cache_root},readonly" \
    "${toolchain_image}" node /usr/local/lib/verification-cache-tool.mjs verify \
      --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null \
    || die 'An existing verification cache pack failed immutable verification.'
  log "Verification cache ${fingerprint} is already ready for ${project_slug}."
  exit 0
fi

cache_available_bytes="$(df --output=avail -B1 -- "${cache_root}" | awk 'NR == 2 {print $1}')"
[[ "${cache_available_bytes}" =~ ^[0-9]+$ && "${cache_available_bytes}" -ge 6442450944 ]] \
  || die 'Verification cache filesystem needs at least 6 GiB free before dependency warm.'

stage=''
stage_marker=''
stage_token=''
warm="${cache_root}/.warm-${compatibility_digest}-${fingerprint}"
cleanup_cache_stage() {
  local expected_stage expected_marker marker_links stage_parent cache_root_real
  if [[ -z "${stage}" && -z "${stage_marker}" && -z "${stage_token}" ]]; then
    return 0
  fi
  [[ "${stage_token}" =~ ^[0-9a-f]{32}$ ]] || return 1
  expected_stage="${cache_root}/.incoming-${fingerprint}-${stage_token}"
  expected_marker="${cache_root}/.incoming-${fingerprint}-${stage_token}.owner.json"
  [[ "${stage}" == "${expected_stage}" && "${stage_marker}" == "${expected_marker}" ]] || return 1
  [[ -f "${stage_marker}" && ! -L "${stage_marker}" ]] || return 1
  marker_links="$(stat -c '%h' -- "${stage_marker}")" || return 1
  [[ "${marker_links}" == 1 ]] || return 1
  jq -e --arg token "${stage_token}" --arg fingerprint "${fingerprint}" \
    --arg image "${toolchain_image}" --arg compatibilityDigest "${compatibility_digest}" \
    '.schemaVersion==1 and .token==$token and .fingerprint==$fingerprint and .toolchainImage==$image and .compatibilityDigest==$compatibilityDigest' \
    "${stage_marker}" >/dev/null || return 1
  if [[ -e "${stage}" || -L "${stage}" ]]; then
    [[ -d "${stage}" && ! -L "${stage}" ]] || return 1
    stage_parent="$(readlink -f -- "$(dirname -- "${stage}")")" || return 1
    cache_root_real="$(readlink -f -- "${cache_root}")" || return 1
    [[ "${stage_parent}" == "${cache_root_real}" ]] || return 1
    rm -rf --one-file-system -- "${stage}" || return 1
  fi
  rm -f -- "${stage_marker}" || return 1
}
cleanup() {
  local status=$?
  if ! cleanup_cache_stage; then
    printf '%s\n' 'Refusing to clean verification staging without its exact owner marker.' >&2
    return 1
  fi
  return "${status}"
}
trap cleanup EXIT
host_uid="$(env_value "${project_env}" HOST_UID)"
host_gid="$(env_value "${project_env}" HOST_GID)"
[[ "${host_uid}" =~ ^[0-9]+$ && "${host_gid}" =~ ^[0-9]+$ ]] \
  || die 'Project delivery identity is invalid.'
if [[ ! -e "${warm}" ]]; then
  mkdir -- "${warm}"
  mkdir -p -- "${warm}/m2/repository" "${warm}/pnpm/store" "${warm}/scratch"
  jq -n --arg compatibilityDigest "${compatibility_digest}" --arg fingerprint "${fingerprint}" \
    --arg image "${toolchain_image}" --arg acquisitionPolicyDigest "${acquisition_policy_digest}" \
    --arg sourceHead "${source_head}" --arg nodeBaseImage "${node_base_image}" --arg mavenBaseImage "${maven_base_image}" \
    '{schemaVersion:1,compatibilityDigest:$compatibilityDigest,fingerprint:$fingerprint,toolchainImage:$image,acquisitionPolicyDigest:$acquisitionPolicyDigest,sourceHead:$sourceHead,nodeBaseImage:$nodeBaseImage,mavenBaseImage:$mavenBaseImage}' \
    >"${warm}/.forge-warm-owner.json"
else
  [[ -d "${warm}" && ! -L "${warm}" ]] || die 'Existing verification warm workspace is unsafe.'
  jq -e --arg compatibilityDigest "${compatibility_digest}" --arg fingerprint "${fingerprint}" \
    --arg image "${toolchain_image}" --arg acquisitionPolicyDigest "${acquisition_policy_digest}" \
    --arg sourceHead "${source_head}" --arg nodeBaseImage "${node_base_image}" --arg mavenBaseImage "${maven_base_image}" \
    '.schemaVersion==1 and .compatibilityDigest==$compatibilityDigest and .fingerprint==$fingerprint and .toolchainImage==$image and .acquisitionPolicyDigest==$acquisitionPolicyDigest and .sourceHead==$sourceHead and .nodeBaseImage==$nodeBaseImage and .mavenBaseImage==$mavenBaseImage' \
    "${warm}/.forge-warm-owner.json" >/dev/null \
    || die 'Existing verification warm workspace belongs to a different compatibility closure.'
  for relative in m2/repository pnpm/store scratch; do
    [[ -d "${warm}/${relative}" && ! -L "${warm}/${relative}" ]] \
      || die "Existing verification warm workspace path is unsafe: ${relative}"
  done
fi
chown -R 1000:1000 "${warm}"
rm -rf -- "${warm}/scratch"
install -d -m 0700 -o 1000 -g 1000 "${warm}/scratch"

# This is the sole network-enabled dependency step. It is an explicit operator
# workflow, uses a reviewed immutable image and fixed commands, and publishes no
# credentials into TaskSpaces, Harness, Broker, or the verification runner.
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 4g --cpus 2 \
  --user 1000:1000 \
  --env XDG_CACHE_HOME=/warm/scratch/xdg-cache \
  --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
  --mount "type=bind,src=${warm},dst=/warm" \
  "${toolchain_image}" bash -Eeuo pipefail -c '
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

rm -rf -- "${warm}/scratch"
pnpm_projects="${warm}/pnpm/store/v11/projects"
if [[ -e "${pnpm_projects}" || -L "${pnpm_projects}" ]]; then
  [[ -d "${pnpm_projects}" && ! -L "${pnpm_projects}" ]] \
    || die 'pnpm project index is not an ordinary directory.'
  rm -rf -- "${pnpm_projects}"
fi
stage_token="$(openssl rand -hex 16)"
[[ "${stage_token}" =~ ^[0-9a-f]{32}$ ]] || die 'Could not generate a verification staging owner token.'
stage="${cache_root}/.incoming-${fingerprint}-${stage_token}"
stage_marker="${cache_root}/.incoming-${fingerprint}-${stage_token}.owner.json"
[[ ! -e "${stage}" && ! -L "${stage}" && ! -e "${stage_marker}" && ! -L "${stage_marker}" ]] \
  || die 'Verification staging owner token collided with an existing path.'
if ! (umask 077; set -o noclobber; jq -n --arg token "${stage_token}" --arg fingerprint "${fingerprint}" \
  --arg image "${toolchain_image}" --arg compatibilityDigest "${compatibility_digest}" \
  '{schemaVersion:1,token:$token,fingerprint:$fingerprint,toolchainImage:$image,compatibilityDigest:$compatibilityDigest}' \
  >"${stage_marker}"); then
  die 'Could not publish the verification staging owner marker.'
fi
mkdir -m 0700 -- "${stage}" || die 'Could not create the owned verification staging directory.'
warm_docker="${warm}"
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --user 1000:1000 \
  --mount "type=bind,src=${warm_docker},dst=/warm,readonly" \
  --mount "type=bind,src=${stage},dst=/staging" \
  "${toolchain_image}" bash -Eeuo pipefail -c '
    if find -P /warm/m2 /warm/pnpm -xdev ! -type f ! -type d -print -quit | grep -q .; then
      printf "%s\n" "verification warm contains a symbolic link or special node after pnpm metadata normalization" >&2
      exit 3
    fi
    cp -R --no-preserve=links,ownership,mode,timestamps -- /warm/m2 /warm/pnpm /staging/
  '

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 1g --cpus 1 \
  --user 1000:1000 \
  --env MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract},dst=/contract.json,readonly" \
  --mount "type=bind,src=${stage},dst=/staging" \
  "${toolchain_image}" node /usr/local/lib/verification-cache-tool.mjs publish \
    --workspace /workspace --contract /contract.json --staging /staging \
    --fingerprint "${fingerprint}" --node-base-image "${node_base_image}" \
    --maven-base-image "${maven_base_image}" >/dev/null

# The verification runner only copies from the published pack. Remove write
# permission from every identity before the atomic publish so the pack is not
# merely content-addressed at verification time but read-only on disk as well.
chmod -R a-w "${stage}"
chown -R "${host_uid}:${host_gid}" "${stage}"

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --cpus 1 \
  --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract},dst=/contract.json,readonly" \
  --mount "type=bind,src=${stage},dst=${contract_cache_root}/${fingerprint},readonly" \
  "${toolchain_image}" node /usr/local/lib/verification-cache-tool.mjs verify \
    --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null \
  || die 'The staged verification cache pack failed pre-publish networkless verification.'

mv -T --no-clobber -- "${stage}" "${final_pack}"
if ! docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --cpus 1 \
  --mount "type=bind,src=${workspace},dst=/workspace,readonly" \
  --mount "type=bind,src=${contract},dst=/contract.json,readonly" \
  --mount "type=bind,src=${image_cache_root},dst=${contract_cache_root},readonly" \
  "${toolchain_image}" node /usr/local/lib/verification-cache-tool.mjs verify \
    --workspace /workspace --contract /contract.json --fingerprint "${fingerprint}" >/dev/null; then
  mv -T --no-clobber -- "${final_pack}" "${stage}" \
    || die 'The invalid published cache could not be returned to its owned staging path.'
  die 'The published verification cache pack failed its final networkless verification.'
fi
cleanup_cache_stage || die 'Could not remove the verified staging owner marker.'
stage=''
stage_marker=''
stage_token=''
log "Published immutable verification cache ${fingerprint} for ${project_slug}."
