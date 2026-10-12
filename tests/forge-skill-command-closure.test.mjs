import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseControlledEvidenceCommand } from '../docker/harness/forge-controlled-command.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(repositoryRoot, 'docker', 'harness', 'skills');
const scopedSkills = [
  'forge-frontend-admin',
  'forge-security-tenancy-permission',
  'forge-workflow-production',
  'forge-backend-architecture',
  'forge-testing-observability',
  'forge-change-design',
  'forge-evidence-truth',
];
const forbiddenDirectCommand = /^\s*(?:cd\s+forge-(?:server|admin-ui)|mvn(?:w)?\s|(?:corepack\s+)?pnpm\s|forge-delivery(?:\s|$))/iu;
const modelCommand = /^\s*(forge-(?:governance|verify)\s+.+?)\s*$/u;
const approvedBase = 'a'.repeat(40);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.md') ? [absolute] : [];
  }));
  return nested.flat();
}

function materialize(command) {
  return command
    .replaceAll('<approved-base-commit>', approvedBase)
    .replaceAll('<contract-required-profile>', 'full-regression')
    .replaceAll('<contract-profile-1>', 'backend-module-test')
    .replaceAll('<profile>', 'full-regression')
    .replaceAll('<current-admission-id>', '123e4567-e89b-12d3-a456-426614174099')
    .replaceAll('<current-task-idempotency-key>', 'task-command-closure-0001')
    .replace(/\s+\[--profile <contract-profile-2>\]\.\.\./u, '')
    .replace(/\s+\[--module.+$/u, '');
}

test('standard source Skills expose only controlled governance and typed verification commands', async () => {
  const files = (await Promise.all(scopedSkills.map((name) => markdownFiles(path.join(skillRoot, name))))).flat();
  const executableExamples = [];

  for (const file of files) {
    const relative = path.relative(repositoryRoot, file).replaceAll('\\', '/');
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      assert.equal(
        forbiddenDirectCommand.test(line.replaceAll('`', '')),
        false,
        `${relative}:${index + 1} exposes a direct shell command outside the standard typed surface`,
      );
      if (line.includes('`forge-delivery`')) {
        assert.match(
          line,
          /(?:OPERATOR_ONLY_REFERENCE_V1|operator-only|reference-only)/iu,
          `${relative}:${index + 1} must label forge-delivery as operator/reference-only`,
        );
      }
      const command = line.match(modelCommand)?.[1];
      if (!command) continue;
      executableExamples.push({ relative, line: index + 1, command });
      assert.notEqual(
        parseControlledEvidenceCommand(materialize(command)),
        null,
        `${relative}:${index + 1} is not accepted by the controlled command parser: ${command}`,
      );
    }
  }

  assert.ok(executableExamples.some(({ command }) => command.startsWith('forge-governance audit ')));
  assert.equal(executableExamples.some(({ command }) => command.startsWith('forge-verify admit ')), false);
  assert.ok(executableExamples.some(({ command }) => command.startsWith('forge-verify run ')));
});
