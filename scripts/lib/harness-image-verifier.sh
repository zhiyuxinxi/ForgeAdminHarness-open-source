#!/usr/bin/env bash

# shellcheck shell=bash
# Requires scripts/lib/common.sh and load_platform_config before use.

harness_image_supports_format_maintenance() {
  local image_id="${1:?Immutable Harness image ID is required.}"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  timeout 20 docker run --rm --pull never --network none --read-only --entrypoint node "${image_id}" \
    --input-type=module -e '
      const { TASK_PROFILES } = await import("/usr/local/lib/forge-task-execution-contract.mjs");
      process.exit(Array.isArray(TASK_PROFILES) && TASK_PROFILES.includes("frontend-format-maintenance") ? 0 : 1);
    ' >/dev/null 2>&1
}

harness_image_supports_contract_continuation() {
  local image_id="${1:?Immutable Harness image ID is required.}"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  timeout 20 docker run --rm --pull never --network none --read-only --entrypoint node "${image_id}" \
    --input-type=module -e '
      const { FORGE_CONTRACT_CONTINUATION_SUPPORTED } = await import("/usr/local/lib/forge-execution-context.mjs");
      process.exit(FORGE_CONTRACT_CONTINUATION_SUPPORTED === true ? 0 : 1);
    ' >/dev/null 2>&1
}

harness_image_supports_review_suspension() {
  local image_id="${1:?Immutable Harness image ID is required.}"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  timeout 20 docker run --rm --pull never --network none --read-only --entrypoint node "${image_id}" \
    --input-type=module -e '
      const { FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED } = await import("/usr/local/lib/forge-execution-context.mjs");
      process.exit(FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED === true ? 0 : 1);
    ' >/dev/null 2>&1
}

harness_image_supports_changed_verification() {
  local image_id="${1:?Immutable Harness image ID is required.}"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  timeout 20 docker run --rm --pull never --network none --read-only --entrypoint node "${image_id}" \
    --input-type=module -e '
      const { FORGE_CHANGED_VERIFICATION_SUPPORTED } = await import("/usr/local/lib/forge-execution-context.mjs");
      process.exit(FORGE_CHANGED_VERIFICATION_SUPPORTED === true ? 0 : 1);
    ' >/dev/null 2>&1
}

harness_image_supports_focused_backend_verification() {
  local image_id="${1:?Immutable Harness image ID is required.}"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  timeout 20 docker run --rm --pull never --network none --read-only --entrypoint node "${image_id}" \
    --input-type=module -e '
      const { FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED } = await import("/usr/local/lib/forge-execution-context.mjs");
      process.exit(FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED === true ? 0 : 1);
    ' >/dev/null 2>&1
}

harness_image_supports_ordinary_final_verification() {
  local image_id="${1:?Immutable Harness image ID is required.}"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  timeout 20 docker run --rm --pull never --network none --read-only --entrypoint node "${image_id}" \
    --input-type=module -e '
      const { FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED } = await import("/usr/local/lib/forge-execution-context.mjs");
      process.exit(FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED === true ? 0 : 1);
    ' >/dev/null 2>&1
}

harness_json_required_field() {
  local field="${1:?JSON field is required.}"
  node -e '
    const fs = require("node:fs");
    const field = process.argv[1];
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Object.prototype.hasOwnProperty.call(value, field)) process.exit(1);
    const selected = value[field];
    if (!["string", "number", "boolean"].includes(typeof selected)) process.exit(1);
    process.stdout.write(String(selected));
  ' "${field}"
}

verify_harness_layer_prefix() {
  local image_layers="${1:?Image layers JSON is required.}"
  local base_layers="${2:?Base layers JSON is required.}"
  local require_descendant="${3:-false}"
  node -e '
    const image = JSON.parse(process.argv[1]);
    const base = JSON.parse(process.argv[2]);
    const requireDescendant = process.argv[3] === "true";
    const lengthIsValid = requireDescendant
      ? image.length > base.length
      : image.length >= base.length;
    if (!Array.isArray(image) || !Array.isArray(base) || base.length === 0
        || !lengthIsValid || !base.every((layer, index) => image[index] === layer)) {
      process.exit(1);
    }
  ' "${image_layers}" "${base_layers}" "${require_descendant}"
}

verify_harness_layer_budget() {
  local image_id="${1:?Harness image ID is required.}"
  local max_layers="${2:-124}"
  local image_layers layer_count
  image_layers="$(docker image inspect --format '{{json .RootFS.Layers}}' "${image_id}")" \
    || die "Cannot inspect Harness image layer inventory: ${image_id}"
  layer_count="$(node -e '
    const layers = JSON.parse(process.argv[1]);
    if (!Array.isArray(layers)) process.exit(1);
    process.stdout.write(String(layers.length));
  ' "${image_layers}")" \
    || die "Harness image layer inventory is invalid: ${image_id}"
  [[ "${layer_count}" =~ ^[0-9]+$ && "${max_layers}" =~ ^[0-9]+$ \
    && "${layer_count}" -le "${max_layers}" ]] \
    || die "Harness image layer budget exceeded (${layer_count}/${max_layers}); rebuild with a shallower overlay before any runtime verification: ${image_id}"
}

verify_harness_os_package_inventory() {
  local image_id="${1:?Harness image ID is required.}"
  docker run --rm --network none --entrypoint sh "${image_id}" -ec '
    receipt=/usr/local/share/forge-os-package-inventory.tsv
    test -f "${receipt}" && test ! -L "${receipt}"
    current="$(mktemp)"
    trap '\''rm -f "${current}"'\'' EXIT HUP INT TERM
    dpkg-query -W -f='\''${binary:Package}\t${Version}\t${Architecture}\n'\'' \
      | LC_ALL=C sort >"${current}"
    cmp -s "${receipt}" "${current}"
  ' >/dev/null \
    || die "Harness image OS package inventory differs from its embedded snapshot receipt: ${image_id}"
}

verify_harness_runtime_tree_metadata() {
  local image_id="${1:?Harness image ID is required.}"
  docker run --rm --read-only --network none --entrypoint sh "${image_id}" \
    /usr/local/lib/validate-runtime-tree-metadata.sh /opt/forge-harness-runtime >/dev/null \
    || die "Harness runtime dependency tree metadata is unsafe: ${image_id}"
}

verify_harness_agent_preset_contract() {
  local image_id="${1:?Harness image ID is required.}"
  local live_policy embedded_policy prompt_contract
  live_policy="$(docker run --rm --read-only --network none --entrypoint node "${image_id}" \
    /usr/local/lib/forge-agent-preset-policy.mjs verify \
    --root /opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh/config/agent-presets)" \
    || die "Harness agent-preset filesystem policy failed live verification: ${image_id}"
  embedded_policy="$(docker run --rm --read-only --network none --entrypoint cat "${image_id}" \
    /usr/local/share/forge-image-build/agent-preset-policy.json)" \
    || die "Harness image has no embedded agent-preset policy receipt: ${image_id}"
  [[ "${live_policy}" == "${embedded_policy}" ]] \
    || die "Harness live agent-preset policy differs from its embedded receipt: ${image_id}"
  prompt_contract="$(docker run --rm --read-only --network none --entrypoint cat "${image_id}" \
    /usr/local/share/forge-image-build/agent-preset-prompt-contract.json)" \
    || die "Harness image has no assembled agent-preset prompt receipt: ${image_id}"
  node -e '
    const policy = JSON.parse(process.argv[1]);
    const prompt = JSON.parse(process.argv[2]);
    const expected = ["standard"];
    const requiredTools = ["bash", "edit", "glob", "grep", "read", "skill", "write"];
    if (policy.ok !== true || policy.schemaVersion !== "forge-agent-preset-governance/v1"
        || JSON.stringify(policy.allowedPresets) !== JSON.stringify(expected)
        || policy.includeUserRoot !== false
        || JSON.stringify(policy.presets?.map((item) => item.preset)) !== JSON.stringify(expected)
        || policy.presets.some((item) => !/^[0-9a-f]{64}$/.test(item.sha256))) process.exit(1);
    if (prompt.ok !== true || prompt.schemaVersion !== "forge-agent-preset-prompt-contract/v1"
        || prompt.defaultPreset !== "standard" || prompt.authorablePresetRoot !== false
        || JSON.stringify(prompt.presets?.map((item) => item.id)) !== JSON.stringify(expected)) process.exit(1);
    const standard = prompt.presets[0];
    if (standard.governanceMarkersPresent !== true || standard.skillAccessMode !== "native-skill-tool"
        || requiredTools.some((tool) => !standard.modelFacingTools.includes(tool))) process.exit(1);
  ' "${live_policy}" "${prompt_contract}" \
    || die "Harness assembled agent-preset prompt contract is invalid: ${image_id}"
}

verify_harness_capability_inventory() {
  local image_id="${1:?Harness image ID is required.}"
  docker run --rm --read-only --network none --entrypoint node "${image_id}" --input-type=module -e '
    import { readFile } from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { collectCapabilityInventoryIssues } from "/usr/local/lib/forge-capability-inventory.mjs";
    import { defaultCapabilityInventoryPath } from "/usr/local/lib/validate-skill-bundle.mjs";
    const file = "/usr/local/share/forge-image-build/capability-inventory.json";
    if (defaultCapabilityInventoryPath() !== file) throw new Error("Inventory is not enabled for its validator consumer");
    const inventory = JSON.parse(await readFile(file, "utf8"));
    const prompt = JSON.parse(await readFile("/usr/local/share/forge-image-build/agent-preset-prompt-contract.json", "utf8"));
    if (collectCapabilityInventoryIssues({ inventory, catalog: { skills: inventory.skills } }).length
      || prompt.capabilityInventory?.inventorySha256 !== inventory.inventorySha256
      || prompt.capabilityInventory.fixtures.length !== inventory.checkers.length
      || prompt.capabilityInventory.fixtures.some(row => !row.positivePassed || !row.negativeRejected)) throw new Error("Inventory or fixture binding differs");
    for (const source of inventory.sources.filter(row => row.path !== "skills.catalog.json")) {
      const target = source.path.startsWith("runtime/")
        ? "/opt/forge-harness-runtime/node_modules/@deepseek-ai/" + (source.path.startsWith("runtime/standard/") ? "dsh/config/agent-presets/" + source.path.slice(8) : source.path.slice(8))
        : "/usr/local/lib/" + source.path;
      if (createHash("sha256").update(await readFile(target)).digest("hex") !== source.sha256) throw new Error("Inventory runtime source differs: " + source.path);
    }
  ' || die "Harness capability inventory differs from its actual image source: ${image_id}"
}

verify_harness_protected_execution_contract() {
  local image_id="${1:?Harness image ID is required.}"
  docker run --rm --read-only --network none \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2m \
    --entrypoint sh "${image_id}" -ec '
      install -d -m 0700 /tmp/forge-protected-execution-smoke
      ln -s /opt/forge-harness-runtime/node_modules /tmp/forge-protected-execution-smoke/node_modules
      ln -s /usr/local/lib/forge-protected-session-mode.mjs /tmp/forge-protected-execution-smoke/forge-protected-session-mode.mjs
      ln -s /usr/local/lib/forge-protected-headless-runner.mjs /tmp/forge-protected-execution-smoke/forge-protected-headless-runner.mjs
      node --preserve-symlinks --input-type=module -e '\''
        const { loadExecutionPolicy } = await import("/usr/local/lib/forge-execution-context.mjs");
        await import("/usr/local/lib/forge-prepare-headless-execution.mjs");
        await import("/usr/local/lib/forge-recover-headless-execution.mjs");
        const runner = await import("file:///tmp/forge-protected-execution-smoke/forge-protected-headless-runner.mjs");
        const policy = await loadExecutionPolicy("/usr/local/lib/forge-execution-policy.json");
        if (policy.policyMode !== "production" || policy.defaultActionCeiling !== "read-only"
            || policy.writerRoutes.length !== 0 || runner.name !== "forge-protected-headless-runner"
            || !Array.isArray(runner.inject) || typeof runner.apply !== "function") process.exit(1);
      '\''
    ' >/dev/null \
    || die "Harness protected-execution imports or production policy smoke failed: ${image_id}"
}

verify_harness_core_runtime_contract() {
  local image_id="${1:?Harness image ID is required.}"
  docker run --rm --read-only --network none --entrypoint sh "${image_id}" -ec '
    test "${DSH_BUNDLED_SKILL_DIR:-}" = /opt/forge-skill-bundles/current/skills
    test ! -e /usr/local/share/dsh-skills
    test ! -e /usr/local/share/dsh-skills.catalog.json
    ! command -v java
    ! command -v javac
    ! command -v mvn
    ! command -v pnpm
    test ! -e /opt/forge-harness-runtime/node_modules/pnpm
    command -v dsh >/dev/null
    test -r /usr/local/lib/validate-skill-bundle.mjs
  ' >/dev/null \
    || die "Harness core runtime contract is invalid: ${image_id}"
}

verify_harness_foundation_image() {
  local foundation_image="${1:-${HARNESS_FOUNDATION_IMAGE:-}}"
  local expected_image_id="${2:-}"
  local expected_skill_bundle="${3:-${HARNESS_FOUNDATION_SKILL_BUNDLE_VERSION:-${HARNESS_SKILL_BUNDLE_VERSION:-}}}"
  local foundation_image_id revision skill_bundle runtime_profile
  local node_base maven_base image_user image_workdir image_entrypoint image_cmd image_os
  local host_receipt image_receipt embedded_receipt host_digest image_digest embedded_digest
  local runtime_receipt embedded_runtime_receipt runtime_digest embedded_runtime_digest
  local config_receipt config_digest assembly_mode offline_receipt offline_receipt_digest runtime_receipt_sha
  for command_name in docker grep node; do require_command "${command_name}"; done
  [[ -n "${foundation_image}" ]] \
    || die "HARNESS_FOUNDATION_IMAGE is not configured."
  [[ -n "${HARNESS_FOUNDATION_IMAGE_REVISION:-}" ]] \
    || die "HARNESS_FOUNDATION_IMAGE_REVISION is not configured."
  docker image inspect "${foundation_image}" >/dev/null 2>&1 \
    || die "Harness foundation image is unavailable: ${foundation_image}"
  foundation_image_id="$(docker image inspect --format '{{.Id}}' "${foundation_image}")"
  [[ "${foundation_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Harness foundation image has no immutable image ID: ${foundation_image}"
  if [[ -n "${expected_image_id}" ]]; then
    [[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ \
      && "${foundation_image_id}" == "${expected_image_id}" ]] \
      || die "Harness foundation reference differs from the expected immutable image ID."
  fi
  assembly_mode="${HARNESS_FOUNDATION_ASSEMBLY_MODE:-}"
  [[ -z "${assembly_mode}" || "${assembly_mode}" == offline-repack ]] \
    || die "Harness foundation assembly mode is invalid."
  if [[ "${assembly_mode}" == offline-repack ]]; then
    [[ "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || die "Offline-repacked Harness foundation requires an explicit immutable image ID."
  fi
  verify_harness_layer_budget "${foundation_image_id}"

  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${foundation_image_id}")"
  skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${foundation_image_id}")"
  runtime_profile="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-runtime-profile"}}' "${foundation_image_id}")"
  node_base="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-node-base-manifest"}}' "${foundation_image_id}")"
  maven_base="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-maven-base-manifest"}}' "${foundation_image_id}")"
  image_user="$(docker image inspect --format '{{.Config.User}}' "${foundation_image_id}")"
  image_workdir="$(docker image inspect --format '{{.Config.WorkingDir}}' "${foundation_image_id}")"
  image_entrypoint="$(docker image inspect --format '{{json .Config.Entrypoint}}' "${foundation_image_id}")"
  image_cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "${foundation_image_id}")"
  image_os="$(docker image inspect --format '{{.Os}}' "${foundation_image_id}")"
  [[ "${revision}" == "${HARNESS_FOUNDATION_IMAGE_REVISION}" \
    && "${skill_bundle}" == "${expected_skill_bundle}" \
    && "${runtime_profile}" == loopback-safe \
    && "${node_base}" == "${HARNESS_NODE_BASE_IMAGE}" \
    && "${maven_base}" == "${HARNESS_MAVEN_BASE_IMAGE}" \
    && "${image_user}" == 1000:1000 \
    && "${image_workdir}" == /workspace \
    && "${image_entrypoint}" == null \
    && "${image_cmd}" == '["/usr/local/bin/start-harness"]' \
    && "${image_os}" == linux ]] \
    || die "Harness foundation labels or safe runtime config are invalid."
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${foundation_image_id}" \
    | grep -Fx -- 'HARNESS_PRIVILEGED_API_MODE=loopback-only' >/dev/null \
    || die "Harness foundation is not the loopback-safe runtime profile."
  if [[ "${assembly_mode}" == offline-repack ]]; then
    config_receipt="$(node --input-type=module - "${REPO_ROOT}/scripts/validate-harness-image-config.mjs" "${foundation_image_id}" "${HARNESS_FOUNDATION_IMAGE_REVISION}" "${expected_skill_bundle}" "${DSH_VERSION}" "${HARNESS_NODE_BASE_IMAGE}" "${HARNESS_MAVEN_BASE_IMAGE}" <<'NODE'
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [modulePath, imageId, revision, skillBundle, dshVersion, nodeBase, mavenBase] = process.argv.slice(2);
const { validateConfigRelationship } = await import(pathToFileURL(modulePath).href);
const parsed = JSON.parse(execFileSync('docker', ['image', 'inspect', imageId], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('offline-repacked foundation image inspection is not unique');
const image = parsed[0];
if (image.Os !== 'linux' || image.Architecture !== 'amd64') throw new Error('offline-repacked foundation image is not linux/amd64');
const receipt = validateConfigRelationship('foundation', image, { Os: image.Os, Architecture: image.Architecture, Config: {} }, { revision, skillBundle, dshVersion, nodeBase, mavenBase });
process.stdout.write(JSON.stringify(receipt));
NODE
)" || die "Offline-repacked Harness foundation full runtime Config failed validation."
  else
    config_receipt="$(node "${REPO_ROOT}/scripts/validate-harness-image-config.mjs" \
      --kind foundation \
      --image "${foundation_image_id}" \
      --base-image "${HARNESS_MAVEN_BASE_IMAGE}" \
      --revision "${HARNESS_FOUNDATION_IMAGE_REVISION}" \
      --skill-bundle "${expected_skill_bundle}" \
      --dsh-version "${DSH_VERSION}" \
      --node-base "${HARNESS_NODE_BASE_IMAGE}" \
      --maven-base "${HARNESS_MAVEN_BASE_IMAGE}" \
      --json)" \
      || die "Harness foundation full runtime Config failed validation."
  fi
  config_digest="$(harness_json_required_field configDigest <<<"${config_receipt}")"
  verify_harness_os_package_inventory "${foundation_image_id}"
  verify_harness_runtime_tree_metadata "${foundation_image_id}"
  verify_harness_agent_preset_contract "${foundation_image_id}"
  verify_harness_protected_execution_contract "${foundation_image_id}"
  verify_harness_core_runtime_contract "${foundation_image_id}"

  if [[ "${assembly_mode}" == offline-repack ]]; then
    require_command sha256sum
    docker run --rm --network none --entrypoint test "${foundation_image_id}" \
      ! -e /usr/local/share/forge-image-build/receipt.json \
      || die "Offline-repacked Harness foundation unexpectedly retains the ordinary build-input receipt."
    offline_receipt="$(docker run --rm --network none --entrypoint cat "${foundation_image_id}" \
      /usr/local/share/forge-image-build/offline-repack-receipt.json)" \
      || die "Offline-repacked Harness foundation has no offline repack receipt."
    offline_receipt_digest="$(docker run --rm --network none --entrypoint cat "${foundation_image_id}" \
      /usr/local/share/forge-image-build/offline-repack-receipt.json | sha256sum | awk '{print $1}')"
    runtime_receipt_sha="$(docker run --rm --network none --entrypoint cat "${foundation_image_id}" \
      /usr/local/share/forge-image-build/runtime-dependency-receipt.json | sha256sum | awk '{print $1}')"
    node - "${offline_receipt}" "${offline_receipt_digest}" "${runtime_receipt_sha}" <<'NODE' \
      || die "Offline-repacked Harness foundation receipt is invalid."
const [receiptText, receiptDigest, runtimeDigest] = process.argv.slice(2);
const value = JSON.parse(receiptText);
const expected = {schemaVersion:'forge-harness-offline-repack/v1',outcome:'repacked',assemblySourceImageId:'sha256:78b601c43b34311fe033132366d2b7a776be981171e51a56732c9f8291f4724b',assemblySourceRevision:'vpn-forge-delivery-toolkit-76',dockerfileSha256:'c02aa8a7bbdcd49fb8491f1dd9c1d5357ee252c59c1184a0c5f0d57837c25bcd',networkMode:'none',removedCapabilities:['jdk','maven','direct-pnpm','embedded-skills']};
const expectedKeys = [...Object.keys(expected), 'runtimeDependencyReceiptSha256'].sort();
if (value === null || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) || value.schemaVersion !== expected.schemaVersion || value.outcome !== expected.outcome || value.assemblySourceImageId !== expected.assemblySourceImageId || value.assemblySourceRevision !== expected.assemblySourceRevision || value.dockerfileSha256 !== expected.dockerfileSha256 || value.networkMode !== expected.networkMode || JSON.stringify(value.removedCapabilities) !== JSON.stringify(expected.removedCapabilities) || value.runtimeDependencyReceiptSha256 !== runtimeDigest || !/^[0-9a-f]{64}$/.test(receiptDigest)) process.exit(2);
NODE
    host_digest="${offline_receipt_digest}"
  else
    host_receipt="$(node "${REPO_ROOT}/docker/harness/validate-image-build-inputs.mjs" \
      --mode source --root "${REPO_ROOT}" \
      --spec "${REPO_ROOT}/docker/harness/image-build-inputs.json" --json)" \
      || die "Host Harness foundation build inputs failed validation."
    image_receipt="$(docker run --rm --network none --entrypoint node "${foundation_image_id}" \
      /usr/local/lib/validate-image-build-inputs.mjs --mode image --root / \
      --spec /usr/local/share/forge-image-build/image-build-inputs.json --json)" \
      || die "Harness foundation build inputs failed validation."
    embedded_receipt="$(docker run --rm --network none --entrypoint cat "${foundation_image_id}" \
      /usr/local/share/forge-image-build/receipt.json)" \
      || die "Harness foundation has no embedded build-input receipt."
    host_digest="$(harness_json_required_field digest <<<"${host_receipt}")"
    image_digest="$(harness_json_required_field digest <<<"${image_receipt}")"
    embedded_digest="$(harness_json_required_field digest <<<"${embedded_receipt}")"
    [[ "${host_digest}" == "${image_digest}" && "${image_digest}" == "${embedded_digest}" ]] \
      || die "Harness foundation differs from the complete reviewed build inputs."
  fi
  runtime_receipt="$(docker run --rm --network none --entrypoint node "${foundation_image_id}" \
    /usr/local/lib/validate-runtime-dependencies.mjs --root /opt/forge-harness-runtime --smoke --json)" \
    || die "Harness foundation runtime dependency closure failed validation."
  embedded_runtime_receipt="$(docker run --rm --network none --entrypoint cat "${foundation_image_id}" \
    /usr/local/share/forge-image-build/runtime-dependency-receipt.json)" \
    || die "Harness foundation has no embedded runtime dependency receipt."
  runtime_digest="$(harness_json_required_field digest <<<"${runtime_receipt}")"
  embedded_runtime_digest="$(harness_json_required_field digest <<<"${embedded_runtime_receipt}")"
  [[ "$(harness_json_required_field schemaVersion <<<"${runtime_receipt}")" == 3 \
    && "$(harness_json_required_field schemaVersion <<<"${embedded_runtime_receipt}")" == 3 \
    && "${runtime_digest}" == "${embedded_runtime_digest}" ]] \
    || die "Harness foundation runtime dependency receipt is invalid."
  [[ "$(docker image inspect --format '{{.Id}}' "${foundation_image}")" == "${foundation_image_id}" ]] \
    || die "Harness foundation reference changed during verification."
  FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID="${foundation_image_id}"
  FORGE_VERIFIED_HARNESS_FOUNDATION_BUILD_DIGEST="${host_digest}"
  FORGE_VERIFIED_HARNESS_FOUNDATION_CONFIG_DIGEST="${config_digest}"
  export FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID FORGE_VERIFIED_HARNESS_FOUNDATION_BUILD_DIGEST \
    FORGE_VERIFIED_HARNESS_FOUNDATION_CONFIG_DIGEST
  printf '%s\n' "${foundation_image_id}"
}

resolve_configured_harness_foundation_image_id() {
  local baselines_root lock_file lock_real lock_ref foundation_image_id verified_image_id
  local owner_uid group_gid lock_fd lock_fd_path lock_metadata lock_identity lock_digest lock_contents
  for command_name in awk cat docker getent id readlink sha256sum stat; do require_command "${command_name}"; done
  [[ -n "${HARNESS_FOUNDATION_IMAGE:-}" ]] \
    || die "HARNESS_FOUNDATION_IMAGE is not configured."

  baselines_root="${HARNESS_IDENTITY_RECEIPT_ROOT:-${DELIVERY_ROOT}/baselines}"
  lock_file="${baselines_root}/baseline.lock"
  [[ -d "${baselines_root}" && ! -L "${baselines_root}" \
    && -f "${lock_file}" && ! -L "${lock_file}" ]] \
    || die "Harness foundation identity receipt is missing or unsafe: ${lock_file}"
  baselines_root="$(readlink -f -- "${baselines_root}")"
  lock_real="$(readlink -f -- "${lock_file}")"
  [[ "${lock_real}" == "${baselines_root}/baseline.lock" ]] \
    || die "Harness foundation identity receipt escaped the managed baseline directory."

  owner_uid="$(id -u "${DELIVERY_OWNER}")" \
    || die "Configured delivery owner does not exist: ${DELIVERY_OWNER}"
  group_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
  [[ "${group_gid}" =~ ^[0-9]+$ ]] \
    || die "Configured delivery group does not exist: ${DELIVERY_GROUP}"

  exec {lock_fd}<"${lock_file}" \
    || die "Harness foundation identity receipt cannot be opened safely."
  lock_fd_path="/proc/${BASHPID}/fd/${lock_fd}"
  [[ "$(readlink -f -- "${lock_fd_path}")" == "${lock_real}" ]] \
    || die "Harness foundation identity receipt changed while it was opened."
  lock_metadata="$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "${lock_fd_path}")"
  [[ "${lock_metadata}" == "${owner_uid}:${group_gid}:640:1:regular file" ]] \
    || die "Harness foundation identity receipt ownership, mode, link count, or type is invalid."
  lock_identity="$(stat -L -c '%d:%i' -- "${lock_fd_path}")"
  lock_digest="$(sha256sum -- "${lock_fd_path}" | awk '{print $1}')"
  lock_contents="$(cat <&${lock_fd})"

  lock_ref="$(awk -F= '$1 == "HARNESS_FOUNDATION_IMAGE" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1 && length(value) > 0) print value; else exit 1}' <<<"${lock_contents}")" \
    || die "Harness foundation receipt has no unique image reference."
  foundation_image_id="$(awk -F= '$1 == "HARNESS_FOUNDATION_IMAGE_ID" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1 && length(value) > 0) print value; else exit 1}' <<<"${lock_contents}")" \
    || die "Harness foundation receipt has no unique immutable image ID."
  [[ "${lock_ref}" == "${HARNESS_FOUNDATION_IMAGE}" \
    && "${foundation_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Configured Harness foundation differs from the persisted baseline receipt."

  if ! verify_registered_compacted_harness_image "${HARNESS_IMAGE}" "${foundation_image_id}" \
    && ! verify_registered_incremental_harness_image "${HARNESS_IMAGE}" "${foundation_image_id}"; then
    verify_harness_foundation_image "${HARNESS_FOUNDATION_IMAGE}" "${foundation_image_id}" >/dev/null
  fi
  verified_image_id="${FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID}"
  [[ "${verified_image_id}" == "${foundation_image_id}" ]] \
    || die "Verified Harness foundation differs from the persisted immutable image ID."
  [[ -f "${lock_file}" && ! -L "${lock_file}" \
    && "$(readlink -f -- "${lock_file}")" == "${lock_real}" \
    && "$(stat -c '%d:%i' -- "${lock_file}")" == "${lock_identity}" \
    && "$(LC_ALL=C stat -c '%u:%g:%a:%h:%F' -- "${lock_file}")" == "${lock_metadata}" \
    && "$(sha256sum -- "${lock_file}" | awk '{print $1}')" == "${lock_digest}" ]] \
    || die "Harness foundation identity receipt changed during image verification."
  exec {lock_fd}<&-
  printf '%s\n' "${verified_image_id}"
}

# Optional registration lives in the existing operator-owned baseline. A malformed
# registration is a hard failure; absent registration keeps the legacy verifier.
verify_registered_compacted_harness_image() {
  local target_image="${1:?Harness image is required.}"
  local foundation_id="${2:?Foundation image ID is required.}"
  local receipt
  receipt="$(node "${REPO_ROOT}/scripts/verify-harness-compaction.mjs" \
    --image "${target_image}" --foundation-id "${foundation_id}" \
    --receipt-root "${HARNESS_IDENTITY_RECEIPT_ROOT:-${DELIVERY_ROOT}/baselines}/harness-compactions")" \
    || die "Harness compaction receipt failed verification."
  [[ "$(harness_json_required_field registered <<<"${receipt}")" == true ]] || return 1
  FORGE_VERIFIED_HARNESS_IMAGE_ID="$(harness_json_required_field imageId <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_BUILD_DIGEST="$(harness_json_required_field buildDigest <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_BASE_IMAGE_ID="$(harness_json_required_field baseImageId <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_CONFIG_DIGEST="$(harness_json_required_field configDigest <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID="$(harness_json_required_field foundationImageId <<<"${receipt}")"
  export FORGE_VERIFIED_HARNESS_IMAGE_ID FORGE_VERIFIED_HARNESS_BUILD_DIGEST \
    FORGE_VERIFIED_HARNESS_BASE_IMAGE_ID FORGE_VERIFIED_HARNESS_CONFIG_DIGEST \
    FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID
}

verify_registered_incremental_harness_image() {
  local image="$1" foundation_id="$2" receipt_file receipt owner_uid group_gid
  receipt_file="${HARNESS_IDENTITY_RECEIPT_ROOT:-${DELIVERY_ROOT}/baselines}/baseline.lock"
  [[ -f "${receipt_file}" ]] || return 1
  owner_uid="$(id -u "${DELIVERY_OWNER}")" || die "Delivery owner is unavailable."
  group_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
  receipt="$(node "${REPO_ROOT}/scripts/validate-harness-image-config.mjs" \
    --kind registered-incremental --image "${image}" --foundation-id "${foundation_id}" \
    --identity-receipt "${receipt_file}" --owner-uid "${owner_uid}" --group-gid "${group_gid}" --json)" \
    || die "Registered incremental Harness artifact failed validation."
  [[ "$(harness_json_required_field registered <<<"${receipt}")" == true ]] || return 1
  FORGE_VERIFIED_HARNESS_IMAGE_ID="$(harness_json_required_field imageId <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_BUILD_DIGEST="$(harness_json_required_field buildDigest <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_BASE_IMAGE_ID="$(harness_json_required_field baseImageId <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_CONFIG_DIGEST="$(harness_json_required_field configDigest <<<"${receipt}")"
  FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID="$(harness_json_required_field foundationImageId <<<"${receipt}")"
  export FORGE_VERIFIED_HARNESS_IMAGE_ID FORGE_VERIFIED_HARNESS_BUILD_DIGEST \
    FORGE_VERIFIED_HARNESS_BASE_IMAGE_ID FORGE_VERIFIED_HARNESS_CONFIG_DIGEST \
    FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID
}

verify_target_harness_image() {
  local target_image="${1:-${HARNESS_IMAGE}}"
  local expected_base_image_id="${2:-${FORGE_EXPECTED_HARNESS_BASE_IMAGE_ID:-}}"
  local expected_inherited_id="${FORGE_VERIFIED_HARNESS_IMAGE_ID:-}"
  local target_image_id revision skill_bundle runtime_profile base_image_id
  local target_os target_arch base_os base_arch image_user image_workdir image_entrypoint image_cmd
  local host_receipt image_receipt embedded_receipt host_digest image_digest embedded_digest
  local runtime_receipt embedded_runtime_receipt runtime_digest embedded_runtime_digest
  local config_receipt config_digest
  local target_layers base_layers

  for command_name in docker grep node; do require_command "${command_name}"; done
  if verify_registered_compacted_harness_image "${target_image}" "${expected_base_image_id}" \
    || verify_registered_incremental_harness_image "${target_image}" "${expected_base_image_id}"; then
    [[ -z "${expected_inherited_id}" || "${expected_inherited_id}" == "${FORGE_VERIFIED_HARNESS_IMAGE_ID}" ]] \
      || die "Verified Harness image identity changed before cutover."
    return 0
  fi
  docker image inspect "${target_image}" >/dev/null 2>&1 \
    || die "Target Harness image is unavailable: ${target_image}"
  target_image_id="$(docker image inspect --format '{{.Id}}' "${target_image}")"
  [[ "${target_image_id}" == sha256:* ]] \
    || die "Target Harness image has no immutable image ID: ${target_image}"
  [[ "${expected_base_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Target Harness verification requires an externally resolved immutable base image ID."
  [[ -z "${expected_inherited_id}" || "${expected_inherited_id}" == "${target_image_id}" ]] \
    || die "Verified Harness image identity changed before cutover."
  verify_harness_layer_budget "${target_image_id}"

  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${target_image_id}")"
  skill_bundle="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-skill-bundle"}}' "${target_image_id}")"
  runtime_profile="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-runtime-profile"}}' "${target_image_id}")"
  base_image_id="$(docker image inspect --format '{{index .Config.Labels "com.forge-delivery.harness-base-image-id"}}' "${target_image_id}")"
  target_os="$(docker image inspect --format '{{.Os}}' "${target_image_id}")"
  target_arch="$(docker image inspect --format '{{.Architecture}}' "${target_image_id}")"
  base_os="$(docker image inspect --format '{{.Os}}' "${expected_base_image_id}")"
  base_arch="$(docker image inspect --format '{{.Architecture}}' "${expected_base_image_id}")"
  image_user="$(docker image inspect --format '{{.Config.User}}' "${target_image_id}")"
  image_workdir="$(docker image inspect --format '{{.Config.WorkingDir}}' "${target_image_id}")"
  image_entrypoint="$(docker image inspect --format '{{json .Config.Entrypoint}}' "${target_image_id}")"
  image_cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "${target_image_id}")"
  [[ "${revision}" == "${HARNESS_IMAGE_REVISION}" \
    && "${skill_bundle}" == "${HARNESS_SKILL_BUNDLE_VERSION}" \
    && "${runtime_profile}" == "${HARNESS_RUNTIME_PROFILE}" \
    && "${base_image_id}" == "${expected_base_image_id}" \
    && "${target_os}" == linux && "${target_os}" == "${base_os}" \
    && "${target_arch}" == "${base_arch}" \
    && "${image_user}" == 1000:1000 \
    && "${image_workdir}" == /workspace \
    && "${image_entrypoint}" == null \
    && "${image_cmd}" == '["/usr/local/bin/start-harness"]' ]] \
    || die "Target Harness image provenance/profile labels are invalid: ${target_image}"
  docker image inspect "${expected_base_image_id}" >/dev/null 2>&1 \
    || die "Target Harness base image content is unavailable: ${base_image_id}"
  target_layers="$(docker image inspect --format '{{json .RootFS.Layers}}' "${target_image_id}")"
  base_layers="$(docker image inspect --format '{{json .RootFS.Layers}}' "${expected_base_image_id}")"
  verify_harness_layer_prefix "${target_layers}" "${base_layers}" true \
    || die "Target Harness image does not inherit the externally verified base layer prefix."
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${target_image_id}" \
    | grep -Fx -- 'HARNESS_PRIVILEGED_API_MODE=trusted-host' >/dev/null \
    || die "Target Harness image is not the reviewed trusted-host runtime profile."
  config_receipt="$(node "${REPO_ROOT}/scripts/validate-harness-image-config.mjs" \
    --kind target \
    --image "${target_image_id}" \
    --base-image "${expected_base_image_id}" \
    --revision "${HARNESS_IMAGE_REVISION}" \
    --skill-bundle "${HARNESS_SKILL_BUNDLE_VERSION}" \
    --dsh-version "${DSH_VERSION}" \
    --runtime-profile "${HARNESS_RUNTIME_PROFILE}" \
    --base-image-id "${expected_base_image_id}" \
    --json)" \
    || die "Target Harness full runtime Config failed validation."
  config_digest="$(harness_json_required_field configDigest <<<"${config_receipt}")"
  verify_harness_os_package_inventory "${target_image_id}"
  verify_harness_runtime_tree_metadata "${target_image_id}"
  verify_harness_agent_preset_contract "${target_image_id}"
  verify_harness_capability_inventory "${target_image_id}"
  verify_harness_protected_execution_contract "${target_image_id}"
  verify_harness_core_runtime_contract "${target_image_id}"

  # The retained foundation may predate output archives; require the complete
  # consumer closure only on the new target selected for existing projects.
  docker run --rm --read-only --network none --entrypoint node "${target_image_id}" \
    --check /usr/local/lib/conversation-output.js \
    || die "Target Harness conversation-output asset failed syntax verification."
  docker run --rm --read-only --network none --entrypoint node "${target_image_id}" \
    --input-type=module -e 'await import("/usr/local/lib/harness-tcp-proxy.mjs");await import("/usr/local/lib/harness-upload-server.mjs");await import("/usr/local/lib/conversation-manager.mjs");const store=await import("/usr/local/lib/conversation-output-store.mjs");const projection=await import("/usr/local/lib/conversation-output-projection.mjs");const service=await import("/usr/local/lib/conversation-output-service.mjs");const history=await import("/usr/local/lib/forge-recover-headless-execution.mjs");if(typeof store.createConversationOutputStore!=="function"||typeof projection.projectConversationOutput!=="function"||typeof service.createConversationOutputService!=="function"||typeof history.readPinnedDshConversationHistory!=="function")process.exit(1)' \
    || die "Target Harness conversation-output consumer imports failed verification."

  host_receipt="$(node "${REPO_ROOT}/docker/harness/validate-image-build-inputs.mjs" \
    --mode source \
    --root "${REPO_ROOT}" \
    --spec "${REPO_ROOT}/docker/harness/image-build-inputs.json" \
    --json)" \
    || die "Host Harness build inputs failed validation."
  image_receipt="$(docker run --rm --network none --entrypoint node "${target_image_id}" \
    /usr/local/lib/validate-image-build-inputs.mjs \
    --mode image \
    --root / \
    --spec /usr/local/share/forge-image-build/image-build-inputs.json \
    --json)" \
    || die "Target Harness image build inputs failed validation."
  embedded_receipt="$(docker run --rm --network none --entrypoint cat "${target_image_id}" \
    /usr/local/share/forge-image-build/receipt.json)" \
    || die "Target Harness image has no embedded build-input receipt."
  host_digest="$(harness_json_required_field digest <<<"${host_receipt}")"
  image_digest="$(harness_json_required_field digest <<<"${image_receipt}")"
  embedded_digest="$(harness_json_required_field digest <<<"${embedded_receipt}")"
  [[ "${host_digest}" == "${image_digest}" && "${image_digest}" == "${embedded_digest}" ]] \
    || die "Target Harness image does not match the complete reviewed build-input manifest."
  runtime_receipt="$(docker run --rm --network none --entrypoint node "${target_image_id}" \
    /usr/local/lib/validate-runtime-dependencies.mjs \
    --root /opt/forge-harness-runtime \
    --smoke \
    --json)" \
    || die "Target Harness runtime dependency closure failed validation."
  embedded_runtime_receipt="$(docker run --rm --network none --entrypoint cat "${target_image_id}" \
    /usr/local/share/forge-image-build/runtime-dependency-receipt.json)" \
    || die "Target Harness image has no embedded runtime dependency receipt."
  runtime_digest="$(harness_json_required_field digest <<<"${runtime_receipt}")"
  embedded_runtime_digest="$(harness_json_required_field digest <<<"${embedded_runtime_receipt}")"
  [[ "$(harness_json_required_field schemaVersion <<<"${runtime_receipt}")" == 3 \
    && "$(harness_json_required_field schemaVersion <<<"${embedded_runtime_receipt}")" == 3 \
    && "${runtime_digest}" == "${embedded_runtime_digest}" ]] \
    || die "Target Harness runtime dependency receipt drifted from the installed closure."

  docker run --rm --network none --entrypoint forge-delivery "${target_image_id}" --help >/dev/null \
    || die "Target Harness image does not expose forge-delivery."
  [[ "$(docker image inspect --format '{{.Id}}' "${target_image}")" == "${target_image_id}" ]] \
    || die "Target Harness image tag changed during verification."

  FORGE_VERIFIED_HARNESS_IMAGE_ID="${target_image_id}"
  FORGE_VERIFIED_HARNESS_BUILD_DIGEST="${host_digest}"
  FORGE_VERIFIED_HARNESS_BASE_IMAGE_ID="${expected_base_image_id}"
  FORGE_VERIFIED_HARNESS_CONFIG_DIGEST="${config_digest}"
  export FORGE_VERIFIED_HARNESS_IMAGE_ID FORGE_VERIFIED_HARNESS_BUILD_DIGEST \
    FORGE_VERIFIED_HARNESS_BASE_IMAGE_ID FORGE_VERIFIED_HARNESS_CONFIG_DIGEST
}

resolve_configured_harness_image_id() {
  local baselines_root lock_file lock_real lock_ref target_image_id foundation_ref foundation_image_id
  local verified_target_id owner_uid group_gid lock_fd lock_fd_path lock_metadata lock_identity lock_digest lock_contents
  for command_name in awk cat docker getent id readlink sha256sum stat; do require_command "${command_name}"; done
  [[ -n "${HARNESS_FOUNDATION_IMAGE:-}" && -n "${HARNESS_IMAGE:-}" ]] \
    || die "Harness foundation and target images must be configured."

  baselines_root="${HARNESS_IDENTITY_RECEIPT_ROOT:-${DELIVERY_ROOT}/baselines}"
  lock_file="${baselines_root}/baseline.lock"
  [[ -d "${baselines_root}" && ! -L "${baselines_root}" \
    && -f "${lock_file}" && ! -L "${lock_file}" ]] \
    || die "Harness target identity receipt is missing or unsafe: ${lock_file}"
  baselines_root="$(readlink -f -- "${baselines_root}")"
  lock_real="$(readlink -f -- "${lock_file}")"
  [[ "${lock_real}" == "${baselines_root}/baseline.lock" ]] \
    || die "Harness target identity receipt escaped the managed baseline directory."

  owner_uid="$(id -u "${DELIVERY_OWNER}")" \
    || die "Configured delivery owner does not exist: ${DELIVERY_OWNER}"
  group_gid="$(getent group "${DELIVERY_GROUP}" | awk -F: 'NR == 1 {print $3}')"
  [[ "${group_gid}" =~ ^[0-9]+$ ]] \
    || die "Configured delivery group does not exist: ${DELIVERY_GROUP}"

  exec {lock_fd}<"${lock_file}" \
    || die "Harness target identity receipt cannot be opened safely."
  lock_fd_path="/proc/${BASHPID}/fd/${lock_fd}"
  [[ "$(readlink -f -- "${lock_fd_path}")" == "${lock_real}" ]] \
    || die "Harness target identity receipt changed while it was opened."
  lock_metadata="$(LC_ALL=C stat -L -c '%u:%g:%a:%h:%F' -- "${lock_fd_path}")"
  [[ "${lock_metadata}" == "${owner_uid}:${group_gid}:640:1:regular file" ]] \
    || die "Harness target identity receipt ownership, mode, link count, or type is invalid."
  lock_identity="$(stat -L -c '%d:%i' -- "${lock_fd_path}")"
  lock_digest="$(sha256sum -- "${lock_fd_path}" | awk '{print $1}')"
  lock_contents="$(cat <&${lock_fd})"

  foundation_ref="$(awk -F= '$1 == "HARNESS_FOUNDATION_IMAGE" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1 && length(value) > 0) print value; else exit 1}' <<<"${lock_contents}")" \
    || die "Harness target receipt has no unique foundation reference."
  foundation_image_id="$(awk -F= '$1 == "HARNESS_FOUNDATION_IMAGE_ID" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1 && length(value) > 0) print value; else exit 1}' <<<"${lock_contents}")" \
    || die "Harness target receipt has no unique foundation image ID."
  lock_ref="$(awk -F= '$1 == "HARNESS_IMAGE" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1 && length(value) > 0) print value; else exit 1}' <<<"${lock_contents}")" \
    || die "Harness target receipt has no unique image reference."
  target_image_id="$(awk -F= '$1 == "HARNESS_IMAGE_ID" {count += 1; sub(/^[^=]*=/, ""); value=$0} END {if (count == 1 && length(value) > 0) print value; else exit 1}' <<<"${lock_contents}")" \
    || die "Harness target receipt has no unique immutable image ID."
  [[ "${foundation_ref}" == "${HARNESS_FOUNDATION_IMAGE}" \
    && "${lock_ref}" == "${HARNESS_IMAGE}" \
    && "${foundation_image_id}" =~ ^sha256:[0-9a-f]{64}$ \
    && "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "Configured Harness images differ from the persisted target identity receipt."

  if ! verify_registered_incremental_harness_image "${HARNESS_IMAGE}" "${foundation_image_id}"; then
    verify_harness_foundation_image "${HARNESS_FOUNDATION_IMAGE}" "${foundation_image_id}" >/dev/null
    verify_target_harness_image "${HARNESS_IMAGE}" "${foundation_image_id}"
  fi
  verified_target_id="${FORGE_VERIFIED_HARNESS_IMAGE_ID}"
  [[ "${verified_target_id}" == "${target_image_id}" ]] \
    || die "Verified Harness target differs from the persisted immutable image ID."
  [[ -f "${lock_file}" && ! -L "${lock_file}" \
    && "$(readlink -f -- "${lock_file}")" == "${lock_real}" \
    && "$(stat -c '%d:%i' -- "${lock_file}")" == "${lock_identity}" \
    && "$(LC_ALL=C stat -c '%u:%g:%a:%h:%F' -- "${lock_file}")" == "${lock_metadata}" \
    && "$(sha256sum -- "${lock_file}" | awk '{print $1}')" == "${lock_digest}" ]] \
    || die "Harness target identity receipt changed during image verification."
  exec {lock_fd}<&-
  printf '%s\n' "${verified_target_id}"
}
