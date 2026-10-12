import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../docker/harness/forge-governance.mjs';
import { controlledEvidenceReceipt, parseControlledEvidenceCommand } from '../docker/harness/forge-controlled-command.mjs';
import { createInitialPhaseState, toolDenialReason, observeToolResult } from '../docker/harness/forge-phase-budget-guard.mjs';

const execution = (command) => ({ name: 'bash', arguments: { command }, callId: 'explain-rule' });

test('governance explain uses the real read-only CLI without satisfying audit or verification', async () => {
  for (const executable of ['forge-governance', '/usr/local/bin/forge-governance']) {
    for (const format of ['', ' --format text', ' --format json']) {
      const command = `${executable} explain --rule BE-PAGE-001${format}`;
      const state = createInitialPhaseState({ suspendHeuristicStops: true });
      state.actionCeiling = 'read-only';
      const before = { audit: state.auditSequence, verification: state.verificationSequence, mutation: state.mutationCount };
      assert.equal(toolDenialReason(state, execution(command)), undefined, command);
      let output = '';
      const io = { stdout: { write(value) { output += value; } }, stderr: { write(value) { output += value; } } };
      assert.equal(await main(command.split(' ').slice(1), io), 0);
      assert.match(output, /BE-PAGE-001/u);
      assert.equal(parseControlledEvidenceCommand(command), null);
      assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ok: true, receiptDigest: `sha256:${'a'.repeat(64)}`, obligations: [] })), null);
      observeToolResult(state, execution(command), { isError: false, content: [{ type: 'text', text: output }] });
      assert.equal(state.auditSequence, before.audit);
      assert.equal(state.verificationSequence, before.verification);
      assert.equal(state.mutationCount, before.mutation);
      assert.equal(state.auditSucceeded, false);
    }
  }
});

test('governance explain keeps shell composition and unneeded options denied', () => {
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  for (const command of [
    'forge-governance explain',
    'forge-governance explain --rule BE-PAGE-001 --rule DB-SEED-001',
    'forge-governance explain --rule ../outside',
    'forge-governance explain --rule BE-PAGE-001 --root /workspace',
    'forge-governance explain --rule BE-PAGE-001 --base HEAD',
    'forge-governance explain --rule BE-PAGE-001 --format yaml',
    'forge-governance explain --rule BE-PAGE-001 > receipt.json',
    'forge-governance explain --rule BE-PAGE-001 && git status',
    'forge-governance explain --rule BE-PAGE-001 | cat',
    'PATH=./bin forge-governance explain --rule BE-PAGE-001',
    '/workspace/forge-governance explain --rule BE-PAGE-001',
  ]) assert.ok(toolDenialReason(state, execution(command)), command);
});
