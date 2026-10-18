import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  SkillBundleValidationError,
  validateSkillBundle,
} from '../docker/harness/validate-skill-bundle.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, '..');
const fixtureRoot = path.join(testRoot, 'fixtures', 'forge-skill-evals', 'valid');

async function fixtureCopy() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-skill-evals-'));
  await cp(fixtureRoot, temporaryRoot, { recursive: true });
  return temporaryRoot;
}

async function expectIssue(root, code, evalPath = path.join(root, 'bundle.eval.json')) {
  await assert.rejects(
    validateSkillBundle({
      skillsRoot: path.join(root, 'skills'),
      catalogPath: path.join(root, 'catalog.json'),
      evalPath,
      strict: true,
    }),
    (error) => {
      assert.ok(error instanceof SkillBundleValidationError);
      assert.ok(error.issues.some((item) => item.code === code), `expected issue ${code}, got ${error.issues.map((item) => item.code).join(', ')}`);
      return true;
    },
  );
}

test('the reviewed Forge bundle has positive and negative trigger coverage within each case authorization ceiling', async () => {
  const catalogPath = path.join(repoRoot, 'docker', 'harness', 'skills.catalog.json');
  const result = await validateSkillBundle({
    skillsRoot: path.join(repoRoot, 'docker', 'harness', 'skills'),
    catalogPath,
    evalPath: path.join(testRoot, 'fixtures', 'forge-skill-evals'),
    strict: true,
  });
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const evalRoot = path.join(testRoot, 'fixtures', 'forge-skill-evals');
  const suites = await Promise.all((await readdir(evalRoot)).filter(name => name.endsWith('.eval.json'))
    .map(async name => JSON.parse(await readFile(path.join(evalRoot, name), 'utf8'))));
  assert.equal(result.bundleVersion, catalog.bundleVersion);
  assert.equal(result.skillCount, catalog.skills.length);
  assert.equal(result.caseCount, suites.reduce((total, suite) => total + suite.cases.length, 0));
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
  assert.deepEqual(
    [
      'forge-task-router',
      'browser-playwright',
      'api-bruno',
      'code-ast-grep',
      'forge-database-migration',
      'forge-backend-architecture',
      'forge-crud-production',
      'forge-frontend-admin',
      'forge-security-tenancy-permission',
      'forge-workflow-production',
      'forge-testing-observability',
    ].filter((name) => !byName.has(name)),
    [],
  );
  for (const name of ['forge-change-design', 'forge-delivery-orchestrator', 'forge-evidence-truth']) {
    assert.equal(byName.get(name)?.sideEffectClass, 'bounded-derived-write');
  }
});

test('implicit-trigger evals require positive and negative coverage for every cataloged Skill', async () => {
  const result = await validateSkillBundle({
    skillsRoot: path.join(fixtureRoot, 'skills'),
    catalogPath: path.join(fixtureRoot, 'catalog.json'),
    evalPath: fixtureRoot,
    strict: true,
  });
  assert.equal(result.caseCount, 2);

  const root = await fixtureCopy();
  try {
    const evalPath = path.join(root, 'bundle.eval.json');
    const suite = JSON.parse(await readFile(evalPath, 'utf8'));
    suite.cases[0].forbiddenSkills = [];
    await writeFile(evalPath, `${JSON.stringify(suite, null, 2)}\n`);
    await expectIssue(root, 'eval-negative-coverage');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eval references must be cataloged and cannot be both expected and forbidden', async () => {
  const root = await fixtureCopy();
  try {
    const evalPath = path.join(root, 'bundle.eval.json');
    const suite = JSON.parse(await readFile(evalPath, 'utf8'));
    suite.cases[0].expectedSkills.push('uncataloged-skill');
    suite.cases[0].forbiddenSkills.push('fixture-read');
    await writeFile(evalPath, `${JSON.stringify(suite, null, 2)}\n`);
    await assert.rejects(
      validateSkillBundle({
        skillsRoot: path.join(root, 'skills'),
        catalogPath: path.join(root, 'catalog.json'),
        evalPath,
        strict: true,
      }),
      (error) => {
        assert.ok(error instanceof SkillBundleValidationError);
        const codes = new Set(error.issues.map((item) => item.code));
        assert.ok(codes.has('eval-unknown-skill'));
        assert.ok(codes.has('eval-expectation-overlap'));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an expected Skill may not exceed the case authorization ceiling', async () => {
  const root = await fixtureCopy();
  try {
    const evalPath = path.join(root, 'bundle.eval.json');
    const suite = JSON.parse(await readFile(evalPath, 'utf8'));
    suite.cases[1].maximumAuthorizedSideEffect = 'read-only';
    await writeFile(evalPath, `${JSON.stringify(suite, null, 2)}\n`);
    await expectIssue(root, 'eval-side-effect-exceeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an eval directory merges only *.eval.json files before enforcing coverage', async () => {
  const root = await fixtureCopy();
  try {
    const sourcePath = path.join(root, 'bundle.eval.json');
    const suite = JSON.parse(await readFile(sourcePath, 'utf8'));
    const splitRoot = path.join(root, 'split-evals');
    await mkdir(splitRoot);
    await writeFile(path.join(splitRoot, 'read.eval.json'), `${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: suite.bundleVersion,
      cases: [suite.cases[0]],
    }, null, 2)}\n`);
    await writeFile(path.join(splitRoot, 'release.eval.json'), `${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: suite.bundleVersion,
      cases: [suite.cases[1]],
    }, null, 2)}\n`);
    await writeFile(path.join(splitRoot, 'notes.json'), '{ this file is deliberately not an eval suite }\n');

    const result = await validateSkillBundle({
      skillsRoot: path.join(root, 'skills'),
      catalogPath: path.join(root, 'catalog.json'),
      evalPath: splitRoot,
      strict: true,
    });
    assert.equal(result.caseCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
