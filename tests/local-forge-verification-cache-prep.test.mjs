import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateMavenVerificationSettings } from '../docker/harness/maven-verification-policy.mjs';
import { readCacheCompatibilityImplementation } from '../docker/harness/verification-cache-tool.mjs';

const scriptUrl = new URL('../scripts/prepare-local-forge-harness-eval-cache.sh', import.meta.url);
const script = await readFile(scriptUrl, 'utf8');
const cacheTool = await readFile(new URL('../docker/harness/verification-cache-tool.mjs', import.meta.url), 'utf8');
const mavenPolicy = await readFile(new URL('../docker/harness/maven-verification-policy.mjs', import.meta.url), 'utf8');
const mavenSettings = await readFile(new URL('../docker/harness/maven-verification-settings.xml', import.meta.url), 'utf8');
const mavenExec = await readFile(new URL('../docker/harness/maven-verification-exec.sh', import.meta.url), 'utf8');

test('local eval cache preparation is syntactically valid and explicitly confirmed', () => {
  const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /--confirm-local-cache-warm/u);
  assert.match(script, /--seed-warm/u);
  assert.match(script, /CONFIRMED=0/u);
  assert.match(script, /network-enabled dependency preparation requires --confirm-local-cache-warm/u);
  assert.match(script, /6eb2881e6f6af85a5348acf3da63cef53a873b0e/u);
  assert.match(script, /'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build'/u);
  assert.match(script, /status --porcelain=v1 --untracked-files=all/u);
  assert.match(script, /CACHE_WARM_MIN_FREE_BYTES=6442450944/u);
  assert.match(script, /fs\.statfsSync\(process\.argv\[2\], \{ bigint: true \}\)/u);
  assert.match(script, /needs at least 6 GiB free before dependency warm/u);
  assert.match(script, /\.cache-warm\.lock/u);
  assert.match(script, /cache_lock_acquired=0/u);
  assert.match(script, /cache_lock_acquired=1/u);
  assert.match(script, /another local verification cache preparation is active/u);
  assert.match(script, /local cache lock ownership changed during execution/u);
});

test('an existing verified final pack bypasses the free-space and network-warm gates', () => {
  const existingFinalFastPath = script.indexOf('if [[ -d "${final_pack}" && ! -L "${final_pack}" ]]');
  const freeSpaceGate = script.indexOf('cache_available_bytes="$(node - "${CACHE_ROOT}"');
  const networkWarm = script.indexOf('# Sole network-enabled step:');
  assert.ok(existingFinalFastPath >= 0, 'existing-final fast path is missing');
  assert.ok(freeSpaceGate > existingFinalFastPath, 'free-space gate must follow the existing-final fast path');
  assert.ok(networkWarm > freeSpaceGate, 'network warm must follow the free-space gate');
});

test('local eval cache preparation has one fixed network warm and networkless fingerprint, publish, and verify', () => {
  assert.match(script, /# Sole network-enabled step:/u);
  assert.match(script, /--user 1000:1000/u);
  assert.match(script, /--env XDG_CACHE_HOME=\/warm\/scratch\/xdg-cache/u);
  assert.match(script, /--env MAVEN_OPTS=-Djansi\.tmpdir=\/tmp\/forge-maven-jansi/u);
  assert.match(script, /--tmpfs \/tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700/u);
  assert.ok((script.match(/--tmpfs \/tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700/gu) ?? []).length >= 4);
  assert.doesNotMatch(script, /--tmpfs \/workspace\/(?:forge-admin-ui|forge-h5-ui)\/node_modules/u);
  assert.match(script, /--mount "type=bind,src=\$\{source_docker\},dst=\/workspace,readonly"/u);
  assert.match(script, /--mount "type=bind,src=\$\{warm_docker\},dst=\/warm"/u);
  assert.match(script, /mvn --strict-checksums --settings \/usr\/local\/lib\/maven-verification-settings\.xml/u);
  assert.match(script, /\/usr\/local\/bin\/maven-verification-exec/u);
  assert.match(script, /\/proc\/self\/mountinfo/u);
  assert.match(script, /forge-exec-probe/u);
  assert.match(script, /exec_probe_source="\$\(type -P true\)"/u);
  assert.doesNotMatch(script, /cp -- "\$\(command -v true\)"/u);
  assert.match(script, /Failed to load native library\|failed to map segment/u);
  assert.doesNotMatch(script, /(?:\/home\/node\/\.cache\/jansi|\/tmp\/jansi)/u);
  assert.match(script, /--no-transfer-progress -f \/workspace\/forge-server\/pom\.xml/u);
  assert.match(script, /-Penable-tests -DskipTests dependency:go-offline/u);
  assert.match(script, /pnpm --dir \/workspace\/forge-admin-ui fetch[\s\S]*pnpm --dir \/workspace\/forge-h5-ui fetch/u);
  assert.equal((script.match(/--ignore-scripts/gu) ?? []).length, 5);
  assert.match(script, /const expectedCommands = \[[\s\S]*?forge-admin-ui'[\s\S]*?'--ignore-scripts'[\s\S]*?forge-h5-ui'[\s\S]*?'--ignore-scripts'/u);
  assert.match(script, /fs\.rmSync\(scratch, \{ recursive: true, force: false \}\)/u);
  assert.equal((script.match(/no-lifecycle-execution-lines/gu) ?? []).length, 1);
  assert.equal((script.match(/ \(preinstall\|install\|postinstall\)/gu) ?? []).length, 2);
  assert.match(script, /--virtual-store-dir \/warm\/scratch\/forge-admin-virtual-store/u);
  assert.match(script, /--virtual-store-dir \/warm\/scratch\/forge-h5-virtual-store/u);
  assert.match(script, /--modules-dir \/warm\/scratch\/forge-admin-node_modules/u);
  assert.match(script, /--modules-dir \/warm\/scratch\/forge-h5-node_modules/u);
  assert.match(script, /warm workspace binding does not match this execution/u);
  assert.match(script, /if \(error\.code !== 'ENOENT'\) throw error;\s*\}\s*fs\.mkdirSync\(scratch/u);
  assert.match(script, /seed warm is not bound to the same dependencies, source, acquisition policy, and executor bases/u);
  assert.match(script, /dst=\/seed,readonly/u);
  assert.match(script, /local download seed contains a symbolic link or special node outside the exact disposable pnpm project index/u);
  assert.match(script, /find -P \/warm\/pnpm\/store\/v11\/projects -depth -delete/u);
  assert.match(script, /copied local download seed contains a symbolic link or special node/u);
  assert.match(script, /tar -C \/seed\/m2\/repository --hard-dereference/u);
  assert.match(script, /--no-overwrite-dir --touch/u);
  assert.match(script, /--exclude=\.\/v11\/projects/u);
  assert.match(script, /refusing to finalize a warm workspace outside the exact cache root/u);
  assert.match(script, /fs\.rmSync\(scratch, \{ recursive: true, force: false \}\)/u);
  assert.match(script, /pnpm[^\n]*store[^\n]*v11[^\n]*projects/u);
  assert.match(script, /verification warm contains a symbolic link or special node after pnpm metadata normalization/u);
  assert.match(script, /find -P \/warm\/m2 \/warm\/pnpm -xdev ! -type f ! -type d/u);
  assert.match(script, /cp -R --no-preserve=links,ownership,mode,timestamps -- \/warm\/m2 \/warm\/pnpm \/staging\//u);
  assert.doesNotMatch(script, /mv -T --no-clobber -- "\$\{warm\}" "\$\{stage\}"/u);
  assert.doesNotMatch(script, /refusing to remove a warm workspace outside the exact cache root/u);
  assert.match(script, /verification-cache-tool\.mjs fingerprint/u);
  assert.match(script, /verification-cache-tool\.mjs publish/u);
  assert.match(script, /verification-cache-tool\.mjs verify/u);
  assert.match(script, /verification-cache-tool\.mjs verify\s+\\\n\s+--workspace \/workspace --contract \/contract\.json/u);
  assert.equal(
    [...script.matchAll(/find -P \/staging -xdev -depth -exec chmod a-w -- \{\} \+/gu)].length,
    2,
  );
  assert.equal(
    [...script.matchAll(/--pids-limit 64 --memory 256m --cpus 1 --user 0:0/gu)].length,
    2,
  );
  assert.doesNotMatch(script, /find -P \/staging[^\n]*-mindepth 1/u);
  assert.doesNotMatch(script, /chmod -R a-w \/staging/u);
  assert.match(script, /staged cache pack failed pre-publish networkless verification/u);
  assert.doesNotMatch(script, /(?:curl|wget|ssh|scp|rsync|docker_safe pull|docker pull)/u);
  assert.doesNotMatch(script, /rm -rf/u);
  assert.doesNotMatch(script, /fs\.rmSync\(warm\s*,\s*\{\s*recursive:\s*true/u);
  assert.doesNotMatch(script, /fs\.rmSync\(final_pack\s*,\s*\{\s*recursive:\s*true/u);
  assert.doesNotMatch(script, /rm\s+[^\n]*(?:--\s+)?"\$\{(?:warm|final_pack)\}"/u);
  assert.match(
    script,
    /die 'promoted verification cache pack failed final networkless verification'\s*\n\s*fi\s*\n\s*cleanup_cache_stage\s*\n\s*stage=""\s*\n\s*stage_marker=""\s*\n\s*stage_token=""/u,
  );
  assert.match(
    script,
    /die 'published cache pack failed networkless verification'\s*\nfi\s*\ncleanup_cache_stage\s*\nstage=""\s*\nstage_marker=""\s*\nstage_token=""/u,
  );
});

test('local eval cache reuse is compatibility-bound, copy-promoted, and keeps exact-image namespaces', () => {
  assert.match(script, /verification-cache-tool\.mjs compatibility/u);
  assert.match(script, /verification-cache-tool\.mjs promote/u);
  assert.match(script, /cacheCompatibilityDigest/u);
  assert.match(script, /com\.forge-delivery\.harness-node-base-manifest/u);
  assert.match(script, /com\.forge-delivery\.harness-maven-base-manifest/u);
  assert.match(script, /images\/\$\{image_id#sha256:\}/u);
  assert.match(script, /source_manifest_image/u);
  assert.match(script, /docker_safe image inspect[\s\S]*grep -Fx -- "\$\{source_manifest_image\}"/u);
  assert.match(script, /promoted verification cache pack failed final networkless verification/u);
  assert.match(script, /promoted staging pack failed pre-publish networkless verification/u);
  assert.match(script, /invalid promoted cache could not be returned to its owned staging path/u);
  assert.doesNotMatch(script, /ln\s/u);
});

test('local eval cache warmer fails closed when the candidate descriptor drifts from its real mounts', () => {
  assert.match(script, /candidate cache producer topology does not match this local warmer implementation/u);
  assert.match(script, /forge-verification-cache-compatibility\/v2/u);
  assert.match(script, /forge-verification-cache-producer-topology\/v8/u);
  assert.match(script, /mavenAcquisitionPolicyDigest/u);
  assert.match(script, /JSON\.stringify\(value\?\.cacheCompatibility\?\.warmCommands\).*expectedCommands/su);
  assert.match(script, /JSON\.stringify\(value\?\.cacheCompatibility\?\.producerTopology\).*expectedTopology/su);
  assert.match(script, /scratchRemovedBeforePublish: true/u);
});

test('Maven verification policy is credential-free, exact-mirror, strict, and part of the cache closure', () => {
  assert.doesNotMatch(mavenSettings, /<(?:servers?|proxies?|username|password|privateKey|passphrase)\b/iu);
  assert.doesNotMatch(mavenSettings, /\$\{/u);
  assert.match(mavenSettings, /<mirrorOf>central,aliyun,public<\/mirrorOf>/u);
  assert.doesNotMatch(mavenSettings, /<mirrorOf>[^<]*(?:\*|external:)[^<]*<\/mirrorOf>/u);
  assert.match(mavenSettings, /<id>forge-central-public<\/id>[\s\S]*<url>https:\/\/repo\.maven\.apache\.org\/maven2<\/url>/u);
  assert.match(mavenSettings, /<id>spring-milestones<\/id>[\s\S]*<url>https:\/\/repo\.spring\.io\/milestone<\/url>[\s\S]*<checksumPolicy>fail<\/checksumPolicy>/u);
  assert.match(mavenSettings, /<id>spring-snapshots<\/id>[\s\S]*?<releases>[\s\S]*?<enabled>false<\/enabled>[\s\S]*?<snapshots>[\s\S]*?<enabled>false<\/enabled>/u);
  assert.match(mavenPolicy, /'--strict-checksums'/u);
  assert.match(mavenPolicy, /MAVEN_VERIFICATION_SETTINGS_PATH/u);
  assert.match(mavenPolicy, /MAVEN_VERIFICATION_JANSI_TMPDIR = '\/tmp\/forge-maven-jansi'/u);
  assert.match(cacheTool, /forge-verification-cache-compatibility\/v2/u);
  assert.match(cacheTool, /forge-verification-cache-producer-topology\/v8/u);
  assert.match(cacheTool, /pnpmStoreSanitization/u);
  assert.match(cacheTool, /removedPaths: Object\.freeze\(\['pnpm\/store\/v11\/projects\/'\]\)/u);
  assert.match(cacheTool, /afterRemovalNodePolicy: 'ordinary-files-and-directories-only'/u);
  assert.match(cacheTool, /stageMaterialization/u);
  assert.match(cacheTool, /warmRetainedUntilFinalVerify: true/u);
  assert.match(cacheTool, /mavenAcquisitionPolicyDigest/u);
  assert.match(cacheTool, /MAVEN_VERIFICATION_ENV_ARG/u);
  assert.match(cacheTool, /IMAGE_CACHE_TOOL_PATH = '\/usr\/local\/lib\/verification-cache-tool\.mjs'/u);
  assert.match(cacheTool, /imageRuntime\s*\? probedVersion\(MAVEN_VERIFICATION_EXEC_PATH, \['mvn', '--version'\]/u);
  assert.match(mavenExec, /install -d -m 0700 -- "\$\{jansi_tmpdir\}"/u);
  assert.match(mavenExec, /trap cleanup EXIT HUP INT TERM/u);
  assert.match(mavenExec, /MAVEN_OPTS contract mismatch/u);
  assert.doesNotMatch(`${mavenPolicy}\n${cacheTool}\n${mavenExec}`, /\/home\/node\/\.cache\/jansi|\/tmp\/jansi/u);
  assert.doesNotThrow(() => validateMavenVerificationSettings(mavenSettings));
  assert.throws(
    () => validateMavenVerificationSettings(mavenSettings.replace('</settings>', '<servers><server><username>model</username></server></servers></settings>')),
    /must not contain credentials/u,
  );
  assert.throws(
    () => validateMavenVerificationSettings(mavenSettings.replace('central,aliyun,public', 'external:*')),
    /mirror only the reviewed public repository IDs/u,
  );
});

test('cache compatibility reads the complete Maven implementation receipt closure', async () => {
  const implementation = await readCacheCompatibilityImplementation();
  assert.deepEqual(implementation.map((entry) => entry.path), [
    'verification-cache-tool.mjs',
    'verification-runner.mjs',
    'verify-policy.mjs',
    'maven-verification-policy.mjs',
    'maven-verification-settings.xml',
    'maven-verification-exec.sh',
  ]);
  for (const entry of implementation) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
  }
});

test('local eval cache paths reject remote, overlapping, linked, and Docker CSV-ambiguous inputs', () => {
  assert.match(script, /must not use a network-share path/u);
  assert.match(script, /must be a local path, not a URI/u);
  assert.match(script, /must not contain a comma/u);
  assert.match(script, /--source and --cache-root must not overlap/u);
  assert.match(script, /must not be a symbolic link/u);
  assert.match(script, /refusing to remove a cache staging path outside the exact generated root/u);
});
