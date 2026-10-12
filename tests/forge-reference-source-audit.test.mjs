import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidenceUrl = new URL(
  '../docs/validation-evidence/2026-09-02-forge-reference-source-audit.json',
  import.meta.url,
);

test('reference source audit accounts for every ProCode Skill entry point and every selected Aiko source', async () => {
  const evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.evidenceType, 'forge-reference-clean-room-source-audit');
  assert.deepEqual(evidence.decisionVocabulary, ['adopt', 'adapt', 'reject', 'defer']);
  assert.deepEqual(evidence.procode.domainTree, {
    fileCount: 62,
    byteCount: 218205,
    canonicalInventorySha256: '53552d4ed203954df77c5f4cb5a1fb363d147c6eaa2815df34a578cbc7bdc627',
  });
  assert.equal(evidence.procode.allSkillEntryPoints.fileCount, 48);
  assert.equal(evidence.procode.domainSkills.length, 29);
  assert.equal(evidence.procode.genericSkills.length, 19);
  assert.equal(evidence.aiko.files.length, 26);

  const entries = [
    ...evidence.procode.domainSkills,
    ...evidence.procode.genericSkills,
    ...evidence.aiko.files,
  ];
  assert.equal(new Set(evidence.procode.domainSkills.map((item) => item.sourceId)).size, 29);
  assert.equal(new Set(evidence.procode.genericSkills.map((item) => item.sourceId)).size, 19);
  for (const item of entries) {
    assert.match(item.path, /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+/u, item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u, item.path);
    assert.ok(evidence.decisionVocabulary.includes(item.decision), item.path);
    if (item.decision === 'reject') assert.ok(item.reason || item.rejectedAspects?.length > 0, item.path);
    else assert.ok(Array.isArray(item.forgeMechanisms) && item.forgeMechanisms.length > 0, item.path);
  }
  assert.equal(evidence.procode.excludedSecret.contentRead, false);
  assert.equal(evidence.procode.excludedSecret.path, '.cursor/mcp.json');
});

test('Stage 1 P1 closure remains explicit about static fixes and Stage 3 runtime proof', async () => {
  const evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
  assert.deepEqual(evidence.stage1P1Closure.map((item) => item.id), [
    'P1-ROUTE-DATABASE-SKILL',
    'P1-JAVA-TEST-DEPENDENCY-CLOSURE',
    'P1-FINAL-RUNTIME-VERIFICATION',
  ]);
  assert.deepEqual(evidence.stage1P1Closure.map((item) => item.status), [
    'resolved-static',
    'resolved-static',
    'contracted-stage3-required',
  ]);
  assert.ok(evidence.stage1P1Closure.every((item) => item.tests.length > 0 && item.remaining.length > 20));
  assert.ok(evidence.cannotClaim.some((item) => /paid model/iu.test(item)));
  assert.ok(evidence.cannotClaim.some((item) => /server/iu.test(item)));
});
