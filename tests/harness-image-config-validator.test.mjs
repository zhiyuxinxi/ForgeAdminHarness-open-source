import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildReviewedConfig,
  validateConfigRelationship,
  validateIncrementalArtifact,
  validateInstalledArtifactPaths,
  resolveRegisteredRuntimeGid,
} from '../scripts/validate-harness-image-config.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

function repositoryText(relativePath) {
  return readFileSync(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
}

function dockerCopyDestinations(dockerfile, source) {
  const instructions = [];
  const destinations = [];
  let pending = '';
  for (const rawLine of dockerfile.split(/\r?\n/u)) {
    const fragment = rawLine.trim();
    pending = pending ? `${pending} ${fragment}` : fragment;
    if (pending.endsWith('\\')) {
      pending = pending.slice(0, -1).trimEnd();
      continue;
    }
    if (pending) instructions.push(pending);
    pending = '';
  }
  for (const instruction of instructions.filter((entry) => entry.startsWith('COPY '))) {
    const tokens = instruction.split(/\s+/u).filter((token) => !token.startsWith('--'));
    const sources = tokens.slice(1, -1);
    if (!sources.includes(source)) continue;
    const destination = tokens.at(-1).replace(/\/$/u, '');
    destinations.push(sources.length > 1 ? `${destination}/${path.posix.basename(source)}` : destination);
  }
  return destinations;
}

const foundationOptions = {
  dshVersion: '0.1.1-rc.2',
  revision: 'vpn-forge-delivery-toolkit-60-base',
  skillBundle: '2026.09.03.3',
  nodeBase: 'node@sha256:reviewed',
  mavenBase: 'maven@sha256:reviewed',
};

function parentImage() {
  return {
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      Env: ['PATH=/usr/local/bin:/usr/bin', 'JAVA_HOME=/opt/java', 'MAVEN_CONFIG=/root/.m2'],
      Entrypoint: ['/usr/local/bin/mvn-entrypoint.sh'],
      Cmd: ['mvn'],
      Labels: { inherited: 'reviewed' },
      Healthcheck: { Test: ['NONE'] },
    },
  };
}

function imageFromReviewed(base, kind, options) {
  const reviewed = buildReviewedConfig(kind, base.Config, options);
  return {
    Os: base.Os,
    Architecture: base.Architecture,
    Config: {
      ...reviewed,
      Env: Object.entries(reviewed.Env).map(([key, value]) => `${key}=${value}`),
    },
  };
}

test('foundation Config is the exact reviewed core contract, not a Maven runtime descendant', () => {
  const base = parentImage();
  const image = imageFromReviewed(base, 'foundation', foundationOptions);
  const receipt = validateConfigRelationship('foundation', image, base, foundationOptions);
  assert.equal(receipt.ok, true);
  assert.match(receipt.configDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('Linux-only legacy ArgsEscaped metadata is normalized but remains type checked', () => {
  const base = parentImage();
  const withoutLegacyField = imageFromReviewed(base, 'foundation', foundationOptions);
  const withLegacyField = structuredClone(withoutLegacyField);
  withLegacyField.Config.ArgsEscaped = true;
  const first = validateConfigRelationship('foundation', withoutLegacyField, base, foundationOptions);
  const second = validateConfigRelationship('foundation', withLegacyField, base, foundationOptions);
  assert.equal(second.configDigest, first.configDigest);

  withLegacyField.Config.ArgsEscaped = 'true';
  assert.throws(
    () => validateConfigRelationship('foundation', withLegacyField, base, foundationOptions),
    /ArgsEscaped metadata must be boolean/u,
  );
});

test('an extra environment key is rejected even when selected safety fields still match', () => {
  const base = parentImage();
  const image = imageFromReviewed(base, 'foundation', foundationOptions);
  image.Config.Env.push('UNREVIEWED_BYPASS=1');
  assert.throws(
    () => validateConfigRelationship('foundation', image, base, foundationOptions),
    /environment differs from the exact reviewed set/u,
  );
});

test('an unreviewed Healthcheck, volume, shell, or other Config change is rejected', () => {
  const base = parentImage();
  const image = imageFromReviewed(base, 'foundation', foundationOptions);
  image.Config.Healthcheck = { Test: ['CMD', 'curl', 'http://attacker.invalid'] };
  assert.throws(
    () => validateConfigRelationship('foundation', image, base, foundationOptions),
    /unreviewed runtime Config field change/u,
  );
});

test('target Config permits only the reviewed VPN overlay delta from its foundation', () => {
  const maven = parentImage();
  const foundation = imageFromReviewed(maven, 'foundation', foundationOptions);
  const options = {
    dshVersion: '0.1.1-rc.2',
    revision: 'vpn-forge-delivery-toolkit-60',
    skillBundle: '2026.09.03.3',
    runtimeProfile: 'vpn-trusted-host',
    baseImageId: `sha256:${'a'.repeat(64)}`,
  };
  const target = imageFromReviewed(foundation, 'target', options);
  assert.equal(validateConfigRelationship('target', target, foundation, options).ok, true);
  target.Config.Labels.unreviewed = 'true';
  assert.throws(
    () => validateConfigRelationship('target', target, foundation, options),
    /labels differ from the exact reviewed set/u,
  );
});

test('current image pins and the separate historical eval snapshot remain explicit', () => {
  const versions = repositoryText('config/versions.env');
  const dockerfile = repositoryText('docker/harness/Dockerfile');
  const overlay = repositoryText('docker/harness/Dockerfile.overlay');
  const runner = repositoryText('scripts/run-local-forge-harness-evals.sh');
  const lockVerifier = repositoryText('scripts/verify-forge-harness-eval-runtime-lock.mjs');
  const skillCatalog = JSON.parse(repositoryText('docker/harness/skills.catalog.json'));
  const governancePolicy = JSON.parse(repositoryText('docker/harness/forge-governance-policy.json'));
  const capabilityRegistry = JSON.parse(repositoryText('docker/harness/forge-quality-capability-registry.json'));
  const uiContract = JSON.parse(repositoryText('docker/harness/forge-ui-contract.json'));
  const behaviorSuite = JSON.parse(repositoryText('tests/fixtures/forge-harness-behavior-evals/suite.json'));
  const skillEval = JSON.parse(repositoryText('tests/fixtures/forge-skill-evals/forge-admin-bundle.eval.json'));
  const runtimeTrustLock = JSON.parse(repositoryText('tests/fixtures/forge-harness-behavior-evals/runtime-trust-lock.json'));

  assert.match(versions, /^HARNESS_FOUNDATION_IMAGE=forge-delivery\/deepseek-harness:0\.1\.1-rc\.2-vpn77-base$/mu);
  assert.match(versions, /^HARNESS_FOUNDATION_IMAGE_REVISION=vpn-forge-delivery-toolkit-77-base$/mu);
  const current = Object.fromEntries([...versions.matchAll(/^([A-Z_]+)=(.+)$/gmu)].map(([, key, value]) => [key, value]));
  for (const key of ['HARNESS_IMAGE', 'CONVERSATION_MANAGER_IMAGE', 'RELEASE_RUNNER_IMAGE']) {
    assert.match(current[key], /^(?:[\w./-]+:[\w.-]+|[\w./:-]+@sha256:[a-f0-9]{64})$/u, key);
    assert.doesNotMatch(current[key], /:(?:latest|main|master)$/u, key);
  }
  assert.match(current.HARNESS_IMAGE_REVISION, /^[\w.-]+$/u);
  assert.match(current.HARNESS_SKILL_BUNDLE_VERSION, /^\d{4}\.\d{2}\.\d{2}\.\d+$/u);
  assert.equal(current.FORGE_EXTERNAL_SKILL_BUNDLE_VERSION, skillCatalog.bundleVersion);
  assert.match(versions, /^FORGE_PHASE_PROFILE_CATALOG_VERSION=2026\.09\.03\.22$/mu);
  assert.match(versions, /^FORGE_HOST_RUNNER_BUNDLE_VERSION=2026\.10\.13\.2-natural-intent$/mu);
  assert.match(dockerfile, /^ARG HARNESS_IMAGE_REVISION=vpn-forge-delivery-toolkit-77-base$/mu);
  assert.match(dockerfile, /^ARG HARNESS_SKILL_BUNDLE_VERSION=2026\.09\.01\.5$/mu);
  assert.match(overlay, /^ARG HARNESS_IMAGE_REVISION=vpn-forge-delivery-toolkit-130$/mu);
  assert.match(overlay, /^ARG HARNESS_SKILL_BUNDLE_VERSION=2026\.09\.27\.1$/mu);
  assert.match(skillCatalog.bundleVersion, /^\d{4}\.\d{2}\.\d{2}\.\d+$/u);
  assert.equal(governancePolicy.policyVersion, '2026.09.20.2');
  assert.match(capabilityRegistry.registryVersion, /^\d{4}\.\d{2}\.\d{2}\.\d+$/u);
  assert.equal(uiContract.contractVersion, '2026.09.03.1');
  assert.equal(behaviorSuite.suiteVersion, '2026.09.14.1');
  assert.equal(skillEval.bundleVersion, '2026.10.15.3');
  assert.equal(runtimeTrustLock.packageVersion, '2026.09.14.3');
  assert.match(runner, /^readonly RUNNER_VERSION="1\.19\.86"$/mu);
  assert.match(runner, /^readonly EXPECTED_RUNTIME_PACKAGE_VERSION="2026\.09\.14\.3"$/mu);
  assert.match(runner, /^readonly EXPECTED_HARNESS_IMAGE_REVISION="vpn-forge-delivery-toolkit-78"$/mu);
  assert.match(runner, /^readonly EXPECTED_HARNESS_SKILL_BUNDLE_VERSION="2026\.09\.22\.6"$/mu);
  assert.match(runner, /^readonly EXPECTED_EXTERNAL_SKILLS_BUNDLE_VERSION="2026\.09\.22\.6"$/mu);
  assert.match(runner, /^readonly EXPECTED_PHASE_CATALOG_VERSION="2026\.09\.03\.22"$/mu);
  assert.match(runner, /^readonly EXPECTED_HOST_RUNNER_BUNDLE_VERSION="2026\.09\.14\.2"$/mu);
  assert.match(lockVerifier, /^const PACKAGE_VERSION = '2026\.09\.14\.3';$/mu);
});

test('both image smokes track the current execution capability registry cardinality', () => {
  const executionRegistry = JSON.parse(repositoryText('docker/harness/forge-execution-capability-registry.json'));
  const expected = executionRegistry.capabilities.length;
  assert.ok(expected > 0);
  for (const content of [repositoryText('docker/harness/Dockerfile'), repositoryText('docker/harness/Dockerfile.overlay')]) {
    assert.match(content, new RegExp(`registry\\.capabilities\\.length!==${expected}\\|\\|`));
  }
});

test('dependency preload image carries the pinned Host delivery closure without changing parent runtime Config', () => {
  const dockerfile = repositoryText('docker/harness/Dockerfile.dependency-preload');
  const required = [
    ['dependency-seed/', '/opt/forge-dependency-seed'],
    ['host-runner-bundle/', '/opt/forge-host-runner-bundle'],
    ['toolchains/versions/pnpm-10.34.5/', '/opt/forge-host-toolchains/versions/pnpm-10.34.5'],
    ['toolchains/pnpm-10.34.5.receipt.json', '/opt/forge-host-toolchains/pnpm-10.34.5.receipt.json'],
    ['docker/harness/host-dependency-seed.mjs', '/usr/local/lib/host-dependency-seed.mjs'],
    ['docker/harness/host-verify-policy.mjs', '/usr/local/lib/host-verify-policy.mjs'],
    ['config/versions.env', '/usr/local/share/forge-image-build/versions.env'],
    ['docker/harness/Dockerfile.dependency-preload', '/usr/local/share/forge-image-build/Dockerfile.dependency-preload'],
    ['templates/project/host-verification-contract.json.tpl', '/usr/local/share/forge-image-build/templates/project/host-verification-contract.json.tpl'],
  ];
  for (const [source, destination] of required) assert.ok(dockerCopyDestinations(dockerfile, source).includes(destination), source);
  for (const argument of ['DEPENDENCY_SEED_MANIFEST_SHA256', 'HOST_RUNNER_MANIFEST_SHA256', 'PNPM_TOOLCHAIN_RECEIPT_SHA256']) {
    assert.match(dockerfile, new RegExp(`^ARG ${argument}$`, 'mu'));
    assert.ok(dockerfile.includes(`"\${${argument}}"`));
  }
  assert.doesNotMatch(dockerfile, /^(?:ENV|LABEL|ENTRYPOINT|CMD|WORKDIR|EXPOSE|VOLUME|HEALTHCHECK)\s/mu);
  assert.match(dockerfile, /USER 1000:1000\s*$/u);
  assert.doesNotMatch(dockerfile, /(?:npm install|corepack prepare|curl|wget|apt-get)/u);
  assert.match(dockerfile, /validateHostRunnerBundle\("\/opt\/forge-host-runner-bundle"/u);
  assert.match(dockerfile, /forge-host-runner-bundle\/v7/u);
  assert.match(dockerfile, /host\.manifest\.bundleVersion!==versions\.FORGE_HOST_RUNNER_BUNDLE_VERSION/u);
  assert.match(dockerfile, /template\.dependencySeed!==null/u);
  assert.match(dockerfile, /executable:Boolean\(s\.mode&0o111\)/u);
  assert.match(dockerfile, /"10\.34\.5"\)throw Error\("Image pnpm version probe failed"\)/u);
});

test('dependency preload fixes only newly created root modes and preserves seed file permissions', () => {
  const dockerfile = repositoryText('docker/harness/Dockerfile.dependency-preload');
  const permissions = dockerfile.indexOf('chmod 0555 /opt/forge-dependency-seed');
  assert.ok(permissions > dockerfile.indexOf('COPY dependency-seed/'));
  assert.ok(permissions < dockerfile.indexOf('const root="/opt/forge-dependency-seed"'));
  assert.doesNotMatch(dockerfile, /chmod\s+-R|COPY\s+--chmod=0?555\s+dependency-seed/u);
  assert.match(dockerfile, /if\(s\.isSymbolicLink\(\)\|\|[\s\S]*?\(s\.mode&0o222\)/u);
});

test('dependency preload embedded verifiers parse as the modules used by the image build', () => {
  const dockerfile = repositoryText('docker/harness/Dockerfile.dependency-preload');
  const commands = [...dockerfile.matchAll(/node --input-type=module -e '([\s\S]*?)'\s+"\$\{/gu)];
  assert.equal(commands.length, 2);
  for (const [, source] of commands) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source.replace(/\\\r?\n/gu, '\n'), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('both image smokes track the current quality capability registry cardinality', async () => {
  const { loadCurrentForgeQualityCapabilityRegistry } = await import('../docker/harness/forge-quality-capability-registry.mjs');
  const registry = await loadCurrentForgeQualityCapabilityRegistry();
  assert.ok(registry.coverage.total > 0);
  assert.ok(registry.blockingGaps.length > 0);
  const expected = `registry\\.coverage\\.total!==${registry.coverage.total}\\|\\|registry\\.coverage\\.statusCounts\\.enforced!==${registry.coverage.statusCounts.enforced}\\|\\|registry\\.blockingGaps\\.length!==${registry.blockingGaps.length}`;
  for (const content of [repositoryText('docker/harness/Dockerfile'), repositoryText('docker/harness/Dockerfile.overlay')]) {
    assert.match(content, new RegExp(expected));
  }
});

test('both images declare an external read-only Skill authority and reject embedded Skill trees', () => {
  for (const content of [repositoryText('docker/harness/Dockerfile'), repositoryText('docker/harness/Dockerfile.overlay')]) {
    assert.match(content, /DSH_BUNDLED_SKILL_DIR=\/opt\/forge-skill-bundles\/current\/skills/u);
    assert.match(content, /test ! -e \/usr\/local\/share\/dsh-skills/u);
    assert.doesNotMatch(content, /COPY docker\/harness\/skills\//u);
  }
});

test('governance and verification runtime assets stay identical across both Dockerfiles and the image-input manifest', () => {
  const dockerfiles = [
    repositoryText('docker/harness/Dockerfile'),
    repositoryText('docker/harness/Dockerfile.overlay'),
  ];
  const manifest = JSON.parse(repositoryText('docker/harness/image-build-inputs.json'));
  const reviewedAssets = [
    {
      source: 'docker/harness/forge-reference-provenance.mjs',
      destination: 'usr/local/lib/forge-reference-provenance.mjs',
      mode: '0644',
    },
    ...['conversation-output.js', 'conversation-output-store.mjs', 'conversation-output-projection.mjs', 'conversation-output-service.mjs'].map((name) => ({
      source: `docker/harness/${name}`,
      destination: `usr/local/lib/${name}`,
      mode: '0644',
    })),
    {
      source: 'docker/harness/forge-phase-budget-guard.mjs',
      destination: 'usr/local/lib/forge-phase-budget-guard.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-controlled-command.mjs',
      destination: 'usr/local/lib/forge-controlled-command.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-task-execution-contract.mjs',
      destination: 'usr/local/lib/forge-task-execution-contract.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-delivery-phase-controller.mjs',
      destination: 'usr/local/lib/forge-delivery-phase-controller.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-delivery-phase-browser-session.mjs',
      destination: 'usr/local/lib/forge-delivery-phase-browser-session.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-delivery-phase-host-receipts.mjs',
      destination: 'usr/local/lib/forge-delivery-phase-host-receipts.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-delivery-phase-workspace-observer.mjs',
      destination: 'usr/local/lib/forge-delivery-phase-workspace-observer.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-cross-layer-runtime-evidence.mjs',
      destination: 'usr/local/lib/forge-cross-layer-runtime-evidence.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-phase-work-package.mjs',
      destination: 'usr/local/lib/forge-phase-work-package.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-delivery-phase-runtime.mjs',
      destination: 'usr/local/lib/forge-delivery-phase-runtime.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-delivery-phase-response.mjs',
      destination: 'usr/local/lib/forge-delivery-phase-response.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-context.mjs',
      destination: 'usr/local/lib/forge-execution-context.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-policy.json',
      destination: 'usr/local/lib/forge-execution-policy.json',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-prepare-headless-execution.mjs',
      destination: 'usr/local/lib/forge-prepare-headless-execution.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-recover-headless-execution.mjs',
      destination: 'usr/local/lib/forge-recover-headless-execution.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-protected-session-mode.mjs',
      destination: 'usr/local/lib/forge-protected-session-mode.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-protected-headless-runner.mjs',
      destination: 'usr/local/lib/forge-protected-headless-runner.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-capability-registry.json',
      destination: 'usr/local/share/forge-execution-capability-registry.json',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-capability-registry.mjs',
      destination: 'usr/local/lib/forge-execution-capability-registry.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-capability-negotiator.mjs',
      destination: 'usr/local/lib/forge-capability-negotiator.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-pack.mjs',
      destination: 'usr/local/lib/forge-execution-pack.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-store.mjs',
      destination: 'usr/local/lib/forge-execution-store.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-execution-orchestrator.mjs',
      destination: 'usr/local/lib/forge-execution-orchestrator.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-progress-detector.mjs',
      destination: 'usr/local/lib/forge-progress-detector.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-change-contract.mjs',
      destination: 'usr/local/lib/forge-change-contract.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-business-data-approval.mjs',
      destination: 'usr/local/lib/forge-business-data-approval.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-business-object-mutation.mjs',
      destination: 'usr/local/lib/forge-business-object-mutation.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-semantic-resource-lease.mjs',
      destination: 'usr/local/lib/forge-semantic-resource-lease.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-workflow-migration-safety.mjs',
      destination: 'usr/local/lib/forge-workflow-migration-safety.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-ui-edit-session.mjs',
      destination: 'usr/local/lib/forge-ui-edit-session.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-behavior-qualification.mjs',
      destination: 'usr/local/lib/forge-behavior-qualification.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-reference-adoption-coverage.mjs',
      destination: 'usr/local/lib/forge-reference-adoption-coverage.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-reference-adoption-coverage.json',
      destination: 'usr/local/lib/forge-reference-adoption-coverage.json',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-acceptance-aggregator.mjs',
      destination: 'usr/local/lib/forge-acceptance-aggregator.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-protected-issuer-adapter.mjs',
      destination: 'usr/local/lib/forge-protected-issuer-adapter.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-production-task-grant.mjs',
      destination: 'usr/local/lib/forge-production-task-grant.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-protected-acceptance-service.mjs',
      destination: 'usr/local/lib/forge-protected-acceptance-service.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-quality-capability-registry.mjs',
      destination: 'usr/local/lib/forge-quality-capability-registry.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-quality-capability-registry.json',
      destination: 'usr/local/share/forge-quality-capability-registry.json',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-ui-contract.mjs',
      destination: 'usr/local/lib/forge-ui-contract.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-ui-contract.json',
      destination: 'usr/local/lib/forge-ui-contract.json',
      mode: '0644',
    },
    {
      source: 'docker/harness/forge-verify',
      destination: 'usr/local/bin/forge-verify',
      mode: '0755',
    },
    {
      source: 'docker/harness/verify-policy.mjs',
      destination: 'usr/local/lib/verify-policy.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/host-verify-policy.mjs',
      destination: 'usr/local/lib/host-verify-policy.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/verification-runner.mjs',
      destination: 'usr/local/lib/verification-runner.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/verification-cache-tool.mjs',
      destination: 'usr/local/lib/verification-cache-tool.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/maven-verification-policy.mjs',
      destination: 'usr/local/lib/maven-verification-policy.mjs',
      mode: '0644',
    },
    {
      source: 'docker/harness/maven-verification-settings.xml',
      destination: 'usr/local/lib/maven-verification-settings.xml',
      mode: '0644',
    },
    {
      source: 'docker/harness/maven-verification-exec.sh',
      destination: 'usr/local/lib/maven-verification-exec.sh',
      mode: '0644',
    },
  ];

  for (const asset of reviewedAssets) {
    for (const dockerfile of dockerfiles) {
      assert.equal(
        dockerCopyDestinations(dockerfile, asset.source).includes(`/${asset.destination}`),
        true,
        `${asset.source} is missing or copied to the wrong destination in a Harness Dockerfile`,
      );
    }
    const mappings = manifest.mappings.filter((entry) => entry.source === asset.source);
    const expectedMappings = reviewedAssets
      .filter((entry) => entry.source === asset.source)
      .map((entry) => ({ ...entry, type: 'file' }));
    assert.deepEqual(mappings, expectedMappings);
  }
  for (const dockerfile of dockerfiles) {
    assert.match(dockerfile, /RUN --network=none\s+\\\r?\n\s+--mount=type=bind,source=docker\/harness\/skills\.catalog\.json,target=\/run\/forge-image-build\/skills\.catalog\.json,ro\s+\\\r?\n\s+node \/usr\/local\/lib\/forge-tool-worker-native-patch\.mjs \/opt\/forge-harness-runtime\/node_modules\s+\\\r?\n\s+&& (?:find|chmod|install)/u);
    assert.match(dockerfile, /loadCurrentForgeQualityCapabilityRegistry\(\{skillCatalogPath:"\/run\/forge-image-build\/skills\.catalog\.json"\}\)/u);
  }
});


function incrementalFixture() {
  const id = x => `sha256:${x.repeat(64)}`;
  const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const configDigest = config => `sha256:${hash(JSON.stringify(stable(config)))}`;
  const parent = { Id: id('b'), Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [id('1'),id('2')] },
    Config: { User: '1000:1000', WorkingDir: '/workspace', Entrypoint: null, Cmd: ['/usr/local/bin/start-harness'],
      Env: ['PATH=/usr/local/bin:/usr/bin', 'HARNESS_PRIVILEGED_API_MODE=trusted-host'], Labels: { reviewed: 'parent' } } };
  const foundation = { Id: id('f'), Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [id('1')] } };
  const image = structuredClone(parent); image.Id = id('c'); image.RootFS.Layers.push(id('3'));
  const source = 'a'.repeat(40), revision = 'incremental-reviewed-1', tag = `forge-harness:${revision}`;
  Object.assign(image.Config.Labels, { 'org.opencontainers.image.revision': revision,
    'com.forge-delivery.harness-base-image-id': parent.Id, 'com.forge-delivery.production-source-commit': source,
    'com.forge-delivery.test-source-commit': source, 'com.forge-delivery.versions-source-commit': source,
    'com.forge-delivery.harness-skill-bundle': '2026.10.08.2' });
  const modules = { '/usr/local/lib/reviewed.mjs': '4'.repeat(64) };
  const sourceReceipt = { ok: true, schemaVersion: 1, digest: id('5') };
  const observation = { modules, sourceReceipt, embeddedReceipt: { digest: id('5') }, dependencyReceiptSha256: '6'.repeat(64),
    versions: { HARNESS_IMAGE_REVISION: revision, HARNESS_SKILL_BUNDLE_VERSION: '2026.10.08.2' } };
  const manifest = { candidateImage: image.Id, buildState: 'finished', buildExit: 0, sourceCommit: source,
    versionsCommit: source, tag, baseImage: parent.Id, parentLayers: parent.RootFS.Layers,
    targetConfigDigest: configDigest(image.Config), installedObservation: { modules, sourceReceipt, dependencyReceiptSha256: '6'.repeat(64) } };
  const proof = { candidateImage: image.Id, status: 'passed', exit: 0, sourceCommit: source, testSourceCommit: source,
    tag, revision, baseImage: parent.Id, actualConsumer: { status: 'passed', installedBindings: modules } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), consumerBytes = Buffer.from(JSON.stringify(proof));
  return { image, parent, foundation, observation, manifestBytes, consumerBytes,
    manifestSha256: hash(manifestBytes), consumerSha256: hash(consumerBytes), expectedImageId: image.Id,
    expectedFoundationId: foundation.Id, configDigest };
}

test('registered incremental image accepts protected versioned Skill paths and rejects mutable or escaped locations', () => {
  assert.equal(validateInstalledArtifactPaths([
    '/usr/local/share/forge-image-build/frontend-quality-skill-bundle/bundle.manifest.json',
    '/opt/forge-skill-bundles/versions/2026.10.08.80/bundle.manifest.json',
    '/opt/forge-skill-bundles/versions/2026.10.08.80/skills/forge-frontend-admin/references/page-patterns.md',
  ]), true);
  for (const file of [
    '/opt/other/skills/SKILL.md',
    '/opt/forge-skill-bundles/current/skills/SKILL.md',
    '/opt/forge-skill-bundles/versions/latest/skills/SKILL.md',
    '/opt/forge-skill-bundles/versions/2026.10.08.80-private/skills/SKILL.md',
    '/opt/forge-skill-bundles/versions/2026.10.08.80/../private/SKILL.md',
    '/opt/forge-skill-bundles/versions/2026.10.08.80/./skills/SKILL.md',
    '/opt/forge-skill-bundles/versions/2026.10.08.80//skills/SKILL.md',
    '/opt/forge-skill-bundles/versions/2026.10.08.80',
    '/usr/local/lib/../private.mjs',
  ]) assert.throws(() => validateInstalledArtifactPaths([file]), /module paths are outside the installed artifact/u);
});

test('registered incremental image binds actual parent, fixed ancestor, consumer and source digest', () => {
  const input = incrementalFixture();
  const result = validateIncrementalArtifact(input);
  assert.equal(result.ok, true);
  assert.equal(result.baseImageId, input.parent.Id);
  assert.equal(result.foundationImageId, input.foundation.Id);
  assert.equal(result.configDigest, input.configDigest(input.image.Config));
});

test('registered incremental image separates the reviewed 1000 runtime group from the baseline disk group', () => {
  const input = incrementalFixture();
  const manifest = JSON.parse(input.manifestBytes);
  manifest.parentConfig = structuredClone(input.parent.Config);
  input.manifestBytes = Buffer.from(JSON.stringify(manifest));
  input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
  input.expectedRuntimeGid = resolveRegisteredRuntimeGid(JSON.parse(input.manifestBytes), 983);
  assert.equal(input.expectedRuntimeGid, 1000);
  assert.equal(validateIncrementalArtifact(input).ok, true);
});

test('registered incremental image retains the baseline group for legacy 983 receipts with or without parent Config', () => {
  for (const recordParentConfig of [true, false]) {
    const input = incrementalFixture();
    input.parent.Config.User = input.image.Config.User = '1000:983';
    const manifest = JSON.parse(input.manifestBytes);
    if (recordParentConfig) manifest.parentConfig = structuredClone(input.parent.Config);
    manifest.targetConfigDigest = input.configDigest(input.image.Config);
    input.manifestBytes = Buffer.from(JSON.stringify(manifest));
    input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
    input.expectedRuntimeGid = resolveRegisteredRuntimeGid(JSON.parse(input.manifestBytes), 983);
    assert.equal(input.expectedRuntimeGid, 983);
    assert.equal(validateIncrementalArtifact(input).ok, true);
  }
});

test('registered incremental image rejects a declared 1000 parent group when the actual bound runtime uses 983', () => {
  const input = incrementalFixture();
  const manifest = JSON.parse(input.manifestBytes);
  manifest.parentConfig = structuredClone(input.parent.Config);
  input.parent.Config.User = input.image.Config.User = '1000:983';
  manifest.targetConfigDigest = input.configDigest(input.image.Config);
  input.manifestBytes = Buffer.from(JSON.stringify(manifest));
  input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
  input.expectedRuntimeGid = resolveRegisteredRuntimeGid(JSON.parse(input.manifestBytes), 983);
  assert.equal(input.expectedRuntimeGid, 1000);
  assert.throws(() => validateIncrementalArtifact(input), /runtime isolation differs/u);
});

test('registered incremental image preserves the baseline non-root runtime owner and group', () => {
  const input = incrementalFixture();
  input.expectedRuntimeUid = 1000;
  input.expectedRuntimeGid = 983;
  const bindIdentity = (user) => {
    input.parent.Config.User = user;
    input.image.Config.User = user;
    const manifest = JSON.parse(input.manifestBytes);
    manifest.targetConfigDigest = input.configDigest(input.image.Config);
    input.manifestBytes = Buffer.from(JSON.stringify(manifest));
    input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
  };
  bindIdentity('1000:983');
  assert.equal(validateIncrementalArtifact(input).ok, true);
  input.expectedRuntimeGid = 1000;
  assert.throws(() => validateIncrementalArtifact(input), /runtime isolation differs/u);
  input.expectedRuntimeGid = 0;
  bindIdentity('1000:0');
  assert.throws(() => validateIncrementalArtifact(input), /runtime isolation differs/u);
  input.expectedRuntimeUid = 0;
  input.expectedRuntimeGid = 983;
  bindIdentity('0:983');
  assert.throws(() => validateIncrementalArtifact(input), /runtime isolation differs/u);
});

test('registered incremental image accepts an absent entrypoint but rejects a configured entrypoint', () => {
  const input = incrementalFixture();
  input.expectedRuntimeGid = 983;
  input.parent.Config.User = input.image.Config.User = '1000:983';
  const rebindConfig = () => {
    const manifest = JSON.parse(input.manifestBytes);
    manifest.targetConfigDigest = input.configDigest(input.image.Config);
    input.manifestBytes = Buffer.from(JSON.stringify(manifest));
    input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
  };
  delete input.parent.Config.Entrypoint;
  delete input.image.Config.Entrypoint;
  rebindConfig();
  assert.equal(validateIncrementalArtifact(input).ok, true);
  input.parent.Config.Entrypoint = input.image.Config.Entrypoint = ['/bin/sh'];
  rebindConfig();
  assert.throws(() => validateIncrementalArtifact(input), /runtime isolation differs/u);
});

test('registered incremental image rejects unknown parents, forged source, Config drift and unbound digests', () => {
  for (const [name, mutate] of [
    ['unknown parent', x => { x.parent.Id = `sha256:${'d'.repeat(64)}`; }],
    ['wrong fixed ancestor', x => { x.foundation.RootFS.Layers = [`sha256:${'e'.repeat(64)}`]; }],
    ['forged source label', x => { x.image.Config.Labels['com.forge-delivery.production-source-commit'] = 'e'.repeat(40); }],
    ['Config environment drift', x => { x.image.Config.Env.push('UNREVIEWED_BYPASS=1'); }],
    ['unbound manifest', x => { x.manifestSha256 = undefined; }],
    ['forged consumer bytes', x => { x.consumerBytes = Buffer.from(x.consumerBytes.toString().replace('passed', 'failed')); }],
    ['changed source digest', x => { x.observation = structuredClone(x.observation); x.observation.sourceReceipt.digest = `sha256:${'d'.repeat(64)}`; }],
    ['changed installed module', x => { x.observation = structuredClone(x.observation); x.observation.modules['/usr/local/lib/reviewed.mjs'] = 'd'.repeat(64); }],
    ['missing embedded digest', x => { x.observation = structuredClone(x.observation); delete x.observation.embeddedReceipt; }],
  ]) {
    const input = incrementalFixture(); mutate(input);
    assert.throws(() => validateIncrementalArtifact(input), /Incremental Harness artifact:/u, name);
  }
  const input = incrementalFixture();
  input.image.Config.Healthcheck = { Test: ['CMD', 'sh', '-c', 'unreviewed'] };
  const manifest = JSON.parse(input.manifestBytes); manifest.targetConfigDigest = input.configDigest(input.image.Config);
  input.manifestBytes = Buffer.from(JSON.stringify(manifest));
  input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
  assert.throws(() => validateIncrementalArtifact(input), /unreviewed Config change/u);
});

test('registered incremental tool worker activation binds exact version and actual modules', () => {
  const input = incrementalFixture();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(input.manifestBytes);
  const proof = JSON.parse(input.consumerBytes);
  const refresh = () => {
    manifest.targetConfigDigest = input.configDigest(input.image.Config);
    input.manifestBytes = Buffer.from(JSON.stringify(manifest));
    input.manifestSha256 = hash(input.manifestBytes);
    input.consumerBytes = Buffer.from(JSON.stringify(proof));
    input.consumerSha256 = hash(input.consumerBytes);
  };
  input.image.Config.Labels['io.forge.tool-worker'] = 'v1';
  refresh();
  assert.throws(() => validateIncrementalArtifact(input), /tool worker activation is not bound/);
  const modules = ['forge-tool-worker.mjs', 'forge-tool-worker-wire.mjs', 'forge-tool-worker-provider.mjs',
    'forge-tool-worker-bash.mjs', 'forge-tool-worker-start.mjs', 'forge-tool-worker-native-patch.mjs']
    .map(name => `/usr/local/lib/${name}`).concat('/usr/local/share/forge-tool-worker.json');
  for (const file of modules) {
    manifest.installedObservation.modules[file] = '7'.repeat(64);
    proof.actualConsumer.installedBindings[file] = '7'.repeat(64);
    input.observation.modules[file] = '7'.repeat(64);
  }
  refresh();
  assert.equal(validateIncrementalArtifact(input).ok, true);
  input.image.Config.Labels['io.forge.tool-worker'] = 'v2';
  refresh();
  assert.throws(() => validateIncrementalArtifact(input), /unsupported tool worker version/);
  input.image.Config.Labels['io.forge.tool-worker'] = 'v1';
  input.image.Config.Labels['unreviewed-worker-label'] = 'true';
  refresh();
  assert.throws(() => validateIncrementalArtifact(input), /unreviewed Config change/);
});

test('registered incremental private proc capability requires the installed sandbox binding', () => {
  const input = incrementalFixture();
  const manifest = JSON.parse(input.manifestBytes), proof = JSON.parse(input.consumerBytes);
  const refresh = () => {
    manifest.targetConfigDigest = input.configDigest(input.image.Config);
    input.manifestBytes = Buffer.from(JSON.stringify(manifest));
    input.manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
    input.consumerBytes = Buffer.from(JSON.stringify(proof));
    input.consumerSha256 = createHash('sha256').update(input.consumerBytes).digest('hex');
  };
  input.image.Config.Labels['io.forge.tool-worker.private-proc'] = 'v1'; refresh();
  assert.throws(() => validateIncrementalArtifact(input), /private proc activation is not bound/);
  const file = '/usr/local/lib/forge-direct-worker-sandbox.mjs';
  manifest.installedObservation.modules[file] = proof.actualConsumer.installedBindings[file] = input.observation.modules[file] = '7'.repeat(64);
  refresh(); assert.equal(validateIncrementalArtifact(input).ok, true);
  input.image.Config.Labels['io.forge.tool-worker.private-proc'] = 'v2'; refresh();
  assert.throws(() => validateIncrementalArtifact(input), /unsupported private proc version/);
});
