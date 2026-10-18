import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSourceQualityReport, SOURCE_QUALITY_BUNDLE_SHA256 } from '../docker/harness/forge-backend-source-quality.mjs';
import { controlledEvidenceCommandHint, parseControlledEvidenceCommand } from '../docker/harness/forge-controlled-command.mjs';

const runner = fileURLToPath(new URL('../docker/harness/backend-source-quality/run.py', import.meta.url));
const report = { schemaVersion: 1, mode: 'fast', bundleSha256: SOURCE_QUALITY_BUNDLE_SHA256,
  status: 'findings', files: [], findings: [{ reviewKind: 'structure', rule: 'GodClass' }], errors: [] };

test('direct source quality preserves structural findings without requiring a refactor; real errors still fail', () => {
  const script = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('quality',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
j=json.load(sys.stdin);code=m.apply_direct_advisory(j['report'],j['code']);print(json.dumps({'report':j['report'],'code':code}))`;
  for (const [mode, findings, errors, initialCode, wanted] of [
    ['direct', report.findings, [], 1, 0], ['', report.findings, [], 1, 1],
    ['direct', [{ reviewKind: 'code', rule: 'NullAssignment' }], [], 1, 1],
    ['direct', [...report.findings, { reviewKind: 'code' }], [], 1, 1],
    ['direct', [{ rule: 'unknown' }], [], 1, 1],
    ['direct', [], ['scanner unavailable'], 2, 2],
  ]) {
    const input = { report: { ...report, status: initialCode === 2 ? 'error' : 'findings', findings, errors }, code: initialCode };
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, runner], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, FORGE_DEVELOPMENT_MODE: mode, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.code, wanted);
    assert.deepEqual(output.report.findings, findings);
    validateSourceQualityReport(output.report, wanted);
    if (wanted === 0) {
      assert.equal(output.report.status, 'advisory');
      assert.equal(output.report.scannerExitCode, 1);
      const forged = structuredClone(output.report); forged.findings.push({ reviewKind: 'code' });
      assert.throws(() => validateSourceQualityReport(forged, 0));
    }
  }
});

test('unsupported diagnostic rebinding explains the actual cause and ends the checkpoint recheck loop', () => {
  const id = '91ef050c-5c0e-4182-9864-95885c37ca09';
  const command = `forge-verify run --profile backend-source-quality --admission-id ${id} --idempotency-key quality-reuse-20261012 --reuse-receipt ${id}`;
  assert.equal(parseControlledEvidenceCommand(command), null);
  assert.match(controlledEvidenceCommandHint(command), /optional diagnostics, not a checkpoint obligation/);
  assert.match(controlledEvidenceCommandHint(command), /do not rerun or rebind/);
  assert.equal(parseControlledEvidenceCommand(command.replace('backend-source-quality', 'frontend-admin-lint'))?.options['--reuse-receipt'], id);
  assert.equal(parseControlledEvidenceCommand(command.replace('backend-source-quality', 'frontend-admin-lint') + ' && whoami'), null);
});
