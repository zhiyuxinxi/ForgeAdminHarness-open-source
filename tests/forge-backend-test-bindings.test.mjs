import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  backendTestSelectorsForContract,
  compileForgeTaskExecutionContract,
  deriveBackendTestBindings,
  validateForgeTaskExecutionContract,
  verificationScopeForContract,
} from '../docker/harness/forge-task-execution-contract.mjs';

const modulePath = 'forge-server/forge-business/core';
const fixture = `${modulePath}/src/test/java/example/RemarkFixture.java`;
const testPath = `${modulePath}/src/test/java/example/RemarkValidation.java`;
const source = (path, content) => ({ path, content, sha256: createHash('sha256').update(content).digest('hex') });
const helperSource = source(fixture, 'package example; public class RemarkFixture {}');
const actualTest = source(testPath, `package example;
import org.junit.jupiter.api.Test;
class RemarkValidation { @Test void checks() { var subject = new RemarkFixture(); } }`);
const input = { prompt: '只修复测试夹具中的长度约束。', actionCeiling: 'workspace-write', ownedPaths: [fixture], taskProfiles: ['backend'] };
const options = { verificationScope: 'changed', focusedBackendVerification: true };

test('actual JUnit source references select the validation class, irrespective of filename suffix', () => {
  const bindings = deriveBackendTestBindings([fixture], [helperSource, actualTest]);
  assert.deepEqual(bindings, [{ module: modulePath, test: 'example.RemarkValidation', testPath,
    testSha256: actualTest.sha256, coveredPaths: [fixture] }]);
  const contract = compileForgeTaskExecutionContract(input, { ...options, backendTestBindings: bindings });
  assert.deepEqual(backendTestSelectorsForContract(contract), { modules: [modulePath], tests: ['example.RemarkValidation'] });
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  assert.notEqual(contract.contractId, compileForgeTaskExecutionContract(input, options).contractId);
});

test('comments, string literals, missing JUnit definitions and unrelated sources cannot supply coverage', () => {
  for (const code of [
    'package example; // @Test new RemarkFixture()\nclass RemarkValidation {}',
    'package example; import org.junit.jupiter.api.Test; class RemarkValidation { @Test void check() { String s="new RemarkFixture()"; } }',
    'package example; class RemarkValidation { void check() { new RemarkFixture(); } }',
    'package example; import org.junit.jupiter.api.Test; class RemarkValidation { @Test void check() {} }',
  ]) assert.equal(deriveBackendTestBindings([fixture], [helperSource, source(testPath, code)]), undefined);
  assert.equal(deriveBackendTestBindings([fixture], [actualTest]), undefined);
  assert.equal(deriveBackendTestBindings([fixture, `${modulePath}/pom.xml`], [helperSource, actualTest]), undefined);
});

test('mixed owned JUnit and helper keep both review paths and select only the verified test', () => {
  const ownedPaths = [fixture, testPath];
  const bindings = deriveBackendTestBindings(ownedPaths, [helperSource, actualTest]);
  assert.deepEqual(bindings, [{ module: modulePath, test: 'example.RemarkValidation', testPath,
    testSha256: actualTest.sha256, coveredPaths: ownedPaths }]);
  const contract = compileForgeTaskExecutionContract({ ...input, ownedPaths }, { ...options,
    backendTestBindings: bindings,
    dualReview: { sourcePath: `${modulePath}/src/test/resources/review.json`, sha256: 'a'.repeat(64) } });
  assert.deepEqual(contract.ownedPaths, ownedPaths);
  assert.ok(contract.requiredObligations.includes('spec-and-quality-review'));
  assert.deepEqual(backendTestSelectorsForContract(contract), { modules: [modulePath], tests: ['example.RemarkValidation'] });
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  assert.equal(deriveBackendTestBindings([testPath], [actualTest]), undefined);
});

test('mixed owned bindings reject unproved JUnit, missing reads, stale bytes and uncovered sources', () => {
  const ownedPaths = [fixture, testPath];
  for (const references of [
    [helperSource], [actualTest],
    [helperSource, source(testPath, 'package example; // @Test new RemarkFixture()\nclass RemarkValidation {}')],
    [helperSource, source(testPath, 'package example; import org.junit.jupiter.api.Test; class RemarkValidation { @Test void check() { String s="new RemarkFixture()"; } }')],
  ]) assert.equal(deriveBackendTestBindings(ownedPaths, references), undefined);
  assert.throws(() => deriveBackendTestBindings(ownedPaths, [helperSource, { ...actualTest, sha256: '0'.repeat(64) }]));
  const foreignPath = 'forge-server/other/src/test/java/example/RemarkValidation.java';
  assert.equal(deriveBackendTestBindings([fixture, foreignPath], [helperSource, source(foreignPath, actualTest.content)]), undefined);
  const extraPath = `${modulePath}/src/test/java/example/UnrelatedFixture.java`;
  assert.equal(deriveBackendTestBindings([...ownedPaths, extraPath], [helperSource, actualTest,
    source(extraPath, 'package example; class UnrelatedFixture {}')]), undefined);
  const [binding] = deriveBackendTestBindings(ownedPaths, [helperSource, actualTest]);
  for (const coveredPaths of [[fixture], [testPath]]) {
    assert.throws(() => compileForgeTaskExecutionContract({ ...input, ownedPaths },
      { ...options, backendTestBindings: [{ ...binding, coveredPaths }] }));
  }
});

test('bindings cannot change modules, omit owned sources, escape paths, or use stale source bytes', () => {
  assert.throws(() => deriveBackendTestBindings([fixture], [helperSource, { ...actualTest, sha256: '0'.repeat(64) }]));
  const [binding] = deriveBackendTestBindings([fixture], [helperSource, actualTest]);
  for (const change of [{ module: 'forge-server/other' }, { coveredPaths: [] },
    { testPath: '../RemarkValidation.java' }, { test: 'example.Other' }, { testSha256: 'bad' }]) {
    assert.throws(() => compileForgeTaskExecutionContract(input, { ...options, backendTestBindings: [{ ...binding, ...change }] }));
  }
  const historical = compileForgeTaskExecutionContract(input, options);
  assert.equal(Object.hasOwn(historical, 'backendTestBindings'), false);
  assert.deepEqual(validateForgeTaskExecutionContract(historical), historical);
});

const applicationModule = 'forge-server/app';
const productionModule = 'forge-server/plugins/rules';
const integrationPath = `${applicationModule}/src/test/java/example/RuleIntegrationTest.java`;
const productionPath = `${productionModule}/src/main/java/example/RuleService.java`;
const integrationSpec = `${applicationModule}/src/test/resources/rules/spec.md`;
const integrationPaths = [productionPath, integrationPath, integrationSpec].sort();
const integrationSource = source(integrationPath, `package example;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
@SpringBootTest(classes = Application.class)
class RuleIntegrationTest { @Test void authenticatedUpdate() {} }`);
const productionPom = source(`${productionModule}/pom.xml`, '<project><parent><groupId>example</groupId><artifactId>plugins</artifactId></parent><artifactId>rules</artifactId></project>');
const dependency = '<dependency><groupId>example</groupId><artifactId>rules</artifactId></dependency>';
const applicationPom = (body = `<dependencies>${dependency}</dependencies>`) => source(`${applicationModule}/pom.xml`, `<project><groupId>example</groupId><artifactId>app</artifactId>${body}</project>`);
const integrationInput = { prompt: '修复规则真实API并验证其集成测试。', actionCeiling: 'workspace-write', ownedPaths: integrationPaths, taskProfiles: ['backend'] };

test('random-port HTTP integration binds the actual class without requiring a full module', () => {
  const httpTest = source(integrationPath, integrationSource.content.replace('Application.class)',
    'Application.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)'));
  const bindings = deriveBackendTestBindings(integrationPaths, [httpTest, applicationPom(), productionPom]);
  assert.ok(bindings);
  const contract = compileForgeTaskExecutionContract(integrationInput, { ...options, backendTestBindings: bindings });
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'backend-test-class']);
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  assert.equal(bindings[0].testSha256, httpTest.sha256);
  assert.deepEqual(bindings[0].coveredPaths, integrationPaths);
});

test('random-port binding keeps application, Maven and source-integrity requirements', () => {
  const http = integrationSource.content.replace('Application.class)',
    'Application.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)');
  for (const code of [http.replace('classes = Application.class, ', ''),
    http.replace('SpringBootTest.WebEnvironment.RANDOM_PORT', 'unverifiedPort'),
    http.replace('RANDOM_PORT)', 'RANDOM_PORT, unknown = true)')]) {
    assert.equal(deriveBackendTestBindings(integrationPaths, [source(integrationPath, code), applicationPom(), productionPom]), undefined);
  }
  const httpTest = source(integrationPath, http);
  assert.equal(deriveBackendTestBindings(integrationPaths, [httpTest, applicationPom()]), undefined);
  assert.throws(() => deriveBackendTestBindings(integrationPaths, [{ ...httpTest, sha256: '0'.repeat(64) }, applicationPom(), productionPom]));
});

test('real integration source and direct Maven dependency bind every production module to the exact class', () => {
  const bindings = deriveBackendTestBindings(integrationPaths, [integrationSource, applicationPom(), productionPom]);
  assert.ok(bindings);
  const contract = compileForgeTaskExecutionContract(integrationInput, { ...options, backendTestBindings: bindings });
  assert.deepEqual(contract.requiredVerificationProfiles, ['governance', 'backend-test-class']);
  assert.deepEqual(backendTestSelectorsForContract(contract), {
    modules: [applicationModule, productionModule], tests: ['example.RuleIntegrationTest'],
  });
  assert.deepEqual(validateForgeTaskExecutionContract(contract), contract);
  assert.deepEqual(contract.ownedPaths, integrationPaths);
  assert.equal(verificationScopeForContract(contract), 'changed');
  assert.deepEqual(compileForgeTaskExecutionContract(integrationInput, {
    ...options, verificationScope: verificationScopeForContract(contract), backendTestBindings: bindings,
  }), contract);
  assert.equal(bindings[0].testSha256, integrationSource.sha256);
  assert.equal(bindings[0].testPomSha256, applicationPom().sha256);
  assert.deepEqual(bindings[0].moduleDependencies, [{ module: productionModule, pomSha256: productionPom.sha256 }]);
});

test('integration binding rejects absent, managed-only, profile-only, commented and test-only dependencies', () => {
  for (const pom of [applicationPom(''), applicationPom(`<!-- <dependencies>${dependency}</dependencies> -->`),
    applicationPom(`<dependencyManagement><dependencies>${dependency}</dependencies></dependencyManagement>`),
    applicationPom(`<profiles><profile><dependencies>${dependency}</dependencies></profile></profiles>`),
    ...['<scope>test</scope>', '<scope>${scope}</scope>', '<optional>${optional}</optional>',
      '<type>pom</type>', '<classifier>tests</classifier>'].map(field =>
      applicationPom(`<dependencies>${dependency.replace('</dependency>', `${field}</dependency>`)}</dependencies>`))]) {
    assert.equal(deriveBackendTestBindings(integrationPaths, [integrationSource, pom, productionPom]), undefined);
  }
  assert.equal(deriveBackendTestBindings(integrationPaths, [integrationSource, applicationPom()]), undefined);
  assert.throws(() => deriveBackendTestBindings(integrationPaths, [integrationSource, { ...applicationPom(), sha256: '0'.repeat(64) }, productionPom]));
});

test('integration bindings cannot hide another module, resources, extra tests or forged contract selectors', () => {
  const refs = [integrationSource, applicationPom(), productionPom];
  for (const extra of ['forge-server/unrelated/src/main/java/example/Other.java', `${productionModule}/pom.xml`,
    `${productionModule}/src/main/resources/schema.sql`, `${applicationModule}/src/test/java/example/OtherTest.java`]) {
    assert.equal(deriveBackendTestBindings([...integrationPaths, extra], refs), undefined);
  }
  const [binding] = deriveBackendTestBindings(integrationPaths, refs);
  for (const change of [{ moduleDependencies: [] }, { testPomSha256: 'bad' }, { coveredPaths: [integrationPath] },
    { moduleDependencies: [{ module: 'forge-server/unrelated', pomSha256: productionPom.sha256 }] }]) {
    assert.throws(() => compileForgeTaskExecutionContract(integrationInput, { ...options, backendTestBindings: [{ ...binding, ...change }] }));
  }
  for (const settings of [{ verificationScope: 'legacy', focusedBackendVerification: true }, { verificationScope: 'changed' }]) {
    assert.throws(() => compileForgeTaskExecutionContract(integrationInput, { ...settings, backendTestBindings: [binding] }));
    const old = compileForgeTaskExecutionContract(integrationInput, settings);
    assert.deepEqual(validateForgeTaskExecutionContract(old), old);
    assert.ok(old.requiredVerificationProfiles.includes('backend-module-test'));
  }
});
