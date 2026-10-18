import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SkillBundleValidationError,
  sha256File,
  sha256SkillTree,
  validateSkillBundle,
} from '../docker/harness/validate-skill-bundle.mjs';

test('inline prose does not require a script or execute it', async (t) => {
  const temporaryParent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, 'coverage-required-executor-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), temporaryParent);
    assert.ok(path.basename(resolved).startsWith('coverage-required-executor-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const testRoot = path.dirname(fileURLToPath(import.meta.url));
  await cp(path.join(testRoot, 'fixtures/forge-skill-evals/valid'), root, { recursive: true });
  const skillRoot = path.join(root, 'skills/fixture-read');
  const skillPath = path.join(skillRoot, 'SKILL.md');
  const declaration = '\n## Required executor\nBefore completing any task covered by this Skill, you must run `node scripts/coverage-required-check.mjs` from this Skill directory. This is a required executor; do not complete the task unless it succeeds.\n';
  await assert.rejects(lstat(path.join(skillRoot, 'scripts/coverage-required-check.mjs')), { code: 'ENOENT' });
  await writeFile(skillPath, (await readFile(skillPath, 'utf8')) + declaration);
  const catalogPath = path.join(root, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const entry = catalog.skills.find(skill => skill.name === 'fixture-read');
  entry.contentSha256 = await sha256File(skillPath);
  entry.treeSha256 = await sha256SkillTree(skillRoot);
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  // This only validates text; the declared command must never be executed by this test.
  assert.equal((await validateSkillBundle({ skillsRoot:path.join(root,'skills'),catalogPath,strict:true })).skillCount,2);
  // Supplying the actual script and its catalog tree hash closes this missing
  // file defect. Neither validation nor this test invokes the declared script.
  await mkdir(path.join(skillRoot, 'scripts'));
  await writeFile(path.join(skillRoot, 'scripts/coverage-required-check.mjs'), 'throw new Error("This fixture must never execute");\n');
  entry.treeSha256 = await sha256SkillTree(skillRoot);
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  assert.equal((await validateSkillBundle({ skillsRoot: path.join(root, 'skills'), catalogPath, strict: true })).skillCount, 2);
});

test('quoted prose and synonyms do not impose script-existence gates', async (t) => {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'coverage-required-executor-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('coverage-required-executor-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await cp(new URL('./fixtures/forge-skill-evals/valid/', import.meta.url), root, { recursive: true });
  const skillRoot = path.join(root, 'skills/fixture-read');
  const skillFile = path.join(skillRoot, 'SKILL.md');
  const original = await readFile(skillFile, 'utf8');
  const catalogPath = path.join(root, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const entry = catalog.skills.find(skill => skill.name === 'fixture-read');
  const options = { skillsRoot: path.join(root, 'skills'), catalogPath, strict: true };
  for (const [text, rejected] of [
    ['You must run `node ../scripts/check.mjs`.', true],
    ['必须执行 `python scripts/check.py`。', true],
    ['You must not run `node scripts/absent.mjs`.', false],
    ['Quoted negative example:\n> You must run `node scripts/absent.mjs`.', false],
    ['You must run the following required executor:\n\n```bash\nnode scripts/check.mjs\n```', true],
    ['必须执行以下脚本：\n~~~sh\npython scripts/check.py\n~~~', true],
    ['You must run the following required executor:\n```sh\nnode ../scripts/check.mjs\n```', true],
    ['You must not run the following example:\n```bash\nnode scripts/absent.mjs\n```', false],
    ['Optional example:\n```bash\nnode scripts/absent.mjs\n```', false],
    ['> You must run the following required executor:\n> ```bash\n> node scripts/absent.mjs\n> ```', false],
    ['```markdown\nYou must run `node scripts/absent.mjs`.\n```', false],
    ['You must run the following required executor:\n```json\n"node scripts/absent.mjs"\n```', false],
  ]) {
    await writeFile(skillFile, `${original}\n${text}\n`);
    entry.contentSha256 = await sha256File(skillFile); entry.treeSha256 = await sha256SkillTree(skillRoot);
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    assert.equal((await validateSkillBundle(options)).skillCount, 2);
  }
});

test('mandatory fenced executors are bundled without executing them', async (t) => {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'coverage-required-executor-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('coverage-required-executor-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await cp(new URL('./fixtures/forge-skill-evals/valid/', import.meta.url), root, { recursive: true });
  const skillRoot = path.join(root, 'skills/fixture-read');
  const skillPath = path.join(skillRoot, 'SKILL.md');
  await writeFile(skillPath, (await readFile(skillPath, 'utf8'))
    + '\nYou must run the following required executor:\n```bash\nnode scripts/check.mjs\n```\n');
  await mkdir(path.join(skillRoot, 'scripts'));
  await writeFile(path.join(skillRoot, 'scripts/check.mjs'), 'throw new Error("Do not execute this fixture");\n');
  const catalogPath = path.join(root, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const entry = catalog.skills.find(skill => skill.name === 'fixture-read');
  entry.contentSha256 = await sha256File(skillPath);
  entry.treeSha256 = await sha256SkillTree(skillRoot);
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  assert.equal((await validateSkillBundle({ skillsRoot: path.join(root, 'skills'), catalogPath, strict: true })).skillCount, 2);
});
