import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySkillBuildOriginal } from '../scripts/verify-coverage-skill-integrity-20260929.mjs';

// Synthetic platform verifier input, never counted as actual coverage evidence.
function fixture() {
  const manifest = 'sha256:c16682571f7acbc3752b03408f4ee745cc970be8ca107d9e2cd2bf12536a40ce';
  const probe = { type: 'pre-model-skill-build-rejection', uid: 1000, modelRequests: 0, businessWrites: 0,
    dangerousCommandExecuted: false, validatorSha256: 'sha256:fa2856162845ffe6b287f67c5374be84df55afb0ade19b0d449fdf5391f2fb81',
    activeManifestSha256: manifest, activeManifestAfterSha256: manifest, installed: { skillCount: 21, strict: true },
    normalBuild: { exitCode: 0, stderr: '', stdout: JSON.stringify({ ok: true, skillCount: 2 }) },
    normalManifestSha256: 'sha256:1354c2f89fd25c6010b8845f266cbf99f795b260c480bc33e2796331a90c7ccd',
    injectedInstructionSha256: 'fe25eb26b25663efc476040060bf492d95754514e5cf24cf2976872e9b8337fd',
    injectedSkillSha256: 'sha256:1e92db5997ecbb054e06345ac5230eb0263cfe62db1d189e8f71f204f60a2225',
    injectedCatalogSha256: 'sha256:79c29576a0fd8653f5d23af201fcda2b0550773031ddd0d3309950b614f2fde3',
    validatorNegative: { rejected: true, name: 'SkillBundleValidationError', issues: [{ code: 'skill-unsafe-instruction' }] },
    maliciousBuild: { exitCode: 1, signal: null, stdout: '', stderr: JSON.stringify({ ok: false, error: 'Skill bundle validation failed with 1 issue.' }) },
    remainingOutputNames: [], overallPass: true };
  const consumer = { image: 'sha256:3e66b7638e3f04f55e669808057f671c28a22c8310c54e3149788825dbe0c7a0',
    containerId: 'a'.repeat(64), user: '1000:1000', network: 'none', readonly: true, capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'], state: { status: 'exited', exitCode: 0 } };
  return { exit: 0, stderr: '', stdout: JSON.stringify({ exit: 0, stderr: '', consumer, stdout: JSON.stringify(probe) }) };
}
test('Skill evidence rejects wrong image, model execution, false success and leaked output', () => {
  const raw = fixture();
  assert.equal(verifySkillBuildOriginal(raw).probe.overallPass, true);
  const changes = [
    (result) => { result.consumer.image = 'sha256:' + '0'.repeat(64); },
    (_, probe) => { probe.modelRequests = 1; },
    (_, probe) => { probe.validatorNegative.issues = []; },
    (_, probe) => { probe.maliciousBuild.exitCode = 0; },
    (_, probe) => { probe.normalBuild.exitCode = 1; },
    (_, probe) => { probe.remainingOutputNames = ['malicious-bundle']; },
    (_, probe) => { probe.activeManifestAfterSha256 = 'sha256:' + '0'.repeat(64); },
  ];
  for (const change of changes) {
    const altered = structuredClone(raw);
    const result = JSON.parse(altered.stdout);
    const probe = JSON.parse(result.stdout);
    change(result, probe);
    result.stdout = JSON.stringify(probe);
    altered.stdout = JSON.stringify(result);
    assert.throws(() => verifySkillBuildOriginal(altered));
  }
});
