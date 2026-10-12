import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectCapabilityInventoryIssues, generateCapabilityInventory, verifyCapabilityInventoryFixtures } from '../docker/harness/forge-capability-inventory.mjs';
import { describeGovernedTool } from '../docker/harness/forge-phase-budget-guard.mjs';
import { createExternalSkillBundle, installExternalSkillBundle, validateExternalSkillBundle } from '../scripts/forge-skill-bundle.mjs';
import { SkillBundleValidationError, validateSkillBundle } from '../docker/harness/validate-skill-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHash = createHash('sha256').update(await readFile(path.join(root, 'docker/harness/forge-capability-inventory.mjs'))).digest('hex');
function input(catalog = { skills: [{ name: 'reader', sideEffectClass: 'read-only', requiredTools: ['read'] }] }) {
  return { catalog, registeredTools: [
    { name: 'read', parameters: { file_path: { type: 'string', required: true } }, outputSchema: { type: 'string' }, policy: describeGovernedTool('read') },
    { name: 'unclassified_tool', parameters: {}, outputSchema: { type: 'string' }, policy: describeGovernedTool('unclassified_tool') },
  ], sources: [{ path: 'forge-capability-inventory.mjs', sha256: sourceHash }] };
}

test('inventory projects guarded admission honestly and executes each checker positive and negative fixture', () => {
  const actual = input(); const inventory = generateCapabilityInventory(actual);
  assert.equal(inventory.tools.find(tool => tool.name === 'unclassified_tool').policy.admitted, false);
  assert.deepEqual(describeGovernedTool('write').sideEffectClasses, ['workspace-write']);
  assert.equal(describeGovernedTool('bash').classification, 'exact-controlled-argv');
  assert.deepEqual(collectCapabilityInventoryIssues({ ...actual, inventory }), []);
  const fixtures = verifyCapabilityInventoryFixtures({ ...actual, inventory });
  assert.equal(fixtures.length, 4);
  assert.ok(fixtures.every(row => row.positivePassed && row.negativeRejected));
  assert.ok(inventory.checkers.every(row => row.sourceSha256 === sourceHash));
});

test('inventory refuses denied declarations, omitted schemas, tampered content and missing checker fixtures', () => {
  const actual = input(); const inventory = generateCapabilityInventory(actual);
  const denied = structuredClone(actual); denied.catalog.skills[0].requiredTools = ['unclassified_tool'];
  assert.throws(() => generateCapabilityInventory(denied), /inventory-declared-tool/u);
  const noSchema = structuredClone(actual); delete noSchema.registeredTools[0].outputSchema;
  assert.throws(() => generateCapabilityInventory(noSchema), /actual input\/output schemas/u);
  const tampered = structuredClone(inventory); tampered.tools[0].policy.admitted = false;
  assert.ok(collectCapabilityInventoryIssues({ ...actual, inventory: tampered }).some(issue => issue.code === 'inventory-integrity'));
  const missingFixture = structuredClone(inventory); delete missingFixture.checkers[0].negativeFixture;
  assert.ok(collectCapabilityInventoryIssues({ ...actual, inventory: missingFixture }).some(issue => issue.code === 'inventory-checker-fixture'));
});

test('real external bundle build and consumption reject missing tools and effect drift before producing an artifact', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-inventory-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await cp(path.join(root, 'tests/fixtures/forge-skill-evals/valid'), source, { recursive: true });
  const catalogPath = path.join(source, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')); catalog.skills[0].requiredTools = ['read'];
  await writeFile(catalogPath, JSON.stringify(catalog));
  const capabilityInventoryPath = path.join(temporary, 'inventory.json');
  await writeFile(capabilityInventoryPath, JSON.stringify(generateCapabilityInventory(input(catalog))));
  const options = { sourceSkillsRoot: path.join(source, 'skills'), sourceCatalogPath: catalogPath,
    compatibleDshVersions: ['0.1.1-rc.2'], capabilityInventoryPath };
  const good = await createExternalSkillBundle({ ...options, outputRoot: path.join(temporary, 'good') });
  assert.equal(good.skillValidation.skillCount, 2);
  await validateExternalSkillBundle(path.join(temporary, 'good'), { capabilityInventoryPath });
  const installOptions = { bundleRoot: path.join(temporary, 'good'), installRoot: path.join(temporary, 'installed'),
    expectedDshVersion: '0.1.1-rc.2', capabilityInventoryPath };
  assert.equal((await installExternalSkillBundle(installOptions)).installed, true);
  assert.equal((await installExternalSkillBundle(installOptions)).idempotent, true);
  for (const [id, mutate] of [
    ['inventory-declared-tool', value => { value.skills[0].requiredTools = ['does_not_exist']; }],
    ['inventory-skill-effect', value => { value.skills[0].sideEffectClass = 'workspace-write'; }],
  ]) {
    const changed = structuredClone(catalog); mutate(changed); await writeFile(catalogPath, JSON.stringify(changed));
    const outputRoot = path.join(temporary, id);
    await assert.rejects(createExternalSkillBundle({ ...options, outputRoot }), error => error instanceof SkillBundleValidationError && error.issues.some(issue => issue.code === id));
    await assert.rejects(stat(outputRoot), { code: 'ENOENT' });
  }
  await writeFile(catalogPath, JSON.stringify(catalog));
  await assert.rejects(validateSkillBundle({ skillsRoot: options.sourceSkillsRoot, catalogPath }), error => error instanceof SkillBundleValidationError && error.issues.some(issue => issue.code === 'inventory-required'));
});
