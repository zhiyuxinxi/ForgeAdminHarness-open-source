import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repo = new URL('../', import.meta.url);

async function text(relative) {
  return readFile(new URL(relative, repo), 'utf8');
}

test('foundation OS packages come from one immutable Ubuntu snapshot and are inventoried', async () => {
  const [dockerfile, overlay, sources, manifest, verifier] = await Promise.all([
    text('docker/harness/Dockerfile'),
    text('docker/harness/Dockerfile.overlay'),
    text('docker/harness/ubuntu.sources'),
    text('docker/harness/image-build-inputs.json'),
    text('scripts/lib/harness-image-verifier.sh'),
  ]);
  assert.match(sources, /^URIs: https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\d{8}T\d{6}Z\/$/mu);
  assert.match(sources, /^Suites: noble noble-updates noble-security$/mu);
  assert.match(sources, /^Check-Valid-Until: no$/mu);
  assert.match(dockerfile, /apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update/u);
  assert.match(dockerfile, /apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install/u);
  assert.match(dockerfile, /update_attempt=1[\s\S]*apt-cache show iproute2 jq ripgrep[\s\S]*\[ "\$\{update_attempt\}" -lt 3 \] \|\| exit 100/u);
  assert.match(dockerfile, /install_attempt=1[\s\S]*until apt-get[\s\S]*\[ "\$\{install_attempt\}" -lt 3 \] \|\| exit 100/u);
  assert.ok(
    dockerfile.indexOf('ARG HARNESS_IMAGE_REVISION=') > dockerfile.indexOf('forge-os-package-inventory.tsv'),
    'release-only identity changes must not invalidate the pinned apt dependency layer',
  );
  for (const source of [dockerfile, overlay]) {
    assert.match(source, /COPY --chmod=0644 docker\/harness\/ubuntu\.sources \/etc\/apt\/sources\.list\.d\/ubuntu\.sources/u);
    assert.match(source, /forge-os-package-inventory\.tsv/u);
  }
  assert.match(manifest, /"source": "docker\/harness\/ubuntu\.sources"/u);
  assert.match(verifier, /verify_harness_os_package_inventory/u);
  assert.match(verifier, /dpkg-query -W/u);
});

test('runtime install is source-preflighted, scriptless during network access, then rebuilt unprivileged without network', async () => {
  const [dockerfile, overlay] = await Promise.all([
    text('docker/harness/Dockerfile'),
    text('docker/harness/Dockerfile.overlay'),
  ]);
  for (const source of [dockerfile, overlay]) {
    const preflight = source.indexOf('--mode source --root /opt/forge-harness-runtime');
    const install = source.indexOf('npm ci --omit=dev --no-audit --no-fund --ignore-scripts');
    const unprivileged = source.lastIndexOf('USER 1000:1000', install);
    const isolatedRebuild = source.indexOf('RUN --network=none', install);
    const rebuild = source.indexOf('npm rebuild --no-audit --no-fund --strict-allow-scripts', isolatedRebuild);
    assert.ok(preflight >= 0 && preflight < install, 'source policy must run before dependency installation');
    assert.ok(unprivileged > preflight && unprivileged < install, 'networked unpack must run as uid 1000');
    assert.ok(isolatedRebuild > install && rebuild > isolatedRebuild, 'approved scripts must run in a network-none rebuild');
    assert.doesNotMatch(source, /npm ci[^\n]*strict-allow-scripts/u);
    assert.match(source, /Object\.keys\(value\).*\["allowScripts"\]/u);
    assert.match(source, /--smoke --json > \/usr\/local\/share\/forge-image-build\/runtime-dependency-receipt\.json/u);
  }
});

test('final runtime tree metadata is root-owned and live-verified without following links', async () => {
  const [dockerfile, overlay, metadataGate, manifest, verifier] = await Promise.all([
    text('docker/harness/Dockerfile'),
    text('docker/harness/Dockerfile.overlay'),
    text('docker/harness/validate-runtime-tree-metadata.sh'),
    text('docker/harness/image-build-inputs.json'),
    text('scripts/lib/harness-image-verifier.sh'),
  ]);
  for (const source of [dockerfile, overlay]) {
    assert.match(source, /docker\/harness\/validate-runtime-tree-metadata\.sh/u);
    assert.match(source, /(?:COPY --chmod=0755 docker\/harness\/validate-runtime-tree-metadata\.sh|chmod 0755 \/usr\/local\/lib\/validate-runtime-tree-metadata\.sh)/u);
    assert.match(source, /validate-runtime-tree-metadata\.sh \/opt\/forge-harness-runtime/u);
    assert.match(source, /chmod 0755[\s\S]*\/usr\/local\/share\/forge-image-build/u);
  }
  assert.equal((overlay.match(/chown -hR/gu) ?? []).length, 2);
  assert.doesNotMatch(overlay, /chown -R/u);
  assert.match(metadataGate, /find -P "\$\{runtime_root\}" -xdev/u);
  assert.match(metadataGate, /! -uid 0 -o ! -gid 0/u);
  assert.match(metadataGate, /-perm \/06022/u);
  assert.match(metadataGate, /-type f -a ! -links 1/u);
  assert.match(metadataGate, /-type l -a ! -links 1/u);
  assert.match(manifest, /"source": "docker\/harness\/validate-runtime-tree-metadata\.sh"/u);
  assert.equal((verifier.match(/verify_harness_runtime_tree_metadata "\$\{(?:foundation|target)_image_id\}"/gu) ?? []).length, 2);
  assert.match(verifier, /docker run --rm --read-only --network none --entrypoint sh/u);
});

test('live verification rejects images that exhaust the Docker layer budget before runtime probes', async () => {
  const verifier = await text('scripts/lib/harness-image-verifier.sh');
  assert.match(verifier, /verify_harness_layer_budget\(\)/u);
  assert.match(verifier, /local max_layers="\$\{2:-124\}"/u);
  assert.equal((verifier.match(/verify_harness_layer_budget "\$\{(?:foundation|target)_image_id\}"/gu) ?? []).length, 2);
  assert.match(verifier, /layer budget exceeded/u);
});

test('protected execution assets are import-smoked with the production read-only policy', async () => {
  const [dockerfile, overlay, manifest, verifier] = await Promise.all([
    text('docker/harness/Dockerfile'),
    text('docker/harness/Dockerfile.overlay'),
    text('docker/harness/image-build-inputs.json'),
    text('scripts/lib/harness-image-verifier.sh'),
  ]);
  for (const source of [dockerfile, overlay]) {
    assert.match(source, /forge-protected-execution-smoke/u);
    assert.match(source, /forge-protected-execution-smoke\/forge-protected-session-mode\.mjs/u);
    assert.match(source, /forge-recover-headless-execution\.mjs/u);
    assert.match(source, /loadExecutionPolicy\("\/usr\/local\/lib\/forge-execution-policy\.json"\)/u);
    assert.match(source, /policy\.policyMode!=="production"/u);
    assert.match(source, /policy\.defaultActionCeiling!=="read-only"/u);
    assert.match(source, /runner\.name!=="forge-protected-headless-runner"/u);
  }
  for (const required of [
    'docker/harness/forge-delivery-phase-runtime.mjs',
    'docker/harness/forge-delivery-phase-response.mjs',
    'docker/harness/forge-execution-context.mjs',
    'docker/harness/forge-execution-policy.json',
    'docker/harness/forge-prepare-headless-execution.mjs',
    'docker/harness/forge-recover-headless-execution.mjs',
    'docker/harness/forge-protected-session-mode.mjs',
    'docker/harness/forge-protected-headless-runner.mjs',
  ]) {
    assert.match(manifest, new RegExp(required.replaceAll('/', '\\/').replaceAll('.', '\\.'), 'u'));
  }
  assert.match(verifier, /verify_harness_protected_execution_contract/u);
  assert.match(verifier, /--tmpfs \/tmp:rw,noexec,nosuid,nodev,size=2m/u);
  assert.match(verifier, /forge-protected-execution-smoke\/forge-protected-session-mode\.mjs/u);
  assert.match(verifier, /forge-recover-headless-execution\.mjs/u);
  assert.match(verifier, /policy\.writerRoutes\.length !== 0/u);
  assert.equal((verifier.match(/verify_harness_protected_execution_contract "\$\{(?:foundation|target)_image_id\}"/gu) ?? []).length, 2);
});

test('linux amd64 glibc optional natives and lifecycle approvals are exact', async () => {
  const packageJson = JSON.parse(await text('docker/harness/runtime-dependencies/package.json'));
  assert.deepEqual(packageJson.os, ['linux']);
  assert.deepEqual(packageJson.cpu, ['x64']);
  assert.deepEqual(packageJson.libc, ['glibc']);
  assert.equal(packageJson.scripts, undefined);
  assert.deepEqual(Object.keys(packageJson.allowScripts).sort(), [
    '@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2',
    '@google/genai@1.52.0',
    'koffi@3.1.6',
    'node-pty@1.2.0-beta.15',
    'protobufjs@7.6.6',
  ]);
  assert.deepEqual(packageJson.forgeRuntimePolicy.requiredOptionalPackages, {
    'node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64': '0.1.1',
    'node_modules/@img/sharp-libvips-linux-x64': '1.3.3',
    'node_modules/@img/sharp-linux-x64': '0.35.4',
    'node_modules/@koromix/koffi-linux-x64': '3.1.6',
    'node_modules/@napi-rs/canvas': '1.0.8',
    'node_modules/@napi-rs/canvas-linux-x64-gnu': '1.0.8',
    'node_modules/@vscode/ripgrep-linux-x64': '1.18.0',
    'node_modules/node-addon-require-builtin-linux-x64-gnu': '0.1.5',
  });
});

test('the full runtime Config relationship validator is mandatory for foundation and target verification', async () => {
  const verifier = await text('scripts/lib/harness-image-verifier.sh');
  assert.match(verifier, /validate-harness-image-config\.mjs[\s\S]*--kind foundation/u);
  assert.match(verifier, /validate-harness-image-config\.mjs[\s\S]*--kind target/u);
  assert.match(verifier, /"\$\{maven_base\}" == "\$\{HARNESS_MAVEN_BASE_IMAGE\}"/u);
  assert.doesNotMatch(verifier, /verify_harness_layer_prefix "\$\{foundation_layers\}" "\$\{maven_layers\}"/u);
  assert.match(verifier, /verify_harness_core_runtime_contract "\$\{foundation_image_id\}"/u);
  assert.match(verifier, /verify_harness_layer_prefix "\$\{target_layers\}" "\$\{base_layers\}" true/u);
  assert.doesNotMatch(verifier, /\bjq\b/u);
  assert.match(verifier, /FORGE_VERIFIED_HARNESS_FOUNDATION_CONFIG_DIGEST/u);
  assert.match(verifier, /FORGE_VERIFIED_HARNESS_CONFIG_DIGEST/u);
});

test('offline-repacked foundations use the reviewed synthetic parent and exact repack receipt', async () => {
  const verifier = await text('scripts/lib/harness-image-verifier.sh');
  const offlineStart = verifier.indexOf('if [[ "${assembly_mode}" == offline-repack ]]; then');
  const offlineConfigEnd = verifier.indexOf('  else\n    config_receipt=', offlineStart);
  assert.ok(offlineStart >= 0 && offlineConfigEnd > offlineStart, 'offline foundation Config branch is missing');
  const offlineConfig = verifier.slice(offlineStart, offlineConfigEnd);
  assert.match(offlineConfig, /validateConfigRelationship\('foundation', image, \{ Os: image\.Os, Architecture: image\.Architecture, Config: \{\} \}/u);
  assert.match(offlineConfig, /image\.Os !== 'linux' \|\| image\.Architecture !== 'amd64'/u);
  assert.doesNotMatch(offlineConfig, /--base-image|inspectImage\(/u);
  for (const required of [
    'offline-repack-receipt.json',
    "schemaVersion:'forge-harness-offline-repack/v1'",
    "outcome:'repacked'",
    "assemblySourceImageId:'sha256:78b601c43b34311fe033132366d2b7a776be981171e51a56732c9f8291f4724b'",
    "assemblySourceRevision:'vpn-forge-delivery-toolkit-76'",
    "dockerfileSha256:'c02aa8a7bbdcd49fb8491f1dd9c1d5357ee252c59c1184a0c5f0d57837c25bcd'",
    "networkMode:'none'",
    "removedCapabilities:['jdk','maven','direct-pnpm','embedded-skills']",
    'runtimeDependencyReceiptSha256 !== runtimeDigest',
    'Object.keys(value).sort()',
  ]) assert.match(verifier, new RegExp(required.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(verifier, /entrypoint test "\$\{foundation_image_id\}"[\s\\]*! -e \/usr\/local\/share\/forge-image-build\/receipt\.json/u);
});

test('new projects and the control plane persist only the verified immutable target ID', async () => {
  const [verifier, createProject, projectTemplate, controlPlane] = await Promise.all([
    text('scripts/lib/harness-image-verifier.sh'),
    text('scripts/create-project.sh'),
    text('templates/project/project.env.tpl'),
    text('scripts/conversation-control-planectl.sh'),
  ]);
  assert.match(verifier, /resolve_configured_harness_image_id\(\)/u);
  assert.match(verifier, /HARNESS_IMAGE_ID/u);
  assert.match(createProject, /harness_image_id="\$\(resolve_configured_harness_image_id\)"/u);
  assert.match(createProject, /__HARNESS_IMAGE__\/\$\{harness_image_id\}/u);
  assert.match(createProject, /__HARNESS_IMAGE_SOURCE__\/\$\{HARNESS_IMAGE\}/u);
  assert.match(projectTemplate, /^HARNESS_IMAGE_SOURCE=__HARNESS_IMAGE_SOURCE__$/mu);
  assert.match(controlPlane, /HARNESS_IMAGE=\$\{harness_image_id\}/u);
  assert.match(controlPlane, /HARNESS_IMAGE_SOURCE=\$\{HARNESS_IMAGE\}/u);
  assert.match(controlPlane, /verify_control_env_harness_identity/u);
});
