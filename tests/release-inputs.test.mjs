import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { collectReleaseInputs, selectReleaseImpact, successfulServiceBaselines, validateReleaseInputs, serviceMavenDockerfile, sameReleaseCandidate } from '../docker/harness/release-inputs.mjs';

const tree = roots => ({ kind: 'tree', roots, inputs: [], migrations: [], imageVariable: 'APP_IMAGE', checks: [] });
const snapshot = contents => new Map(Object.entries(contents).map(([file, value]) => [file,
  { mode: '100644', object: crypto.createHash('sha1').update(value).digest('hex') }]));
const collect = (model, contents) => collectReleaseInputs(model, snapshot(contents), file => contents[file]);
const baseline = input => ({ commit: 'a'.repeat(40), inputDigest: input.digest, inputFiles: input.files });

test('impact comparison base does not change artifact identity or allow a different candidate', () => {
  const candidate = { source: 'taskspace', taskId: 'one', actorId: 'actor', conversationId: 'chat', candidateCommit: 'a'.repeat(40) };
  assert.equal(sameReleaseCandidate(candidate, { ...candidate, sourceBaseCommit: 'b'.repeat(40) }), true);
  assert.equal(sameReleaseCandidate(candidate, { ...candidate, candidateCommit: 'c'.repeat(40) }), false);
  assert.equal(sameReleaseCandidate(candidate, { ...candidate, taskId: 'two' }), false);
});

test('Maven build narrows only the reactor selection and preserves runtime and cache instructions', () => {
  const recipe = 'FROM maven:3 AS builder\nCOPY ./code .\nRUN --mount=type=cache,target=/root/.m2,sharing=locked \\\n  mvn package -pl one,two,three -am -Pprod,fast-package\nFROM eclipse-temurin:17-jre\nCOPY --from=builder /build/one/target/app.jar app.jar\nENTRYPOINT ["java", "-jar", "app.jar"]\n';
  const result = serviceMavenDockerfile(recipe, 'one');
  assert.match(result, /mvn package -pl one -am -Pprod,fast-package/);
  assert.match(result, /--mount=type=cache,target=\/root\/.m2,sharing=locked/);
  assert.equal(result.split('FROM eclipse-temurin')[1], recipe.split('FROM eclipse-temurin')[1]);
  assert.throws(() => serviceMavenDockerfile('RUN mvn package -pl one -am && do-other-work', 'one'), { code: 'RELEASE_INPUTS_UNRESOLVED' });
  assert.throws(() => serviceMavenDockerfile('RUN mvn package', 'one'), { code: 'RELEASE_INPUTS_UNRESOLVED' });
});

test('input identity ignores Git commit and unrelated files, and detects deletion', async () => {
  const model = { schemaVersion: 1, services: { alpha: tree(['one']), beta: { ...tree(['two']), imageVariable: 'B_IMAGE' } } };
  validateReleaseInputs(model, ['alpha', 'beta']);
  const before = await collect(model, { 'one/a': 'a', 'two/b': 'b', 'notes': 'old' });
  const after = await collect(model, { 'one/a': 'a', 'two/b': 'b', 'notes': 'new' });
  const baselines = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, baseline(value)]));
  assert.deepEqual(selectReleaseImpact({ requestedServices: ['alpha', 'beta'], inputs: after, baselines, changes: {} }).selectedServices, []);
  const deleted = await collect(model, { 'one/a': 'a' });
  assert.deepEqual(selectReleaseImpact({ requestedServices: ['alpha', 'beta'], inputs: deleted, baselines, changes: { beta: ['two/b'] }, allowedChanges: new Set(['two/b']) }).selectedServices, ['beta']);
});

test('Maven closure follows transitive reactor dependencies and parent inputs for arbitrary modules', async () => {
  const pom = (name, dependencies = '') => `<project><parent><groupId>sample</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>${name}</artifactId><dependencies>${dependencies}</dependencies></project>`;
  const dep = name => `<dependency><groupId>sample</groupId><artifactId>${name}</artifactId></dependency>`;
  const contents = { 'code/pom.xml': '<project><groupId>sample</groupId><artifactId>root</artifactId><version>1</version></project>',
    'code/service-a/pom.xml': pom('service-a', dep('library')), 'code/service-b/pom.xml': pom('service-b'),
    'code/library/pom.xml': pom('library'), 'code/library/src/main/a.java': 'v1', 'code/library/src/test/a.java': 'test',
    'code/service-b/src/main/b.java': 'b' };
  const unit = module => ({ ...tree([]), kind: 'maven', mavenRoot: 'code', module });
  const model = { schemaVersion: 1, services: { alpha: unit('service-a'), beta: unit('service-b') } };
  const before = await collect(model, contents);
  const after = await collect(model, { ...contents, 'code/library/src/main/a.java': 'v2' });
  assert.notEqual(before.alpha.digest, after.alpha.digest);
  assert.equal(before.beta.digest, after.beta.digest);
  const testsOnly = await collect(model, { ...contents, 'code/library/src/test/a.java': 'new test' });
  assert.equal(before.alpha.digest, testsOnly.alpha.digest);
  assert.ok(before.alpha.files.includes('code/pom.xml'));
});

test('shared consumers cannot be omitted and an artifact cannot silently include another task delta', async () => {
  const model = { schemaVersion: 1, services: { a: tree(['shared', 'a']), b: tree(['shared', 'b']) } };
  const before = await collect(model, { 'shared/config': 'old', 'a/own': 'old', 'a/other': 'old' });
  const inputs = await collect(model, { 'shared/config': 'new', 'a/own': 'new', 'a/other': 'new' });
  const baselines = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, baseline(value)]));
  assert.throws(() => selectReleaseImpact({ requestedServices: ['a'], inputs, baselines, changes: {}, allowedChanges: new Set(['shared/config']) }), { code: 'RELEASE_AFFECTED_SERVICE_OMITTED' });
  assert.throws(() => selectReleaseImpact({ requestedServices: ['a', 'b'], inputs, baselines, changes: { a: ['a/other'] }, allowedChanges: new Set(['a/own', 'shared/config']) }), { code: 'RELEASE_CANDIDATE_SCOPE_MISMATCH' });
  assert.throws(() => selectReleaseImpact({ requestedServices: ['a', 'b'], inputs, baselines, changes: { a: ['a/own'] },
    allowedChanges: new Set(['a/own', 'shared/config']), unreleasedBaseChanges: { a: new Set(['a/own']) } }),
  { code: 'RELEASE_CANDIDATE_SCOPE_MISMATCH' }, 'another task delta in the same file is still an artifact conflict');
});

test('baselines remain service-specific and failures or environment drift cannot advance them', () => {
  const model = { services: { a: { imageVariable: 'A_IMAGE' }, b: { imageVariable: 'B_IMAGE' } } };
  const imageA = `sha256:${'a'.repeat(64)}`, imageB = `sha256:${'b'.repeat(64)}`;
  const records = [
    { type: 'controlled-release', jobId: '1', status: 'success', services: ['a'], commit: 'a'.repeat(40), images: { a: { id: imageA } } },
    { type: 'controlled-release', jobId: '2', status: 'success', services: ['b'], commit: 'b'.repeat(40), images: { b: { id: imageB } } },
    { type: 'controlled-release', jobId: '3', status: 'success', services: ['a'], commit: 'c'.repeat(40), images: { a: { id: imageA } } },
    { type: 'controlled-release', jobId: '3', status: 'failed' },
  ];
  const result = successfulServiceBaselines(records, model, { A_IMAGE: imageA, B_IMAGE: imageB });
  assert.equal(result.a.commit, 'a'.repeat(40));
  assert.equal(result.b.commit, 'b'.repeat(40));
  assert.deepEqual(successfulServiceBaselines(records, model, { A_IMAGE: 'changed', B_IMAGE: imageB }), { b: result.b });
});

test('platform-approved protected inputs still require every affected consumer and do not approve business deltas', async () => {
  const model = { services: { a: tree(['shared', 'a']), b: tree(['shared', 'b']) } };
  const before = await collect(model, { 'shared/Dockerfile': 'old', 'a/own': 'old', 'a/other': 'old' });
  const inputs = await collect(model, { 'shared/Dockerfile': 'approved', 'a/own': 'new', 'a/other': 'other' });
  const args = { inputs, baselines: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, baseline(v)])),
    changes: { a: ['shared/Dockerfile', 'a/own'], b: ['shared/Dockerfile'] }, allowedChanges: new Set(['a/own']),
    unreleasedBaseChanges: { a: new Set(['shared/Dockerfile']), b: new Set(['shared/Dockerfile']) },
    approvedProtectedChanges: new Set(['shared/Dockerfile']) };
  assert.deepEqual(selectReleaseImpact({ ...args, requestedServices: ['a', 'b'] }).selectedServices, ['a', 'b']);
  assert.throws(() => selectReleaseImpact({ ...args, requestedServices: ['a'] }), { code: 'RELEASE_AFFECTED_SERVICE_OMITTED' });
  assert.throws(() => selectReleaseImpact({ ...args, requestedServices: ['a', 'b'], changes: { ...args.changes, a: [...args.changes.a, 'a/other'] } }),
    { code: 'RELEASE_CANDIDATE_SCOPE_MISMATCH' });
});

test('missing baseline selects only requested services; unknown inputs fail explicitly', async () => {
  const model = { schemaVersion: 1, services: { alpha: tree(['source']) } };
  const inputs = await collect(model, { 'source/a': 'a' });
  assert.deepEqual(selectReleaseImpact({ requestedServices: ['alpha'], inputs, baselines: {}, changes: {} }).selectedServices, ['alpha']);
  await assert.rejects(collect({ services: { alpha: { ...tree(['source']), inputs: ['absent'] } } }, {}), { code: 'RELEASE_INPUTS_UNRESOLVED' });
  assert.throws(() => validateReleaseInputs({ schemaVersion: 1, services: { alpha: tree(['../escape']) } }, ['alpha']), { code: 'RELEASE_INPUTS_UNRESOLVED' });
  await assert.rejects(collectReleaseInputs(model, new Map([['source/link', { mode: '120000', object: 'a' }]]), () => ''), { code: 'RELEASE_INPUTS_UNRESOLVED' });
});

test('a combined image does not demand an unchanged frontend check', async () => {
  const model = { services: { web: { ...tree(['desktop', 'mobile']), checks: [
    { profile: 'desktop-test', selectors: {}, inputRoots: ['desktop'] },
    { profile: 'mobile-test', selectors: {}, inputRoots: ['mobile'] },
  ] } } };
  const before = await collect(model, { 'desktop/a': 'old', 'mobile/a': 'same' });
  const after = await collect(model, { 'desktop/a': 'new', 'mobile/a': 'same' });
  const plan = selectReleaseImpact({ requestedServices: ['web'], inputs: after, baselines: { web: baseline(before.web) }, changes: { web: ['desktop/a'] } });
  assert.deepEqual(plan.checks, [{ profile: 'desktop-test', selectors: {} }]);
  assert.deepEqual(plan.selectedServices, ['web']);
});

test('optional shared build configuration participates when added or removed', async () => {
  const model = { services: { web: { ...tree(['web']), optionalInputs: ['shared.config'] } } };
  const before = await collect(model, { 'web/a': 'a' });
  const after = await collect(model, { 'web/a': 'a', 'shared.config': 'config' });
  assert.notEqual(before.web.digest, after.web.digest);
});
